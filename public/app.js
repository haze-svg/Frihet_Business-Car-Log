/* Frihet 업무차량 운행관리 - SPA (빌드 도구 없음) */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = (v) => (Number(v) || 0).toLocaleString('ko-KR');
const km = (v) => (Math.round((Number(v) || 0) * 10) / 10).toLocaleString('ko-KR', { maximumFractionDigits: 1 });
const FUEL = { gasoline: '휘발유', diesel: '경유', lpg: 'LPG', hybrid: '하이브리드(휘발유)', ev: '전기' };
const OWN = { corporate: '법인차량', personal: '개인차량' };
const CARD = { corporate: '법인카드', personal: '개인카드', receipt: '증빙(이관)' };
const EXP_CATS = ['식대', '주유비', '통행료', '주차비', '업무물품구매', '숙박비', '교통비', '기타'];
// 부서팀장 법인카드: 기본 항목 + 부서회식
const TEAM_CATS = ['식대', '부서회식', '주유비', '통행료', '주차비', '업무물품구매', '숙박비', '교통비', '기타'];
const UNSET = '미선택';
// ---- 그랜터 연동 법인카드 건: 카드내역(가맹점·시각·금액)은 고정, 사용 목적·상세내용·영수증만 입력 ----
function gRowHtml(r, cats, withSave = true) {
  const cur = r.category === UNSET ? '' : r.category;
  const std = cats.includes(cur);
  return `<div class="g-row" data-gid="${r.id}"><div class="g-head"><span class="badge corp">법인카드</span><b class="g-merch">${esc(r.merchant || '-')}</b>
      <span class="note">${String(r.expense_date).slice(0, 10)} ${esc(r.pay_time || '')}</span><b class="g-amt">${won(r.amount)}원</b></div>
    <div class="g-in"><select name="gcat"><option value="">사용 목적 선택</option>${cats.map((x) => `<option ${x === (std ? cur : (cur ? '기타' : '')) ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
      <input name="getc" class="${!std && cur ? '' : 'hidden'}" placeholder="기타 사용 목적 직접 입력" value="${!std && cur && cur !== '기타' ? esc(cur) : ''}">
      <input name="gdet" placeholder="상세 내용 (선택)" value="${esc(r.purpose || '')}">
      ${withSave ? '<button class="btn sm primary" data-gsave>저장</button>' : ''}</div>
    <div class="g-ph">${(r.photos || []).length ? thumbs(r.photos) : ''}<label class="note">영수증 사진<input type="file" name="gphotos" accept="image/*,application/pdf" multiple></label></div></div>`;
}
function gVal(el) {
  const sel = $('[name=gcat]', el).value, etc = $('[name=getc]', el).value.trim();
  return { category: !sel ? UNSET : sel === '기타' ? (etc || '기타') : sel, purpose: $('[name=gdet]', el).value };
}
function bindGRows(root, after) {
  $$('.g-row', root).forEach((el) => {
    $('[name=gcat]', el).onchange = (e) => { const on = e.target.value === '기타'; $('[name=getc]', el).classList.toggle('hidden', !on); if (on) $('[name=getc]', el).focus(); };
    const b = $('[data-gsave]', el);
    if (b) b.onclick = async () => {
      const v = gVal(el);
      if ($('[name=gcat]', el).value === '기타' && !$('[name=getc]', el).value.trim()) return toast('기타 사용 목적을 직접 입력하세요', true);
      const fd = new FormData(); fd.append('category', v.category); fd.append('purpose', v.purpose);
      for (const f of $('[name=gphotos]', el).files) fd.append('photos', await shrink(f));
      b.disabled = true;
      try { await api(`/api/expenses/${el.dataset.gid}/classify`, { method: 'PUT', body: fd }); toast('저장되었습니다'); after && after(); } catch (e) { fail(e); b.disabled = false; }
    };
  });
}
const MAINT_TYPES = ['정기점검', '엔진오일', '타이어', '소모품', '수리', '세차', '보험', '검사', '사고', '기타'];

const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const monthRange = (offset = 0) => {
  const d = new Date(Date.now() + 9 * 3600e3);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + offset;
  const s = new Date(Date.UTC(y, m, 1)), e = new Date(Date.UTC(y, m + 1, 0));
  return { from: s.toISOString().slice(0, 10), to: e.toISOString().slice(0, 10) };
};

const state = { me: null, page: 'trips', tripUser: null, vehicle: null, range: monthRange(0), tab: 'trips', jsKey: null };

async function api(path, opts = {}) {
  const o = { credentials: 'same-origin', ...opts };
  if (o.body && !(o.body instanceof FormData)) { o.headers = { 'Content-Type': 'application/json' }; o.body = JSON.stringify(o.body); }
  const res = await fetch(path, o);
  if (res.status === 401 && !path.startsWith('/api/auth')) { showLogin(); throw new Error('로그인이 필요합니다'); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 403 && data?.must_change && !state.forcedPw) changePassword(true);
  if (!res.ok) throw new Error(data?.error || `요청 실패 (${res.status})`);
  return data;
}
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' error' : '');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), 3000);
}
const fail = (e) => toast(e.message || String(e), true);
function openModal(html, wide = false) {
  const c = $('#modal-card'); c.className = 'modal-card' + (wide === 'full' ? ' full' : wide ? ' wide' : ''); c.innerHTML = html;
  $('#modal').classList.remove('hidden');
  $$('[data-close]', c).forEach((b) => (b.onclick = closeModal));
  return c;
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modal-card').innerHTML = ''; }
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal' && !state.forcedPw) closeModal(); });
function lightbox(src) {
  const d = document.createElement('div'); d.className = 'lightbox'; d.innerHTML = `<img src="${src}">`;
  d.onclick = () => d.remove(); document.body.appendChild(d);
}
document.addEventListener('click', (e) => { const img = e.target.closest('img[data-full]'); if (img) lightbox(img.dataset.full); });
const thumbs = (photos) => `<div class="thumbs">${(photos || []).map((p) => p.mime === 'application/pdf'
  ? `<a href="/api/photos/${p.id}" target="_blank">PDF</a>`
  : `<img src="/api/photos/${p.id}" data-full="/api/photos/${p.id}" loading="lazy" alt="">`).join('')}</div>`;
const isAdmin = () => state.me?.role === 'admin';
const userLabel = (u) => `${esc(u.name)}${u.nickname ? `(${esc(u.nickname)})` : ''}`;

function rangeControls(onChange) {
  const id = 'rg' + Math.random().toString(36).slice(2, 7);
  setTimeout(() => {
    const box = document.getElementById(id); if (!box) return;
    const apply = () => { state.range = { from: $('[name=from]', box).value, to: $('[name=to]', box).value }; onChange(); };
    $$('input[type=date]', box).forEach((i) => (i.onchange = apply));
    $('[name=month]', box).onchange = (e) => {
      const [y, m] = e.target.value.split('-').map(Number); if (!y) return;
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      state.range = { from: `${y}-${String(m).padStart(2, '0')}-01`, to: `${y}-${String(m).padStart(2, '0')}-${last}` }; onChange();
    };
    $$('[data-preset]', box).forEach((b) => (b.onclick = () => {
      const p = b.dataset.preset;
      if (p === 'this') state.range = monthRange(0);
      else if (p === 'last') state.range = monthRange(-1);
      else if (p === 'year') { const y = today().slice(0, 4); state.range = { from: `${y}-01-01`, to: `${y}-12-31` }; }
      else if (p === 'all') state.range = { from: '2000-01-01', to: '2999-12-31' };
      onChange();
    }));
  });
  const r = state.range;
  const isMonth = r.from.slice(0, 7) === r.to.slice(0, 7) && r.from.endsWith('-01');
  return `<div class="inline" id="${id}">
    <label class="inline" style="font-size:12px">월 선택 <input type="month" name="month" value="${isMonth ? r.from.slice(0, 7) : ''}"></label>
    <input type="date" name="from" value="${r.from}"> ~ <input type="date" name="to" value="${r.to}">
    <button class="btn sm" data-preset="this">이번 달</button><button class="btn sm" data-preset="last">지난 달</button>
    <button class="btn sm" data-preset="year">올해</button><button class="btn sm" data-preset="all">전체</button></div>`;
}
const rq = () => `from=${state.range.from}&to=${state.range.to}`;

// ---------- 인증 ----------
function showLogin() { $('#app-view').classList.add('hidden'); $('#login-view').classList.remove('hidden'); }
$('#login-form').onsubmit = async (e) => {
  e.preventDefault(); $('#login-err').textContent = '';
  const f = new FormData(e.target);
  try {
    const r = await api('/api/auth/login', { method: 'POST', body: { email: f.get('email'), password: f.get('password') } });
    await boot();
  } catch (err) { $('#login-err').textContent = err.message; }
};
$('#btn-logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); };
$('#btn-pw').onclick = () => changePassword(false);
function changePassword(forced) {
  state.forcedPw = !!forced;
  const c = openModal(`<h2>비밀번호 변경</h2>${forced ? '<p class="warn">최초 로그인입니다. 초기 비밀번호를 본인만 아는 비밀번호로 변경해야 이용할 수 있습니다.</p>' : ''}
    <label>현재 비밀번호<input type="password" name="current"></label>
    <label>새 비밀번호 (8자 이상)<input type="password" name="next"></label>
    <label>새 비밀번호 확인<input type="password" name="next2"></label>
    <div class="modal-actions">${forced ? '<button class="btn" id="pw-logout">로그아웃</button>' : '<button class="btn" data-close>취소</button>'}<button class="btn primary" id="pw-save">변경</button></div>`);
  $('#pw-logout', c)?.addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); });
  $('#pw-save', c).onclick = async () => {
    const v = (n) => $(`[name=${n}]`, c).value;
    if (v('next') !== v('next2')) return toast('새 비밀번호가 일치하지 않습니다', true);
    if (forced && v('next') === v('current')) return toast('기존과 다른 비밀번호를 입력하세요', true);
    try {
      await api('/api/auth/password', { method: 'POST', body: { current: v('current'), next: v('next') } });
      state.forcedPw = false; closeModal(); toast('변경되었습니다');
      if (forced) { state.me.must_change_password = false; render(); }
    } catch (e) { fail(e); }
  };
}

async function boot() {
  try { state.me = await api('/api/me'); } catch { return showLogin(); }
  $('#login-view').classList.add('hidden'); $('#app-view').classList.remove('hidden');
  $('#me-name').innerHTML = `<b>${userLabel(state.me)}</b><br><span class="note">${esc(state.me.department || '')} ${esc(state.me.position || '')}</span>`;
  $$('.admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin()));
  $$('.lead-only').forEach((el) => el.classList.toggle('hidden', !(isAdmin() || state.me.is_holder)));
  if (state.me.must_change_password) { $('#main').innerHTML = '<div class="card">최초 로그인입니다. 비밀번호를 변경한 뒤 이용할 수 있습니다.</div>'; changePassword(true); return; }
  try { const c = await api('/api/public-config'); state.jsKey = c.kakao_js_key; state.granter = !!c.granter; } catch {}
  window.onhashchange = render;
  render();
}
// 주소(#) 기반 화면 전환: 브라우저·마우스 뒤로가기로 이전 화면 복귀
$$('#nav a').forEach((a) => (a.onclick = () => go(a.dataset.page)));
function go(hash) {
  if (location.hash === '#' + hash) render(); else location.hash = hash;
}
const back = (fallback) => { if (history.length > 1 && state.navCount > 1) history.back(); else go(fallback); };
async function render() {
  state.navCount = (state.navCount || 0) + 1;
  const [page, kind, id, sub] = (location.hash.replace('#', '') || 'trips').split('/');
  state.page = page;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  state.tripUser = null; state.vehicle = null; state.cardUser = null;
  try {
    if (page === 'trips' && kind === 'u' && id) {
      state.tripUser = isAdmin() ? (await api('/api/users?all=1')).find((u) => u.id == id) : state.me;
    }
    if (page === 'teamcard' && kind === 'u' && id) state.cardUser = (await api('/api/leads')).find((u) => u.id == id && String(u.card_id || '') === decodeURIComponent(sub || '')) || null;
    if (page === 'maintenance' && kind === 'v' && id) state.vehicle = (await api('/api/vehicles?scope=all')).find((v) => v.id == id) || null;
  } catch (e) { fail(e); }
  // 관리자 전용 화면은 관리자만 (서버에서도 차단)
  if (['staff', 'settings', 'cardadmin'].includes(page) && !isAdmin()) { location.hash = 'trips'; return; }
  ({ trips: pageTrips, maintenance: pageMaint, summary: pageSummary, staff: pageStaff, settings: pageSettings, teamcard: pageTeamCard, cardadmin: pageCardAdmin }[page] || pageTrips)();
  window.scrollTo(0, 0);
}
const backBtn = (fallback) => `<button class="btn sm back-btn" data-back="${fallback}">← 뒤로</button>`;
document.addEventListener('click', (e) => { const b = e.target.closest('[data-back]'); if (b) back(b.dataset.back); });

// ---------- 숫자 상세 보기 (드릴다운) ----------
// dd(title, query) → 클릭 가능한 속성. query: kind, user_ids, book, card_type, category, has_photo, ym, vehicle_id, scope, holders, sum
const dd = (title, qo) => `data-drill="${esc(JSON.stringify({ title, q: qo }))}" title="눌러서 상세 보기"`;
const ddLink = (v, title, qo) => `<span class="dl" ${dd(title, qo)}>${v}</span>`;
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-drill]'); if (!el) return;
  e.stopPropagation(); e.preventDefault();
  const d = JSON.parse(el.dataset.drill); openDrill(d.title, d.q);
}, true);
const SUMK = { trip_count: null, distance_km: 'distance_km', fuel_cost_won: 'fuel_cost_won', toll_won: 'toll_won', parking_won: 'parking_won', operating_cost_won: 'op' };
async function openDrill(title, qo) {
  const c = openModal(`<div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(title)}</h2><button class="btn" data-close>닫기</button></div><div class="note">불러오는 중…</div>`, 'full');
  try {
    const params = new URLSearchParams({ from: qo.from || state.range.from, to: qo.to || state.range.to });
    Object.entries(qo).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '' && !['sum', 'from', 'to'].includes(k)) params.set(k, Array.isArray(v) ? v.join(',') : v); });
    const d = await api('/api/records?' + params);
    const R = d.rows; const n = R.length;
    let head, body, foot;
    const who = (r) => `${esc(r.name || '')}${r.nickname ? `(${esc(r.nickname)})` : ''}`;
    if (d.kind === 'trips') {
      const op = (r) => r.fuel_cost_won + r.toll_won + r.parking_won;
      const S = (f) => R.reduce((a, r) => a + Number(f(r)), 0);
      head = '<th>일자</th><th>직원</th><th>차량</th><th>목적</th><th>출발 → 도착</th><th class="n">km</th><th class="n">연료비</th><th class="n">통행료</th><th class="n">주차비</th><th class="n">운행비</th>';
      body = R.map((r) => `<tr><td>${r.trip_date.slice(0, 10)}</td><td>${who(r)}</td><td>${esc(r.plate || '')}</td><td class="wrap">${esc(r.purpose || '')}</td><td class="wrap">${esc(r.start_name || '')} → ${esc(r.end_name || '')}${r.round_trip ? ' (왕복)' : ''}</td>
        <td class="n">${km(r.distance_km)}</td><td class="n">${won(r.fuel_cost_won)}</td><td class="n">${won(r.toll_won)}</td><td class="n">${won(r.parking_won)}</td><td class="n"><b>${won(op(r))}</b></td></tr>`).join('');
      foot = `<td colspan="5">합계 ${n}건</td><td class="n">${km(S((r) => r.distance_km))}</td><td class="n">${won(S((r) => r.fuel_cost_won))}</td><td class="n">${won(S((r) => r.toll_won))}</td><td class="n">${won(S((r) => r.parking_won))}</td><td class="n">${won(S(op))}</td>`;
    } else if (d.kind === 'expenses') {
      const tot = R.reduce((a, r) => a + r.amount, 0), ph = R.reduce((a, r) => a + r.photos.length, 0);
      head = '<th>일자</th><th>직원</th><th>장부</th><th>카드</th><th>항목</th><th>목적</th><th class="n">금액</th><th>영수증</th>';
      body = R.map((r) => `<tr><td>${r.expense_date.slice(0, 10)}</td><td>${who(r)}</td><td>${r.book === 'team' ? '팀장카드' : '운행일지'}</td>
        <td><span class="badge ${r.card_type === 'personal' ? 'pers' : 'corp'}">${CARD[r.card_type]}</span></td><td>${esc(r.category)}</td><td class="wrap">${esc(r.purpose || '')}${r.memo ? `<div class="note">${esc(r.memo)}</div>` : ''}</td>
        <td class="n"><b>${won(r.amount)}</b></td><td>${thumbs(r.photos)}</td></tr>`).join('');
      foot = `<td colspan="6">합계 ${n}건 · 영수증 ${ph}장</td><td class="n">${won(tot)}</td><td></td>`;
    } else {
      const tot = R.reduce((a, r) => a + r.amount, 0);
      head = '<th>일자</th><th>차량</th><th>직원</th><th>구분</th><th class="n">주행거리</th><th>내용</th><th>업체</th><th class="n">금액</th><th>사진</th>';
      body = R.map((r) => `<tr><td>${r.maint_date.slice(0, 10)}</td><td>${esc(r.plate || '')}</td><td>${who(r)}</td><td>${esc(r.maint_type)}</td><td class="n">${r.odometer_km ? won(r.odometer_km) : '-'}</td>
        <td class="wrap">${esc(r.description || '')}</td><td>${esc(r.vendor || '')}</td><td class="n"><b>${won(r.amount)}</b></td><td>${thumbs(r.photos)}</td></tr>`).join('');
      foot = `<td colspan="7">합계 ${n}건</td><td class="n">${won(tot)}</td><td></td>`;
    }
    c.innerHTML = `<div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(title)}</h2><button class="btn" data-close>닫기</button></div>
      <p class="note">기간 ${d.from} ~ ${d.to} · ${n}건${n >= 3000 ? ' (최대 3,000건까지 표시)' : ''}</p>
      <div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="10" class="empty">해당 기록 없음</td></tr>`}</tbody>${n ? `<tfoot><tr>${foot}</tr></tfoot>` : ''}</table></div>`;
    $$('[data-close]', c).forEach((b) => (b.onclick = closeModal));
  } catch (e) { closeModal(); fail(e); }
}
function vehicleDrill(title, list, map) {
  const c = openModal(`<div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(title)} · ${list.length}대</h2><button class="btn" data-close>닫기</button></div>
    <div class="table-wrap"><table><thead><tr><th>차량</th><th>구분</th><th>담당자</th><th class="n">추정 주행거리</th><th>최근 정비</th><th>상태·사유</th></tr></thead><tbody>
    ${list.map((v) => `<tr class="clickable" data-vgo="${v.id}"><td><b>${esc(v.plate)}</b></td><td>${OWN[v.ownership]}</td><td>${esc(v.user_name || '-')}</td>
      <td class="n">${map[v.id]?.est_odometer != null ? won(map[v.id].est_odometer) + 'km' : '확인 불가'}</td><td>${map[v.id]?.recent ? map[v.id].recent.maint_date + ' ' + esc(map[v.id].recent.maint_type) : '없음'}</td>
      <td class="wrap">${(map[v.id]?.alerts || []).map((a) => `<div><span class="al ${LV[a.level][0]}">${esc(a.title)}</span> ${esc(a.reason)}</div>`).join('') || '-'}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">해당 차량 없음</td></tr>'}
    </tbody></table></div><p class="note">행을 누르면 해당 차량 관리·점검일지로 이동합니다.</p>`, 'full');
  $$('[data-vgo]', c).forEach((tr) => (tr.onclick = () => { closeModal(); go('maintenance/v/' + tr.dataset.vgo); }));
}

// ---------- 차량 정비 상태 표시 ----------
const LV = { overdue: ['al-red', '교체 필요'], unknown: ['al-amber', '확인 필요'], soon: ['al-orange', '임박'], ok: ['al-green', '정상'] };
async function vehicleStatusMap(ids, all) {
  try { const r = await api('/api/vehicle-status?scope=' + (all ? 'all' : 'mine') + (ids ? '&ids=' + ids.join(',') : '')); const m = {}; r.items.forEach((x) => (m[x.vehicle_id] = x)); return { map: m, rules: r.rules }; }
  catch { return { map: {}, rules: null }; }
}
function alertChips(st) {
  if (!st) return '<span class="note">정비 상태 데이터 확인 불가</span>';
  return st.alerts.map((a) => `<span class="al ${LV[a.level][0]}" title="${esc(a.reason)}">${esc(a.title)}</span>`).join('');
}
function alertReasons(st) {
  if (!st) return '';
  return `<ul class="al-reasons">${st.alerts.map((a) => `<li><span class="al ${LV[a.level][0]}">${esc(a.title)}</span> ${esc(a.reason)}</li>`).join('')}</ul>`;
}
function vehiclePanel(v, st) {
  const r = st?.recent;
  return `<div class="card veh-panel lv-${st?.worst || 'ok'}">
    <div class="row" style="justify-content:space-between"><div class="row"><b style="font-size:17px">${esc(v.plate)}</b>
      <span class="badge ${v.ownership === 'corporate' ? 'corp' : 'pers'}">${OWN[v.ownership]}</span>${v.active ? '' : '<span class="badge off">미사용</span>'}</div>
      <button class="btn sm" data-gov="${v.id}">관리·점검일지 →</button></div>
    <div class="veh-specs"><div><span>차종</span><b>${esc(v.model || '미입력')}</b></div><div><span>유종</span><b>${FUEL[v.fuel_type]}</b></div>
      <div><span>공식연비</span><b>${v.efficiency_km_l ? v.efficiency_km_l + ' km/L' : '미등록'}</b></div>
      <div><span>추정 주행거리</span><b>${st?.est_odometer != null ? won(st.est_odometer) + ' km' : '데이터 확인 불가'}</b></div>
      <div><span>최근 정비</span><b>${r ? `${r.maint_date} ${esc(r.maint_type)}` : '기록 없음'}</b></div></div>
    <div class="row">${alertChips(st)}</div>
    <details><summary class="note">알림 사유 보기</summary>${alertReasons(st)}${st?.odometer_basis ? `<div class="note">주행거리 추정 근거: ${esc(st.odometer_basis)}</div>` : ''}</details></div>`;
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-gov]'); if (b) go('maintenance/v/' + b.dataset.gov); });

// ========== 차량운행일지 ==========
async function pageTrips() {
  const main = $('#main');
  if (!isAdmin()) state.tripUser = state.me;
  if (!state.tripUser) {
    const users = await api('/api/users');
    const groups = {};
    users.forEach((u) => (groups[u.department || '미지정'] ||= []).push(u));
    main.innerHTML = `<div class="page-head"><h1>차량운행일지</h1></div><p class="note">직원을 선택하세요.</p>` +
      Object.entries(groups).map(([d, list]) => `<div class="dept-title">${esc(d)}</div><div class="cards">${list.map((u) => `
        <div class="card pick" data-uid="${u.id}"><div class="row" style="justify-content:space-between"><div class="t">${userLabel(u)}</div>${isAdmin() ? `<button class="btn sm" data-uedit="${u.id}">수정</button>` : ''}</div>
        <div class="s">${esc(u.position || '')} · ${u.vehicles.map((v) => `${esc(v.plate)} (${OWN[v.ownership]})`).join(', ') || '차량 미등록'}</div></div>`).join('')}</div>`).join('');
    $$('[data-uid]', main).forEach((el) => (el.onclick = (ev) => {
      if (ev.target.closest('[data-uedit]')) return;
      go('trips/u/' + el.dataset.uid);
    }));
    $$('[data-uedit]', main).forEach((b) => (b.onclick = async (ev) => {
      ev.stopPropagation();
      const [all, models] = await Promise.all([api('/api/users?all=1'), api('/api/vehicle-models')]);
      userForm(all.find((x) => x.id == b.dataset.uedit), models, pageTrips);
    }));
    return;
  }
  const u = state.tripUser;
  const qs = `user_id=${u.id}&${rq()}`;
  const [trips, exps, vehicles] = await Promise.all([api(`/api/trips?${qs}`), api(`/api/expenses?${qs}`), api('/api/vehicles')]);
  const myVehicles = vehicles.filter((v) => v.user_id === u.id && v.active);
  const vst = myVehicles.length ? await vehicleStatusMap(myVehicles.map((v) => v.id)) : { map: {} };
  const t = trips.reduce((a, r) => ({ km: a.km + Number(r.distance_km), toll: a.toll + r.toll_won, fuel: a.fuel + r.fuel_cost_won, park: a.park + r.parking_won }), { km: 0, toll: 0, fuel: 0, park: 0 });
  const e = exps.reduce((a, r) => { if (r.card_type in a) a[r.card_type] += r.amount; return a; }, { corporate: 0, personal: 0 });

  main.innerHTML = `
    <div class="crumb">${isAdmin() ? `${backBtn('trips')} <a id="back">차량운행일지</a> / ` : ''}${userLabel(u)}</div>
    <div class="page-head"><h1>${userLabel(u)} 운행일지</h1>${isAdmin() ? '<button class="btn sm" id="u-edit">직원·차량 수정</button>' : ''}<div class="grow"></div>${rangeControls(pageTrips)}
      <a class="btn" href="/api/export?${qs}">엑셀 다운로드</a></div>
    <div class="veh-panels">${myVehicles.map((v) => vehiclePanel(v, vst.map[v.id])).join('') || '<div class="card note">등록된 사용 차량이 없습니다.</div>'}</div>
    <div class="kpis">
      <div class="kpi pick" ${dd(u.name + ' 운행 기록', { kind: 'trips', user_ids: u.id })}><div class="l">운행 횟수</div><div class="v">${trips.length}회</div></div>
      <div class="kpi pick" ${dd(u.name + ' 운행 거리', { kind: 'trips', user_ids: u.id })}><div class="l">운행 거리</div><div class="v">${km(t.km)} km</div></div>
      <div class="kpi pick" ${dd(u.name + ' 연료비', { kind: 'trips', user_ids: u.id })}><div class="l">연료비(공식연비 기준)</div><div class="v">${won(t.fuel)}원</div></div>
      <div class="kpi pick" ${dd(u.name + ' 통행료', { kind: 'trips', user_ids: u.id })}><div class="l">통행료</div><div class="v">${won(t.toll)}원</div></div>
      <div class="kpi pick" ${dd(u.name + ' 운행비', { kind: 'trips', user_ids: u.id })}><div class="l">운행비 합계</div><div class="v">${won(t.fuel + t.toll + t.park)}원</div></div>
      <div class="kpi pick" id="kpi-card" title="카드 사용 상세 보기"><div class="l">법인카드 / 개인카드 ›</div><div class="v">${won(e.corporate)} / ${won(e.personal)}</div></div>
    </div>
    <div class="tabs"><a data-tab="trips">운행 기록 (${trips.length})</a><a data-tab="expenses">카드 사용 (${exps.length})</a></div>
    <div id="tab-body"></div>`;
  $('#back')?.addEventListener('click', () => go('trips'));
  $('#u-edit')?.addEventListener('click', async () => {
    const [all, models] = await Promise.all([api('/api/users?all=1'), api('/api/vehicle-models')]);
    userForm(all.find((x) => x.id === u.id), models, render);
  });
  $('#kpi-card').onclick = () => { state.tab = 'expenses'; renderTab(); $('.tabs').scrollIntoView({ behavior: 'smooth' }); };
  const renderTab = () => {
    $$('.tabs a', main).forEach((a) => a.classList.toggle('active', a.dataset.tab === state.tab));
    const body = $('#tab-body');
    if (state.tab === 'trips') {
      body.innerHTML = `<div class="row" style="margin-bottom:10px"><button class="btn primary" id="add-trip">+ 운행 기록 (하루 일괄 입력)</button>
        ${myVehicles.length ? '' : '<span class="warn">등록된 차량이 없습니다. 연료비 자동계산을 위해 차량을 먼저 등록하세요.</span>'}</div>
        <div class="table-wrap"><table><thead><tr><th>일자</th><th>차량</th><th>목적</th><th>출발</th><th>도착</th><th>왕복</th>
        <th class="n">거리(km)</th><th class="n">통행료</th><th class="n">유가(원/L)</th><th class="n">연비</th><th class="n">연료비</th><th class="n">주차비</th><th class="n">운행비</th><th></th></tr></thead>
        <tbody>${trips.map((r) => `<tr><td>${r.trip_date.slice(0, 10)}</td><td>${esc(r.plate || '')}</td><td class="wrap">${esc(r.purpose)}</td>
          <td class="wrap">${esc(r.start_name)}</td><td class="wrap">${esc(r.end_name)}</td><td>${r.round_trip ? '왕복' : '편도'}</td>
          <td class="n">${km(r.distance_km)}</td><td class="n">${won(r.toll_won)}</td><td class="n">${r.fuel_price_won ? won(r.fuel_price_won) : '-'}</td>
          <td class="n">${r.efficiency_km_l ?? '-'}</td><td class="n">${won(r.fuel_cost_won)}</td><td class="n">${won(r.parking_won)}</td>
          <td class="n"><b>${won(r.fuel_cost_won + r.toll_won + r.parking_won)}</b></td>
          <td><button class="btn sm" data-edit="${r.id}">수정</button></td></tr>`).join('') || '<tr><td colspan="14" class="empty">기록 없음</td></tr>'}</tbody>
        <tfoot><tr><td colspan="6">합계</td><td class="n">${km(t.km)}</td><td class="n">${won(t.toll)}</td><td></td><td></td><td class="n">${won(t.fuel)}</td><td class="n">${won(t.park)}</td><td class="n">${won(t.fuel + t.toll + t.park)}</td><td></td></tr></tfoot></table></div>`;
      $('#add-trip').onclick = () => dayForm(u, myVehicles);
      $$('[data-edit]', body).forEach((b) => (b.onclick = () => tripForm(u, myVehicles, trips.find((x) => x.id == b.dataset.edit))));
    } else {
      const real = exps.filter((r) => r.card_type !== 'receipt');
      const bundles = exps.filter((r) => r.card_type === 'receipt');
      const days = {};
      real.forEach((r) => ((days[r.expense_date.slice(0, 10)] ||= { corporate: [], personal: [] })[r.card_type].push(r)));
      const nPhotos = exps.reduce((a, r) => a + r.photos.length, 0);
      const item = (r) => r.source === 'granter' ? `<div class="exp-item">${gRowHtml(r, EXP_CATS)}</div>` : `<div class="exp-item"><div class="row" style="justify-content:space-between"><span><span class="badge ${r.card_type === 'corporate' ? 'corp' : 'pers'}">${esc(r.category)}</span> ${esc(r.purpose || '')}</span><b>${won(r.amount)}원</b></div>
        ${r.photos.length ? `<div class="thumbs big">${thumbs(r.photos).replace('<div class="thumbs">', '').replace(/<\/div>$/, '')}</div>` : '<div class="note">영수증 없음</div>'}
        ${r.memo ? `<div class="note">${esc(r.memo)}</div>` : ''}<div style="text-align:right"><button class="btn sm" data-edit="${r.id}">수정</button></div></div>`;
      body.innerHTML = `<div class="row" style="margin-bottom:10px"><button class="btn primary" id="add-exp">+ ${state.granter ? '개인카드 사용 등록' : '카드 사용 단건 등록'}</button>
          <button class="btn" id="add-day2">+ 하루 일괄 입력</button></div>
        <div class="kpis">
          <div class="kpi pick" ${dd(u.name + ' 법인카드', { kind: 'expenses', user_ids: u.id, card_type: 'corporate' })}><div class="l">법인카드 합계</div><div class="v" style="color:var(--corp)">${won(e.corporate)}원</div><div class="note">${real.filter((r) => r.card_type === 'corporate').length}건</div></div>
          <div class="kpi pick" ${dd(u.name + ' 개인카드', { kind: 'expenses', user_ids: u.id, card_type: 'personal' })}><div class="l">개인카드 합계</div><div class="v" style="color:var(--pers)">${won(e.personal)}원</div><div class="note">${real.filter((r) => r.card_type === 'personal').length}건</div></div>
          <div class="kpi pick" ${dd(u.name + ' 카드 사용 전체', { kind: 'expenses', user_ids: u.id })}><div class="l">총 합계</div><div class="v">${won(e.corporate + e.personal)}원</div></div>
          <div class="kpi pick" ${dd(u.name + ' 영수증 있는 카드 사용', { kind: 'expenses', user_ids: u.id, has_photo: 1 })}><div class="l">영수증 사진</div><div class="v">${nPhotos}장</div></div></div>
        ${Object.keys(days).sort().reverse().map((d) => { const D = days[d]; const sc = D.corporate.reduce((a, r) => a + r.amount, 0), sp = D.personal.reduce((a, r) => a + r.amount, 0);
          return `<div class="card day-block"><div class="row" style="justify-content:space-between;margin-bottom:8px"><b>${d}</b>
            <span class="note">법인 <b style="color:var(--corp)">${won(sc)}</b> · 개인 <b style="color:var(--pers)">${won(sp)}</b> · 합계 <b>${won(sc + sp)}원</b></span></div>
            <div class="grid2"><div><div class="col-title corp">법인카드</div>${D.corporate.map(item).join('') || '<div class="note">-</div>'}</div>
            <div><div class="col-title pers">개인카드</div>${D.personal.map(item).join('') || '<div class="note">-</div>'}</div></div></div>`; }).join('') || '<div class="empty card">기간 내 카드 사용 내역 없음</div>'}
        ${bundles.length ? `<h2 style="margin-top:18px">엑셀 이관 영수증 (월별 일괄 · 건별 구분 불가)</h2>${bundles.map((r) => `<div class="card day-block"><div class="row" style="justify-content:space-between"><b>${esc(r.purpose)}</b><span class="note">${esc(r.memo || '')}</span></div><div class="thumbs big">${thumbs(r.photos).replace('<div class="thumbs">', '').replace(/<\/div>$/, '')}</div></div>`).join('')}` : ''}`;
      $('#add-day2').onclick = () => dayForm(u, myVehicles);
      $('#add-exp').onclick = () => expenseForm(u, myVehicles, null);
      $$('[data-edit]', body).forEach((b) => (b.onclick = () => expenseForm(u, myVehicles, exps.find((x) => x.id == b.dataset.edit))));
      bindGRows(body, pageTrips);
      const nUnset = real.filter((r) => r.category === UNSET).length;
      if (nUnset) body.insertAdjacentHTML('afterbegin', `<div class="warn" style="margin-bottom:10px">사용 목적을 선택하지 않은 법인카드 사용 ${nUnset}건이 있습니다. 각 건 옆에서 선택 후 저장하세요.</div>`);
    }
  };
  $$('.tabs a', main).forEach((a) => (a.onclick = () => { state.tab = a.dataset.tab; renderTab(); }));
  renderTab();
}

function placeInput(name, label, init) {
  return `<div class="place" data-place="${name}"><label>${label}<input class="pq" placeholder="장소·주소 검색 (카카오맵)" value="${esc(init?.name || '')}" autocomplete="off"></label>
    <div class="results hidden"></div><div class="chosen">${init?.addr ? '✓ ' + esc(init.addr) : ''}</div></div>`;
}
function bindPlace(box, onPick, initVal) {
  const input = $('.pq', box), results = $('.results', box), chosen = $('.chosen', box);
  box._val = initVal || null; let timer; let list = []; let pending = null;
  const pick = (p) => {
    box._val = p; input.value = p.name; chosen.textContent = '✓ ' + p.address; chosen.classList.remove('warn');
    results.classList.add('hidden'); onPick(p);
  };
  const search = async (qv) => {
    list = await api('/api/places?q=' + encodeURIComponent(qv));
    results.innerHTML = list.map((p, i) => `<div data-i="${i}"><b>${esc(p.name)}</b><small>${esc(p.address)} ${p.category ? '· ' + esc(p.category) : ''}</small></div>`).join('') || '<div>검색 결과 없음 — 다른 이름이나 도로명 주소로 입력하세요</div>';
    $$('[data-i]', results).forEach((d) => (d.onmousedown = (ev) => { ev.preventDefault(); pick(list[d.dataset.i]); }));
    return list;
  };
  input.oninput = () => {
    box._val = null; list = []; chosen.textContent = ''; onPick(null);
    clearTimeout(timer);
    const qv = input.value.trim(); if (qv.length < 1) return results.classList.add('hidden');
    timer = setTimeout(() => {
      pending = search(qv).then(() => { if (document.activeElement === input) results.classList.remove('hidden'); })
        .catch((e) => { results.innerHTML = `<div class="warn">${esc(e.message)}</div>`; results.classList.remove('hidden'); });
    }, 250);
  };
  // 목록을 누르지 않고 Enter·다음 칸 이동 시 첫 번째 결과를 자동 선택
  const autoPick = async () => {
    if (box._val) return;
    const qv = input.value.trim(); if (qv.length < 1) return;
    clearTimeout(timer);
    try { if (!list.length) await search(qv); } catch (e) { chosen.textContent = e.message; chosen.classList.add('warn'); return; }
    if (list.length) pick(list[0]);
    else { chosen.textContent = '장소를 찾지 못했습니다 — 거리를 직접 입력하세요'; chosen.classList.add('warn'); }
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); autoPick(); } };
  input.onblur = () => { results.classList.add('hidden'); autoPick(); };
}

// 업로드 전 사진 축소 (긴 변 1600px JPEG) — 업로드 실패·용량 문제 방지
async function shrink(file) {
  if (!file.type.startsWith('image/') || file.size < 400 * 1024) return file;
  try {
    const img = await createImageBitmap(file);
    const sc = Math.min(1, 1600 / Math.max(img.width, img.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.8));
    return blob ? new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}

let kakaoLoading;
function loadKakao() {
  if (!state.jsKey) return Promise.reject(new Error('no key'));
  if (window.kakao?.maps?.LatLng) return Promise.resolve();
  kakaoLoading ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${state.jsKey}&autoload=false`;
    s.onload = () => kakao.maps.load(res); s.onerror = rej; document.head.appendChild(s);
  });
  return kakaoLoading;
}
async function drawMap(el, a, b) {
  try {
    await loadKakao(); el.classList.remove('hidden');
    const map = new kakao.maps.Map(el, { center: new kakao.maps.LatLng(a.y, a.x), level: 8 });
    const bounds = new kakao.maps.LatLngBounds();
    [a, b].forEach((p) => { const ll = new kakao.maps.LatLng(p.y, p.x); new kakao.maps.Marker({ map, position: ll }); bounds.extend(ll); });
    map.setBounds(bounds);
  } catch { el.classList.add('hidden'); }
}

