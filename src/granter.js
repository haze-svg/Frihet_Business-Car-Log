// 그랜터(app.granter.biz) 법인카드 사용내역 자동 연동
// - API 키: 환경변수 GRANTER_API_KEY (저장소에 키를 두지 않음)
// - 조회: POST /api/public-docs/tickets (EXPENSE_TICKET), Basic 인증 base64("KEY:")
// - 연동 시작일 이후(기본 2026-11-01) 카드 승인 건을 expenses 에 source='granter' 로 적재
// - 직원은 사용 목적(category)·상세내용(purpose)·영수증만 입력, 금액·일자는 그랜터 기준
const { q, pool } = require('./db');

const BASE = process.env.GRANTER_BASE || 'https://app.granter.biz/api/public-docs';
const DEFAULT_FROM = '2026-11-01';
const INTERVAL_MS = 10 * 60 * 1000;
const UNSET = '미선택';

const state = { running: false, last: null };

const key = () => (process.env.GRANTER_API_KEY || '').trim();
const enabled = () => !!key();

async function getSetting(k, d = null) {
  const r = await q('SELECT value FROM settings WHERE key=$1', [k]);
  return r.rows[0]?.value ?? d;
}
async function setSetting(k, v) {
  await q('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [k, v]);
}
const syncFrom = async () => (await getSetting('granter_sync_from')) || DEFAULT_FROM;

function kstToday() {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
}

async function call(pathname, body) {
  const auth = Buffer.from(key() + ':').toString('base64');
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(BASE + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + auth },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (res.status === 429) {
      const wait = Math.min(Number(res.headers.get('retry-after')) || 10, 60);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`그랜터 API ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }
  throw new Error('그랜터 API 요청 한도 초과 (429)');
}

// 티켓 → 카드 승인 1건으로 정리. 반환 null = 적재 대상 아님
function normalize(t) {
  const u = t.cardUsage || t.purchaseUsage;
  if (!u || !u.card) return null;
  if (t.transactionType && t.transactionType !== 'OUT') return null;
  const gross = Math.round(Number(u.amount) || 0);
  const net = gross - Math.round(Number(u.canceledAmount) || 0);
  const canceled = /CANCEL/i.test(String(u.paymentStatus || '')) || net <= 0;
  const when = String(u.paymentDate || t.transactAt || '');
  return {
    ext_id: 'g' + t.id,
    included: t.isIncluded !== false,
    canceled,
    amount: net,
    date: when.slice(0, 10),
    time: when.slice(11, 16),
    merchant: u.storeName || t.content || '',
    card: {
      id: String(u.card.id),
      name: u.card.nickname || u.card.name || '',
      number: u.card.number || '',
      owners: (u.card.owners || []).filter((x) => !x.isDeleted).map((x) => (x.email || '').toLowerCase()).filter(Boolean),
      ownerNames: (u.card.owners || []).filter((x) => !x.isDeleted).map((x) => (x.name || '').trim()).filter(Boolean),
    },
    users: (t.users || []).filter((x) => !x.isDeleted).map((x) => (x.email || '').toLowerCase()).filter(Boolean),
    userNames: (t.users || []).filter((x) => !x.isDeleted).map((x) => (x.name || '').trim()).filter(Boolean),
  };
}

const isHolder = (u) => !!u && (!!u.team_card || /팀장/.test(u.position || ''));

async function sync({ reason = 'auto' } = {}) {
  if (!enabled()) return { ok: false, error: 'GRANTER_API_KEY 미설정' };
  if (state.running) return { ok: false, error: '동기화 진행 중' };
  state.running = true;
  const started = new Date();
  const out = { ok: true, reason, from: await syncFrom(), to: kstToday(), fetched: 0, inserted: 0, merged: 0, updated: 0, removed: 0, skipped_unmapped: 0, skipped_off: 0 };
  try {
    // 최대 366일 단위로 조회
    const tickets = [];
    let s = out.from;
    while (s <= out.to) {
      const e = new Date(Date.parse(s) + 365 * 864e5).toISOString().slice(0, 10);
      const end = e < out.to ? e : out.to;
      const r = await call('/tickets', { ticketType: 'EXPENSE_TICKET', startDate: s, endDate: end });
      tickets.push(...(Array.isArray(r) ? r : r.data || r.tickets || []));
      s = new Date(Date.parse(end) + 864e5).toISOString().slice(0, 10);
    }
    out.fetched = tickets.length;

    const users = (await q('SELECT id,name,nickname,email,position,team_card,active FROM users')).rows;
    const byEmail = new Map(users.map((u) => [String(u.email || '').toLowerCase(), u]));
    const active = users.filter((u) => u.active);
    // 이름 매칭: 실명 또는 영문 별명(닉네임) 일치. 같은 이름이 2명 이상이면 매칭하지 않음
    const byName = (n) => {
      const k = String(n || '').trim().toLowerCase(); if (!k) return null;
      const hit = active.filter((u) => [u.name, u.nickname].some((x) => String(x || '').trim().toLowerCase() === k));
      return hit.length === 1 ? hit[0] : null;
    };
    // 카드명 앞 담당자 이름 (예: '노아_기업체크카드(8912)' → 노아)
    const byCardName = (name) => { const m = String(name || '').match(/^([^_\s(]+)_/); return m ? byName(m[1]) : null; };
    const seen = new Set();

    for (const t of tickets) {
      const x = normalize(t);
      if (!x || !x.date || x.date < out.from) continue;
      // 카드 목록 갱신
      const card = (await q(
        `INSERT INTO granter_cards(card_id,name,number,owner_emails,last_seen) VALUES($1,$2,$3,$4,now())
         ON CONFLICT (card_id) DO UPDATE SET name=EXCLUDED.name, number=EXCLUDED.number, owner_emails=EXCLUDED.owner_emails, last_seen=now()
         RETURNING *`, [x.card.id, x.card.name, x.card.number, x.card.owners.join(',')]
      )).rows[0];
      seen.add(x.ext_id);
      const cur = (await q('SELECT * FROM expenses WHERE ext_id=$1', [x.ext_id])).rows[0];

      if (card.book === 'off' || !x.included || x.canceled) {
        if (cur) { await removeExpense(cur.id); out.removed++; }
        if (card.book === 'off') out.skipped_off++;
        continue;
      }
      // 사용자: 관리자 지정 > 카드명 담당자 이름 > 그랜터 사용직원(이메일·이름) > 카드 소유자(이메일·이름)
      const user = (card.user_id && users.find((u) => u.id === card.user_id))
        || byCardName(x.card.name)
        || x.users.map((m) => byEmail.get(m)).find(Boolean) || x.userNames.map(byName).find(Boolean)
        || x.card.owners.map((m) => byEmail.get(m)).find(Boolean) || x.card.ownerNames.map(byName).find(Boolean);
      if (!user) { out.skipped_unmapped++; continue; }
      const book = card.book === 'drive' || card.book === 'team' ? card.book : (isHolder(user) ? 'team' : 'drive');

      if (cur) {
        if (cur.amount !== x.amount || cur.expense_date !== x.date || cur.user_id !== user.id || cur.book !== book || cur.merchant !== x.merchant || cur.ext_card !== x.card.id) {
          await q('UPDATE expenses SET amount=$1, expense_date=$2, user_id=$3, book=$4, merchant=$5, pay_time=$6, ext_card=$7 WHERE id=$8',
            [x.amount, x.date, user.id, book, x.merchant, x.time, x.card.id, cur.id]);
          out.updated++;
        }
        continue;
      }
      // 직원이 이미 수기 입력한 같은 날·같은 금액 법인카드 건은 연동 건으로 흡수 (중복 방지, 입력한 목적·영수증 유지)
      const manual = (await q(
        `SELECT id FROM expenses WHERE ext_id IS NULL AND user_id=$1 AND expense_date=$2 AND amount=$3 AND card_type='corporate' AND book=$4 ORDER BY id LIMIT 1`,
        [user.id, x.date, x.amount, book]
      )).rows[0];
      if (manual) {
        await q("UPDATE expenses SET ext_id=$1, ext_card=$2, merchant=$3, pay_time=$4, source='granter' WHERE id=$5", [x.ext_id, x.card.id, x.merchant, x.time, manual.id]);
        out.merged++;
        continue;
      }
      await q(
        `INSERT INTO expenses(user_id,expense_date,card_type,category,purpose,amount,book,source,ext_id,ext_card,merchant,pay_time)
         VALUES($1,$2,'corporate',$3,NULL,$4,$5,'granter',$6,$7,$8,$9)`,
        [user.id, x.date, UNSET, x.amount, book, x.ext_id, x.card.id, x.merchant, x.time]
      );
      out.inserted++;
    }
    // 그랜터에서 사라진 건(삭제·기간 밖 아님) 정리
    const stale = (await q("SELECT id, ext_id FROM expenses WHERE source='granter' AND ext_id IS NOT NULL AND expense_date BETWEEN $1 AND $2", [out.from, out.to])).rows
      .filter((r) => !seen.has(r.ext_id));
    for (const r of stale) { await removeExpense(r.id); out.removed++; }
  } catch (e) {
    out.ok = false; out.error = e.message;
  } finally {
    state.running = false;
    out.at = started.toISOString();
    out.ms = Date.now() - started.getTime();
    state.last = out;
    await setSetting('granter_last_sync', JSON.stringify(out)).catch(() => {});
    if (!out.ok) console.error('[granter] sync failed:', out.error);
  }
  return out;
}

async function removeExpense(id) {
  await q("DELETE FROM photos WHERE owner_type='expense' AND owner_id=$1", [id]);
  await q('DELETE FROM expenses WHERE id=$1', [id]);
}

async function status() {
  const last = state.last || JSON.parse((await getSetting('granter_last_sync')) || 'null');
  return { enabled: enabled(), from: await syncFrom(), running: state.running, last };
}

function start() {
  if (!enabled()) { console.log('[granter] GRANTER_API_KEY 미설정 — 자동 연동 꺼짐'); return; }
  setTimeout(() => sync({ reason: 'startup' }), 15000);
  setInterval(() => sync(), INTERVAL_MS);
}

module.exports = { sync, status, start, enabled, setSetting, UNSET, pool };
