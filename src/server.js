const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { q, pool, migrate } = require('./db');
const ext = require('./external');
const { bootstrap } = require('./seed');

const PORT = Number(process.env.PORT || 3000);
const DOMAIN = '@cafefrihet.com';
const FUEL_TYPES = ['gasoline', 'diesel', 'lpg', 'hybrid', 'ev'];
const CARD_TYPES = ['corporate', 'personal'];

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => cb(null, /^image\/|application\/pdf/.test(file.mimetype)),
});
const dayUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 40 },
  fileFilter: (req, file, cb) => cb(null, /^image\/|application\/pdf/.test(file.mimetype)),
});
const xlsxUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

let JWT_SECRET = process.env.JWT_SECRET;

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const int = (v, d = 0) => {
  const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : d;
};
const num = (v, d = null) => {
  if (v === '' || v === null || v === undefined) return d;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : d;
};
const str = (v) => (v === undefined || v === null ? null : String(v).trim() || null);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

function calcFuelCost(distanceKm, efficiency, price) {
  if (!distanceKm || !efficiency || !price) return 0;
  return Math.round((Number(distanceKm) / Number(efficiency)) * Number(price));
}

// ---------- auth ----------
function issue(res, user) {
  const token = jwt.sign({ uid: user.id, tv: user.token_version }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('fbcl', token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE !== 'false', maxAge: 30 * 864e5,
  });
}

const auth = wrap(async (req, res, next) => {
  const token = req.cookies.fbcl;
  if (!token) throw bad('로그인이 필요합니다', 401);
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); } catch { throw bad('세션이 만료되었습니다', 401); }
  const r = await q('SELECT * FROM users WHERE id=$1', [payload.uid]);
  const u = r.rows[0];
  if (!u || !u.active || u.token_version !== payload.tv) {
    res.clearCookie('fbcl');
    throw bad('접속이 차단되었거나 세션이 무효화되었습니다', 401);
  }
  req.user = u;
  const allow = ['/api/me', '/api/auth/password', '/api/auth/logout'];
  if (u.must_change_password && !allow.includes(req.path)) {
    throw Object.assign(new Error('최초 로그인입니다. 비밀번호를 먼저 변경하세요'), { status: 403, mustChange: true });
  }
  next();
});
const admin = (req, res, next) => (req.user.role === 'admin' ? next() : next(bad('관리자 권한이 필요합니다', 403)));
const isAdmin = (req) => req.user.role === 'admin';
// 법인카드 일지 사용자: 직책에 '팀장' 포함 또는 카드 구분(team_card) 지정 (관리자라도 지정 없으면 제외)
const isHolder = (u) => !!u && (!!u.team_card || /팀장/.test(u.position || ''));
const cardLabel = (u) => u.team_card || '팀장카드';
// 장부: drive(운행일지) / team(부서팀장 법인카드) — team은 팀장·관리자만, 법인카드만
async function resolveBook(req, book, userId) {
  if (book !== 'team') return 'drive';
  const u = (await q('SELECT role, position, team_card FROM users WHERE id=$1', [userId])).rows[0];
  if (!isHolder(u) || !(req.user.role === 'admin' || req.user.id === userId)) throw bad('법인카드 일지 사용 대상이 아닙니다', 403);
  return 'team';
}
// 일반 직원은 본인 데이터만, 관리자는 지정 직원 데이터
function targetUserId(req, requested) {
  if (isAdmin(req) && requested) return int(requested);
  return req.user.id;
}
function assertOwner(req, ownerId) {
  if (!isAdmin(req) && ownerId !== req.user.id) throw bad('본인 기록만 수정할 수 있습니다', 403);
}

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.post('/api/auth/login', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email.endsWith(DOMAIN)) throw bad('회사 계정(@cafefrihet.com)으로만 로그인할 수 있습니다', 403);
  const r = await q('SELECT * FROM users WHERE email=$1', [email]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash))) throw bad('이메일 또는 비밀번호가 올바르지 않습니다', 401);
  if (!u.active) throw bad('접속이 차단된 계정입니다. 관리자에게 문의하세요', 403);
  issue(res, u);
  res.json({ ok: true, must_change_password: u.must_change_password });
}));

app.post('/api/auth/logout', (req, res) => { res.clearCookie('fbcl'); res.json({ ok: true }); });

app.post('/api/auth/password', auth, wrap(async (req, res) => {
  const { current, next: nextPw } = req.body;
  if (!(await bcrypt.compare(String(current || ''), req.user.password_hash))) throw bad('현재 비밀번호가 올바르지 않습니다');
  if (!nextPw || String(nextPw).length < 8) throw bad('새 비밀번호는 8자 이상이어야 합니다');
  const hash = await bcrypt.hash(String(nextPw), 10);
  const r = await q(
    'UPDATE users SET password_hash=$1, must_change_password=false, token_version=token_version+1 WHERE id=$2 RETURNING *',
    [hash, req.user.id]
  );
  issue(res, r.rows[0]);
  res.json({ ok: true });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  const u = req.user;
  const v = await q('SELECT * FROM vehicles WHERE user_id=$1 AND active ORDER BY id', [u.id]);
  res.json({
    id: u.id, email: u.email, name: u.name, nickname: u.nickname, department: u.department,
    position: u.position, role: u.role, must_change_password: u.must_change_password, vehicles: v.rows, is_lead: u.role === 'admin' || isHolder(u), is_holder: isHolder(u), team_card: u.team_card,
  });
}));

// ---------- 직원 ----------
app.get('/api/users', auth, wrap(async (req, res) => {
  const where = isAdmin(req) ? (req.query.all ? '' : 'WHERE u.active') : 'WHERE u.id=$1';
  const params = isAdmin(req) ? [] : [req.user.id];
  const r = await q(
    `SELECT u.id,u.email,u.name,u.nickname,u.department,u.position,u.role,u.active,u.deactivated_at,u.team_card,
      COALESCE(json_agg(v ORDER BY v.id) FILTER (WHERE v.id IS NOT NULL),'[]') AS vehicles
     FROM users u LEFT JOIN vehicles v ON v.user_id=u.id AND v.active
     ${where} GROUP BY u.id ORDER BY u.department NULLS LAST, u.name`, params
  );
  res.json(r.rows);
}));

