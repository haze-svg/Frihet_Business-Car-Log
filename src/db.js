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
}

module.exports = { pool, q, migrate };