async function tripForm(u, vehicles, rec) {
  const r = rec || { trip_date: today(), vehicle_id: vehicles[0]?.id, round_trip: false, distance_km: '', toll_won: 0, parking_won: 0 };
  const c = openModal(`<h2>${rec ? '운행 기록 수정' : '운행 기록 추가'} · ${userLabel(u)}</h2>
    <div class="grid3"><label>운행일자<input type="date" name="trip_date" value="${String(r.trip_date).slice(0, 10)}"></label>
      <label>차량<select name="vehicle_id">${vehicles.map((v) => `<option value="${v.id}" ${v.id == r.vehicle_id ? 'selected' : ''}>${esc(v.plate)} · ${OWN[v.ownership]} · ${FUEL[v.fuel_type]}</option>`).join('') || '<option value="">차량 없음</option>'}</select></label>
      <label>운행 목적<input name="purpose" value="${esc(r.purpose || '')}" placeholder="예: 매장 점검"></label></div>
    <div class="grid2">${placeInput('start', '출발지', rec && { name: r.start_name, addr: r.start_addr })}${placeInput('end', '도착지', rec && { name: r.end_name, addr: r.end_addr })}</div>
    <div class="row"><label class="inline" style="font-size:13px;color:var(--ink)"><input type="checkbox" name="round_trip" style="width:auto" ${r.round_trip ? 'checked' : ''}> 왕복 (거리·통행료 ×2)</label>
      <span class="note" id="route-status"></span></div>
    <div id="route-map" class="hidden"></div>
    <div class="grid3"><label>운행거리 (km)<input name="distance_km" inputmode="decimal" value="${r.distance_km ?? ''}"></label>
      <label>예상 통행료 (원)<input name="toll_won" inputmode="numeric" value="${r.toll_won ?? 0}"></label>
      <label>주차비 (원)<input name="parking_won" inputmode="numeric" value="${r.parking_won ?? 0}"></label></div>
    <div class="grid2"><label>유가 (원/L, 전기는 원/kWh)<input name="fuel_price_won" inputmode="decimal" value="${r.fuel_price_won ?? ''}"></label>
      <label>공식연비 (km/L, 전기는 km/kWh)<input name="efficiency_km_l" inputmode="decimal" value="${r.efficiency_km_l ?? ''}"></label></div>
    <div class="calc"><div><div class="l">거리</div><div class="v" id="c-km">-</div></div><div><div class="l">연료비</div><div class="v" id="c-fuel">-</div></div>
      <div><div class="l">통행료+주차</div><div class="v" id="c-toll">-</div></div><div><div class="l">운행비 합계</div><div class="v" id="c-total">-</div></div></div>
    <div class="note" id="price-src"></div>
    <label>비고<input name="memo" value="${esc(r.memo || '')}"></label>
    <div class="modal-actions">${rec ? '<button class="btn danger" id="del">삭제</button><div style="flex:1"></div>' : ''}<button class="btn" data-close>취소</button><button class="btn primary" id="save">저장</button></div>`, true);
  const f = (n) => $(`[name=${n}]`, c);
  const base = { km: null, toll: null };
  const recalc = () => {
    const d = Number(f('distance_km').value) || 0, eff = Number(f('efficiency_km_l').value) || 0, p = Number(f('fuel_price_won').value) || 0;
    const fuel = d && eff && p ? Math.round((d / eff) * p) : 0;
    const toll = (Number(f('toll_won').value) || 0) + (Number(f('parking_won').value) || 0);
    $('#c-km', c).textContent = km(d) + ' km'; $('#c-fuel', c).textContent = eff && p ? won(fuel) + '원' : '데이터 확인 불가';
    $('#c-toll', c).textContent = won(toll) + '원'; $('#c-total', c).textContent = won(fuel + toll) + '원';
  };
  const setVehicle = async (initial) => {
    const v = vehicles.find((x) => x.id == f('vehicle_id').value);
    if (!v) return recalc();
    if (!initial || !rec) f('efficiency_km_l').value = v.efficiency_km_l ?? '';
    if (!initial || !rec) {
      try {
        const fp = await api('/api/fuel-price?type=' + v.fuel_type);
        f('fuel_price_won').value = fp.price ?? '';
        $('#price-src', c).textContent = fp.price
          ? `유가 ${won(fp.price)}원 · 출처: ${fp.source === 'opinet' ? '오피넷 전국평균' : '관리자 수동입력'} (${fp.date})`
          : '유가 데이터 확인 불가 — 설정에서 오피넷 키 또는 수동 유가를 등록하세요';
      } catch (e) { fail(e); }
    }
    if (!v.efficiency_km_l) $('#price-src', c).textContent += ' · 이 차량의 공식연비가 미등록 상태입니다';
    recalc();
  };
  const applyRoute = () => {
    if (base.km === null) return;
    const m = f('round_trip').checked ? 2 : 1;
    f('distance_km').value = Math.round(base.km * m * 10) / 10; f('toll_won').value = base.toll * m; recalc();
  };
  const boxS = $('[data-place=start]', c), boxE = $('[data-place=end]', c);
  const initS = rec?.start_x ? { name: r.start_name, address: r.start_addr, x: r.start_x, y: r.start_y } : null;
  const initE = rec?.end_x ? { name: r.end_name, address: r.end_addr, x: r.end_x, y: r.end_y } : null;
  const onPick = async () => {
    const a = boxS._val, b = boxE._val; if (!a || !b) return;
    $('#route-status', c).textContent = '경로 계산 중…';
    try {
      const rt = await api(`/api/route?sx=${a.x}&sy=${a.y}&ex=${b.x}&ey=${b.y}`);
      base.km = rt.distance_km; base.toll = rt.toll_won; applyRoute();
      $('#route-status', c).textContent = `카카오 추천경로 편도 ${km(rt.distance_km)}km · 약 ${rt.duration_min}분 · 통행료 ${won(rt.toll_won)}원`;
      drawMap($('#route-map', c), a, b);
    } catch (e) { $('#route-status', c).textContent = e.message + ' — 거리 직접 입력 가능'; }
  };
  bindPlace(boxS, onPick, initS); bindPlace(boxE, onPick, initE);
  f('round_trip').onchange = applyRoute;
  f('vehicle_id').onchange = () => setVehicle(false);
  ['distance_km', 'toll_won', 'parking_won', 'fuel_price_won', 'efficiency_km_l'].forEach((n) => (f(n).oninput = recalc));
  await setVehicle(true);
  $('#save', c).onclick = async () => {
    const s = boxS._val, e = boxE._val;
    const body = {
      user_id: u.id, trip_date: f('trip_date').value, vehicle_id: f('vehicle_id').value || null, purpose: f('purpose').value,
      start_name: $('.pq', boxS).value, start_addr: s?.address, start_x: s?.x, start_y: s?.y,
      end_name: $('.pq', boxE).value, end_addr: e?.address, end_x: e?.x, end_y: e?.y,
      round_trip: f('round_trip').checked, distance_km: f('distance_km').value, toll_won: f('toll_won').value,
      parking_won: f('parking_won').value, fuel_price_won: f('fuel_price_won').value, efficiency_km_l: f('efficiency_km_l').value, memo: f('memo').value,
    };
    try { await api(rec ? `/api/trips/${rec.id}` : '/api/trips', { method: rec ? 'PUT' : 'POST', body }); closeModal(); toast('저장되었습니다'); pageTrips(); } catch (err) { fail(err); }
  };
  $('#del', c)?.addEventListener('click', async () => {
    if (!confirmInline(c, '이 운행 기록을 삭제합니다')) return;
    try { await api(`/api/trips/${rec.id}`, { method: 'DELETE' }); closeModal(); pageTrips(); } catch (e) { fail(e); }
  });
}
// 브라우저 confirm() 대신 버튼 2회 클릭 확인
function confirmInline(c, msg) {
  const b = $('#del', c);
  if (b.dataset.armed) return true;
  b.dataset.armed = '1'; b.textContent = '한 번 더 눌러 삭제'; toast(msg + ' — 삭제 버튼을 한 번 더 누르세요');
  setTimeout(() => { delete b.dataset.armed; b.textContent = '삭제'; }, 4000);
  return false;
}

