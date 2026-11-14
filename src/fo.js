// 가맹운영팀 업무
//  - 라운딩일정 (rounding_days): 인원·날짜별 출근시간 + 방문 지점/업무 목록
//  - 시트형 자료 (fo_sheets / fo_rows): 가맹점관리 히스토리 · 머신관리/주간회의 · 업무 매뉴얼 · AS 히스토리
//    구글시트 탭을 그대로 격자(행×열)로 보관, 셀 수정·행 추가·직전 기록 복사·전체 검색
//  - 매장 목록 (fo_stores): 매장명 선택(자동완성)용, '지점명 (구분)' 표기
// 열람·사용: 부서가 '가맹운영팀'인 직원 + 관리자. 탭 삭제·타인 라운딩 수정: 가맹운영팀 팀장·관리자
const { q, pool } = require('./db');

const DEPT = '가맹운영팀';
const BOARDS = {
  store: '가맹점관리 히스토리',
  machine: '머신관리 매뉴얼 및 주간회의 직영관리',
  manual: '가맹운영팀 업무 매뉴얼',
  as_before: '매장 AS 히스토리 (2026.07월 이전)',
};
const INFO_SHEET = '지점 정보';

async function migrate() {
  await q(`CREATE TABLE IF NOT EXISTS fo_stores (
    id SERIAL PRIMARY KEY, no INTEGER, name TEXT NOT NULL UNIQUE, kind TEXT, active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await q(`CREATE TABLE IF NOT EXISTS rounding_days (
    id SERIAL PRIMARY KEY, person TEXT NOT NULL, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    day DATE NOT NULL, start_time TEXT, end_time TEXT, items JSONB NOT NULL DEFAULT '[]', note TEXT,
    source TEXT NOT NULL DEFAULT 'web', updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (person, day))`);
  await q('CREATE INDEX IF NOT EXISTS rounding_days_day ON rounding_days(day)');
  await q(`CREATE TABLE IF NOT EXISTS fo_sheets (
    id SERIAL PRIMARY KEY, board TEXT NOT NULL, name TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0,
    is_store BOOLEAN NOT NULL DEFAULT false, source TEXT NOT NULL DEFAULT 'web',
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (board, name))`);
  await q(`CREATE TABLE IF NOT EXISTS fo_rows (
    id SERIAL PRIMARY KEY, sheet_id INTEGER NOT NULL REFERENCES fo_sheets(id) ON DELETE CASCADE,
    ord DOUBLE PRECISION NOT NULL, cells JSONB NOT NULL DEFAULT '[]',
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await q('CREATE INDEX IF NOT EXISTS fo_rows_sheet ON fo_rows(sheet_id, ord)');
}

const foAccess = (u) => !!u && (u.role === 'admin' || u.department === DEPT);
const foLead = (u) => !!u && (u.role === 'admin' || (u.department === DEPT && /팀장/.test(u.position || '')));
const myPerson = (u) => u.nickname || u.name;

// ---------- CSV ----------
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const trimRows = (rows) => {
  // 뒤쪽 빈 열·빈 행 제거
  const out = rows.map((r) => { const a = r.map((c) => String(c ?? '').replace(/\r/g, '')); while (a.length && a[a.length - 1].trim() === '') a.pop(); return a; });
  while (out.length && !out[out.length - 1].length) out.pop();
  return out;
};

// ---------- 라운딩 시트 파서 (구글시트 월별 탭 → 인원·날짜별 일정) ----------
const SKIP = new Set(['FALSE', 'TRUE', '-', '`', '']);
const clean = (s) => String(s || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
function normTime(v) {
  v = clean(v); if (!v || SKIP.has(v)) return '';
  const f = Number(v); if (!Number.isNaN(f) && f > 0 && f < 1) { const m = Math.round(f * 1440); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
  let m = v.match(/^(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?$/); if (m) return `${m[1].padStart(2, '0')}:${String(m[2] || 0).padStart(2, '0')}`;
  m = v.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/); if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  return v.replace(/\n/g, ' ');
}
const iso = (y, m, d) => { const dt = new Date(Date.UTC(y, m - 1, d)); return Number.isNaN(dt.getTime()) || dt.getUTCDate() !== d ? null : dt.toISOString().slice(0, 10); };
function parseDate(v, Y, M) {
  v = clean(v); if (!v) return null;
  let m = v.match(/^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/); if (m) return iso(+m[1], +m[2], +m[3]);
  m = v.match(/^(\d{1,2})\/(\d{1,2})/);
  if (m) { const mm = +m[1]; let y = Y; if (M === 1 && mm === 12) y--; if (M === 12 && mm === 1) y++; return iso(y, mm, +m[2]); }
  if (/^\d{5}(\.0+)?$/.test(v)) return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(v)) * 864e5).toISOString().slice(0, 10);
  return null;
}
function parseRoundingSheet(sheet, rows, out) {
  let Y = null; let M = null;
  for (const r of rows.slice(0, 6)) r.forEach((c, j) => {
    if (clean(c) === '연도' && /^\d+$/.test(clean(r[j + 1]))) Y = +clean(r[j + 1]);
    if (clean(c) === '월' && /^\d+$/.test(clean(r[j + 1]))) M = +clean(r[j + 1]);
  });
  if (!Y || !M) return 0;
  let n = 0; let lastLab = null; let k = 0;
  const has = (r, s) => r.some((c) => clean(c) === s);
  while (k < rows.length) {
    const r = rows[k];
    if (!has(r, '날짜')) { k++; continue; }
    const dcol = r.findIndex((c) => clean(c) === '날짜');
    const nxt = rows[k + 1] || [];
    let lab; let ncol; let first;
    if (has(nxt, '요일')) { lab = nxt; ncol = nxt.findIndex((c) => clean(c) === '요일'); first = k + 2; lastLab = [lab, ncol]; }
    else if (lastLab) { [lab, ncol] = lastLab; first = k + 1; }
    else { k++; continue; }
    const starts = [];
    for (let j = dcol + 1; j < r.length; j++) { const d = parseDate(r[j], Y, M); if (d) starts.push([j, d]); }
    const blocks = [];
    starts.forEach(([j, d], i) => {
      const end = i + 1 < starts.length ? starts[i + 1][0] : lab.length;
      const labels = []; for (let c = j; c < end; c++) labels.push([c, clean(lab[c])]);
      if (labels.some(([, l]) => l === '지점명' || l === '출근')) blocks.push([d, labels]);
    });
    let k2 = first; const persons = [];
    while (k2 < rows.length && !has(rows[k2], '날짜')) {
      const rr = rows[k2]; const nm = clean(String(rr[ncol] || '').replace(/\n/g, ''));
      if (nm && !SKIP.has(nm)) persons.push([nm, [rr]]); else if (persons.length) persons[persons.length - 1][1].push(rr);
      k2++;
    }
    for (const [nm, prow] of persons) {
      for (const [d, labels] of blocks) {
        let start = ''; let endT = ''; const items = [];
        for (const rr of prow) {
          let cur = null;
          for (const [c, l] of labels) {
            const v = clean(rr[c]);
            if (l === '출근') { if (v && !SKIP.has(v) && !start) start = normTime(v); cur = null; continue; }
            if (l === '퇴근') { if (v && !SKIP.has(v) && !endT) endT = normTime(v); cur = null; continue; }
            if (l === '지점명') { cur = { store: SKIP.has(v) ? '' : v, task: '' }; items.push(cur); continue; }
            if (cur && v && !SKIP.has(v)) {
              if (l === '' && !cur.store && !cur.task) cur.store = v; // 구형(7칸) 양식: 체크박스 다음 칸이 지점명
              else cur.task = cur.task ? `${cur.task} / ${v}` : v;
            }
          }
        }
        const it = items.filter((x) => x.store || x.task);
        if (!start && !it.length) continue;
        const key = `${d}|${nm}`;
        const own = d.slice(0, 7) === `${Y}-${String(M).padStart(2, '0')}`;
        if (out.has(key) && !own) continue;
        out.set(key, { date: d, person: nm, start, end: endT, items: it, sheet }); n++;
      }
    }
    k = k2;
  }
  return n;
}

// ---------- 이관 패키지 (version: 'fo') ----------
// { version:'fo', stores:[{no,name,kind}], rounding:{시트명:csv}, boards:{store:[{name,csv}], machine:[...], manual:[...], as_before:[...]} }
// 같은 패키지를 다시 올리면 이관분(source='sheet')만 다시 적재, 웹에서 등록·수정한 자료는 유지
async function importPackage(data, dryRun) {
  const rep = { fo: true, dry_run: dryRun, stores: 0, rounding_days: 0, rounding_kept_web: 0, sheets: {}, rows: 0, kept_web_sheets: 0 };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 매장 목록
    for (const s of data.stores || []) {
      const name = clean(s.name).replace(/\s*\n\s*/g, ' '); if (!name) continue;
      await client.query(`INSERT INTO fo_stores(no,name,kind) VALUES($1,$2,$3) ON CONFLICT (name) DO UPDATE SET no=EXCLUDED.no, kind=EXCLUDED.kind`,
        [Number(s.no) || null, name, clean(s.kind) || null]);
      rep.stores++;
    }
    // 라운딩일정
    const map = new Map();
    for (const [sheet, csv] of Object.entries(data.rounding || {})) parseRoundingSheet(sheet, parseCsv(csv), map);
    const users = (await client.query('SELECT id,name,nickname,department FROM users')).rows
      .sort((a, b) => (a.department === DEPT ? -1 : 1) - (b.department === DEPT ? -1 : 1));
    const uid = (p) => (users.find((u) => u.nickname === p) || users.find((u) => u.name === p) || {}).id || null;
    for (const x of map.values()) {
      const cur = (await client.query('SELECT id, source FROM rounding_days WHERE person=$1 AND day=$2', [x.person, x.date])).rows[0];
      if (cur && cur.source === 'web') { rep.rounding_kept_web++; continue; }
      const vals = [x.person, uid(x.person), x.date, x.start || null, x.end || null, JSON.stringify(x.items), `시트:${x.sheet}`];
      if (cur) await client.query(`UPDATE rounding_days SET user_id=$2,start_time=$4,end_time=$5,items=$6,note=$7,source='sheet',updated_at=now() WHERE person=$1 AND day=$3`, vals);
      else await client.query(`INSERT INTO rounding_days(person,user_id,day,start_time,end_time,items,note,source) VALUES($1,$2,$3,$4,$5,$6,$7,'sheet')`, vals);
      rep.rounding_days++;
    }
    // 시트형 자료
    for (const [board, tabs] of Object.entries(data.boards || {})) {
      if (!BOARDS[board]) continue;
      rep.sheets[board] = 0;
      let ord = 0;
      for (const t of tabs) {
        ord++;
        const name = clean(t.name); if (!name) continue;
        const rows = trimRows(parseCsv(t.csv || ''));
        const ex = (await client.query('SELECT id, source FROM fo_sheets WHERE board=$1 AND name=$2', [board, name])).rows[0];
        if (ex && ex.source === 'web') { rep.kept_web_sheets++; continue; }
        const isStore = board === 'store' && rows.slice(0, 2).some((r) => clean(r[1]) === '지점명');
        let sid;
        if (ex) { sid = ex.id; await client.query('DELETE FROM fo_rows WHERE sheet_id=$1', [sid]); await client.query('UPDATE fo_sheets SET ord=$2, is_store=$3, updated_at=now() WHERE id=$1', [sid, ord, isStore]); }
        else sid = (await client.query(`INSERT INTO fo_sheets(board,name,ord,is_store,source) VALUES($1,$2,$3,$4,'sheet') RETURNING id`, [board, name, ord, isStore])).rows[0].id;
        for (let i = 0; i < rows.length; i++) {
          await client.query('INSERT INTO fo_rows(sheet_id,ord,cells) VALUES($1,$2,$3)', [sid, i + 1, JSON.stringify(rows[i])]);
          rep.rows++;
        }
        rep.sheets[board]++;
      }
    }
    if (dryRun) await client.query('ROLLBACK'); else await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  return rep;
}

// ---------- API ----------
function register(app, { auth, wrap, bad, int, str, isDate }) {
  const need = (req) => { if (!foAccess(req.user)) throw bad('가맹운영팀과 관리자만 사용할 수 있습니다', 403); };
  const lead = (req) => { if (!foLead(req.user)) throw bad('가맹운영팀 팀장·관리자만 가능합니다', 403); };

  app.get('/api/fo/me', auth, wrap(async (req, res) => {
    res.json({ access: foAccess(req.user), lead: foLead(req.user), person: myPerson(req.user), boards: BOARDS });
  }));

  // 매장 목록
  app.get('/api/fo/stores', auth, wrap(async (req, res) => {
    need(req);
    res.json((await q('SELECT id,no,name,kind,active FROM fo_stores ORDER BY no NULLS LAST, name')).rows);
  }));
  app.post('/api/fo/stores', auth, wrap(async (req, res) => {
    need(req);
    const b = req.body || {};
    const name = str(b.name); if (!name) throw bad('매장명을 입력하세요');
    if ((await q('SELECT 1 FROM fo_stores WHERE name=$1', [name])).rows.length) throw bad('이미 등록된 매장입니다');
    const no = (await q('SELECT COALESCE(max(no),0)+1 n FROM fo_stores')).rows[0].n;
    await q('INSERT INTO fo_stores(no,name,kind) VALUES($1,$2,$3)', [no, name, str(b.kind)]);
    const out = { ok: true, no };
    // 가맹점관리 히스토리: '지점 정보' 행 추가 + 매장 탭 생성(기존 매장 탭 양식 복사)
    if (b.history) {
      const info = (await q(`SELECT id FROM fo_sheets WHERE board='store' AND name=$1`, [INFO_SHEET])).rows[0];
      if (info && Array.isArray(b.info_cells)) {
        const last = (await q('SELECT COALESCE(max(ord),0) o FROM fo_rows WHERE sheet_id=$1', [info.id])).rows[0].o;
        const cells = b.info_cells.map((c) => String(c ?? '')); if (!cells[1]) cells[1] = name; if (!cells[0]) cells[0] = String(no);
        await q('INSERT INTO fo_rows(sheet_id,ord,cells,updated_by) VALUES($1,$2,$3,$4)', [info.id, Number(last) + 1, JSON.stringify(cells), req.user.id]);
      }
      const tpl = b.template_id ? int(b.template_id) : (await q(`SELECT id FROM fo_sheets WHERE board='store' AND is_store ORDER BY updated_at DESC LIMIT 1`)).rows[0]?.id;
      const tabName = name + (str(b.kind) ? ` (${str(b.kind)})` : '');
      if ((await q(`SELECT 1 FROM fo_sheets WHERE board='store' AND name=$1`, [tabName])).rows.length) throw bad('같은 이름의 탭이 이미 있습니다');
      const ord = (await q(`SELECT COALESCE(max(ord),0)+1 o FROM fo_sheets WHERE board='store'`)).rows[0].o;
      const sid = (await q(`INSERT INTO fo_sheets(board,name,ord,is_store,source,updated_by) VALUES('store',$1,$2,true,'web',$3) RETURNING id`, [tabName, ord, req.user.id])).rows[0].id;
      if (tpl) {
        const rows = (await q('SELECT cells FROM fo_rows WHERE sheet_id=$1 ORDER BY ord', [tpl])).rows.map((r) => r.cells);
        const hi = rows.findIndex((r) => r.some((c) => clean(c) === '방문일자'));
        const head = rows.slice(0, hi >= 0 ? hi + 1 : Math.min(4, rows.length)).map((r) => [...r]);
        const set = { 지점명: name, 담당자: str(b.sv) || '', '최근 방문일': '', '방문전 연락여부': '', '유로머신 정보': str(b.machine) || '', 오픈일: str(b.open_date) || '', '머신필터 교체일': '' };
        const norm = (s) => clean(String(s || '').replace(/\n/g, ' ')).replace(/\s+/g, ' ');
        for (const r of head) for (let i = 0; i < r.length - 1; i++) {
          const key = Object.keys(set).find((k) => norm(r[i]) === k || norm(r[i]).replace(/\s/g, '') === k.replace(/\s/g, ''));
          if (key !== undefined) { r[i + 1] = set[key]; }
        }
        for (let i = 0; i < head.length; i++) await q('INSERT INTO fo_rows(sheet_id,ord,cells,updated_by) VALUES($1,$2,$3,$4)', [sid, i + 1, JSON.stringify(head[i]), req.user.id]);
      }
      out.sheet_id = sid;
    }
    res.json(out);
  }));
  app.put('/api/fo/stores/:id', auth, wrap(async (req, res) => {
    need(req);
    const b = req.body || {};
    await q('UPDATE fo_stores SET name=COALESCE($1,name), kind=$2, active=COALESCE($3,active) WHERE id=$4', [str(b.name), str(b.kind), typeof b.active === 'boolean' ? b.active : null, int(req.params.id)]);
    res.json({ ok: true });
  }));

  // ----- 라운딩일정 -----
  app.get('/api/fo/rounding/meta', auth, wrap(async (req, res) => {
    need(req);
    const months = (await q(`SELECT to_char(day,'YYYY-MM') ym, count(*)::int n FROM rounding_days GROUP BY 1 ORDER BY 1 DESC`)).rows;
    const persons = (await q(`SELECT person, to_char(max(day),'YYYY-MM-DD') last_day, count(*)::int n FROM rounding_days GROUP BY person ORDER BY max(day) DESC, person`)).rows;
    const members = (await q(`SELECT id,name,nickname,position FROM users WHERE department=$1 AND active AND COALESCE(position,'')<>'부서카드' ORDER BY (position LIKE '%팀장%') DESC, name`, [DEPT])).rows;
    res.json({ months, persons, members });
  }));
  app.get('/api/fo/rounding', auth, wrap(async (req, res) => {
    need(req);
    if (!isDate(req.query.from) || !isDate(req.query.to)) throw bad('기간 오류');
    const P = [req.query.from, req.query.to]; let w = '';
    if (req.query.person) { P.push(String(req.query.person).split(',')); w = 'AND d.person = ANY($3)'; }
    const r = await q(`SELECT d.id, d.person, d.user_id, to_char(d.day,'YYYY-MM-DD') AS day, d.start_time, d.end_time, d.items, d.note, d.source, d.updated_at, u.name AS updated_by_name
      FROM rounding_days d LEFT JOIN users u ON u.id=d.updated_by WHERE d.day BETWEEN $1 AND $2 ${w} ORDER BY d.day, d.person`, P);
    res.json(r.rows);
  }));
  app.get('/api/fo/rounding/search', auth, wrap(async (req, res) => {
    need(req);
    const k = String(req.query.q || '').trim(); if (!k) return res.json([]);
    const P = ['%' + k + '%']; let w = '';
    if (isDate(req.query.from)) { P.push(req.query.from); w += ` AND day >= $${P.length}`; }
    if (isDate(req.query.to)) { P.push(req.query.to); w += ` AND day <= $${P.length}`; }
    const r = await q(`SELECT id, person, to_char(day,'YYYY-MM-DD') AS day, start_time, end_time, items, note, source FROM rounding_days
      WHERE (person ILIKE $1 OR items::text ILIKE $1) ${w} ORDER BY day DESC, person LIMIT 1500`, P);
    res.json(r.rows);
  }));
  const cleanItems = (items) => (Array.isArray(items) ? items : []).map((x) => ({ store: str(x.store) || '', task: str(x.task) || '' })).filter((x) => x.store || x.task).slice(0, 30);
  app.put('/api/fo/rounding', auth, wrap(async (req, res) => {
    need(req);
    const b = req.body || {};
    const person = str(b.person) || myPerson(req.user);
    if (!isDate(b.day)) throw bad('날짜를 입력하세요');
    if (!foLead(req.user) && person !== myPerson(req.user)) throw bad('본인 일정만 등록·수정할 수 있습니다', 403);
    const items = cleanItems(b.items);
    if (!str(b.start_time) && !items.length) throw bad('출근시간 또는 지점명·업무를 입력하세요');
    const u = (await q('SELECT id FROM users WHERE nickname=$1 OR name=$1 ORDER BY (department=$2) DESC LIMIT 1', [person, DEPT])).rows[0];
    if (b.id) {
      const cur = (await q('SELECT * FROM rounding_days WHERE id=$1', [int(b.id)])).rows[0];
      if (!cur) throw bad('일정 없음', 404);
      if (!foLead(req.user) && cur.person !== myPerson(req.user)) throw bad('본인 일정만 수정할 수 있습니다', 403);
      if ((await q('SELECT 1 FROM rounding_days WHERE person=$1 AND day=$2 AND id<>$3', [person, b.day, cur.id])).rows.length) throw bad('같은 날짜에 이미 일정이 있습니다. 그 일정을 수정하세요');
      await q(`UPDATE rounding_days SET person=$1,user_id=$2,day=$3,start_time=$4,items=$5,note=NULL,source='web',updated_by=$6,updated_at=now() WHERE id=$7`,
        [person, u?.id || null, b.day, str(b.start_time), JSON.stringify(items), req.user.id, cur.id]);
      return res.json({ ok: true, id: cur.id });
    }
    const r = await q(`INSERT INTO rounding_days(person,user_id,day,start_time,items,source,updated_by) VALUES($1,$2,$3,$4,$5,'web',$6)
      ON CONFLICT (person, day) DO UPDATE SET start_time=EXCLUDED.start_time, items=EXCLUDED.items, note=NULL, source='web', updated_by=EXCLUDED.updated_by, updated_at=now() RETURNING id`,
    [person, u?.id || null, b.day, str(b.start_time), JSON.stringify(items), req.user.id]);
    res.json({ ok: true, id: r.rows[0].id });
  }));
  app.delete('/api/fo/rounding/:id', auth, wrap(async (req, res) => {
    need(req);
    const cur = (await q('SELECT * FROM rounding_days WHERE id=$1', [int(req.params.id)])).rows[0];
    if (!cur) throw bad('일정 없음', 404);
    if (!foLead(req.user) && cur.person !== myPerson(req.user)) throw bad('본인 일정만 삭제할 수 있습니다', 403);
    await q('DELETE FROM rounding_days WHERE id=$1', [cur.id]);
    res.json({ ok: true });
  }));

  // ----- 시트형 자료 -----
  const sheetOf = async (id) => { const s = (await q('SELECT * FROM fo_sheets WHERE id=$1', [int(id)])).rows[0]; if (!s) throw bad('탭 없음', 404); return s; };
  const touch = (sid, uid) => q("UPDATE fo_sheets SET updated_at=now(), updated_by=$2, source='web' WHERE id=$1", [sid, uid]);
  app.get('/api/fo/sheets', auth, wrap(async (req, res) => {
    need(req);
    if (!BOARDS[req.query.board]) throw bad('게시판 없음', 404);
    const r = await q(`SELECT s.id, s.name, s.ord, s.is_store, s.updated_at, u.name updated_by_name, (SELECT count(*)::int FROM fo_rows r WHERE r.sheet_id=s.id) n
      FROM fo_sheets s LEFT JOIN users u ON u.id=s.updated_by WHERE s.board=$1 ORDER BY s.ord, s.id`, [req.query.board]);
    res.json(r.rows);
  }));
  app.get('/api/fo/sheets/:id', auth, wrap(async (req, res) => {
    need(req);
    const s = await sheetOf(req.params.id);
    const rows = (await q('SELECT id, ord, cells FROM fo_rows WHERE sheet_id=$1 ORDER BY ord, id', [s.id])).rows;
    res.json({ ...s, rows });
  }));
  app.post('/api/fo/sheets', auth, wrap(async (req, res) => {
    need(req);
    const b = req.body || {};
    if (!BOARDS[b.board]) throw bad('게시판 없음', 404);
    const name = str(b.name); if (!name) throw bad('탭 이름을 입력하세요');
    if ((await q('SELECT 1 FROM fo_sheets WHERE board=$1 AND name=$2', [b.board, name])).rows.length) throw bad('같은 이름의 탭이 이미 있습니다');
    const ord = (await q('SELECT COALESCE(max(ord),0)+1 o FROM fo_sheets WHERE board=$1', [b.board])).rows[0].o;
    const sid = (await q(`INSERT INTO fo_sheets(board,name,ord,source,updated_by) VALUES($1,$2,$3,'web',$4) RETURNING id`, [b.board, name, ord, req.user.id])).rows[0].id;
    const cols = Math.min(Math.max(int(b.cols) || 6, 1), 40);
    const header = Array.isArray(b.header) ? b.header.map(String) : Array(cols).fill('');
    await q('INSERT INTO fo_rows(sheet_id,ord,cells,updated_by) VALUES($1,1,$2,$3)', [sid, JSON.stringify(header), req.user.id]);
    res.json({ ok: true, id: sid });
  }));
  app.put('/api/fo/sheets/:id', auth, wrap(async (req, res) => {
    need(req);
    const s = await sheetOf(req.params.id);
    const name = str(req.body.name); if (!name) throw bad('탭 이름을 입력하세요');
    if ((await q('SELECT 1 FROM fo_sheets WHERE board=$1 AND name=$2 AND id<>$3', [s.board, name, s.id])).rows.length) throw bad('같은 이름의 탭이 이미 있습니다');
    await q('UPDATE fo_sheets SET name=$1 WHERE id=$2', [name, s.id]); await touch(s.id, req.user.id);
    res.json({ ok: true });
  }));
  app.delete('/api/fo/sheets/:id', auth, wrap(async (req, res) => {
    need(req); lead(req);
    const s = await sheetOf(req.params.id);
    await q('DELETE FROM fo_sheets WHERE id=$1', [s.id]);
    res.json({ ok: true });
  }));
  // 행 추가: after(행 id) 뒤에, rows(셀 배열 목록) 또는 count(빈 행 수)
  app.post('/api/fo/sheets/:id/rows', auth, wrap(async (req, res) => {
    need(req);
    const s = await sheetOf(req.params.id);
    const b = req.body || {};
    let rows = Array.isArray(b.rows) ? b.rows.slice(0, 200).map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : [])) : [];
    if (!rows.length) rows = Array.from({ length: Math.min(Math.max(int(b.count) || 1, 1), 50) }, () => []);
    const all = (await q('SELECT id, ord FROM fo_rows WHERE sheet_id=$1 ORDER BY ord, id', [s.id])).rows;
    let lo; let hi;
    const i = b.after ? all.findIndex((r) => r.id === int(b.after)) : -1;
    if (i >= 0) { lo = Number(all[i].ord); hi = i + 1 < all.length ? Number(all[i + 1].ord) : lo + rows.length + 1; }
    else { lo = all.length ? Number(all[all.length - 1].ord) : 0; hi = lo + rows.length + 1; }
    const step = (hi - lo) / (rows.length + 1);
    const ids = [];
    for (let k = 0; k < rows.length; k++) {
      ids.push((await q('INSERT INTO fo_rows(sheet_id,ord,cells,updated_by) VALUES($1,$2,$3,$4) RETURNING id', [s.id, lo + step * (k + 1), JSON.stringify(rows[k]), req.user.id])).rows[0].id);
    }
    await touch(s.id, req.user.id);
    res.json({ ok: true, ids });
  }));
  app.put('/api/fo/rows/:id', auth, wrap(async (req, res) => {
    need(req);
    const r = (await q('SELECT * FROM fo_rows WHERE id=$1', [int(req.params.id)])).rows[0];
    if (!r) throw bad('행 없음', 404);
    let cells = r.cells;
    if (Array.isArray(req.body.cells)) cells = req.body.cells.map((c) => String(c ?? ''));
    else if (Number.isInteger(req.body.col)) { cells = [...cells]; while (cells.length <= req.body.col) cells.push(''); cells[req.body.col] = String(req.body.value ?? ''); }
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    await q('UPDATE fo_rows SET cells=$1, updated_by=$2, updated_at=now() WHERE id=$3', [JSON.stringify(cells), req.user.id, r.id]);
    await touch(r.sheet_id, req.user.id);
    res.json({ ok: true, cells });
  }));
  app.delete('/api/fo/rows/:id', auth, wrap(async (req, res) => {
    need(req);
    const r = (await q('SELECT * FROM fo_rows WHERE id=$1', [int(req.params.id)])).rows[0];
    if (!r) throw bad('행 없음', 404);
    await q('DELETE FROM fo_rows WHERE id=$1', [r.id]); await touch(r.sheet_id, req.user.id);
    res.json({ ok: true });
  }));
  // 전체 검색 (게시판 내 모든 탭)
  app.get('/api/fo/search', auth, wrap(async (req, res) => {
    need(req);
    const k = String(req.query.q || '').trim(); if (!k) return res.json([]);
    const P = ['%' + k + '%']; let w = '';
    if (BOARDS[req.query.board]) { P.push(req.query.board); w = 'AND s.board=$2'; }
    const r = await q(`SELECT s.board, s.id sheet_id, s.name sheet, r.id row_id, r.cells FROM fo_rows r JOIN fo_sheets s ON s.id=r.sheet_id
      WHERE (r.cells::text ILIKE $1 OR s.name ILIKE $1) ${w} ORDER BY s.board, s.ord, r.ord LIMIT 500`, P);
    res.json(r.rows);
  }));
}

module.exports = { migrate, register, importPackage, parseCsv, parseRoundingSheet, foAccess, foLead, BOARDS, DEPT };
