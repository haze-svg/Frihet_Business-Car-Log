const path = require('path');
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
  next();
});
const admin = (req, res, next) => (req.user.role === 'admin' ? next() : next(bad('관리자 권한이 필요합니다', 403)));
const isAdmin = (req) => req.user.role === 'admin';
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
    position: u.position, role: u.role, must_change_password: u.must_change_password, vehicles: v.rows,
  });
}));

// ---------- 직원 ----------
app.get('/api/users', auth, wrap(async (req, res) => {
  const where = isAdmin(req) ? (req.query.all ? '' : 'WHERE u.active') : 'WHERE u.id=$1';
  const params = isAdmin(req) ? [] : [req.user.id];
  const r = await q(
    `SELECT u.id,u.email,u.name,u.nickname,u.department,u.position,u.role,u.active,u.deactivated_at,
      COALESCE(json_agg(v ORDER BY v.id) FILTER (WHERE v.id IS NOT NULL),'[]') AS vehicles
     FROM users u LEFT JOIN vehicles v ON v.user_id=u.id AND v.active
     ${where} GROUP BY u.id ORDER BY u.department NULLS LAST, u.name`, params
  );
  res.json(r.rows);
}));

function tempPassword() {
  return 'Fh' + crypto.randomBytes(5).toString('base64url') + '!7';
}