// ========== 하루 일괄 입력: 여러 구간 운행 + 법인/개인 카드 사용 + 당일 합계 ==========
async function dayForm(u, vehicles) {
  const c = openModal(`<div class="row" style="justify-content:space-between"><h2 style="margin:0">운행 기록 · ${userLabel(u)}</h2><button class="btn" data-close>닫기</button></div>
    <div class="grid3"><label>운행일자<input type="date" name="date" value="${today()}"></label>
      <label>차량<select name="vehicle_id">${vehicles.map((v) => `<option value="${v.id}">${esc(v.plate)} · ${OWN[v.ownership]} · ${FUEL[v.fuel_type]}</option>`).join('') || '<option value="">차량 없음</option>'}</select></label>
      <label>운행 목적 (전체 구간 공통)<input name="purpose" placeholder="예: 매장 점검·라운딩"></label></div>
    <div class="grid2"><label>유가 (원/L)<input name="price" inputmode="decimal"></label><label>공식연비 (km/L)<input name="eff" inputmode="decimal"></label></div>
    <div class="note" id="price-src"></div>
    <h3 class="sec">이동 구간</h3>
    <div id="legs"></div>
    <div><button class="btn" id="add-leg">+ 구간 추가 (이어서 이동한 장소)</button></div>
    <h3 class="sec">카드 사용 내역</h3>
    <div class="grid2 cards2">
      <div class="card-col corp"><div class="col-title corp">법인카드${state.granter ? ' <span class="note">(그랜터 카드내역 자동 불러오기)</span>' : ''}</div>
        ${state.granter ? '<div id="g-rows"><div class="note">불러오는 중…</div></div>' : '<div class="exp-rows" data-card="corporate"></div><button class="btn sm" data-addexp="corporate">+ 법인카드 사용 추가</button>'}</div>
      <div class="card-col pers"><div class="col-title pers">개인카드</div><div class="exp-rows" data-card="personal"></div><button class="btn sm" data-addexp="personal">+ 개인카드 사용 추가</button></div>
    </div>
    <h3 class="sec">당일 합계</h3>
    <div class="day-sum" id="day-sum"></div>
    <div class="modal-actions"><button class="btn" data-close>취소</button><button class="btn primary" id="save">저장</button></div>`, 'full');
  const f = (n) => $(`[name=${n}]`, c);
  let seq = 0;

  const setVehicle = async () => {
    const v = vehicles.find((x) => x.id == f('vehicle_id').value);
    f('eff').value = v?.efficiency_km_l ?? '';
    if (!v) return recalc();
    try {
      const fp = await api('/api/fuel-price?type=' + v.fuel_type);
      f('price').value = fp.price ?? '';
      $('#price-src', c).textContent = (fp.price ? `유가 ${won(fp.price)}원 · ${fp.source === 'opinet' ? '오피넷 전국평균' : '관리자 수동입력'} (${fp.date})` : '유가 데이터 확인 불가 — 직접 입력하세요')
        + (v.efficiency_km_l ? '' : ' · 이 차량의 공식연비 미등록 (연료비 계산 불가)');
    } catch (e) { fail(e); }
    recalc();
  };

  const legBox = $('#legs', c);
  const addLeg = (prevEnd) => {
    const n = legBox.children.length + 1;
    const el = document.createElement('div'); el.className = 'leg card';
    el.innerHTML = `<div class="row" style="justify-content:space-between"><b class="leg-no">구간 ${n}</b><button class="btn sm danger" data-rm>삭제</button></div>
      <div class="grid2">${placeInput('s' + (++seq), '출발지', prevEnd && { name: prevEnd.name, addr: prevEnd.address })}${placeInput('e' + seq, '도착지', null)}</div>
      <div class="leg-nums"><label class="inline" style="font-size:13px;color:var(--ink)"><input type="checkbox" name="round" style="width:auto"> 왕복</label>
        <label>거리(km)<input name="km" inputmode="decimal"></label><label>통행료(원)<input name="toll" inputmode="numeric" value="0"></label>
        <label>주차비(원)<input name="park" inputmode="numeric" value="0"></label><div class="leg-fuel"><span class="note">연료비</span><b>-</b></div></div>
      <div class="note leg-status"></div>`;
    legBox.appendChild(el);
    const [bs, be] = $$('.place', el);
    el._bs = bs; el._be = be; el._base = null;
    const g = (k) => $(`[name=${k}]`, el);
    const apply = () => { if (!el._base) return recalc(); const m = g('round').checked ? 2 : 1; g('km').value = Math.round(el._base.km * m * 10) / 10; g('toll').value = el._base.toll * m; recalc(); };
    const onPick = async () => {
      const a = bs._val, b = be._val; if (!a || !b) return;
      $('.leg-status', el).textContent = '경로 계산 중…';
      try {
        const rt = await api(`/api/route?sx=${a.x}&sy=${a.y}&ex=${b.x}&ey=${b.y}`);
        el._base = { km: rt.distance_km, toll: rt.toll_won }; apply();
        $('.leg-status', el).textContent = `카카오 추천경로 편도 ${km(rt.distance_km)}km · 약 ${rt.duration_min}분 · 통행료 ${won(rt.toll_won)}원`;
      } catch (e) { $('.leg-status', el).textContent = e.message + ' — 거리 직접 입력'; }
    };
    bindPlace(bs, onPick, prevEnd || null); bindPlace(be, onPick, null);
    g('round').onchange = apply;
    ['km', 'toll', 'park'].forEach((k) => (g(k).oninput = recalc));
    $('[data-rm]', el).onclick = () => { if (legBox.children.length > 1) { el.remove(); $$('.leg-no', legBox).forEach((x, i) => (x.textContent = '구간 ' + (i + 1))); recalc(); } };
    (prevEnd ? $('.pq', be) : $('.pq', bs)).focus();
    recalc();
  };

  const addExp = (card) => {
    const k = 'x' + (++seq);
    const el = document.createElement('div'); el.className = 'exp-row'; el.dataset.key = k;
    el.innerHTML = `<div class="exp-grid"><select name="cat">${EXP_CATS.map((x) => `<option>${x}</option>`).join('')}</select>
      <input name="etc" class="hidden" placeholder="기타 사용 목적 직접 입력"><input name="amount" inputmode="numeric" placeholder="금액(원)">
      <input name="purpose" placeholder="상세 내용 (예: 운영팀 중식)"><button class="btn sm danger" data-rm>×</button></div>
      <label class="note">영수증 사진<input type="file" name="photos" accept="image/*,application/pdf" multiple></label><div class="photo-edit"></div>`;
    $(`.exp-rows[data-card=${card}]`, c).appendChild(el);
    $('[name=cat]', el).onchange = (e) => $('[name=etc]', el).classList.toggle('hidden', e.target.value !== '기타');
    $('[name=amount]', el).oninput = recalc;
    $('[name=photos]', el).onchange = (e) => {
      $('.photo-edit', el).innerHTML = [...e.target.files].map((x) => x.type.startsWith('image/') ? `<div class="ph"><img src="${URL.createObjectURL(x)}"></div>` : `<div class="note">${esc(x.name)}</div>`).join('');
    };
    $('[data-rm]', el).onclick = () => { el.remove(); recalc(); };
    $('[name=amount]', el).focus();
  };

  function recalc() {
    const eff = Number(f('eff').value) || 0, price = Number(f('price').value) || 0;
    let tk = 0, tt = 0, tp = 0, tf = 0;
    $$('.leg', legBox).forEach((el) => {
      const d = Number($('[name=km]', el).value) || 0, fuel = d && eff && price ? Math.round((d / eff) * price) : 0;
      $('.leg-fuel b', el).textContent = eff && price ? won(fuel) + '원' : '데이터 확인 불가';
      tk += d; tt += Number($('[name=toll]', el).value) || 0; tp += Number($('[name=park]', el).value) || 0; tf += fuel;
    });
    const sum = (card) => $$(`.exp-rows[data-card=${card}] [name=amount]`, c).reduce((a, x) => a + (Number(String(x.value).replace(/[^\d]/g, '')) || 0), 0);
    const sc = sum('corporate') + $$('#g-rows .g-row', c).reduce((a, x) => a + (Number(x.dataset.amt) || 0), 0), sp = sum('personal');
    $('#day-sum', c).innerHTML = `<div><span>총 거리</span><b>${km(tk)} km</b></div><div><span>연료비</span><b>${won(tf)}원</b></div>
      <div><span>통행료</span><b>${won(tt)}원</b></div><div><span>주차비</span><b>${won(tp)}원</b></div><div class="hl"><span>운행비 합계</span><b>${won(tf + tt + tp)}원</b></div>
      <div><span>법인카드</span><b style="color:var(--corp)">${won(sc)}원</b></div><div><span>개인카드</span><b style="color:var(--pers)">${won(sp)}원</b></div><div class="hl"><span>카드 합계</span><b>${won(sc + sp)}원</b></div>`;
  }

  $('#add-leg', c).onclick = () => { const legs = $$('.leg', legBox); const last = legs[legs.length - 1]; addLeg(last?._be._val || null); };
  $$('[data-addexp]', c).forEach((b) => (b.onclick = () => addExp(b.dataset.addexp)));
  f('vehicle_id').onchange = setVehicle;
  ['price', 'eff'].forEach((n) => (f(n).oninput = recalc));
  const loadG = async () => {
    const box = $('#g-rows', c); if (!box) return;
    try {
      const d = await api(`/api/day-cards?user_id=${u.id}&date=${f('date').value}`);
      box.innerHTML = d.rows.map((r) => gRowHtml(r, EXP_CATS, false)).join('') || '<div class="note">이 날짜의 법인카드 사용내역이 없습니다. (그랜터 반영까지 시간이 걸릴 수 있습니다)</div>';
      $$('.g-row', box).forEach((el, i) => (el.dataset.amt = d.rows[i].amount));
      bindGRows(box);
    } catch (e) { box.innerHTML = '<div class="note">카드내역 불러오기 실패: ' + esc(e.message) + '</div>'; }
    recalc();
  };
  f('date').onchange = loadG;
  loadG();
  addLeg(null);
  await setVehicle();

  $('#save', c).onclick = async (ev) => {
    const btn = ev.target;
    const legs = $$('.leg', legBox).map((el) => {
      const s1 = el._bs._val, e1 = el._be._val, g = (k) => $(`[name=${k}]`, el);
      return { purpose: f('purpose').value, start_name: $('.pq', el._bs).value, start_addr: s1?.address, start_x: s1?.x, start_y: s1?.y,
        end_name: $('.pq', el._be).value, end_addr: e1?.address, end_x: e1?.x, end_y: e1?.y,
        round_trip: g('round').checked, distance_km: g('km').value, toll_won: g('toll').value, parking_won: g('park').value };
    });
    const noKm = legs.filter((l) => (l.start_name || l.end_name) && !Number(l.distance_km));
    if (noKm.length) return toast(`거리가 비어 있는 구간이 ${noKm.length}개 있습니다. 장소를 목록에서 선택하거나 거리를 입력하세요`, true);
    const expenses = $$('.exp-row', c).map((el) => {
      const cat = $('[name=cat]', el).value;
      return { key: el.dataset.key, card_type: el.closest('.exp-rows').dataset.card, category: cat === '기타' ? ($('[name=etc]', el).value.trim() || '기타') : cat,
        purpose: $('[name=purpose]', el).value, amount: $('[name=amount]', el).value };
    });
    const gEls = $$('#g-rows .g-row', c);
    const bad = gEls.find((el) => $('[name=gcat]', el).value === '기타' && !$('[name=getc]', el).value.trim());
    if (bad) return toast('기타 사용 목적을 직접 입력하세요', true);
    const classify = gEls.map((el) => ({ id: el.dataset.gid, key: 'g' + el.dataset.gid, ...gVal(el) }));
    const fd = new FormData();
    fd.append('payload', JSON.stringify({ user_id: u.id, date: f('date').value, vehicle_id: f('vehicle_id').value || null,
      fuel_price_won: f('price').value, efficiency_km_l: f('eff').value, legs, expenses, classify }));
    for (const el of gEls) for (const file of $('[name=gphotos]', el).files) fd.append('photo_g' + el.dataset.gid, await shrink(file));
    btn.disabled = true; btn.textContent = '저장 중…';
    try {
      for (const el of $$('.exp-row', c)) for (const file of $('[name=photos]', el).files) fd.append('photo_' + el.dataset.key, await shrink(file));
      const r = await api('/api/day', { method: 'POST', body: fd });
      closeModal(); toast(`저장 완료 · 운행 ${r.trips}건 · 카드 ${r.expenses}건 · 사진 ${r.photos}장`); pageTrips();
    } catch (e) { fail(e); btn.disabled = false; btn.textContent = '저장'; }
  };
}

