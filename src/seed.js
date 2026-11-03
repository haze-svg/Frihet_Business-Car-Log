// 최초 기동 시 관리자 및 기본 직원 등록
// - 이메일은 FND 사내 계정 ID(닉네임@cafefrihet.com) 기준. 다르면 직원관리에서 수정.
// - 직원 초기 비밀번호: INITIAL_PASSWORD 환경변수(없으면 무작위 → 관리자가 '비밀번호 초기화'로 발급)
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { q } = require('./db');

const STAFF = [
  { email: 'karry@cafefrihet.com', name: '박혜리', nickname: '캐리', department: '운영팀', position: '사원' },
  { email: 'joby@cafefrihet.com', name: '안정화', nickname: '조비', department: '운영팀', position: '사원' },
  { email: 'james@cafefrihet.com', name: '김명현', nickname: '제임스', department: '운영팀', position: '사원' },
  { email: 'teo@cafefrihet.com', name: '김태오', nickname: '태오', department: '운영팀', position: '사원' },
  { email: 'chloe@cafefrihet.com', name: '김희선', nickname: '클로이', department: '운영팀', position: '팀장' },
  { email: 'bruno@cafefrihet.com', name: '권민수', nickname: '브르노', department: '운영팀', position: '사원' },
  { email: 'jerry@cafefrihet.com', name: '이수익', nickname: '제리', department: '물류팀', position: '팀장' },
  { email: 'one@cafefrihet.com', name: '원태경', nickname: '원', department: '물류팀', position: '사원' },
  { email: 'luca@cafefrihet.com', name: '오안', nickname: '루카', department: '인테리어팀', position: '팀장' },
  { email: 'louis@cafefrihet.com', name: '정민규', nickname: '루이스', department: '인테리어팀', position: '사원' },
  { email: 'grap@cafefrihet.com', name: '윤효근', nickname: '그랩', department: '브랜드마케팅팀', position: '사원' },
];

async function bootstrap() {
  const done = await q("SELECT value FROM settings WHERE key='seeded'");
  const adminEmail = (process.env.ADMIN_EMAIL || 'haze@cafefrihet.com').toLowerCase();

  const existingAdmin = await q('SELECT id FROM users WHERE email=$1', [adminEmail]);
  if (!existingAdmin.rows[0]) {
    const pw = process.env.ADMIN_PASSWORD || 'Fh' + crypto.randomBytes(6).toString('base64url') + '!9';
    await q(
      `INSERT INTO users(email,name,nickname,department,position,role,password_hash,must_change_password)
       VALUES($1,$2,$3,$4,$5,'admin',$6,true)`,
      [adminEmail, process.env.ADMIN_NAME || '헤이즈', '헤이즈', '경영', '대표', await bcrypt.hash(pw, 10)]
    );
    if (!process.env.ADMIN_PASSWORD) console.log(`[seed] 관리자 ${adminEmail} 임시 비밀번호: ${pw} (최초 로그인 후 변경)`);
    else console.log(`[seed] 관리자 ${adminEmail} 생성 (ADMIN_PASSWORD 사용)`);
  }

  if (done.rows[0]) return applyInitialPassword();
  const initial = process.env.INITIAL_PASSWORD;
  for (const s of STAFF) {
    const pw = initial || crypto.randomBytes(12).toString('hex');
    await q(
      `INSERT INTO users(email,name,nickname,department,position,role,password_hash,must_change_password)
       VALUES($1,$2,$3,$4,$5,'user',$6,true) ON CONFLICT (email) DO NOTHING`,
      [s.email, s.name, s.nickname, s.department, s.position, await bcrypt.hash(pw, 10)]
    );
  }
  await q("INSERT INTO settings(key,value) VALUES('seeded','1') ON CONFLICT DO NOTHING");
  await applyInitialPassword();
  console.log(`[seed] 기본 직원 ${STAFF.length}명 등록${initial ? ' (INITIAL_PASSWORD 적용)' : ' (관리자 화면에서 비밀번호 초기화 필요)'}`);
}

// INITIAL_PASSWORD가 새 값으로 바뀐 경우에만: 최초 비밀번호를 아직 바꾸지 않은 일반 직원 계정에 적용
// (이미 본인 비밀번호로 바꾼 직원과 관리자 계정은 건드리지 않음)
async function applyInitialPassword() {
  const pw = process.env.INITIAL_PASSWORD;
  if (!pw) return;
  const mark = crypto.createHash('sha256').update('fbcl:' + pw).digest('hex');
  const cur = await q("SELECT value FROM settings WHERE key='initial_pw_mark'");
  if (cur.rows[0]?.value === mark) return;
  const hash = await bcrypt.hash(pw, 10);
  const r = await q("UPDATE users SET password_hash=$1, token_version=token_version+1 WHERE role<>'admin' AND must_change_password=true RETURNING email", [hash]);
  await q("INSERT INTO settings(key,value) VALUES('initial_pw_mark',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [mark]);
  console.log(`[seed] 변경된 INITIAL_PASSWORD를 최초 비밀번호 미변경 직원 ${r.rowCount}명에게 적용`);
}

module.exports = { bootstrap, STAFF };