app.post('/api/users', auth, admin, wrap(async (req, res) => {
  const b = req.body;
  const email = String(b.email || '').trim().toLowerCase();
  if (!email.endsWith(DOMAIN)) throw bad('이메일은 @cafefrihet.com 계정이어야 합니다');
  if (!str(b.name)) throw bad('이름은 필수입니다');
  const pw = str(b.password) || tempPassword();
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
    res.json({ id: u.rows[0].id, temp_password: pw });
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
    'UPDATE users SET email=$1,name=$2,nickname=$3,department=$4,position=$5,role=$6 WHERE id=$7',
    [email, str(b.name), str(b.nickname), str(b.department), str(b.position), b.role === 'admin' ? 'admin' : 'user', int(req.params.id)]
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
  const pw = tempPassword();
  await q('UPDATE users SET password_hash=$1, must_change_password=true, token_version=token_version+1 WHERE id=$2',
    [await bcrypt.hash(pw, 10), int(req.params.id)]);
  res.json({ temp_password: pw });
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

// ---------- 외부 연동 ----------
app.get('/api/places', auth, wrap(async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (query.length < 2) return res.json([]);
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

// ---------- 카드 사용 내역 ----------
app.get('/api/expenses', auth, wrap(async (req, res) => {
  const { from, to } = period(req);
  const uid = targetUserId(req, req.query.user_id);
  const r = await q(
    `SELECT e.*, v.plate FROM expenses e LEFT JOIN vehicles v ON v.id=e.vehicle_id
     WHERE e.user_id=$1 AND e.expense_date BETWEEN $2 AND $3 ORDER BY e.expense_date DESC, e.id DESC`, [uid, from, to]
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
  const r = await q(
    'INSERT INTO expenses(user_id,vehicle_id,expense_date,card_type,category,purpose,amount,memo) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
    expenseValues(req.body, uid)
  );
  await savePhotos('expense', r.rows[0].id, req.files, req.user.id);
  res.json({ id: r.rows[0].id });
}));
app.put('/api/expenses/:id', auth, upload.array('photos', 10), wrap(async (req, res) => {
  const cur = (await q('SELECT * FROM expenses WHERE id=$1', [int(req.params.id)])).rows[0];
  if (!cur) throw bad('기록 없음', 404);
  assertOwner(req, cur.user_id);
  const v = expenseValues(req.body, cur.user_id);
  await q('UPDATE expenses SET vehicle_id=$2,expense_date=$3,card_type=$4,category=$5,purpose=$6,amount=$7,memo=$8 WHERE id=$9',
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
                 sum(amount) FILTER (WHERE category='주유') fueling,
                 count(*) cnt
               FROM expenses WHERE expense_date BETWEEN $1 AND $2 GROUP BY user_id),
         m AS (SELECT user_id, sum(amount) amt, count(*) cnt FROM maintenance WHERE maint_date BETWEEN $1 AND $2 GROUP BY user_id)
    SELECT u.id, u.name, u.nickname, u.department, u.position, u.active,
      COALESCE(t.cnt,0)::int trip_count, COALESCE(t.km,0)::float distance_km, COALESCE(t.toll,0)::int toll_won,
      COALESCE(t.fuel,0)::int fuel_cost_won, COALESCE(t.parking,0)::int parking_won,
      (COALESCE(t.fuel,0)+COALESCE(t.toll,0)+COALESCE(t.parking,0))::int operating_cost_won,
      COALESCE(e.corp,0)::int corporate_card_won, COALESCE(e.personal,0)::int personal_card_won,
      COALESCE(e.fueling,0)::int fueling_won, COALESCE(e.cnt,0)::int expense_count,
      COALESCE(m.amt,0)::int maintenance_won, COALESCE(m.cnt,0)::int maintenance_count
    FROM users u LEFT JOIN t ON t.user_id=u.id LEFT JOIN e ON e.user_id=u.id LEFT JOIN m ON m.user_id=u.id
    WHERE (u.active OR t.cnt IS NOT NULL OR e.cnt IS NOT NULL) ${userFilter}
    ORDER BY u.department NULLS LAST, u.name`, params);

  const monthly = await q(`
    WITH months AS (
      SELECT user_id, to_char(trip_date,'YYYY-MM') ym, sum(distance_km) km, sum(fuel_cost_won) fuel, sum(toll_won) toll,
             sum(parking_won) parking, 0 corp, 0 personal, 0 fueling
        FROM trips WHERE trip_date BETWEEN $1 AND $2 GROUP BY 1,2
      UNION ALL
      SELECT user_id, to_char(expense_date,'YYYY-MM'), 0,0,0,0,
             sum(amount) FILTER (WHERE card_type='corporate'), sum(amount) FILTER (WHERE card_type='personal'),
             sum(amount) FILTER (WHERE category='주유')
        FROM expenses WHERE expense_date BETWEEN $1 AND $2 GROUP BY 1,2)
    SELECT ym, sum(km)::float distance_km, sum(fuel)::int fuel_cost_won, sum(toll)::int toll_won,
      (sum(fuel)+sum(toll)+sum(parking))::int operating_cost_won,
      COALESCE(sum(corp),0)::int corporate_card_won, COALESCE(sum(personal),0)::int personal_card_won,
      COALESCE(sum(fueling),0)::int fueling_won
    FROM months JOIN users u ON u.id=months.user_id WHERE true ${userFilter}
    GROUP BY ym ORDER BY ym`, params);

  res.json({ from, to, users: perUser.rows, monthly: monthly.rows });
}));

// ---------- 설정 (관리자) ----------
const SETTING_KEYS = ['kakao_rest_key', 'kakao_js_key', 'opinet_key', 'price_gasoline', 'price_diesel', 'price_lpg', 'price_ev'];
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
app.get('/api/public-config', auth, wrap(async (req, res) => {
  const r = await q("SELECT value FROM settings WHERE key='kakao_js_key'");
  res.json({ kakao_js_key: process.env.KAKAO_JS_KEY || r.rows[0]?.value || null });
}));

// ---------- 기존 엑셀 이관 데이터 적재 (관리자) ----------
// 대용량 패키지는 브라우저에서 4MB 단위로 나눠 전송 (프록시 업로드 한도 회피)
const fs = require('fs');
const os = require('os');
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
      category 항목, purpose 목적, amount 금액, memo 비고 FROM expenses WHERE user_id=$1 AND expense_date BETWEEN $2 AND $3 ORDER BY expense_date`, [uid, from, to])).rows;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(trips), '운행일지');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(exps), '카드사용');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`운행일지_${from}_${to}.xlsx`)}`);
  res.send(buf);
}));

// ---------- static ----------
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: '1h' }));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, req, res, next) => {
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && !err.status ? '서버 오류가 발생했습니다' : err.message });
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