// ========== 부서팀장 법인카드 일지 ==========
function expItemHtml(r) {
  if (r.source === 'granter') return `<div class="exp-item">${gRowHtml(r, TEAM_CATS)}</div>`;
  return `<div class="exp-item"><div class="row" style="justify-content:space-between"><span><span class="badge corp">${esc(r.category)}</span> ${esc(r.purpose || '')}</span><b>${won(r.amount)}원</b></div>
    ${r.photos.length ? `<div class="thumbs big">${r.photos.map((p) => p.mime === 'application/pdf' ? `<a href="/api/photos/${p.id}" target="_blank">PDF</a>` : `<img src="/api/photos/${p.id}" data-full="/api/photos/${p.id}" loading="lazy" alt="">`).join('')}</div>` : '<div class="note">영수증 없음</div>'}
    ${r.memo ? `<div class="note">${esc(r.memo)}</div>` : ''}<div style="text-align:right"><button class="btn sm" data-edit="${r.id}">수정</button></div></div>`;
}
async function pageTeamCard() {
  const main = $('#main');
  let leads = null;
  if (!isAdmin() && !state.cardUser) {
    leads = await api('/api/leads');
    if (!leads.length) { main.innerHTML = '<div class="card empty">법인카드 일지 사용 대상이 아닙니다.</div>'; return; }
    if (leads.length === 1) state.cardUser = leads[0];
  }
  if (!state.cardUser) {
    leads ||= await api('/api/leads');
    main.innerHTML = `<div class="page-head"><h1>부서팀장 법인카드 일지</h1></div><p class="note">카드 사용자를 선택하세요. (직책에 '팀장'이 포함된 직원 + 직원·차량 관리에서 카드 구분을 지정한 직원)</p>
      <div class="cards">${leads.map((u) => `<div class="card pick" data-uid="${u.id}${u.card_id ? '/' + esc(encodeURIComponent(u.card_id)) : ''}"><div class="row" style="justify-content:space-between"><div class="t">${userLabel(u)}</div><span class="badge corp">${esc(u.card_label)}</span></div><div class="s">${esc(u.department || '')} · ${esc(u.position || '')}</div></div>`).join('')}</div>`;
    $$('[data-uid]', main).forEach((el) => (el.onclick = () => go('teamcard/u/' + el.dataset.uid)));
    return;
  }
  const u = state.cardUser;
  const rows0 = await api(`/api/expenses?book=team&user_id=${u.id}&card=${u.card_id ? encodeURIComponent(u.card_id) : 'main'}&${rq()}`);
  const rows = rows0.filter((r) => r.card_type !== 'receipt'), bundles = rows0.filter((r) => r.card_type === 'receipt');
  const total = rows.reduce((a, r) => a + r.amount, 0), nPh = rows.reduce((a, r) => a + r.photos.length, 0);
  const days = {}; rows.forEach((r) => (days[r.expense_date.slice(0, 10)] ||= []).push(r));
  const cats = {}; rows.forEach((r) => (cats[r.category] = (cats[r.category] || 0) + r.amount));
  main.innerHTML = `<div class="crumb">${isAdmin() || leads?.length > 1 || u.card_id ? `${backBtn('teamcard')} <a id="back">부서팀장 법인카드 일지</a> / ` : ''}${userLabel(u)}</div>
    <div class="page-head"><h1>${userLabel(u)} 법인카드 일지 <span class="badge corp">${esc(u.card_label)}</span></h1><div class="grow"></div>${rangeControls(pageTeamCard)}</div>
    <div class="kpis"><div class="kpi pick" ${dd(u.name + ' 법인카드 사용', { kind: 'expenses', book: 'team', user_ids: u.id })}><div class="l">법인카드 사용 합계</div><div class="v" style="color:var(--corp)">${won(total)}원</div></div>
      <div class="kpi pick" ${dd(u.name + ' 법인카드 사용', { kind: 'expenses', book: 'team', user_ids: u.id })}><div class="l">사용 건수</div><div class="v">${rows.length}건</div></div>
      <div class="kpi pick" ${dd(u.name + ' 영수증 있는 사용', { kind: 'expenses', book: 'team', user_ids: u.id, has_photo: 1 })}><div class="l">영수증 사진</div><div class="v">${nPh}장</div></div>
      <div class="kpi"><div class="l">항목별</div><div class="note">${Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => ddLink(`${esc(k)} ${won(v)}`, u.name + ' · ' + k, { kind: 'expenses', book: 'team', user_ids: u.id, category: k })).join(' · ') || '-'}</div></div></div>
    ${state.granter ? (rows.some((r) => r.category === UNSET) ? `<div class="warn" style="margin-bottom:10px">사용 목적을 선택하지 않은 사용 ${rows.filter((r) => r.category === UNSET).length}건이 있습니다. 각 건 옆에서 선택 후 저장하세요.</div>` : '') : '<div class="row" style="margin-bottom:10px"><button class="btn primary" id="add-team">+ 법인카드 사용 등록 (여러 건)</button></div>'}
    ${Object.keys(days).sort().reverse().map((d) => `<div class="card day-block"><div class="row" style="justify-content:space-between;margin-bottom:8px"><b>${d}</b>
      <span class="note">합계 <b>${won(days[d].reduce((a, r) => a + r.amount, 0))}원</b> · ${days[d].length}건</span></div>${days[d].map(expItemHtml).join('')}</div>`).join('') || '<div class="card empty">기간 내 사용 내역 없음</div>'}
    ${bundles.length ? `<h2 style="margin-top:18px">이관 영수증 (월별 일괄 · 건별 연결 안 된 사진)</h2>${bundles.map((r) => `<div class="card day-block"><div class="row" style="justify-content:space-between"><b>${esc(r.purpose)}</b><span class="note">${esc(r.memo || '')}</span></div>${thumbs(r.photos)}</div>`).join('')}` : ''}`;
  $('#back')?.addEventListener('click', () => go('teamcard'));
  $('#add-team')?.addEventListener('click', () => teamForm(u));
  bindGRows(main, pageTeamCard);
  $$('[data-edit]', main).forEach((b) => (b.onclick = () => expenseForm(u, [], rows.find((x) => x.id == b.dataset.edit), { book: 'team', after: pageTeamCard })));
}
function teamForm(u) {
  const c = openModal(`<div class="row" style="justify-content:space-between"><h2 style="margin:0">부서팀장 법인카드 사용 등록 · ${userLabel(u)}</h2><button class="btn" data-close>닫기</button></div>
    <div class="grid3"><label>사용일자<input type="date" name="date" value="${today()}"></label></div>
    <div class="card-col corp"><div class="col-title corp">법인카드 사용 내역</div><div class="exp-rows" data-card="corporate"></div><button class="btn sm" id="add-row">+ 사용 건 추가</button></div>
    <div class="day-sum" id="team-sum" style="grid-template-columns:repeat(2,1fr)"></div>
    <div class="modal-actions"><button class="btn" data-close>취소</button><button class="btn primary" id="save">저장</button></div>`, 'wide');
  let seq = 0;
  const box = $('.exp-rows', c);
  const recalc = () => {
    const t = $$('[name=amount]', box).reduce((a, x) => a + (Number(String(x.value).replace(/[^\d]/g, '')) || 0), 0);
    $('#team-sum', c).innerHTML = `<div><span>건수</span><b>${$$('.exp-row', box).length}건</b></div><div class="hl"><span>법인카드 합계</span><b>${won(t)}원</b></div>`;
  };
  const addRow = () => {
    const k = 't' + (++seq);
    const el = document.createElement('div'); el.className = 'exp-row'; el.dataset.key = k;
    el.innerHTML = `<div class="exp-grid"><select name="cat">${TEAM_CATS.map((x) => `<option>${x}</option>`).join('')}</select>
      <input name="etc" class="hidden" placeholder="기타 사용 목적 직접 입력"><input name="amount" inputmode="numeric" placeholder="금액(원)">
      <input name="purpose" placeholder="상세 내용 (예: 팀 회의 식대)"><button class="btn sm danger" data-rm>×</button></div>
      <label class="note">영수증 사진<input type="file" name="photos" accept="image/*,application/pdf" multiple></label><div class="photo-edit"></div>`;
    box.appendChild(el);
    $('[name=cat]', el).onchange = (e) => $('[name=etc]', el).classList.toggle('hidden', e.target.value !== '기타');
    $('[name=amount]', el).oninput = recalc;
    $('[name=photos]', el).onchange = (e) => { $('.photo-edit', el).innerHTML = [...e.target.files].map((x) => x.type.startsWith('image/') ? `<div class="ph"><img src="${URL.createObjectURL(x)}"></div>` : `<div class="note">${esc(x.name)}</div>`).join(''); };
    $('[data-rm]', el).onclick = () => { el.remove(); recalc(); };
    recalc();
  };
  $('#add-row', c).onclick = addRow;
  addRow();
  $('#save', c).onclick = async (ev) => {
    const btn = ev.target;
    const expenses = $$('.exp-row', box).map((el) => {
      const cat = $('[name=cat]', el).value;
      return { key: el.dataset.key, card_type: 'corporate', category: cat === '기타' ? ($('[name=etc]', el).value.trim() || '기타') : cat,
        purpose: $('[name=purpose]', el).value, amount: $('[name=amount]', el).value };
    });
    const fd = new FormData();
    fd.append('payload', JSON.stringify({ user_id: u.id, date: $('[name=date]', c).value, book: 'team', legs: [], expenses }));
    btn.disabled = true; btn.textContent = '저장 중…';
    try {
      for (const el of $$('.exp-row', box)) for (const f of $('[name=photos]', el).files) fd.append('photo_' + el.dataset.key, await shrink(f));
      const r = await api('/api/day', { method: 'POST', body: fd });
      closeModal(); toast(`저장 완료 · ${r.expenses}건 · 사진 ${r.photos}장`); pageTeamCard();
    } catch (e) { fail(e); btn.disabled = false; btn.textContent = '저장'; }
  };
}