// 회사 기본 초기 비밀번호는 FND 환경변수 INITIAL_PASSWORD (저장소는 공개이므로 코드에 두지 않음)
const defaultPassword = () => process.env.INITIAL_PASSWORD || null;
function tempPassword() {
  return 'Fh' + crypto.randomBytes(5).toString('base64url') + '!7';
}

app.post('/api/users', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  const email = String(b.email || '').trim().toLowerCase();
  if (!email.endsWith(DOMAIN)) throw bad('이메일은 @cafefrihet.com 계정이어야 합니다');
  if (!str(b.name)) throw bad('이름은 필수입니다');
  const pw = str(b.password) || defaultPassword() || tempPassword();
  const hash = await bcrypt.hash(pw, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query(
      `INSERT INTO users(email,name,nickname,department,position,role,password_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [email, str(b.name), str(b.nickname), str(b.department), str(b.position), b.role === 'admin' ? 'admin' : 'user', hash]
    );
    if (b.vehicle && str(b.vehicle.plate)) {
      await insertVehicle(client, u.rows[0].id, b.vehicle);
    }
    await client.query('COMMIT');
    res.json({ id: u.rows[0].id, temp_password: pw, is_default: !str(b.password) && !!defaultPassword() });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') throw bad('이미 등록된 이메일입니다');
    throw e;
  } finally { client.release(); }
}));

app.put('/api/users/:id', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  const email = String(b.email || '').trim().toLowerCase();
  if (!email.endsWith(DOMAIN)) throw bad('이메일은 @cafefrihet.com 계정이어야 합니다');
  await q(
    'UPDATE users SET email=$1,name=$2,nickname=$3,department=$4,position=$5,role=$6,team_card=COALESCE($8,team_card) WHERE id=$7',
    [email, str(b.name), str(b.nickname), str(b.department), str(b.position), b.role === 'admin' ? 'admin' : 'user', int(req.params.id),
      b.team_card === undefined ? null : String(b.team_card).trim()]
  );
  res.json({ ok: true });
}));

// 퇴사: 접속차단(기록 보존) / 복구
app.post('/api/users/:id/deactivate', auth, admin, wrap(async (req, res) => {
  if (int(req.params.id) === req.user.id) throw bad('본인 계정은 차단할 수 없습니다');
  await q('UPDATE users SET active=false, deactivated_at=now(), token_version=token_version+1 WHERE id=$1', [int(req.params.id)]);
  res.json({ ok: true });
}));
app.post('/api/users/:id/activate', auth, admin, wrap(async (req, res) => {
  await q('UPDATE users SET active=true, deactivated_at=NULL WHERE id=$1', [int(req.params.id)]);
  res.json({ ok: true });
}));
app.post('/api/users/:id/reset-password', auth, admin, wrap(async (req, res) => {
  const pw = defaultPassword() || tempPassword();
  await q('UPDATE users SET password_hash=$1, must_change_password=true, token_version=token_version+1 WHERE id=$2',
    [await bcrypt.hash(pw, 10), int(req.params.id)]);
  res.json({ temp_password: pw, is_default: !!defaultPassword() });
}));

// ---------- 차량 ----------
async function resolveEfficiency(db, v) {
  let eff = num(v.efficiency_km_l);
  if (!eff && str(v.model)) {
    const m = await db.query('SELECT efficiency_km_l FROM vehicle_models WHERE lower(model)=lower($1)', [str(v.model)]);
    if (m.rows[0]) eff = Number(m.rows[0].efficiency_km_l);
  }
  return eff;
}
async function insertVehicle(db, userId, v) {
  const fuel = FUEL_TYPES.includes(v.fuel_type) ? v.fuel_type : 'gasoline';
  const eff = await resolveEfficiency(db, v);
  const r = await db.query(
    `INSERT INTO vehicles(user_id,ownership,plate,model,fuel_type,efficiency_km_l) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
    [userId, v.ownership === 'corporate' ? 'corporate' : 'personal', str(v.plate), str(v.model), fuel, eff]
  );
  return r.rows[0];
}

app.get('/api/vehicles', auth, wrap(async (req, res) => {
  const r = await q(
    `SELECT v.*, u.name AS user_name, u.nickname AS user_nickname, u.department
     FROM vehicles v LEFT JOIN users u ON u.id=v.user_id
     ${isAdmin(req) ? '' : 'WHERE v.user_id=$1'} ORDER BY v.active DESC, u.name, v.plate`,
    isAdmin(req) ? [] : [req.user.id]
  );
  res.json(r.rows);
}));
app.post('/api/vehicles', auth, wrap(async (req, res) => {
  const userId = targetUserId(req, req.body.user_id);
  if (!str(req.body.plate)) throw bad('차량번호는 필수입니다');
  res.json(await insertVehicle(pool, userId, req.body));
}));
app.put('/api/vehicles/:id', auth, wrap(async (req, res) => {
  const cur = await q('SELECT * FROM vehicles WHERE id=$1', [int(req.params.id)]);
  if (!cur.rows[0]) throw bad('차량 없음', 404);
  assertOwner(req, cur.rows[0].user_id);
  const v = req.body;
  const eff = await resolveEfficiency(pool, v);
  await q(
    `UPDATE vehicles SET ownership=$1,plate=$2,model=$3,fuel_type=$4,efficiency_km_l=$5,active=$6,user_id=$7 WHERE id=$8`,
    [v.ownership === 'corporate' ? 'corporate' : 'personal', str(v.plate), str(v.model),
      FUEL_TYPES.includes(v.fuel_type) ? v.fuel_type : 'gasoline', eff, v.active !== false,
      isAdmin(req) && v.user_id ? int(v.user_id) : cur.rows[0].user_id, int(req.params.id)]
  );
  res.json({ ok: true });
}));

// 공식연비 기준표 (관리자 등록 → 차종 입력 시 자동 반영)
app.get('/api/vehicle-models', auth, wrap(async (req, res) => {
  res.json((await q('SELECT * FROM vehicle_models ORDER BY model')).rows);
}));
app.post('/api/vehicle-models', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  if (!str(b.model) || !num(b.efficiency_km_l)) throw bad('차종과 공식연비는 필수입니다');
  await q(
    `INSERT INTO vehicle_models(model,fuel_type,efficiency_km_l,source) VALUES($1,$2,$3,$4)
     ON CONFLICT (model) DO UPDATE SET fuel_type=EXCLUDED.fuel_type, efficiency_km_l=EXCLUDED.efficiency_km_l, source=EXCLUDED.source`,
    [str(b.model), FUEL_TYPES.includes(b.fuel_type) ? b.fuel_type : 'gasoline', num(b.efficiency_km_l), str(b.source)]
  );
  res.json({ ok: true });
}));
app.delete('/api/vehicle-models/:id', auth, admin, wrap(async (req, res) => {
  await q('DELETE FROM vehicle_models WHERE id=$1', [int(req.params.id)]);
  res.json({ ok: true });
}));

