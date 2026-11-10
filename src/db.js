const { Pool, types } = require('pg');
// DATE 컬럼은 타임존 변환 없이 'YYYY-MM-DD' 문자열로 사용
types.setTypeParser(1082, (v) => v);

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[db] DATABASE_URL 환경변수가 없습니다. PostgreSQL 연결 문자열이 필요합니다.');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 10,
});

const q = (text, params) => pool.query(text, params);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  nickname TEXT,
  department TEXT,
  position TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  password_hash TEXT NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deactivated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS vehicles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ownership TEXT NOT NULL DEFAULT 'personal',
  plate TEXT NOT NULL,
  model TEXT,
  fuel_type TEXT NOT NULL DEFAULT 'gasoline',
  efficiency_km_l NUMERIC(6,2),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vehicle_models (
  id SERIAL PRIMARY KEY,
  model TEXT UNIQUE NOT NULL,
  fuel_type TEXT NOT NULL,
  efficiency_km_l NUMERIC(6,2) NOT NULL,
  source TEXT
);

CREATE TABLE IF NOT EXISTS trips (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
  trip_date DATE NOT NULL,
  purpose TEXT,
  start_name TEXT, start_addr TEXT, start_x DOUBLE PRECISION, start_y DOUBLE PRECISION,
  end_name TEXT, end_addr TEXT, end_x DOUBLE PRECISION, end_y DOUBLE PRECISION,
  round_trip BOOLEAN NOT NULL DEFAULT FALSE,
  distance_km NUMERIC(8,1) NOT NULL DEFAULT 0,
  toll_won INTEGER NOT NULL DEFAULT 0,
  fuel_price_won NUMERIC(8,2),
  efficiency_km_l NUMERIC(6,2),
  fuel_cost_won INTEGER NOT NULL DEFAULT 0,
  parking_won INTEGER NOT NULL DEFAULT 0,
  memo TEXT,
  source TEXT NOT NULL DEFAULT 'web',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trips_user_date ON trips(user_id, trip_date);

CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
  expense_date DATE NOT NULL,
  card_type TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '기타',
  purpose TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  memo TEXT,
  source TEXT NOT NULL DEFAULT 'web',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expenses_user_date ON expenses(user_id, expense_date);

CREATE TABLE IF NOT EXISTS maintenance (
  id SERIAL PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  maint_date DATE NOT NULL,
  maint_type TEXT NOT NULL DEFAULT '점검',
  odometer_km INTEGER,
  description TEXT,
  vendor TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  card_type TEXT,
  next_due_date DATE,
  next_due_km INTEGER,
  memo TEXT,
  source TEXT NOT NULL DEFAULT 'web',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS photos (
  id SERIAL PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  filename TEXT,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BYTEA NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS photos_owner ON photos(owner_type, owner_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS fuel_prices (
  price_date DATE NOT NULL,
  fuel_type TEXT NOT NULL,
  price_won NUMERIC(8,2) NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (price_date, fuel_type)
);
`;

async function migrate() {
  await pool.query(SCHEMA);
  // 카드 사용 항목명 통일 (선택형 항목: 식대·주유비·통행료·주차비·업무물품구매·숙박비·교통비·기타)
  // 카드 사용 장부 구분: drive=차량운행일지, team=부서팀장 법인카드 일지
  await pool.query("ALTER TABLE expenses ADD COLUMN IF NOT EXISTS book TEXT NOT NULL DEFAULT 'drive'");
  // 부서팀장 법인카드 일지 사용자 지정 (예: 총무카드). 비어 있으면 직책 '팀장' 기준
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS team_card TEXT");
  await pool.query("CREATE INDEX IF NOT EXISTS expenses_book_date ON expenses(book, expense_date)");
  await pool.query("UPDATE expenses SET category='주유비' WHERE category='주유'");
  await pool.query("UPDATE expenses SET category='주차비' WHERE category='주차'");
  // 사용 목적 항목 변경: 매장물품구매 → 업무물품구매
  await pool.query("UPDATE expenses SET category='업무물품구매' WHERE category='매장물품구매'");
  // 그랜터 법인카드 자동 연동
  await pool.query('ALTER TABLE expenses ADD COLUMN IF NOT EXISTS ext_id TEXT');
  await pool.query('ALTER TABLE expenses ADD COLUMN IF NOT EXISTS ext_card TEXT');
  await pool.query('ALTER TABLE expenses ADD COLUMN IF NOT EXISTS merchant TEXT');
  await pool.query('ALTER TABLE expenses ADD COLUMN IF NOT EXISTS pay_time TEXT');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS expenses_ext_id ON expenses(ext_id) WHERE ext_id IS NOT NULL');
  await pool.query(`CREATE TABLE IF NOT EXISTS granter_cards (
    card_id TEXT PRIMARY KEY,
    name TEXT,
    number TEXT,
    owner_emails TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    book TEXT NOT NULL DEFAULT 'auto',
    last_seen TIMESTAMPTZ
  )`);
  // 부서팀장 법인카드 일지에 별도 항목으로 보일 이름 (예: 백은하(실버) - 삼성카드 전용)
  await pool.query('ALTER TABLE granter_cards ADD COLUMN IF NOT EXISTS label TEXT');
  // 1회 적용: 삼성카드 CORPORATE 2장(3188·2109) → 백은하(실버) 부서팀장 일지 '삼성카드 전용' 항목 (대표 지시 2026-11-11)
  const doneS = await pool.query("SELECT 1 FROM settings WHERE key='mig_samsung_silver'");
  if (!doneS.rows.length) {
    const r = await pool.query(`UPDATE granter_cards SET user_id=(SELECT id FROM users WHERE name='백은하' AND nickname='실버' LIMIT 1), book='team', label='삼성카드 전용'
      WHERE number LIKE '%3188' OR number LIKE '%2109'`);
    if (r.rowCount) await pool.query("INSERT INTO settings(key,value) VALUES('mig_samsung_silver','1')");
  }
  // 1회 적용 (대표 지시 2026-11-11): KB국민 MYBIZ(9902)·본사(3959) 카드 연동 제외,
  // 온라인결제 카드(8896) → 백은하(실버) 부서팀장 일지, 백은하 일지 명칭 '온라인결제전용'
  const doneO = await pool.query("SELECT 1 FROM settings WHERE key='mig_online_silver'");
  if (!doneO.rows.length) {
    const off = await pool.query("UPDATE granter_cards SET book='off', user_id=NULL, label=NULL WHERE number LIKE '%9902' OR number LIKE '%3959'");
    const on = await pool.query(`UPDATE granter_cards SET user_id=(SELECT id FROM users WHERE name='백은하' AND nickname='실버' LIMIT 1), book='team', label=NULL,
      name=CASE WHEN name LIKE '실버\_%' THEN name ELSE '실버_' || name END WHERE number LIKE '%8896'`);
    await pool.query("UPDATE users SET team_card='온라인결제전용' WHERE name='백은하' AND nickname='실버'");
    if (off.rowCount || on.rowCount) await pool.query("INSERT INTO settings(key,value) VALUES('mig_online_silver','1')");
  }
  // 1회 적용 (대표 지시 2026-11-11): 헤이즈(6843)·쟈스민(6811)·루니(7860) 카드 연동 제외
  const doneE = await pool.query("SELECT 1 FROM settings WHERE key='mig_exec_cards_off'");
  if (!doneE.rows.length) {
    const r = await pool.query("UPDATE granter_cards SET book='off', user_id=NULL, label=NULL WHERE number LIKE '%6843' OR number LIKE '%6811' OR number LIKE '%7860'");
    await pool.query("DELETE FROM photos WHERE owner_type='expense' AND owner_id IN (SELECT id FROM expenses WHERE source='granter' AND ext_card IN (SELECT card_id FROM granter_cards WHERE book='off'))");
    await pool.query("DELETE FROM expenses WHERE source='granter' AND ext_card IN (SELECT card_id FROM granter_cards WHERE book='off')");
    if (r.rowCount) await pool.query("INSERT INTO settings(key,value) VALUES('mig_exec_cards_off','1')");
  }
  // 1회 적용 (대표 지시 2026-11-11 04:32): 공용업무카드(8974)·삼성카드(7578) → 백은하, 불필요 KB국민 카드 연동 제외
  const doneB = await pool.query("SELECT 1 FROM settings WHERE key='mig_cards_1111b'");
  if (!doneB.rows.length) {
    const silver = "(SELECT id FROM users WHERE name='백은하' AND nickname='실버' LIMIT 1)";
    const a1 = await pool.query(`UPDATE granter_cards SET user_id=${silver}, book='team', label='공용업무카드' WHERE number LIKE '%8974'`);
    const a2 = await pool.query(`UPDATE granter_cards SET user_id=${silver}, book='team', label='삼성카드 전용' WHERE number LIKE '%7578'`);
    const a3 = await pool.query(`UPDATE granter_cards SET book='off', user_id=NULL, label=NULL
      WHERE number LIKE '%3990' OR number LIKE '%9967' OR number LIKE '%2983' OR number LIKE '%6904' OR number LIKE '%3907'
         OR number LIKE '%9902' OR number LIKE '%3959' OR number LIKE '%7860' OR number LIKE '%6811' OR number LIKE '%6843'`);
    await pool.query("DELETE FROM photos WHERE owner_type='expense' AND owner_id IN (SELECT id FROM expenses WHERE source='granter' AND ext_card IN (SELECT card_id FROM granter_cards WHERE book='off'))");
    await pool.query("DELETE FROM expenses WHERE source='granter' AND ext_card IN (SELECT card_id FROM granter_cards WHERE book='off')");
    if (a1.rowCount + a2.rowCount + a3.rowCount) await pool.query("INSERT INTO settings(key,value) VALUES('mig_cards_1111b','1')");
  }
  // 1회 적용: 오안(루카) 팀장카드는 운행일지 법인카드와 같은 카드 → 부서팀장 일지에서 제외 (대표 지시 2026-11-11)
  const done = await pool.query("SELECT 1 FROM settings WHERE key='mig_oan_no_team'");
  if (!done.rows.length) {
    await pool.query("UPDATE users SET team_card='사용안함' WHERE name='오안' AND nickname='루카'");
    await pool.query("INSERT INTO settings(key,value) VALUES('mig_oan_no_team','1')");
  }
}

module.exports = { pool, q, migrate };