// ========== 법인카드 사용 관리 (관리자) ==========
state.cardBook = 'all';
async function pageCardAdmin() {
  const main = $('#main');
  const d = await api(`/api/card-stats?book=${state.cardBook}&${rq()}`);
  const tot = d.users.reduce((a, u) => a + u.amount, 0), cnt = d.users.reduce((a, u) => a + u.cnt, 0);
  const drv = d.users.reduce((a, u) => a + (u.drive_amount || 0), 0), team = d.users.reduce((a, u) => a + (u.team_amount || 0), 0);
  const maxM = Math.max(1, ...d.monthly.map((m) => m.amount));
  const BOOK = { all: '전체', drive: '차량운행일지 법인카드', team: '부서팀장 법인카드' };
  main.innerHTML = `<div class="page-head"><h1>법인카드 사용 관리</h1><div class="grow"></div>${rangeControls(pageCardAdmin)}</div>
    <div class="row" style="margin-bottom:12px">${Object.entries(BOOK).map(([k, l]) => `<button class="btn ${state.cardBook === k ? 'primary' : ''}" data-book="${k}">${l}</button>`).join('')}</div>
    <div class="kpis"><div class="kpi pick" ${dd(BOOK[state.cardBook] + ' 전체', { kind: 'expenses', card_type: 'corporate', book: state.cardBook })}><div class="l">${BOOK[state.cardBook]} 합계</div><div class="v" style="color:var(--corp)">${won(tot)}원</div><div class="note">${cnt}건</div></div>
      <div class="kpi pick" ${dd('차량운행일지 법인카드', { kind: 'expenses', card_type: 'corporate', book: 'drive' })}><div class="l">차량운행일지 법인카드</div><div class="v">${won(drv)}원</div></div>
      <div class="kpi pick" ${dd('부서팀장 법인카드', { kind: 'expenses', card_type: 'corporate', book: 'team' })}><div class="l">부서팀장 법인카드</div><div class="v">${won(team)}원</div></div></div>
    <p class="note">차량운행일지 법인카드 수치는 통합 합계관리의 "법인카드"와 같은 기준(운행일지에 등록된 법인카드)입니다.</p>
    <h2>직원별</h2>
    <div class="table-wrap"><table><thead><tr><th>부서</th><th>직원</th><th>직책</th><th class="n">건수</th><th class="n">운행일지 법인카드</th><th class="n">팀장 법인카드</th><th class="n">합계</th><th class="n">영수증</th></tr></thead>
      <tbody>${d.users.map((u) => `<tr class="clickable" data-uid="${u.id}" data-lead="${u.team_amount ? 1 : 0}"><td>${esc(u.department || '')}</td><td>${userLabel(u)}${u.active ? '' : ' <span class="badge off">퇴사</span>'}</td><td>${esc(u.position || '')}</td>
        <td class="n">${ddLink(u.cnt, u.name + ' 법인카드', { kind: 'expenses', card_type: 'corporate', book: state.cardBook, user_ids: u.id })}</td><td class="n">${ddLink(won(u.drive_amount), u.name + ' 운행일지 법인카드', { kind: 'expenses', card_type: 'corporate', book: 'drive', user_ids: u.id })}</td><td class="n">${ddLink(won(u.team_amount), u.name + ' 팀장 법인카드', { kind: 'expenses', card_type: 'corporate', book: 'team', user_ids: u.id })}</td><td class="n"><b>${ddLink(won(u.amount), u.name + ' 법인카드', { kind: 'expenses', card_type: 'corporate', book: state.cardBook, user_ids: u.id })}</b></td><td class="n">${ddLink(u.photos, u.name + ' 영수증 있는 법인카드', { kind: 'expenses', card_type: 'corporate', book: state.cardBook, user_ids: u.id, has_photo: 1 })}</td></tr>`).join('') || '<tr><td colspan="8" class="empty">데이터 없음</td></tr>'}</tbody>
      <tfoot><tr><td colspan="3">합계</td><td class="n">${ddLink(cnt, '법인카드 전체', { kind: 'expenses', card_type: 'corporate', book: state.cardBook })}</td><td class="n">${ddLink(won(drv), '차량운행일지 법인카드', { kind: 'expenses', card_type: 'corporate', book: 'drive' })}</td><td class="n">${ddLink(won(team), '부서팀장 법인카드', { kind: 'expenses', card_type: 'corporate', book: 'team' })}</td><td class="n">${ddLink(won(tot), '법인카드 전체', { kind: 'expenses', card_type: 'corporate', book: state.cardBook })}</td><td></td></tr></tfoot></table></div>
    <div class="grid2" style="margin-top:16px"><div class="card"><h2>항목별</h2><div class="table-wrap"><table><thead><tr><th>항목</th><th class="n">건수</th><th class="n">금액</th><th class="n">비중</th></tr></thead>
      <tbody>${d.categories.map((x) => `<tr class="clickable" ${dd('법인카드 · ' + x.category, { kind: 'expenses', card_type: 'corporate', book: state.cardBook, category: x.category })}><td>${esc(x.category)}</td><td class="n">${x.cnt}</td><td class="n">${won(x.amount)}</td><td class="n">${tot ? Math.round((x.amount / tot) * 100) : 0}%</td></tr>`).join('') || '<tr><td colspan="4" class="empty">-</td></tr>'}</tbody></table></div></div>
      <div class="card"><h2>월별</h2><div class="bars">${d.monthly.map((m) => `<div class="bar-row pick" ${dd(m.ym + ' 법인카드', { kind: 'expenses', card_type: 'corporate', book: state.cardBook, ym: m.ym })}><span>${m.ym}</span><div class="bar alt" style="width:${(m.amount / maxM) * 100}%"></div><span class="n">${won(m.amount)}원</span></div>`).join('') || '<div class="empty">-</div>'}</div></div></div>
    <h2 style="margin-top:16px">최근 사용 내역 (최대 300건)</h2>
    <div class="table-wrap"><table><thead><tr><th>일자</th><th>장부</th><th>직원</th><th>항목</th><th>목적</th><th class="n">금액</th><th>영수증</th></tr></thead>
      <tbody>${d.items.map((r) => `<tr><td>${r.expense_date}</td><td><span class="badge ${r.book === 'team' ? 'pers' : 'corp'}">${r.book === 'team' ? '팀장' : '운행일지'}</span></td><td>${userLabel(r)}</td><td>${esc(r.category)}</td><td class="wrap">${esc(r.purpose || '')}</td><td class="n">${won(r.amount)}</td><td>${thumbs(r.photos)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">-</td></tr>'}</tbody></table></div>`;
  $$('[data-book]', main).forEach((b) => (b.onclick = () => { state.cardBook = b.dataset.book; pageCardAdmin(); }));
  $$('tr[data-uid]', main).forEach((tr) => (tr.onclick = () => {
    if (state.cardBook === 'team' || (state.cardBook === 'all' && tr.dataset.lead === '1')) go('teamcard/u/' + tr.dataset.uid);
    else { state.tab = 'expenses'; go('trips/u/' + tr.dataset.uid); }
  }));
}

function photoPicker(existing) {
  return `<label>증빙 사진 (여러 장 가능, 이 건에만 연결됩니다)<input type="file" name="photos" accept="image/*,application/pdf" multiple></label>
    <div class="photo-edit" id="photo-edit">${(existing || []).map((p) => `<div class="ph" data-pid="${p.id}">${p.mime === 'application/pdf' ? '<div class="note">PDF</div>' : `<img src="/api/photos/${p.id}" data-full="/api/photos/${p.id}">`}<span class="x" title="삭제">×</span></div>`).join('')}</div>
    <div class="photo-edit" id="photo-new"></div>`;
}
function bindPhotoPicker(c) {
  $$('#photo-edit .x', c).forEach((x) => (x.onclick = async () => {
    const ph = x.closest('.ph');
    try { await api('/api/photos/' + ph.dataset.pid, { method: 'DELETE' }); ph.remove(); } catch (e) { fail(e); }
  }));
  $('[name=photos]', c).onchange = (e) => {
    $('#photo-new', c).innerHTML = [...e.target.files].map((f) => f.type.startsWith('image/') ? `<div class="ph"><img src="${URL.createObjectURL(f)}"></div>` : `<div class="note">${esc(f.name)}</div>`).join('');
  };
}

function expenseForm(u, vehicles, rec, opt = {}) {
  const team = opt.book === 'team';
  const after = opt.after || (() => { state.tab = 'expenses'; pageTrips(); });
  const gLock = rec && rec.source === 'granter';
  if (gLock) return toast('그랜터 연동 법인카드 건은 목록에서 사용 목적만 선택하세요', true);
  const r = rec || { expense_date: today(), card_type: !team && state.granter ? 'personal' : 'corporate', category: '식대', amount: '' };
  const isStd = (team ? TEAM_CATS : EXP_CATS).includes(r.category) && r.category !== '기타' || r.category === '기타';
  const c = openModal(`<h2>${rec ? '카드 사용 수정' : '카드 사용 등록'} · ${userLabel(u)}${team ? ' · 부서팀장 법인카드' : ''}</h2>
    <div class="row${team ? ' hidden' : ''}">${(state.granter && !team && !(rec && rec.card_type === 'corporate') ? ['personal'] : ['corporate', 'personal']).map((t) => `<label class="inline" style="font-size:14px;color:var(--ink)"><input type="radio" name="card_type" value="${t}" style="width:auto" ${r.card_type === t ? 'checked' : ''}> ${CARD[t]}</label>`).join('')}</div>
    <div class="grid3"><label>사용일자<input type="date" name="expense_date" value="${String(r.expense_date).slice(0, 10)}"></label>
      <label>사용 목적<select name="category">${(team ? TEAM_CATS : EXP_CATS).map((x) => `<option ${x === (isStd ? r.category : '기타') ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
        <input name="cat_etc" class="${isStd && r.category !== '기타' ? 'hidden' : ''}" placeholder="기타 사용 목적 직접 입력" value="${isStd || r.category === '기타' ? '' : esc(r.category || '')}" style="margin-top:6px"></label>
      <label>금액 (원)<input name="amount" inputmode="numeric" value="${r.amount}"></label></div>
    <div class="grid2"><label>상세 내용 (선택)<input name="purpose" placeholder="예: 용인동백점 오픈지원 식대" value="${esc(r.purpose || '')}"></label>
      <label class="${team ? 'hidden' : ''}">차량<select name="vehicle_id"><option value="">-</option>${vehicles.map((v) => `<option value="${v.id}" ${v.id == r.vehicle_id ? 'selected' : ''}>${esc(v.plate)}</option>`).join('')}</select></label></div>
    <label>비고<input name="memo" value="${esc(r.memo || '')}"></label>
    ${photoPicker(r.photos)}
    <div class="modal-actions">${rec ? '<button class="btn danger" id="del">삭제</button><div style="flex:1"></div>' : ''}<button class="btn" data-close>취소</button><button class="btn primary" id="save">저장</button></div>`);
  bindPhotoPicker(c);
  $('[name=category]', c).onchange = (e) => { const on = e.target.value === '기타'; $('[name=cat_etc]', c).classList.toggle('hidden', !on); if (on) $('[name=cat_etc]', c).focus(); };
  $('#save', c).onclick = async () => {
    const fd = new FormData();
    const catSel = $('[name=category]', c).value, catEtc = $('[name=cat_etc]', c).value.trim();
    if (catSel === '기타' && !catEtc && !(rec && rec.category === '기타')) return toast('기타 사용 목적을 직접 입력하세요', true);
    fd.append('user_id', u.id); fd.append('book', team ? 'team' : 'drive');
    fd.append('card_type', team ? 'corporate' : ($('[name=card_type]:checked', c)?.value || ''));
    fd.append('category', catSel === '기타' ? (catEtc || '기타') : catSel);
    ['expense_date', 'amount', 'purpose', 'vehicle_id', 'memo'].forEach((n) => fd.append(n, $(`[name=${n}]`, c).value));
    for (const f of $('[name=photos]', c).files) fd.append('photos', await shrink(f));
    try { await api(rec ? `/api/expenses/${rec.id}` : '/api/expenses', { method: rec ? 'PUT' : 'POST', body: fd }); closeModal(); toast('저장되었습니다'); after(); } catch (e) { fail(e); }
  };
  $('#del', c)?.addEventListener('click', async () => {
    if (!confirmInline(c, '이 카드 사용 내역과 사진을 삭제합니다')) return;
    try { await api(`/api/expenses/${rec.id}`, { method: 'DELETE' }); closeModal(); after(); } catch (e) { fail(e); }
  });
}

// ========== 차량관리 및 점검일지 ==========
async function pageMaint() {
  const main = $('#main');
  const vehicles = await api('/api/vehicles?scope=all');
  if (!state.vehicle) {
    const { map, rules } = await vehicleStatusMap(null, true);
    const order = { overdue: 0, unknown: 1, soon: 2, ok: 3 };
    const list = [...vehicles].sort((a, b) => (b.active - a.active) || (order[map[a.id]?.worst] ?? 9) - (order[map[b.id]?.worst] ?? 9));
    const cnt = (lv) => vehicles.filter((v) => v.active && map[v.id]?.alerts.some((a) => a.level === lv)).length;
    main.innerHTML = `<div class="page-head"><h1>차량관리 및 점검일지</h1></div>
      <div class="kpis"><div class="kpi pick" data-vlv="overdue"><div class="l">교체 필요 차량</div><div class="v" style="color:#b23b3b">${cnt('overdue')}대</div></div>
        <div class="kpi pick" data-vlv="unknown"><div class="l">이력 확인 필요</div><div class="v" style="color:#a86b00">${cnt('unknown')}대</div></div>
        <div class="kpi pick" data-vlv="soon"><div class="l">교체 임박</div><div class="v" style="color:#c26a1b">${cnt('soon')}대</div></div>
        <div class="kpi pick" data-vlv="active"><div class="l">사용 차량</div><div class="v">${vehicles.filter((v) => v.active).length}대</div></div></div>
      ${rules ? `<p class="note">알림 기준: 엔진오일 ${won(rules.oil_km)}km 또는 ${rules.oil_months}개월 · 타이어 ${won(rules.tire_km)}km${rules.tire_months ? ' 또는 ' + rules.tire_months + '개월' : ''} · ${rules.due_soon_pct}% 도달 시 임박 (회사 운영 기준, 설정에서 변경)</p>` : ''}
      <div class="veh-board">${list.map((v) => `<div class="card pick veh-card lv-${map[v.id]?.worst || 'ok'}" data-vid="${v.id}">
        <div class="row" style="justify-content:space-between"><div><b style="font-size:17px">${esc(v.plate)}</b> ${v.active ? '' : '<span class="badge off">미사용</span>'}</div>
          <span class="badge ${v.ownership === 'corporate' ? 'corp' : 'pers'}">${OWN[v.ownership]}</span></div>
        <div class="s">${esc(v.model || '차종 미입력')} · ${FUEL[v.fuel_type]} · ${v.efficiency_km_l ? v.efficiency_km_l + 'km/L' : '연비 미등록'} · ${v.user_name ? esc(v.user_name) + (v.user_nickname ? `(${esc(v.user_nickname)})` : '') : '담당자 없음'}</div>
        <div class="s">추정 주행거리 <b>${map[v.id]?.est_odometer != null ? won(map[v.id].est_odometer) + 'km' : '확인 불가'}</b> · 최근 정비 <b>${map[v.id]?.recent ? map[v.id].recent.maint_date + ' ' + esc(map[v.id].recent.maint_type) : '없음'}</b></div>
        <div class="row">${alertChips(map[v.id])}</div>
        ${map[v.id] ? `<div class="al-why">${map[v.id].alerts.filter((a) => a.level !== 'ok').map((a) => `<div>· <b>${esc(a.title)}</b>: ${esc(a.reason)}</div>`).join('')}</div>` : ''}
      </div>`).join('') || '<div class="empty">등록된 차량이 없습니다</div>'}</div>`;
    $$('[data-vid]', main).forEach((el) => (el.onclick = () => go('maintenance/v/' + el.dataset.vid)));
    const LVT = { overdue: '교체 필요 차량', unknown: '이력 확인 필요 차량', soon: '교체 임박 차량', active: '사용 차량' };
    $$('[data-vlv]', main).forEach((el) => (el.onclick = () => {
      const lv = el.dataset.vlv;
      const list = list0().filter((v) => v.active && (lv === 'active' || map[v.id]?.alerts.some((a) => a.level === lv)));
      vehicleDrill(LVT[lv], list, map);
    }));
    function list0() { return list; }
    return;
  }
  const v = state.vehicle;
  const [rows, vs1] = await Promise.all([api(`/api/maintenance?vehicle_id=${v.id}&${rq()}`), vehicleStatusMap([v.id], true)]);
  const canEdit = isAdmin() || v.user_id === state.me.id;
  const total = rows.reduce((a, r) => a + r.amount, 0);
  const lastOdo = rows.find((r) => r.odometer_km)?.odometer_km;
  main.innerHTML = `<div class="crumb">${backBtn('maintenance')} <a id="back">차량관리 및 점검일지</a> / ${esc(v.plate)}</div>
    <div class="page-head"><h1>${esc(v.plate)} <span class="badge ${v.ownership === 'corporate' ? 'corp' : 'pers'}">${OWN[v.ownership]}</span></h1><div class="grow"></div>${rangeControls(pageMaint)}</div>
    <div class="kpis"><div class="kpi"><div class="l">차종 / 유종</div><div class="v" style="font-size:15px">${esc(v.model || '-')} / ${FUEL[v.fuel_type]}</div></div>
      <div class="kpi"><div class="l">공식연비</div><div class="v">${v.efficiency_km_l ? v.efficiency_km_l + ' km/L' : '데이터 확인 불가'}</div></div>
      <div class="kpi pick" ${dd(v.plate + ' 관리·점검 기록', { kind: 'maintenance', vehicle_id: v.id })}><div class="l">최근 주행거리</div><div class="v">${lastOdo ? won(lastOdo) + ' km' : '-'}</div></div>
      <div class="kpi pick" ${dd(v.plate + ' 관리·점검 비용', { kind: 'maintenance', vehicle_id: v.id })}><div class="l">기간 관리비용</div><div class="v">${won(total)}원</div></div></div>
    ${canEdit ? '<div class="row" style="margin-bottom:10px"><button class="btn primary" id="add">+ 관리·점검 기록</button></div>' : '<p class="note">다른 직원 차량은 열람만 가능합니다. 기록 등록·수정은 담당 직원과 관리자만 할 수 있습니다.</p>'}
    <div class="table-wrap"><table><thead><tr><th>일자</th><th>구분</th><th class="n">주행거리</th><th>내용</th><th>업체</th><th>결제</th><th class="n">금액</th><th>다음 점검</th><th>사진</th><th>작성자</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${r.maint_date.slice(0, 10)}</td><td>${esc(r.maint_type)}</td><td class="n">${r.odometer_km ? won(r.odometer_km) : '-'}</td>
      <td class="wrap">${esc(r.description)}</td><td>${esc(r.vendor)}</td><td>${r.card_type ? `<span class="badge ${r.card_type === 'corporate' ? 'corp' : 'pers'}">${CARD[r.card_type]}</span>` : '-'}</td>
      <td class="n">${won(r.amount)}</td><td>${r.next_due_date ? r.next_due_date.slice(0, 10) : ''}${r.next_due_km ? ' / ' + won(r.next_due_km) + 'km' : ''}</td>
      <td>${thumbs(r.photos)}</td><td>${esc(r.user_name || '')}</td><td>${canEdit ? `<button class="btn sm" data-edit="${r.id}">수정</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="11" class="empty">기록 없음</td></tr>'}</tbody>
    <tfoot><tr><td colspan="6">합계</td><td class="n">${won(total)}</td><td colspan="4"></td></tr></tfoot></table></div>`;
  $('#back').onclick = () => go('maintenance');
  $('.kpis', main).insertAdjacentHTML('beforebegin', vehiclePanel(v, vs1.map[v.id]).replace('<button class="btn sm" data-gov="' + v.id + '">관리·점검일지 →</button>', ''));
  $('.veh-panel details', main)?.setAttribute('open', '');
  $('#add')?.addEventListener('click', () => maintForm(v, null));
  $$('[data-edit]', main).forEach((b) => (b.onclick = () => maintForm(v, rows.find((x) => x.id == b.dataset.edit))));
}
function maintForm(v, rec) {
  const r = rec || { maint_date: today(), maint_type: '정기점검', amount: 0 };
  const c = openModal(`<h2>${rec ? '관리·점검 수정' : '관리·점검 기록'} · ${esc(v.plate)}</h2>
    <div class="grid3"><label>일자<input type="date" name="maint_date" value="${String(r.maint_date).slice(0, 10)}"></label>
      <label>구분<select name="maint_type">${MAINT_TYPES.map((x) => `<option ${x === r.maint_type ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
      <label>주행거리 (km)<input name="odometer_km" inputmode="numeric" value="${r.odometer_km ?? ''}"></label></div>
    <label>점검·정비 내용<textarea name="description" rows="3">${esc(r.description || '')}</textarea></label>
    <div class="grid3"><label>업체<input name="vendor" value="${esc(r.vendor || '')}"></label>
      <label>금액 (원)<input name="amount" inputmode="numeric" value="${r.amount}"></label>
      <label>결제<select name="card_type"><option value="">-</option>${Object.entries(CARD).map(([k, l]) => `<option value="${k}" ${k === r.card_type ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
    <div class="grid2"><label>다음 점검일<input type="date" name="next_due_date" value="${r.next_due_date ? r.next_due_date.slice(0, 10) : ''}"></label>
      <label>다음 점검 주행거리 (km)<input name="next_due_km" inputmode="numeric" value="${r.next_due_km ?? ''}"></label></div>
    <label>비고<input name="memo" value="${esc(r.memo || '')}"></label>
    ${photoPicker(r.photos)}
    <div class="modal-actions">${rec ? '<button class="btn danger" id="del">삭제</button><div style="flex:1"></div>' : ''}<button class="btn" data-close>취소</button><button class="btn primary" id="save">저장</button></div>`);
  bindPhotoPicker(c);
  $('#save', c).onclick = async () => {
    const fd = new FormData(); fd.append('vehicle_id', v.id);
    ['maint_date', 'maint_type', 'odometer_km', 'description', 'vendor', 'amount', 'card_type', 'next_due_date', 'next_due_km', 'memo'].forEach((n) => fd.append(n, $(`[name=${n}]`, c).value));
    for (const f of $('[name=photos]', c).files) fd.append('photos', await shrink(f));
    try { await api(rec ? `/api/maintenance/${rec.id}` : '/api/maintenance', { method: rec ? 'PUT' : 'POST', body: fd }); closeModal(); toast('저장되었습니다'); pageMaint(); } catch (e) { fail(e); }
  };
  $('#del', c)?.addEventListener('click', async () => {
    if (!confirmInline(c, '이 기록과 사진을 삭제합니다')) return;
    try { await api(`/api/maintenance/${rec.id}`, { method: 'DELETE' }); closeModal(); pageMaint(); } catch (e) { fail(e); }
  });
}

// ========== 통합 합계관리 ==========
state.sumUsers = [];
state.sumView = 'drive';
function summaryTabs() {
  const canTeam = isAdmin() || state.me.is_holder;
  return `<div class="sum-tabs"><button class="sum-tab ${state.sumView === 'drive' ? 'on' : ''}" data-sumview="drive">통합 합계관리</button>${canTeam ? `<button class="sum-tab ${state.sumView === 'team' ? 'on' : ''}" data-sumview="team">부서팀장 법인카드 합계관리</button>` : ''}</div>`;
}
function bindSummaryTabs(main) { $$('[data-sumview]', main).forEach((b) => (b.onclick = () => { state.sumView = b.dataset.sumview; pageSummary(); })); }
async function pageTeamSummary() {
  const main = $('#main');
  const d = await api(`/api/team-summary?${rq()}`);
  const tot = d.users.reduce((a, u) => a + u.amount, 0), cnt = d.users.reduce((a, u) => a + u.cnt, 0);
  const cats = [...TEAM_CATS.filter((c) => d.categories.includes(c)), ...d.categories.filter((c) => !TEAM_CATS.includes(c))];
  const maxM = Math.max(1, ...d.monthly.map((m) => m.amount));
  main.innerHTML = `<div class="page-head">${summaryTabs()}<div class="grow"></div>${rangeControls(pageSummary)}</div>
    <div class="kpis"><div class="kpi pick" ${dd('부서팀장 법인카드 전체', { kind: 'expenses', book: 'team', holders: 1 })}><div class="l">법인카드 사용 합계</div><div class="v" style="color:var(--corp)">${won(tot)}원</div></div>
      <div class="kpi pick" ${dd('부서팀장 법인카드 전체', { kind: 'expenses', book: 'team', holders: 1 })}><div class="l">사용 건수</div><div class="v">${cnt}건</div></div>
      <div class="kpi pick" ${dd('부서회식', { kind: 'expenses', book: 'team', holders: 1, category: '부서회식' })}><div class="l">부서회식</div><div class="v">${won(d.users.reduce((a, u) => a + (u.by['부서회식'] || 0), 0))}원</div></div>
      <div class="kpi pick" ${dd('영수증 있는 법인카드 사용', { kind: 'expenses', book: 'team', holders: 1, has_photo: 1 })}><div class="l">영수증 사진</div><div class="v">${d.users.reduce((a, u) => a + u.photos, 0)}장</div></div></div>
    <h2>사용자별 비교</h2>
    <div class="table-wrap"><table><thead><tr><th>부서</th><th>사용자</th><th>구분</th><th class="n">건수</th>${cats.map((c) => `<th class="n">${esc(c)}</th>`).join('')}<th class="n">합계</th><th class="n">영수증</th></tr></thead>
      <tbody>${d.users.map((u) => `<tr class="clickable" data-uid="${u.id}"><td>${esc(u.department || '')}</td><td>${userLabel(u)}</td><td><span class="badge corp">${esc(u.card_label)}</span></td><td class="n">${ddLink(u.cnt, u.name + ' 법인카드', { kind: 'expenses', book: 'team', user_ids: u.id })}</td>
        ${cats.map((c) => `<td class="n">${ddLink(won(u.by[c] || 0), u.name + ' · ' + c, { kind: 'expenses', book: 'team', user_ids: u.id, category: c })}</td>`).join('')}<td class="n"><b>${ddLink(won(u.amount), u.name + ' 법인카드', { kind: 'expenses', book: 'team', user_ids: u.id })}</b></td><td class="n">${ddLink(u.photos, u.name + ' 영수증 있는 사용', { kind: 'expenses', book: 'team', user_ids: u.id, has_photo: 1 })}</td></tr>`).join('') || `<tr><td colspan="${cats.length + 6}" class="empty">데이터 없음</td></tr>`}</tbody>
      <tfoot><tr><td colspan="3">합계</td><td class="n">${ddLink(cnt, '부서팀장 법인카드 전체', { kind: 'expenses', book: 'team', holders: 1 })}</td>${cats.map((c) => `<td class="n">${ddLink(won(d.users.reduce((a, u) => a + (u.by[c] || 0), 0)), '부서팀장 법인카드 · ' + c, { kind: 'expenses', book: 'team', holders: 1, category: c })}</td>`).join('')}<td class="n">${ddLink(won(tot), '부서팀장 법인카드 전체', { kind: 'expenses', book: 'team', holders: 1 })}</td><td></td></tr></tfoot></table></div>
    <p class="note">숫자를 누르면 해당 내역이 열리고, 이름을 누르면 해당 사용자의 법인카드 일지로 이동합니다.</p>
    <h2 style="margin-top:20px">월별 추이</h2>
    <div class="card"><div class="bars">${d.monthly.map((m) => `<div class="bar-row pick" ${dd(m.ym + ' 부서팀장 법인카드', { kind: 'expenses', book: 'team', holders: 1, ym: m.ym })}><span>${m.ym}</span><div class="bar alt" style="width:${(m.amount / maxM) * 100}%"></div><span class="n">${won(m.amount)}원 · ${m.cnt}건</span></div>`).join('') || '<div class="empty">데이터 없음</div>'}</div></div>`;
  bindSummaryTabs(main);
  $$('tr[data-uid]', main).forEach((tr) => (tr.onclick = () => go('teamcard/u/' + tr.dataset.uid)));
}
async function pageSummary() {
  if (state.sumView === 'team' && (isAdmin() || state.me.is_holder)) return pageTeamSummary();
  const main = $('#main');
  const ids = state.sumUsers.join(',');
  const [data, users0] = await Promise.all([api(`/api/summary?${rq()}${ids ? '&user_ids=' + ids : ''}`), isAdmin() ? api('/api/users?all=1') : Promise.resolve([])]);
  const users = users0.filter((u) => !/대표/.test(u.position || ''));
  const U = data.users;
  const sum = (k) => U.reduce((a, r) => a + Number(r[k] || 0), 0);
  const cols = [
    ['trip_count', '운행횟수', (v) => won(v)], ['distance_km', '운행km', km], ['fuel_cost_won', '연료비', won], ['toll_won', '통행료', won],
    ['parking_won', '주차비', won], ['operating_cost_won', '운행비 합계', won], ['fueling_won', '월 주유비(카드)', won],
    ['corporate_card_won', '법인카드', won], ['personal_card_won', '개인카드', won], ['maintenance_won', '관리·점검비', won],
  ];
  const sq = { scope: 'summary', user_ids: state.sumUsers.length ? state.sumUsers : undefined };
  const colQ = (k) => k === 'fueling_won' ? { kind: 'expenses', category: ['주유', '주유비'] } : k === 'corporate_card_won' ? { kind: 'expenses', card_type: 'corporate' }
    : k === 'personal_card_won' ? { kind: 'expenses', card_type: 'personal' } : k === 'maintenance_won' ? { kind: 'maintenance' } : { kind: 'trips' };
  const cell = (k, label, v, extra, who) => ddLink(v, `${who || '전체'} · ${label}`, { ...sq, ...colQ(k), ...extra });
  const maxOp = Math.max(1, ...data.monthly.map((m) => m.operating_cost_won));
  const maxCard = Math.max(1, ...data.monthly.map((m) => m.corporate_card_won + m.personal_card_won));
  main.innerHTML = `<div class="page-head">${summaryTabs()}<div class="grow"></div>${rangeControls(pageSummary)}</div>
    ${isAdmin() ? `<div class="card" style="margin-bottom:14px"><div class="row"><b style="font-size:13px">직원 선택</b>
      <button class="btn sm" id="sel-all">전체 비교</button>
      ${users.map((u) => `<label class="inline" style="font-size:13px;color:var(--ink);font-weight:400"><input type="checkbox" value="${u.id}" style="width:auto" ${state.sumUsers.includes(u.id) ? 'checked' : ''}>${userLabel(u)}${u.active ? '' : ' <span class="badge off">퇴사</span>'}</label>`).join('')}
      </div></div>` : ''}
    <div class="kpis">
      <div class="kpi pick" ${dd('전체 · 총 운행거리', { ...sq, ...colQ('distance_km') })}><div class="l">총 운행거리</div><div class="v">${km(sum('distance_km'))} km</div></div>
      <div class="kpi pick" ${dd('전체 · 총 운행비', { ...sq, ...colQ('operating_cost_won') })}><div class="l">총 운행비</div><div class="v">${won(sum('operating_cost_won'))}원</div></div>
      <div class="kpi pick" ${dd('전체 · 주유비(카드)', { ...sq, ...colQ('fueling_won') })}><div class="l">주유비(카드)</div><div class="v">${won(sum('fueling_won'))}원</div></div>
      <div class="kpi pick" ${dd('전체 · 법인카드', { ...sq, ...colQ('corporate_card_won') })}><div class="l">법인카드</div><div class="v">${won(sum('corporate_card_won'))}원</div></div>
      <div class="kpi pick" ${dd('전체 · 개인카드', { ...sq, ...colQ('personal_card_won') })}><div class="l">개인카드</div><div class="v">${won(sum('personal_card_won'))}원</div></div>
      <div class="kpi pick" ${dd('전체 · 관리·점검비', { ...sq, ...colQ('maintenance_won') })}><div class="l">관리·점검비</div><div class="v">${won(sum('maintenance_won'))}원</div></div></div>
    <h2>직원별 비교</h2>
    <div class="table-wrap"><table><thead><tr><th>부서</th><th>직원</th>${cols.map((c) => `<th class="n">${c[1]}</th>`).join('')}</tr></thead>
      <tbody>${U.map((r) => `<tr class="clickable" data-uid="${r.id}"><td>${esc(r.department || '')}</td><td>${userLabel(r)}${r.active ? '' : ' <span class="badge off">퇴사</span>'}</td>
        ${cols.map((c) => `<td class="n">${cell(c[0], c[1], c[2](r[c[0]]), { user_ids: r.id }, r.name)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length + 2}" class="empty">데이터 없음</td></tr>`}</tbody>
      <tfoot><tr><td colspan="2">합계</td>${cols.map((c) => `<td class="n">${cell(c[0], c[1], c[2](sum(c[0])), {})}</td>`).join('')}</tr></tfoot></table></div>
    <p class="note">운행비 = 연료비(공식연비×유가) + 통행료 + 주차비. 숫자를 누르면 해당 내역이 열리고, 이름을 누르면 해당 직원 운행일지로 이동합니다.</p>
    <h2 style="margin-top:20px">월별 추이</h2>
    <div class="grid2"><div class="card"><div class="note" style="margin-bottom:8px">운행비 합계</div><div class="bars">${data.monthly.map((m) => `<div class="bar-row pick" ${dd(m.ym + ' 운행 기록', { ...sq, kind: 'trips', ym: m.ym })}><span>${m.ym}</span><div class="bar" style="width:${(m.operating_cost_won / maxOp) * 100}%"></div><span class="n">${won(m.operating_cost_won)}원</span></div>`).join('') || '<div class="empty">데이터 없음</div>'}</div></div>
      <div class="card"><div class="note" style="margin-bottom:8px">카드 사용 (법인+개인)</div><div class="bars">${data.monthly.map((m) => `<div class="bar-row pick" ${dd(m.ym + ' 카드 사용', { ...sq, kind: 'expenses', ym: m.ym })}><span>${m.ym}</span><div class="bar alt" style="width:${((m.corporate_card_won + m.personal_card_won) / maxCard) * 100}%"></div><span class="n">${won(m.corporate_card_won + m.personal_card_won)}원</span></div>`).join('') || '<div class="empty">데이터 없음</div>'}</div></div></div>
    <div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>월</th><th class="n">운행km</th><th class="n">연료비</th><th class="n">통행료</th><th class="n">운행비</th><th class="n">월 주유비</th><th class="n">법인카드</th><th class="n">개인카드</th></tr></thead>
      <tbody>${data.monthly.map((m) => `<tr><td>${m.ym}</td><td class="n">${cell('distance_km', '운행km', km(m.distance_km), { ym: m.ym }, m.ym)}</td><td class="n">${cell('fuel_cost_won', '연료비', won(m.fuel_cost_won), { ym: m.ym }, m.ym)}</td><td class="n">${cell('toll_won', '통행료', won(m.toll_won), { ym: m.ym }, m.ym)}</td><td class="n">${cell('operating_cost_won', '운행비', won(m.operating_cost_won), { ym: m.ym }, m.ym)}</td><td class="n">${cell('fueling_won', '월 주유비', won(m.fueling_won), { ym: m.ym }, m.ym)}</td><td class="n">${cell('corporate_card_won', '법인카드', won(m.corporate_card_won), { ym: m.ym }, m.ym)}</td><td class="n">${cell('personal_card_won', '개인카드', won(m.personal_card_won), { ym: m.ym }, m.ym)}</td></tr>`).join('')}</tbody></table></div>`;
  $$('[data-uid]', main).forEach((tr) => (tr.onclick = async () => {
    if (!isAdmin()) return go('trips');
    go('trips/u/' + tr.dataset.uid);
  }));
  bindSummaryTabs(main);
  $('#sel-all')?.addEventListener('click', () => { state.sumUsers = []; pageSummary(); });
  $$('.card input[type=checkbox]', main).forEach((cb) => (cb.onchange = () => {
    state.sumUsers = $$('.card input[type=checkbox]:checked', main).map((x) => Number(x.value)); pageSummary();
  }));
}

// ========== 직원·차량 관리 (관리자) ==========
async function pageStaff() {
  const main = $('#main');
  const [users, models] = await Promise.all([api('/api/users?all=1'), api('/api/vehicle-models')]);
  main.innerHTML = `<div class="page-head"><h1>직원·차량 관리</h1><div class="grow"></div><button class="btn primary" id="add-user">+ 새 직원 추가</button></div>
    <div class="table-wrap"><table><thead><tr><th>상태</th><th>이름(닉네임)</th><th>부서</th><th>직책</th><th>이메일</th><th>권한</th><th>차량</th><th></th></tr></thead>
    <tbody>${users.map((u) => `<tr><td>${u.active ? '<span class="badge ok">재직</span>' : '<span class="badge off">접속차단</span>'}</td>
      <td>${userLabel(u)}</td><td>${esc(u.department || '')}</td><td>${esc(u.position || '')}</td><td>${esc(u.email)}</td><td>${u.role === 'admin' ? '관리자' : '직원'}</td>
      <td class="wrap">${u.vehicles.map((v) => `<a data-veh="${v.id}" data-u="${u.id}">${esc(v.plate)}</a> <span class="note">${OWN[v.ownership]}·${FUEL[v.fuel_type]}·${v.efficiency_km_l ? v.efficiency_km_l + 'km/L' : '연비 미등록'}</span>`).join('<br>') || '-'}
        <br><a data-addveh="${u.id}">+ 차량 추가</a></td>
      <td><div class="row"><button class="btn sm" data-edit="${u.id}">수정</button><button class="btn sm" data-reset="${u.id}">비밀번호 초기화</button>
        ${u.id === state.me.id ? '' : u.active ? `<button class="btn sm danger" data-block="${u.id}">퇴사·접속차단</button>` : `<button class="btn sm" data-unblock="${u.id}">접속 복구</button>`}</div></td></tr>`).join('')}</tbody></table></div>
    <h2 style="margin-top:24px">공식연비 기준표</h2>
    <p class="note">차종을 등록해 두면 차량 등록 시 차종 입력만으로 공식연비가 자동 입력됩니다. 값은 한국에너지공단 수송에너지(자동차 표시연비) 기준으로 입력하세요.</p>
    <div class="card"><div class="grid3" style="grid-template-columns:2fr 1fr 1fr 2fr auto;align-items:end">
      <label>차종<input id="vm-model" placeholder="예: 쏘렌토 2.2 디젤 2WD"></label>
      <label>유종<select id="vm-fuel">${Object.entries(FUEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
      <label>공식연비(복합)<input id="vm-eff" inputmode="decimal"></label><label>출처<input id="vm-src" placeholder="에너지공단 수송에너지"></label>
      <button class="btn" id="vm-add">등록</button></div>
      <div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>차종</th><th>유종</th><th class="n">공식연비</th><th>출처</th><th></th></tr></thead>
      <tbody>${models.map((m) => `<tr><td>${esc(m.model)}</td><td>${FUEL[m.fuel_type]}</td><td class="n">${m.efficiency_km_l}</td><td>${esc(m.source || '')}</td><td><button class="btn sm danger" data-delm="${m.id}">삭제</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">등록된 차종 없음</td></tr>'}</tbody></table></div></div>`;
  $('#add-user').onclick = () => userForm(null, models);
  $$('[data-edit]', main).forEach((b) => (b.onclick = () => userForm(users.find((u) => u.id == b.dataset.edit), models)));
  $$('[data-addveh]', main).forEach((b) => (b.onclick = () => vehicleForm(Number(b.dataset.addveh), null, models)));
  $$('[data-veh]', main).forEach((b) => (b.onclick = () => vehicleForm(Number(b.dataset.u), users.find((u) => u.id == b.dataset.u).vehicles.find((v) => v.id == b.dataset.veh), models)));
  $$('[data-reset]', main).forEach((b) => (b.onclick = async () => {
    try { const r = await api(`/api/users/${b.dataset.reset}/reset-password`, { method: 'POST' });
      openModal(`<h2>비밀번호 초기화 완료</h2><p>${r.is_default ? '회사 기본 초기 비밀번호로 초기화했습니다.' : '임시 비밀번호를 발급했습니다.'} 직원은 최초 로그인 시 변경해야 합니다.</p><input readonly value="${esc(r.temp_password)}" onclick="this.select()"><div class="modal-actions"><button class="btn primary" data-close>확인</button></div>`);
    } catch (e) { fail(e); }
  }));
  $$('[data-block]', main).forEach((b) => (b.onclick = async () => {
    if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = '한 번 더 눌러 차단'; return; }
    try { await api(`/api/users/${b.dataset.block}/deactivate`, { method: 'POST' }); toast('접속이 차단되었습니다 (기록은 보존)'); pageStaff(); } catch (e) { fail(e); }
  }));
  $$('[data-unblock]', main).forEach((b) => (b.onclick = async () => { try { await api(`/api/users/${b.dataset.unblock}/activate`, { method: 'POST' }); pageStaff(); } catch (e) { fail(e); } }));
  $('#vm-add').onclick = async () => {
    try { await api('/api/vehicle-models', { method: 'POST', body: { model: $('#vm-model').value, fuel_type: $('#vm-fuel').value, efficiency_km_l: $('#vm-eff').value, source: $('#vm-src').value } }); pageStaff(); } catch (e) { fail(e); }
  };
  $$('[data-delm]', main).forEach((b) => (b.onclick = async () => { try { await api('/api/vehicle-models/' + b.dataset.delm, { method: 'DELETE' }); pageStaff(); } catch (e) { fail(e); } }));
}
function vehicleFields(v, models) {
  v = v || { ownership: 'corporate', fuel_type: 'gasoline' };
  return `<div class="row">${Object.entries(OWN).map(([k, l]) => `<label class="inline" style="font-size:14px;color:var(--ink)"><input type="radio" name="ownership" value="${k}" style="width:auto" ${v.ownership === k ? 'checked' : ''}> ${l}</label>`).join('')}</div>
    <div class="grid2"><label>차량번호<input name="plate" value="${esc(v.plate || '')}" placeholder="예: 12가 3456"></label>
      <label>차종<input name="model" list="model-list" value="${esc(v.model || '')}" placeholder="기준표에서 선택 또는 입력"><datalist id="model-list">${models.map((m) => `<option value="${esc(m.model)}">`).join('')}</datalist></label></div>
    <div class="grid2"><label>유종<select name="fuel_type">${Object.entries(FUEL).map(([k, l]) => `<option value="${k}" ${v.fuel_type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>공식연비 (km/L, 전기 km/kWh)<input name="efficiency_km_l" inputmode="decimal" value="${v.efficiency_km_l ?? ''}"></label></div>
    <div class="note" id="eff-note"></div>`;
}
function bindVehicleFields(c, models) {
  const model = $('[name=model]', c);
  model.oninput = () => {
    const m = models.find((x) => x.model.toLowerCase() === model.value.trim().toLowerCase());
    if (m) { $('[name=efficiency_km_l]', c).value = m.efficiency_km_l; $('[name=fuel_type]', c).value = m.fuel_type; $('#eff-note', c).textContent = `공식연비 자동 입력: ${m.efficiency_km_l} (${m.source || '기준표'})`; }
    else $('#eff-note', c).textContent = model.value ? '기준표에 없는 차종 — 공식연비를 직접 입력하거나 기준표에 먼저 등록하세요 (미입력 시 연료비 계산 불가)' : '';
  };
}
const vehicleBody = (c) => ({
  ownership: $('[name=ownership]:checked', c)?.value, plate: $('[name=plate]', c).value, model: $('[name=model]', c).value,
  fuel_type: $('[name=fuel_type]', c).value, efficiency_km_l: $('[name=efficiency_km_l]', c).value,
});
function userForm(u, models, done = pageStaff) {
  const c = openModal(`<h2>${u ? '직원·차량 정보 수정' : '새 직원 추가'}</h2>
    <div class="grid2"><label>이름<input name="name" value="${esc(u?.name || '')}"></label><label>닉네임<input name="nickname" value="${esc(u?.nickname || '')}"></label></div>
    <div class="grid3"><label>부서<input name="department" value="${esc(u?.department || '')}" list="dept-list"><datalist id="dept-list"><option value="운영팀"><option value="물류팀"><option value="인테리어팀"><option value="브랜드마케팅팀"></datalist></label>
      <label>직책<input name="position" value="${esc(u?.position || '')}"></label>
      <label>권한<select name="role"><option value="user">직원</option><option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>관리자</option></select></label></div>
    <label>회사 이메일 (@cafefrihet.com)<input name="email" type="email" value="${esc(u?.email || '')}"></label>
    <label>법인카드 일지 구분 (비우면 직책이 '팀장'인 경우에만 팀장카드로 사용 · '사용안함'이면 부서팀장 일지에서 제외)<input name="team_card" list="tc-list" value="${esc(u?.team_card || '')}" placeholder="예: 총무카드"><datalist id="tc-list"><option value="총무카드"><option value="팀장카드"><option value="사용안함"></datalist></label>
    ${u ? `<h2 style="margin-top:6px">등록 차량</h2>${(u.vehicles || []).map((v) => `<div class="card veh-edit" data-vid="${v.id}" style="display:grid;gap:8px;padding:12px">
        <div class="grid3"><label>차량번호<input name="v_plate" value="${esc(v.plate)}"></label>
          <label>구분<select name="v_ownership">${Object.entries(OWN).map(([k, l]) => `<option value="${k}" ${v.ownership === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>유종<select name="v_fuel">${Object.entries(FUEL).map(([k, l]) => `<option value="${k}" ${v.fuel_type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
        <div class="grid3"><label>차종<input name="v_model" value="${esc(v.model || '')}"></label>
          <label>공식연비 (km/L)<input name="v_eff" inputmode="decimal" value="${v.efficiency_km_l ?? ''}"></label>
          <label class="inline" style="font-size:13px;color:var(--ink);align-self:end"><input type="checkbox" name="v_active" style="width:auto" ${v.active ? 'checked' : ''}> 사용 중</label></div></div>`).join('') || '<p class="note">등록된 차량 없음 (목록의 "+ 차량 추가" 사용)</p>'}`
      : `<h2 style="margin-top:6px">차량 등록</h2>${vehicleFields(null, models)}<p class="note">차량번호를 비워두면 차량 없이 등록됩니다. 초기 비밀번호는 저장 후 화면에 표시됩니다.</p>`}
    <div class="modal-actions"><button class="btn" data-close>취소</button><button class="btn primary" id="save">저장</button></div>`);
  if (!u) bindVehicleFields(c, models);
  $('#save', c).onclick = async () => {
    const body = {}; ['name', 'nickname', 'department', 'position', 'role', 'email', 'team_card'].forEach((n) => (body[n] = $(`[name=${n}]`, c).value));
    if (!u) body.vehicle = vehicleBody(c);
    try {
      const r = await api(u ? `/api/users/${u.id}` : '/api/users', { method: u ? 'PUT' : 'POST', body });
      if (u) for (const box of $$('.veh-edit', c)) {
        const g = (n) => $(`[name=${n}]`, box);
        await api(`/api/vehicles/${box.dataset.vid}`, { method: 'PUT', body: { user_id: u.id, plate: g('v_plate').value, ownership: g('v_ownership').value, fuel_type: g('v_fuel').value, model: g('v_model').value, efficiency_km_l: g('v_eff').value, active: g('v_active').checked } });
      }
      if (r.temp_password) openModal(`<h2>직원 등록 완료</h2><p>로그인: 회사 이메일 / 초기 비밀번호: ${r.is_default ? '회사 기본 초기 비밀번호' : '아래 임시 비밀번호'}. 최초 로그인 시 변경 화면이 뜹니다.</p><input readonly value="${esc(r.temp_password)}" onclick="this.select()"><div class="modal-actions"><button class="btn primary" data-close>확인</button></div>`);
      else closeModal();
      done();
    } catch (e) { fail(e); }
  };
}
function vehicleForm(userId, v, models) {
  const c = openModal(`<h2>${v ? '차량 수정' : '차량 추가'}</h2>${vehicleFields(v, models)}
    ${v ? `<label class="inline" style="font-size:13px;color:var(--ink)"><input type="checkbox" name="active" style="width:auto" ${v.active ? 'checked' : ''}> 사용 중</label>` : ''}
    <div class="modal-actions"><button class="btn" data-close>취소</button><button class="btn primary" id="save">저장</button></div>`);
  bindVehicleFields(c, models);
  $('#save', c).onclick = async () => {
    const body = { ...vehicleBody(c), user_id: userId, active: v ? $('[name=active]', c).checked : true };
    try { await api(v ? `/api/vehicles/${v.id}` : '/api/vehicles', { method: v ? 'PUT' : 'POST', body }); closeModal(); pageStaff(); } catch (e) { fail(e); }
  };
}

// ========== 설정 (관리자) ==========
async function pageSettings() {
  const main = $('#main');
  const s = await api('/api/settings');
  const keyState = (k) => (s[k].set ? `<span class="badge ok">등록됨${s[k].from_env ? ' (환경변수)' : ''}</span>` : '<span class="badge off">미등록</span>');
  main.innerHTML = `<div class="page-head"><h1>설정</h1></div>
    <div class="card" style="display:grid;gap:12px;margin-bottom:16px"><h2>외부 연동 키</h2>
      <p class="note">카카오 REST 키: 장소검색·경로거리·예상통행료에 사용 (카카오디벨로퍼스 앱 → 카카오맵/카카오모빌리티 활성화). JavaScript 키: 경로 지도 표시용 (플랫폼 Web 도메인에 이 사이트 주소 등록 필요). 오피넷 키: 전국 평균 유가 자동 조회.</p>
      <div class="grid2"><label>카카오 REST API 키 ${keyState('kakao_rest_key')}<input name="kakao_rest_key" type="password" placeholder="변경 시에만 입력"></label>
        <label>카카오 JavaScript 키<input name="kakao_js_key" value="${esc(s.kakao_js_key)}"></label></div>
      <label>오피넷 API 키 ${keyState('opinet_key')}<input name="opinet_key" type="password" placeholder="변경 시에만 입력"></label>
      <h2>수동 유가 (오피넷 미연동 시 사용)</h2>
      <div class="grid3" style="grid-template-columns:repeat(4,1fr)"><label>휘발유 (원/L)<input name="price_gasoline" value="${esc(s.price_gasoline)}"></label>
        <label>경유 (원/L)<input name="price_diesel" value="${esc(s.price_diesel)}"></label><label>LPG (원/L)<input name="price_lpg" value="${esc(s.price_lpg)}"></label>
        <label>전기 (원/kWh)<input name="price_ev" value="${esc(s.price_ev)}"></label></div>
      <h2>정비 알림 기준 (회사 운영 기준)</h2>
      <div class="grid3" style="grid-template-columns:repeat(5,1fr)"><label>엔진오일 주기 (km)<input name="rule_oil_km" placeholder="10000" value="${esc(s.rule_oil_km)}"></label>
        <label>엔진오일 주기 (개월)<input name="rule_oil_months" placeholder="12" value="${esc(s.rule_oil_months)}"></label>
        <label>타이어 교체 주기 (km)<input name="rule_tire_km" placeholder="20000" value="${esc(s.rule_tire_km)}"></label>
        <label>타이어 주기 (개월, 0=미사용)<input name="rule_tire_months" placeholder="0" value="${esc(s.rule_tire_months)}"></label>
        <label>임박 알림 (%)<input name="rule_due_soon_pct" placeholder="85" value="${esc(s.rule_due_soon_pct)}"></label></div>
      <p class="note">비워두면 기본값(엔진오일 10,000km/12개월, 타이어 20,000km, 85%)을 사용합니다. 차량 제조사 권장 주기는 차종별로 다르므로 확인 후 조정하세요.</p>
      <div class="row"><button class="btn primary" id="save">저장</button><button class="btn" id="opi-test">오피넷 연결 테스트</button></div><pre id="opi-out" class="note"></pre></div>
    <div class="card" style="display:grid;gap:12px;margin-bottom:16px" id="granter-box"><h2>그랜터 법인카드 연동</h2><div class="note">불러오는 중…</div></div>
    <div class="card" style="display:grid;gap:12px"><h2>기존 엑셀 데이터 이관</h2>
      <p class="note">기존 엑셀(SV팀 차량 운행일지 · 직원점검 관리일지)에서 추출한 이관 파일(.json.gz)을 올립니다. 다시 올리면 이전 엑셀 이관분을 지우고 새로 적재합니다. 웹에서 입력한 기록은 유지됩니다.</p>
      <label>이관 파일 (.zip / .json.gz)<input type="file" name="file" accept=".zip,.gz,.json"></label>
      <div class="row"><button class="btn" id="dry">미리 검사</button><button class="btn primary" id="imp">이관 실행</button></div><pre id="imp-out" class="note"></pre></div>`;
  $('#save').onclick = async () => {
    const body = {}; ['kakao_rest_key', 'kakao_js_key', 'opinet_key', 'price_gasoline', 'price_diesel', 'price_lpg', 'price_ev', 'rule_oil_km', 'rule_oil_months', 'rule_tire_km', 'rule_tire_months', 'rule_due_soon_pct'].forEach((k) => (body[k] = $(`[name=${k}]`, main).value));
    try { await api('/api/settings', { method: 'PUT', body }); toast('저장되었습니다'); state.jsKey = body.kakao_js_key || null; pageSettings(); } catch (e) { fail(e); }
  };
  const run = async (dry) => {
    const file = $('[name=file]', main).files[0]; if (!file) return toast('파일을 선택하세요', true);
    const out = $('#imp-out');
    $$('#dry,#imp', main).forEach((b) => (b.disabled = true));
    try {
      const CH = 4 * 1024 * 1024, total = Math.max(1, Math.ceil(file.size / CH)), id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      let r;
      for (let i = 0; i < total; i++) {
        out.textContent = `업로드 중 ${i + 1}/${total} (${Math.round(((i + 1) / total) * 100)}%)${i === total - 1 ? ' · 서버 적재 중…' : ''}`;
        const res = await fetch(`/api/admin/import-chunk?id=${id}&index=${i}&total=${total}&dry=${dry}`, { method: 'POST', body: file.slice(i * CH, (i + 1) * CH), credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' } });
        r = await res.json(); if (!res.ok) throw new Error(r.error || '업로드 실패');
      }
      out.textContent = (dry ? '[미리 검사 · 저장 안 됨]\n' : '[이관 완료]\n') + JSON.stringify(r, null, 2);
    } catch (e) { fail(e); out.textContent = '실패: ' + e.message; }
    $$('#dry,#imp', main).forEach((b) => (b.disabled = false));
  };
  $('#opi-test').onclick = async () => {
    $('#opi-out').textContent = '조회 중…';
    try { $('#opi-out').textContent = JSON.stringify(await api('/api/admin/opinet-test'), null, 2); } catch (e) { $('#opi-out').textContent = '실패: ' + e.message; }
  };
  $('#dry').onclick = () => run(true); $('#imp').onclick = () => run(false);
  granterAdmin();
}
async function granterAdmin() {
  const box = $('#granter-box'); if (!box) return;
  const [g, users] = await Promise.all([api('/api/admin/granter'), api('/api/users?all=1')]);
  const L = g.last;
  const BOOK = { auto: '자동 (팀장카드 대상자면 팀장일지)', drive: '차량운행일지', team: '부서팀장 법인카드 일지', off: '연동 안 함' };
  box.innerHTML = `<h2>그랜터 법인카드 연동 ${g.enabled ? '<span class="badge ok">API 키 등록됨</span>' : '<span class="badge off">API 키 미등록</span>'}</h2>
    <p class="note">10분마다 그랜터 카드 사용내역을 자동으로 불러옵니다. 금액·일자·가맹점은 그랜터 기준이며, 취소·제외 처리된 건은 자동으로 빠집니다. 직원은 사용 목적·상세내용·영수증만 입력합니다.
      직원 연결 순서: 아래에서 지정한 직원 → 카드명 앞 담당자 이름(예: 노아_기업체크카드 → 노아) → 그랜터 사용직원·카드 소유자. 기록 위치 '자동'은 팀장카드 대상자면 부서팀장 일지, 아니면 차량운행일지입니다.
      '일지 표시명'을 넣고 기록 위치를 부서팀장 법인카드 일지로 두면 그 카드는 팀장일지에 별도 항목으로 보입니다. ${g.enabled ? '' : '<b>API 키는 FND 환경변수 GRANTER_API_KEY 에 등록해야 동작합니다.</b>'}</p>
    <div class="row"><label class="inline">연동 시작일 <input type="date" name="g_from" value="${esc(g.from)}" style="width:auto"></label><button class="btn sm" id="g-from">시작일 저장</button>
      <button class="btn primary" id="g-sync" ${g.enabled ? '' : 'disabled'}>지금 동기화</button></div>
    <div class="note">최근 동기화: ${L ? `${esc(new Date(L.at).toLocaleString('ko-KR'))} · ${L.ok ? `조회 ${L.fetched}건 · 신규 ${L.inserted} · 수기입력 흡수 ${L.merged} · 변경 ${L.updated} · 삭제 ${L.removed} · 직원 미연결 ${L.skipped_unmapped}건` : '실패: ' + esc(L.error)}` : '없음'}</div>
    <div class="row"><span class="note">연동 안 함 카드 ${g.cards.filter((c) => c.book === 'off').length}장 ${state.showOffCards ? '표시 중' : '숨김'}</span><button class="btn sm" id="g-off">${state.showOffCards ? '숨기기' : '보기'}</button></div>
    <div class="table-wrap"><table><thead><tr><th>그랜터 카드</th><th>카드번호</th><th>연결 직원</th><th>기록 위치</th><th>일지 표시명 (별도 항목)</th><th class="n">적재</th><th class="n">목적 미선택</th><th></th></tr></thead><tbody>
    ${g.cards.filter((c) => state.showOffCards || c.book !== 'off').map((c) => `<tr data-card="${esc(c.card_id)}"><td class="wrap">${esc(c.name)}</td><td>${esc(c.number || '')}</td>
      <td><select name="uid"><option value="">자동${c.auto_user ? ': ' + esc(c.auto_user) : ' (매칭 없음)'}</option>${users.filter((u) => u.active || u.id === c.user_id).map((u) => `<option value="${u.id}" ${u.id === c.user_id ? 'selected' : ''}>${esc(u.name)}${u.nickname ? ' (' + esc(u.nickname) + ')' : ''}</option>`).join('')}</select></td>
      <td><select name="book">${Object.entries(BOOK).map(([k, v]) => `<option value="${k}" ${k === c.book ? 'selected' : ''}>${k === 'auto' && c.auto_book ? '자동: ' + (c.auto_book === 'team' ? '부서팀장 일지' : '차량운행일지') : v}</option>`).join('')}</select></td>
      <td><input name="label" value="${esc(c.label || '')}" placeholder="예: 삼성카드 전용"></td>
      <td class="n">${c.n}</td><td class="n">${c.n_unset}</td><td><button class="btn sm" data-csave>저장</button></td></tr>`).join('') || '<tr><td colspan="8" class="empty">아직 불러온 카드가 없습니다. 동기화 후 표시됩니다.</td></tr>'}</tbody></table></div>`;
  $('#g-off').onclick = () => { state.showOffCards = !state.showOffCards; granterAdmin(); };
  $('#g-from').onclick = async () => { try { await api('/api/admin/granter/from', { method: 'PUT', body: { from: $('[name=g_from]', box).value } }); toast('시작일 저장'); granterAdmin(); } catch (e) { fail(e); } };
  $('#g-sync').onclick = async (ev) => {
    ev.target.disabled = true; ev.target.textContent = '동기화 중…';
    try { const r = await api('/api/admin/granter/sync', { method: 'POST' }); toast(r.ok ? `동기화 완료 · 신규 ${r.inserted}건` : '실패: ' + r.error, !r.ok); } catch (e) { fail(e); }
    granterAdmin();
  };
  $$('[data-csave]', box).forEach((b) => (b.onclick = async () => {
    const tr = b.closest('tr');
    try {
      await api('/api/admin/granter/cards/' + encodeURIComponent(tr.dataset.card), { method: 'PUT', body: { user_id: $('[name=uid]', tr).value || null, book: $('[name=book]', tr).value, label: $('[name=label]', tr).value } });
      toast('저장 · 다음 동기화부터 반영 (지금 동기화로 즉시 반영)');
    } catch (e) { fail(e); }
  }));
}

boot();