// ---------- 차량 정비 상태 / 알림 ----------
// 기준값은 회사 운영 기준(설정에서 변경). 제조사 권장 주기가 아님.
const MAINT_DEFAULTS = { oil_km: 10000, oil_months: 12, tire_km: 20000, tire_months: 0, due_soon_pct: 85 };
async function maintRules() {
  const r = await q("SELECT key,value FROM settings WHERE key = ANY($1)", [Object.keys(MAINT_DEFAULTS).map((k) => 'rule_' + k)]);
  const out = { ...MAINT_DEFAULTS };
  for (const row of r.rows) { const n = Number(row.value); if (Number.isFinite(n) && n >= 0) out[row.key.slice(5)] = n; }
  return out;
}
const monthsBetween = (a, b) => {
  const d1 = new Date(a + 'T00:00:00Z'), d2 = new Date(b + 'T00:00:00Z');
  return Math.round(((d2 - d1) / (30.4375 * 864e5)) * 10) / 10;
};
async function vehicleStatus(v, rules, today) {
  const recent = (await q(`SELECT maint_date, maint_type, description, odometer_km FROM maintenance WHERE vehicle_id=$1 ORDER BY maint_date DESC, id DESC LIMIT 1`, [v.id])).rows[0] || null;
  const odo = (await q(`SELECT maint_date, odometer_km FROM maintenance WHERE vehicle_id=$1 AND odometer_km IS NOT NULL ORDER BY maint_date DESC, id DESC LIMIT 1`, [v.id])).rows[0] || null;
  const kmSince = async (date) => Number((await q('SELECT COALESCE(sum(distance_km),0) s FROM trips WHERE vehicle_id=$1 AND trip_date > $2', [v.id, date])).rows[0].s);
  let estOdo = null;
  if (odo) estOdo = Math.round(Number(odo.odometer_km) + (await kmSince(odo.maint_date)));
  const firstTrip = (await q('SELECT min(trip_date) d FROM trips WHERE vehicle_id=$1', [v.id])).rows[0].d;

  const check = async (kind, label, sql, kmLimit, monthLimit) => {
    const last = (await q(`SELECT maint_date, description, odometer_km FROM maintenance WHERE vehicle_id=$1 AND (${sql}) ORDER BY maint_date DESC, id DESC LIMIT 1`, [v.id])).rows[0];
    if (!last) {
      return { kind, label, level: 'unknown', title: `${label} 이력 없음 · 확인 필요`,
        reason: `관리·점검일지에 ${label} 기록이 없습니다. 마지막 교체 시점을 확인해 기록하세요.${firstTrip ? ` (이 차량 웹 운행기록 시작: ${firstTrip})` : ''}` };
    }
    let used = null; let basis;
    if (last.odometer_km && estOdo != null && estOdo >= last.odometer_km) {
      used = estOdo - last.odometer_km; basis = `교체 시 계기판 ${Number(last.odometer_km).toLocaleString()}km → 현재 추정 ${estOdo.toLocaleString()}km`;
    } else {
      used = Math.round(await kmSince(last.maint_date)); basis = `교체일 이후 운행일지 합산 ${used.toLocaleString()}km (업무 운행만 집계)`;
    }
    const months = monthsBetween(last.maint_date, today);
    const pctKm = kmLimit ? used / kmLimit : 0;
    const pctMo = monthLimit ? months / monthLimit : 0;
    const pct = Math.max(pctKm, pctMo);
    const level = pct >= 1 ? 'overdue' : pct * 100 >= rules.due_soon_pct ? 'soon' : 'ok';
    const limits = [kmLimit ? `${kmLimit.toLocaleString()}km` : null, monthLimit ? `${monthLimit}개월` : null].filter(Boolean).join(' 또는 ');
    const title = level === 'overdue' ? `${label} 교체 필요` : level === 'soon' ? `${label} 교체 임박` : `${label} 정상`;
    return { kind, label, level, title, last_date: last.maint_date, last_desc: last.description, used_km: used, months, pct: Math.round(pct * 100),
      reason: `마지막 ${label}: ${last.maint_date} (${String(last.description || '').replace(/\s+/g, ' ').slice(0, 40)}) · ${basis} · ${months}개월 경과 · 기준 ${limits} 대비 ${Math.round(pct * 100)}%` };
  };
  const oil = await check('oil', '엔진오일', "maint_type='엔진오일' OR description ILIKE '%엔진%오일%'", rules.oil_km, rules.oil_months);
  const tire = await check('tire', '타이어', "(maint_type='타이어' OR description ILIKE '%타이어%') AND description ~ '(교체|교환)' AND description !~ '(위치|공기)'", rules.tire_km, rules.tire_months);
  const due = (await q(`SELECT maint_date, maint_type, next_due_date, next_due_km FROM maintenance WHERE vehicle_id=$1 AND (next_due_date IS NOT NULL OR next_due_km IS NOT NULL) ORDER BY maint_date DESC, id DESC LIMIT 1`, [v.id])).rows[0];
  const alerts = [oil, tire];
  if (due) {
    const soonDate = due.next_due_date && monthsBetween(today, due.next_due_date) <= 0.5;
    const soonKm = due.next_due_km && estOdo != null && estOdo >= due.next_due_km - 500;
    if (soonDate || soonKm) alerts.push({ kind: 'next', label: '예약 점검', level: 'soon', title: '다음 점검 예정',
      reason: `${due.maint_date} ${due.maint_type} 기록의 다음 점검: ${due.next_due_date || ''}${due.next_due_km ? ' / ' + Number(due.next_due_km).toLocaleString() + 'km' : ''}` });
  }
  const rank = { overdue: 3, unknown: 2, soon: 1, ok: 0 };
  const worst = alerts.reduce((a, x) => (rank[x.level] > rank[a] ? x.level : a), 'ok');
  return { vehicle_id: v.id, est_odometer: estOdo, odometer_basis: odo ? `${odo.maint_date} 계기판 ${Number(odo.odometer_km).toLocaleString()}km + 이후 운행일지` : null,
    recent, alerts, worst };
}
app.get('/api/vehicle-status', auth, wrap(async (req, res) => {
  const rules = await maintRules();
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const vs = (await q(`SELECT * FROM vehicles ${isAdmin(req) ? '' : 'WHERE user_id=$1'} ORDER BY id`, isAdmin(req) ? [] : [req.user.id])).rows;
  const want = req.query.ids ? String(req.query.ids).split(',').map(int) : null;
  const out = [];
  for (const v of vs) if (!want || want.includes(v.id)) out.push(await vehicleStatus(v, rules, today));
  res.json({ rules, items: out });
}));

// ---------- 외부 연동 ----------
app.get('/api/places', auth, wrap(async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 1) return res.json([]);
  res.json(await ext.searchPlaces(query));
}));
app.get('/api/route', auth, wrap(async (req, res) => {
  const { sx, sy, ex, ey } = req.query;
  if ([sx, sy, ex, ey].some((v) => !Number.isFinite(Number(v)))) throw bad('좌표가 올바르지 않습니다');
  res.json(await ext.route(Number(sx), Number(sy), Number(ex), Number(ey)));
}));
app.get('/api/fuel-price', auth, wrap(async (req, res) => {
  res.json(await ext.fuelPrice(String(req.query.type || 'gasoline')));
}));

// ---------- 사진 ----------
async function savePhotos(ownerType, ownerId, files, userId) {
  for (const f of files || []) {
    await q('INSERT INTO photos(owner_type,owner_id,filename,mime,size,data,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [ownerType, ownerId, Buffer.from(f.originalname, 'latin1').toString('utf8'), f.mimetype, f.size, f.buffer, userId]);
  }
}
async function photoList(ownerType, ids) {
  if (!ids.length) return {};
  const r = await q('SELECT id,owner_id,filename,mime FROM photos WHERE owner_type=$1 AND owner_id = ANY($2) ORDER BY id', [ownerType, ids]);
  const map = {};
  for (const p of r.rows) (map[p.owner_id] ||= []).push({ id: p.id, filename: p.filename, mime: p.mime });
  return map;
}
app.get('/api/photos/:id', auth, wrap(async (req, res) => {
  const r = await q('SELECT * FROM photos WHERE id=$1', [int(req.params.id)]);
  const p = r.rows[0];
  if (!p) throw bad('사진 없음', 404);
  if (!isAdmin(req)) {
    const table = p.owner_type === 'expense' ? 'expenses' : 'maintenance';
    const o = await q(`SELECT user_id FROM ${table} WHERE id=$1`, [p.owner_id]);
    if (o.rows[0]?.user_id !== req.user.id) throw bad('권한 없음', 403);
  }
  res.set('Content-Type', p.mime);
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(p.data);
}));
app.delete('/api/photos/:id', auth, wrap(async (req, res) => {
  const r = await q('SELECT * FROM photos WHERE id=$1', [int(req.params.id)]);
  const p = r.rows[0];
  if (!p) throw bad('사진 없음', 404);
  if (!isAdmin(req) && p.uploaded_by !== req.user.id) throw bad('권한 없음', 403);
  await q('DELETE FROM photos WHERE id=$1', [p.id]);
  res.json({ ok: true });
}));

// ---------- 기간 필터 ----------
function period(req) {
  const from = isDate(req.query.from) ? req.query.from : '2000-01-01';
  const to = isDate(req.query.to) ? req.query.to : '2999-12-31';
  return { from, to };
}

// ---------- 운행일지 ----------
app.get('/api/trips', auth, wrap(async (req, res) => {
  const { from, to } = period(req);
  const uid = targetUserId(req, req.query.user_id);
  const r = await q(
    `SELECT t.*, v.plate, v.ownership FROM trips t LEFT JOIN vehicles v ON v.id=t.vehicle_id
     WHERE t.user_id=$1 AND t.trip_date BETWEEN $2 AND $3 ORDER BY t.trip_date DESC, t.id DESC`, [uid, from, to]
  );
  res.json(r.rows);
}));

async function tripValues(req, b, userId) {
  if (!isDate(b.trip_date)) throw bad('운행일자를 입력하세요');
  let vehicle = null;
  if (b.vehicle_id) {
    vehicle = (await q('SELECT * FROM vehicles WHERE id=$1', [int(b.vehicle_id)])).rows[0];
    if (!vehicle) throw bad('차량을 찾을 수 없습니다');
    if (!isAdmin(req) && vehicle.user_id !== userId) throw bad('본인 차량만 선택할 수 있습니다', 403);
  }
  const distance = num(b.distance_km, 0);
  const efficiency = num(b.efficiency_km_l) ?? (vehicle ? num(vehicle.efficiency_km_l) : null);
  const price = num(b.fuel_price_won);
  const fuelCost = b.fuel_cost_won !== undefined && b.fuel_cost_manual ? int(b.fuel_cost_won) : calcFuelCost(distance, efficiency, price);
  return [
    userId, vehicle?.id || null, b.trip_date, str(b.purpose),
    str(b.start_name), str(b.start_addr), num(b.start_x), num(b.start_y),
    str(b.end_name), str(b.end_addr), num(b.end_x), num(b.end_y),
    !!b.round_trip, distance, int(b.toll_won), price, efficiency, fuelCost, int(b.parking_won), str(b.memo),
  ];
}
const TRIP_COLS = 'user_id,vehicle_id,trip_date,purpose,start_name,start_addr,start_x,start_y,end_name,end_addr,end_x,end_y,round_trip,distance_km,toll_won,fuel_price_won,efficiency_km_l,fuel_cost_won,parking_won,memo';

app.post('/api/trips', auth, wrap(async (req, res) => {
  const uid = targetUserId(req, req.body.user_id);
  const vals = await tripValues(req, req.body, uid);
  const ph = vals.map((_, i) => '$' + (i + 1)).join(',');
  const r = await q(`INSERT INTO trips(${TRIP_COLS}) VALUES(${ph}) RETURNING *`, vals);
  res.json(r.rows[0]);
}));
app.put('/api/trips/:id', auth, wrap(async (req, res) => {
  const cur = (await q('SELECT * FROM trips WHERE id=$1', [int(req.params.id)])).rows[0];
  if (!cur) throw bad('기록 없음', 404);
  assertOwner(req, cur.user_id);
  const vals = await tripValues(req, req.body, cur.user_id);
  const set = TRIP_COLS.split(',').map((c, i) => `${c}=$${i + 1}`).join(',');
  await q(`UPDATE trips SET ${set} WHERE id=$${vals.length + 1}`, [...vals, cur.id]);
  res.json({ ok: true });
}));
app.delete('/api/trips/:id', auth, wrap(async (req, res) => {
  const cur = (await q('SELECT * FROM trips WHERE id=$1', [int(req.params.id)])).rows[0];
  if (!cur) throw bad('기록 없음', 404);
  assertOwner(req, cur.user_id);
  await q('DELETE FROM trips WHERE id=$1', [cur.id]);
  res.json({ ok: true });
}));

// ---------- 하루 단위 일괄 등록 (여러 구간 운행 + 법인/개인 카드 사용 + 건별 사진) ----------
app.post('/api/day', auth, dayUpload.any(), wrap(async (req, res) => {
  let b;
  try { b = JSON.parse(req.body.payload || '{}'); } catch { throw bad('요청 형식 오류'); }
  if (!isDate(b.date)) throw bad('운행일자를 입력하세요');
  const uid = targetUserId(req, b.user_id);
  const book = await resolveBook(req, b.book, uid);
  if (book === 'team') { b.legs = []; (b.expenses || []).forEach((e) => (e.card_type = 'corporate')); }
  const legs = (b.legs || []).filter((l) => str(l.start_name) || str(l.end_name) || num(l.distance_km));
  const exps = (b.expenses || []).filter((e) => int(e.amount));
  if (!legs.length && !exps.length) throw bad('운행 구간 또는 카드 사용 내역을 1건 이상 입력하세요');
  const tripVals = [];
  for (const l of legs) {
    tripVals.push(await tripValues(req, { ...l, trip_date: b.date, vehicle_id: b.vehicle_id, fuel_price_won: b.fuel_price_won, efficiency_km_l: b.efficiency_km_l }, uid));
  }
  const expVals = exps.map((e) => ({ v: expenseValues({ ...e, expense_date: b.date, vehicle_id: b.vehicle_id }, uid), key: e.key }));
  const client = await pool.connect();
  const out = { trips: 0, expenses: 0, photos: 0 };
  try {
    await client.query('BEGIN');
    const ph = (n) => Array.from({ length: n }, (_, i) => '$' + (i + 1)).join(',');
    for (const v of tripVals) { await client.query(`INSERT INTO trips(${TRIP_COLS}) VALUES(${ph(v.length)})`, v); out.trips++; }
    for (const { v, key } of expVals) {
      const r = await client.query('INSERT INTO expenses(user_id,vehicle_id,expense_date,card_type,category,purpose,amount,memo,book) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [...v, book]);
      out.expenses++;
      for (const f of (req.files || []).filter((x) => x.fieldname === 'photo_' + key)) {
        await client.query('INSERT INTO photos(owner_type,owner_id,filename,mime,size,data,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
          ['expense', r.rows[0].id, Buffer.from(f.originalname, 'latin1').toString('utf8'), f.mimetype, f.size, f.buffer, req.user.id]);
        out.photos++;
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  res.json(out);
}));

// ---------- 카드 사용 내역 ----------
app.get('/api/expenses', auth, wrap(async (req, res) => {
  const { from, to } = period(req);
  const uid = targetUserId(req, req.query.user_id);
  const r = await q(
    `SELECT e.*, v.plate FROM expenses e LEFT JOIN vehicles v ON v.id=e.vehicle_id
     WHERE e.user_id=$1 AND e.expense_date BETWEEN $2 AND $3 AND e.book=$4 ORDER BY e.expense_date DESC, e.id DESC`, [uid, from, to, req.query.book === 'team' ? 'team' : 'drive']
  );
  const photos = await photoList('expense', r.rows.map((x) => x.id));
  res.json(r.rows.map((x) => ({ ...x, photos: photos[x.id] || [] })));
}));
function expenseValues(b, userId) {
  if (!isDate(b.expense_date)) throw bad('사용일자를 입력하세요');
  if (!CARD_TYPES.includes(b.card_type)) throw bad('법인카드/개인카드를 선택하세요');
  if (!int(b.amount)) throw bad('금액을 입력하세요');
  return [userId, b.vehicle_id ? int(b.vehicle_id) : null, b.expense_date, b.card_type, str(b.category) || '기타', str(b.purpose), int(b.amount), str(b.memo)];
}
app.post('/api/expenses', auth, upload.array('photos', 10), wrap(async (req, res) => {
  const uid = targetUserId(req, req.body.user_id);
  const book = await resolveBook(req, req.body.book, uid);
  if (book === 'team') req.body.card_type = 'corporate';
  const r = await q(
    'INSERT INTO expenses(user_id,vehicle_id,expense_date,card_type,category,purpose,amount,memo,book) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
    [...expenseValues(req.body, uid), book]
  );
  await savePhotos('expense', r.rows[0].id, req.files, req.user.id);
  res.json({ id: r.rows[0].id });
}));
app.put('/api/expenses/:id', auth, upload.array('photos', 10), wrap(async (req, res) => {
  const cur = (await q('SELECT * FROM expenses WHERE id=$1', [int(req.params.id)])).rows[0];
  if (!cur) throw bad('기록 없음', 404);
  assertOwner(req, cur.user_id);
  if (cur.book === 'team') req.body.card_type = 'corporate';
  const v = expenseValues(req.body, cur.user_id);
  await q('UPDATE expenses SET user_id=$1,vehicle_id=$2,expense_date=$3,card_type=$4,category=$5,purpose=$6,amount=$7,memo=$8 WHERE id=$9',
    [...v, cur.id]);
  await savePhotos('expense', cur.id, req.files, req.user.id);
  res.json({ ok: true });
}));
app.delete('/api/expenses/:id', auth, wrap(async (req, res) => {
  const cur = (await q('SELECT * FROM expenses WHERE id=$1', [int(req.params.id)])).rows[0];
  if (!cur) throw bad('기록 없음', 404);
  assertOwner(req, cur.user_id);
  await q("DELETE FROM photos WHERE owner_type='expense' AND owner_id=$1", [cur.id]);
  await q('DELETE FROM expenses WHERE id=$1', [cur.id]);
  res.json({ ok: true });
}));

// ---------- 법인카드 사용 관리 (관리자) ----------
app.get('/api/leads', auth, wrap(async (req, res) => {
  const r = await q(`SELECT id,name,nickname,department,position,active,team_card FROM users WHERE (team_card IS NOT NULL AND team_card<>'' OR position LIKE '%팀장%') ${isAdmin(req) ? '' : 'AND id=$1'} ORDER BY department NULLS LAST, name`, isAdmin(req) ? [] : [req.user.id]);
  res.json(r.rows.map((u) => ({ ...u, card_label: cardLabel(u) })));
}));
app.get('/api/card-stats', auth, admin, wrap(async (req, res) => {
  const { from, to } = period(req);
  const book = ['drive', 'team'].includes(req.query.book) ? req.query.book : 'all';
  const cond = `e.card_type='corporate' AND e.expense_date BETWEEN $1 AND $2 ${book === 'all' ? '' : `AND e.book='${book}'`}`;
  const users = await q(`SELECT u.id,u.name,u.nickname,u.department,u.position,u.active,
      count(*)::int cnt, sum(e.amount)::int amount,
      sum(e.amount) FILTER (WHERE e.book='drive')::int drive_amount, sum(e.amount) FILTER (WHERE e.book='team')::int team_amount,
      (SELECT count(*) FROM photos p WHERE p.owner_type='expense' AND p.owner_id = ANY(array_agg(e.id)))::int photos
    FROM expenses e JOIN users u ON u.id=e.user_id WHERE ${cond} GROUP BY u.id ORDER BY amount DESC`, [from, to]);
  const cats = await q(`SELECT e.category, count(*)::int cnt, sum(e.amount)::int amount FROM expenses e WHERE ${cond} GROUP BY 1 ORDER BY 3 DESC`, [from, to]);
  const months = await q(`SELECT to_char(e.expense_date,'YYYY-MM') ym, sum(e.amount)::int amount,
      COALESCE(sum(e.amount) FILTER (WHERE e.book='drive'),0)::int drive_amount, COALESCE(sum(e.amount) FILTER (WHERE e.book='team'),0)::int team_amount
    FROM expenses e WHERE ${cond} GROUP BY 1 ORDER BY 1`, [from, to]);
  const items = await q(`SELECT e.id,e.expense_date,e.category,e.purpose,e.amount,e.book,e.memo,u.name,u.nickname FROM expenses e JOIN users u ON u.id=e.user_id
    WHERE ${cond} ORDER BY e.expense_date DESC, e.id DESC LIMIT 300`, [from, to]);
  const ph = await photoList('expense', items.rows.map((x) => x.id));
  res.json({ from, to, book, users: users.rows, categories: cats.rows, monthly: months.rows,
    items: items.rows.map((x) => ({ ...x, photos: ph[x.id] || [] })) });
}));

// ---------- 차량관리·점검일지 ----------
app.get('/api/maintenance', auth, wrap(async (req, res) => {
  const { from, to } = period(req);
  const vid = int(req.query.vehicle_id);
  const v = (await q('SELECT * FROM vehicles WHERE id=$1', [vid])).rows[0];
  if (!v) throw bad('차량 없음', 404);
  if (!isAdmin(req) && v.user_id !== req.user.id) throw bad('권한 없음', 403);
  const r = await q(
    `SELECT m.*, u.name AS user_name FROM maintenance m LEFT JOIN users u ON u.id=m.user_id
     WHERE m.vehicle_id=$1 AND m.maint_date BETWEEN $2 AND $3 ORDER BY m.maint_date DESC, m.id DESC`, [vid, from, to]
  );
  const photos = await photoList('maintenance', r.rows.map((x) => x.id));
  res.json(r.rows.map((x) => ({ ...x, photos: photos[x.id] || [] })));
}));
async function maintValues(req, b) {
  if (!isDate(b.maint_date)) throw bad('일자를 입력하세요');
  const v = (await q('SELECT * FROM vehicles WHERE id=$1', [int(b.vehicle_id)])).rows[0];
  if (!v) throw bad('차량을 선택하세요');
  if (!isAdmin(req) && v.user_id !== req.user.id) throw bad('본인 차량만 기록할 수 있습니다', 403);
  return [v.id, v.user_id ?? req.user.id, b.maint_date, str(b.maint_type) || '점검', b.odometer_km ? int(b.odometer_km) : null,
    str(b.description), str(b.vendor), int(b.amount), CARD_TYPES.includes(b.card_type) ? b.card_type : null,
    isDate(b.next_due_date) ? b.next_due_date : null, b.next_due_km ? int(b.next_due_km) : null, str(b.memo)];
}
const MAINT_COLS = 'vehicle_id,user_id,maint_date,maint_type,odometer_km,description,vendor,amount,card_type,next_due_date,next_due_km,memo';
app.post('/api/maintenance', auth, upload.array('photos', 10), wrap(async (req, res) => {
  const vals = await maintValues(req, req.body);
  const ph = vals.map((_, i) => '$' + (i + 1)).join(',');
  const r = await q(`INSERT INTO maintenance(${MAINT_COLS}) VALUES(${ph}) RETURNING id`, vals);
  await savePhotos('maintenance', r.rows[0].id, req.files, req.user.id);
  res.json({ id: r.rows[0].id });
}));
app.put('/api/maintenance/:id', auth, upload.array('photos', 10), wrap(async (req, res) => {
  const cur = (await q('SELECT * FROM maintenance WHERE id=$1', [int(req.params.id)])).rows[0];
  if (!cur) throw bad('기록 없음', 404);
  assertOwner(req, cur.user_id);
  const vals = await maintValues(req, req.body);
  const set = MAINT_COLS.split(',').map((c, i) => `${c}=$${i + 1}`).join(',');
  await q(`UPDATE maintenance SET ${set} WHERE id=$${vals.length + 1}`, [...vals, cur.id]);
  await savePhotos('maintenance', cur.id, req.files, req.user.id);
  res.json({ ok: true });
}));
app.delete('/api/maintenance/:id', auth, wrap(async (req, res) => {
  const cur = (await q('SELECT * FROM maintenance WHERE id=$1', [int(req.params.id)])).rows[0];
  if (!cur) throw bad('기록 없음', 404);
  assertOwner(req, cur.user_id);
  await q("DELETE FROM photos WHERE owner_type='maintenance' AND owner_id=$1", [cur.id]);
  await q('DELETE FROM maintenance WHERE id=$1', [cur.id]);
  res.json({ ok: true });
}));

// ---------- 통합 합계 ----------
app.get('/api/summary', auth, wrap(async (req, res) => {
  const { from, to } = period(req);
  let ids = null;
  if (!isAdmin(req)) ids = [req.user.id];
  else if (req.query.user_ids) ids = String(req.query.user_ids).split(',').map(int).filter(Boolean);
  const userFilter = ids ? 'AND u.id = ANY($3)' : '';
  const params = ids ? [from, to, ids] : [from, to];

  const perUser = await q(`
    WITH t AS (SELECT user_id, count(*) cnt, sum(distance_km) km, sum(toll_won) toll, sum(fuel_cost_won) fuel, sum(parking_won) parking
               FROM trips WHERE trip_date BETWEEN $1 AND $2 GROUP BY user_id),
         e AS (SELECT user_id,
                 sum(amount) FILTER (WHERE card_type='corporate') corp,
                 sum(amount) FILTER (WHERE card_type='personal') personal,
                 sum(amount) FILTER (WHERE category IN ('주유','주유비')) fueling,
                 count(*) cnt
               FROM expenses WHERE expense_date BETWEEN $1 AND $2 AND book='drive' GROUP BY user_id),
         m AS (SELECT user_id, sum(amount) amt, count(*) cnt FROM maintenance WHERE maint_date BETWEEN $1 AND $2 GROUP BY user_id)
    SELECT u.id, u.name, u.nickname, u.department, u.position, u.active,
      COALESCE(t.cnt,0)::int trip_count, COALESCE(t.km,0)::float distance_km, COALESCE(t.toll,0)::int toll_won,
      COALESCE(t.fuel,0)::int fuel_cost_won, COALESCE(t.parking,0)::int parking_won,
      (COALESCE(t.fuel,0)+COALESCE(t.toll,0)+COALESCE(t.parking,0))::int operating_cost_won,
      COALESCE(e.corp,0)::int corporate_card_won, COALESCE(e.personal,0)::int personal_card_won,
      COALESCE(e.fueling,0)::int fueling_won, COALESCE(e.cnt,0)::int expense_count,
      COALESCE(m.amt,0)::int maintenance_won, COALESCE(m.cnt,0)::int maintenance_count
    FROM users u LEFT JOIN t ON t.user_id=u.id LEFT JOIN e ON e.user_id=u.id LEFT JOIN m ON m.user_id=u.id
    WHERE (u.active OR t.cnt IS NOT NULL OR e.cnt IS NOT NULL) AND COALESCE(u.position,'') NOT LIKE '%대표%' ${userFilter}
    ORDER BY u.department NULLS LAST, u.name`, params);

  const monthly = await q(`
    WITH months AS (
      SELECT user_id, to_char(trip_date,'YYYY-MM') ym, sum(distance_km) km, sum(fuel_cost_won) fuel, sum(toll_won) toll,
             sum(parking_won) parking, 0 corp, 0 personal, 0 fueling
        FROM trips WHERE trip_date BETWEEN $1 AND $2 GROUP BY 1,2
      UNION ALL
      SELECT user_id, to_char(expense_date,'YYYY-MM'), 0,0,0,0,
             sum(amount) FILTER (WHERE card_type='corporate'), sum(amount) FILTER (WHERE card_type='personal'),
             sum(amount) FILTER (WHERE category IN ('주유','주유비'))
        FROM expenses WHERE expense_date BETWEEN $1 AND $2 AND book='drive' GROUP BY 1,2)
    SELECT ym, sum(km)::float distance_km, sum(fuel)::int fuel_cost_won, sum(toll)::int toll_won,
      (sum(fuel)+sum(toll)+sum(parking))::int operating_cost_won,
      COALESCE(sum(corp),0)::int corporate_card_won, COALESCE(sum(personal),0)::int personal_card_won,
      COALESCE(sum(fueling),0)::int fueling_won
    FROM months JOIN users u ON u.id=months.user_id WHERE COALESCE(u.position,'') NOT LIKE '%대표%' ${userFilter}
    GROUP BY ym ORDER BY ym`, params);

  res.json({ from, to, users: perUser.rows, monthly: monthly.rows });
}));

// ---------- 부서팀장 법인카드 합계관리 ----------
app.get('/api/team-summary', auth, wrap(async (req, res) => {
  const { from, to } = period(req);
  const holders = (await q(`SELECT id,name,nickname,department,position,active,team_card FROM users
    WHERE (team_card IS NOT NULL AND team_card<>'' OR position LIKE '%팀장%') ORDER BY department NULLS LAST, name`)).rows
    .filter((u) => isAdmin(req) || u.id === req.user.id);
  const ids = holders.map((u) => u.id);
  if (!ids.length) return res.json({ from, to, users: [], categories: [], monthly: [] });
  const per = (await q(`SELECT user_id, category, count(*)::int cnt, sum(amount)::int amount FROM expenses
    WHERE book='team' AND expense_date BETWEEN $1 AND $2 AND user_id = ANY($3) GROUP BY 1,2`, [from, to, ids])).rows;
  const ph = (await q(`SELECT e.user_id, count(p.id)::int n FROM expenses e JOIN photos p ON p.owner_type='expense' AND p.owner_id=e.id
    WHERE e.book='team' AND e.expense_date BETWEEN $1 AND $2 AND e.user_id = ANY($3) GROUP BY 1`, [from, to, ids])).rows;
  const monthly = (await q(`SELECT to_char(expense_date,'YYYY-MM') ym, sum(amount)::int amount, count(*)::int cnt FROM expenses
    WHERE book='team' AND expense_date BETWEEN $1 AND $2 AND user_id = ANY($3) GROUP BY 1 ORDER BY 1`, [from, to, ids])).rows;
  const cats = [...new Set(per.map((x) => x.category))];
  const users = holders.map((u) => {
    const rows = per.filter((x) => x.user_id === u.id);
    const by = {}; rows.forEach((x) => (by[x.category] = x.amount));
    return { ...u, card_label: u.team_card || '팀장카드', cnt: rows.reduce((a, x) => a + x.cnt, 0), amount: rows.reduce((a, x) => a + x.amount, 0),
      photos: (ph.find((x) => x.user_id === u.id) || {}).n || 0, by };
  });
  res.json({ from, to, users, categories: cats, monthly });
}));

// ---------- 설정 (관리자) ----------
const SETTING_KEYS = ['kakao_rest_key', 'kakao_js_key', 'opinet_key', 'price_gasoline', 'price_diesel', 'price_lpg', 'price_ev', 'rule_oil_km', 'rule_oil_months', 'rule_tire_km', 'rule_tire_months', 'rule_due_soon_pct'];
const SECRET_KEYS = ['kakao_rest_key', 'opinet_key'];
app.get('/api/settings', auth, admin, wrap(async (req, res) => {
  const r = await q('SELECT key,value FROM settings WHERE key = ANY($1)', [SETTING_KEYS]);
  const out = {};
  for (const k of SETTING_KEYS) {
    const row = r.rows.find((x) => x.key === k);
    const envSet = (k === 'kakao_rest_key' && process.env.KAKAO_REST_KEY) || (k === 'opinet_key' && process.env.OPINET_KEY);
    out[k] = SECRET_KEYS.includes(k) ? { set: !!(row?.value || envSet), from_env: !!envSet } : row?.value || '';
  }
  res.json(out);
}));
app.put('/api/settings', auth, admin, wrap(async (req, res) => {
  for (const k of SETTING_KEYS) {
    if (req.body[k] === undefined) continue;
    if (SECRET_KEYS.includes(k) && !String(req.body[k]).trim()) continue; // 빈 값이면 기존 유지
    await q('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, String(req.body[k]).trim()]);
  }
  res.json({ ok: true });
}));
app.get('/api/admin/opinet-test', auth, admin, wrap(async (req, res) => {
  const key = await ext.getSetting('opinet_key');
  if (!key) return res.json({ ok: false, reason: '오피넷 키 미등록' });
  const t = await ext.fetchOpinet(key);
  res.json(t.ok ? { ok: true, prices: t.rows.map((r) => ({ code: r.PRODCD, name: r.PRODNM, price: r.PRICE, date: r.TRADE_DT })) } : t);
}));
app.get('/api/public-config', auth, wrap(async (req, res) => {
  const r = await q("SELECT value FROM settings WHERE key='kakao_js_key'");
  res.json({ kakao_js_key: process.env.KAKAO_JS_KEY || r.rows[0]?.value || null });
}));

// ---------- 기존 엑셀 이관 데이터 적재 (관리자) ----------
// 대용량 패키지는 브라우저에서 4MB 단위로 나눠 전송 (프록시 업로드 한도 회피)
app.post('/api/admin/import-chunk', auth, admin, express.raw({ type: '*/*', limit: '8mb' }), wrap(async (req, res) => {
  const id = String(req.query.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
  const index = int(req.query.index, -1), total = int(req.query.total, 0);
  if (!id || index < 0 || total < 1 || index >= total) throw bad('잘못된 업로드 요청');
  const file = path.join(os.tmpdir(), `fbcl-import-${id}`);
  if (index === 0 && fs.existsSync(file)) fs.unlinkSync(file);
  fs.appendFileSync(file, req.body);
  if (index < total - 1) return res.json({ received: index + 1, total });
  try {
    const { importLegacy } = require('./importer');
    res.json(await importLegacy(fs.readFileSync(file), { dryRun: req.query.dry === 'true' }));
  } finally {
    fs.rmSync(file, { force: true });
  }
}));
app.post('/api/admin/import', auth, admin, xlsxUpload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw bad('이관 데이터 파일을 첨부하세요');
  const { importLegacy } = require('./importer');
  res.json(await importLegacy(req.file.buffer, { dryRun: req.body.dry_run === 'true' }));
}));

// ---------- 엑셀 내보내기 ----------
app.get('/api/export', auth, wrap(async (req, res) => {
  const XLSX = require('xlsx');
  const { from, to } = period(req);
  const uid = targetUserId(req, req.query.user_id);
  const trips = (await q(`SELECT trip_date 일자, purpose 목적, start_name 출발지, end_name 도착지, round_trip 왕복,
      distance_km 운행km, toll_won 통행료, fuel_price_won 유가, efficiency_km_l 연비, fuel_cost_won 연료비, parking_won 주차비, memo 비고
      FROM trips WHERE user_id=$1 AND trip_date BETWEEN $2 AND $3 ORDER BY trip_date`, [uid, from, to])).rows;
  const exps = (await q(`SELECT expense_date 일자, CASE card_type WHEN 'corporate' THEN '법인카드' ELSE '개인카드' END 구분,
      category 항목, purpose 목적, amount 금액, memo 비고 FROM expenses WHERE user_id=$1 AND expense_date BETWEEN $2 AND $3 AND book='drive' ORDER BY expense_date`, [uid, from, to])).rows;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(trips), '운행일지');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exps), '카드사용');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`운행일지_${from}_${to}.xlsx`)}`);
  res.send(buf);
}));

// ---------- static ----------
// 재배포 직후에도 새 화면이 바로 보이도록: index.html은 캐시 금지, js/css는 내용 해시로 버전 부여
const PUB = path.join(__dirname, '..', 'public');
const assetVer = require('crypto').createHash('sha1')
  .update(fs.readFileSync(path.join(PUB, 'app.js'))).update(fs.readFileSync(path.join(PUB, 'style.css')))
  .digest('hex').slice(0, 10);
const indexHtml = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8')
  .replace('/app.js', `/app.js?v=${assetVer}`).replace('/style.css', `/style.css?v=${assetVer}`);
const sendIndex = (req, res) => { res.set('Cache-Control', 'no-cache, no-store, must-revalidate'); res.type('html').send(indexHtml); };
app.get(['/', '/index.html'], sendIndex);
app.use(express.static(PUB, { index: false, maxAge: '30d' }));
app.get(/^\/(?!api\/).*/, sendIndex);

app.use((err, req, res, next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && !err.status ? '서버 오류가 발생했습니다' : err.message, must_change: !!err.mustChange });
});

(async () => {
  await migrate();
  if (!JWT_SECRET) {
    const r = await q("SELECT value FROM settings WHERE key='jwt_secret'");
    JWT_SECRET = r.rows[0]?.value;
    if (!JWT_SECRET) {
      JWT_SECRET = crypto.randomBytes(48).toString('hex');
      await q("INSERT INTO settings(key,value) VALUES('jwt_secret',$1)", [JWT_SECRET]);
    }
  }
  await bootstrap();
  app.listen(PORT, () => console.log(`[frihet-car-log] listening on :${PORT}`));
})().catch((e) => { console.error(e); process.exit(1); });
