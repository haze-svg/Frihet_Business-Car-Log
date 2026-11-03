/* Frihet 업무차량 운행관리 - SPA (빌드 도구 없음) */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = (v) => (Number(v) || 0).toLocaleString('ko-KR');
const km = (v) => (Math.round((Number(v) || 0) * 10) / 10).toLocaleString('ko-KR', { maximumFractionDigits: 1 });
const FUEL = { gasoline: '휘발유', diesel: '경유', lpg: 'LPG', hybrid: '하이브리드(휘발유)', ev: '전기' };
const OWN = { corporate: '법인차량', personal: '개인차량' };
const CARD = { corporate: '법인카드', personal: '개인카드', receipt: '증빙(이관)' };
const EXP_CATS = ['식대', '주유비', '통행료', '주차비', '매장물품구매', '숙박비', '기타'];
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
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
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
    if (r.must_change_password) changePassword(true);
  } catch (err) { $('#login-err').textContent = err.message; }
};
$('#btn-logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); };
$('#btn-pw').onclick = () => changePassword(false);
function changePassword(forced) {
  const c = openModal(`<h2>비밀번호 변경</h2>${forced ? '<p class="warn">최초 로그인입니다. 비밀번호를 변경하세요.</p>' : ''}
    <label>현재 비밀번호<input type="password" name="current"></label>
    <label>새 비밀번호 (8자 이상)<input type="password" name="next"></label>
    <label>새 비밀번호 확인<input type="password" name="next2"></label>
    <div class="modal-actions">${forced ? '' : '<button class="btn" data-close>취소</button>'}<button class="btn primary" id="pw-save">변경</button></div>`);
  $('#pw-save', c).onclick = async () => {
    const v = (n) => $(`[name=${n}]`, c).value;
    if (v('next') !== v('next2')) return toast('새 비밀번호가 일치하지 않습니다', true);
    try { await api('/api/auth/password', { method: 'POST', body: { current: v('current'), next: v('next') } }); closeModal(); toast('변경되었습니다'); } catch (e) { fail(e); }
  };
}

async function boot() {
  try { state.me = await api('/api/me'); } catch { return showLogin(); }
  $('#login-view').classList.add('hidden'); $('#app-view').classList.remove('hidden');
  $('#me-name').innerHTML = `<b>${userLabel(state.me)}</b><br><span class="note">${esc(state.me.department || '')} ${esc(state.me.position || '')}</span>`;
  $$('.admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin()));
  api('/api/public-config').then((c) => (state.jsKey = c.kakao_js_key)).catch(() => {});
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
  const [page, kind, id] = (location.hash.replace('#', '') || 'trips').split('/');
  state.page = page;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
  state.tripUser = null; state.vehicle = null;
  try {
    if (page === 'trips' && kind === 'u' && id) {
      state.tripUser = isAdmin() ? (await api('/api/users?all=1')).find((u) => u.id == id) : state.me;
    }
    if (page === 'maintenance' && kind === 'v' && id) state.vehicle = (await api('/api/vehicles')).find((v) => v.id == id) || null;
  } catch (e) { fail(e); }
  ({ trips: pageTrips, maintenance: pageMaint, summary: pageSummary, staff: pageStaff, settings: pageSettings }[page] || pageTrips)();
  window.scrollTo(0, 0);
}
const backBtn = (fallback) => `<button class="btn sm back-btn" data-back="${fallback}">← 뒤로</button>`;
document.addEventListener('click', (e) => { const b = e.target.closest('[data-back]'); if (b) back(b.dataset.back); });

// ---------- 차량 정비 상태 표시 ----------
const LV = { overdue: ['al-red', '교체 필요'], unknown: ['al-amber', '확인 필요'], soon: ['al-orange', '임박'], ok: ['al-green', '정상'] };
async function vehicleStatusMap(ids) {
  try { const r = await api('/api/vehicle-status' + (ids ? '?ids=' + ids.join(',') : '')); const m = {}; r.items.forEach((x) => (m[x.vehicle_id] = x)); return { map: m, rules: r.rules }; }
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
      <div class="kpi"><div class="l">운행 횟수</div><div class="v">${trips.length}회</div></div>
      <div class="kpi"><div class="l">운행 거리</div><div class="v">${km(t.km)} km</div></div>
      <div class="kpi"><div class="l">연료비(공식연비 기준)</div><div class="v">${won(t.fuel)}원</div></div>
      <div class="kpi"><div class="l">통행료</div><div class="v">${won(t.toll)}원</div></div>
      <div class="kpi"><div class="l">운행비 합계</div><div class="v">${won(t.fuel + t.toll + t.park)}원</div></div>
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
      const item = (r) => `<div class="exp-item"><div class="row" style="justify-content:space-between"><span><span class="badge ${r.card_type === 'corporate' ? 'corp' : 'pers'}">${esc(r.category)}</span> ${esc(r.purpose || '')}</span><b>${won(r.amount)}원</b></div>
        ${r.photos.length ? `<div class="thumbs big">${thumbs(r.photos).replace('<div class="thumbs">', '').replace(/<\/div>$/, '')}</div>` : '<div class="note">영수증 없음</div>'}
        ${r.memo ? `<div class="note">${esc(r.memo)}</div>` : ''}<div style="text-align:right"><button class="btn sm" data-edit="${r.id}">수정</button></div></div>`;
      body.innerHTML = `<div class="row" style="margin-bottom:10px"><button class="btn primary" id="add-exp">+ 카드 사용 단건 등록</button>
          <button class="btn" id="add-day2">+ 하루 일괄 입력</button></div>
        <div class="kpis">
          <div class="kpi"><div class="l">법인카드 합계</div><div class="v" style="color:var(--corp)">${won(e.corporate)}원</div><div class="note">${real.filter((r) => r.card_type === 'corporate').length}건</div></div>
          <div class="kpi"><div class="l">개인카드 합계</div><div class="v" style="color:var(--pers)">${won(e.personal)}원</div><div class="note">${real.filter((r) => r.card_type === 'personal').length}건</div></div>
          <div class="kpi"><div class="l">총 합계</div><div class="v">${won(e.corporate + e.personal)}원</div></div>
          <div class="kpi"><div class="l">영수증 사진</div><div class="v">${nPhotos}장</div></div></div>
        ${Object.keys(days).sort().reverse().map((d) => { const D = days[d]; const sc = D.corporate.reduce((a, r) => a + r.amount, 0), sp = D.personal.reduce((a, r) => a + r.amount, 0);
          return `<div class="card day-block"><div class="row" style="justify-content:space-between;margin-bottom:8px"><b>${d}</b>
            <span class="note">법인 <b style="color:var(--corp)">${won(sc)}</b> · 개인 <b style="color:var(--pers)">${won(sp)}</b> · 합계 <b>${won(sc + sp)}원</b></span></div>
            <div class="grid2"><div><div class="col-title corp">법인카드</div>${D.corporate.map(item).join('') || '<div class="note">-</div>'}</div>
            <div><div class="col-title pers">개인카드</div>${D.personal.map(item).join('') || '<div class="note">-</div>'}</div></div></div>`; }).join('') || '<div class="empty card">기간 내 카드 사용 내역 없음</div>'}
        ${bundles.length ? `<h2 style="margin-top:18px">엑셀 이관 영수증 (월별 일괄 · 건별 구분 불가)</h2>${bundles.map((r) => `<div class="card day-block"><div class="row" style="justify-content:space-between"><b>${esc(r.purpose)}</b><span class="note">${esc(r.memo || '')}</span></div><div class="thumbs big">${thumbs(r.photos).replace('<div class="thumbs">', '').replace(/<\/div>$/, '')}</div></div>`).join('')}` : ''}`;
      $('#add-day2').onclick = () => dayForm(u, myVehicles);
      $('#add-exp').onclick = () => expenseForm(u, myVehicles, null);
      $$('[data-edit]', body).forEach((b) => (b.onclick = () => expenseForm(u, myVehicles, exps.find((x) => x.id == b.dataset.edit))));
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
      <div class="card-col corp"><div class="col-title corp">법인카드</div><div class="exp-rows" data-card="corporate"></div><button class="btn sm" data-addexp="corporate">+ 법인카드 사용 추가</button></div>
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
      <input name="etc" class="hidden" placeholder="기타 항목 입력"><input name="amount" inputmode="numeric" placeholder="금액(원)">
      <input name="purpose" placeholder="내용 (예: 운영팀 중식)"><button class="btn sm danger" data-rm>×</button></div>
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
    const sc = sum('corporate'), sp = sum('personal');
    $('#day-sum', c).innerHTML = `<div><span>총 거리</span><b>${km(tk)} km</b></div><div><span>연료비</span><b>${won(tf)}원</b></div>
      <div><span>통행료</span><b>${won(tt)}원</b></div><div><span>주차비</span><b>${won(tp)}원</b></div><div class="hl"><span>운행비 합계</span><b>${won(tf + tt + tp)}원</b></div>
      <div><span>법인카드</span><b style="color:var(--corp)">${won(sc)}원</b></div><div><span>개인카드</span><b style="color:var(--pers)">${won(sp)}원</b></div><div class="hl"><span>카드 합계</span><b>${won(sc + sp)}원</b></div>`;
  }

  $('#add-leg', c).onclick = () => { const legs = $$('.leg', legBox); const last = legs[legs.length - 1]; addLeg(last?._be._val || null); };
  $$('[data-addexp]', c).forEach((b) => (b.onclick = () => addExp(b.dataset.addexp)));
  f('vehicle_id').onchange = setVehicle;
  ['price', 'eff'].forEach((n) => (f(n).oninput = recalc));
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
    const fd = new FormData();
    fd.append('payload', JSON.stringify({ user_id: u.id, date: f('date').value, vehicle_id: f('vehicle_id').value || null,
      fuel_price_won: f('price').value, efficiency_km_l: f('eff').value, legs, expenses }));
    btn.disabled = true; btn.textContent = '저장 중…';
    try {
      for (const el of $$('.exp-row', c)) for (const file of $('[name=photos]', el).files) fd.append('photo_' + el.dataset.key, await shrink(file));
      const r = await api('/api/day', { method: 'POST', body: fd });
      closeModal(); toast(`저장 완료 · 운행 ${r.trips}건 · 카드 ${r.expenses}건 · 사진 ${r.photos}장`); pageTrips();
    } catch (e) { fail(e); btn.disabled = false; btn.textContent = '저장'; }
  };
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

function expenseForm(u, vehicles, rec) {
  const r = rec || { expense_date: today(), card_type: 'corporate', category: '주유', amount: '' };
  const c = openModal(`<h2>${rec ? '카드 사용 수정' : '카드 사용 등록'} · ${userLabel(u)}</h2>
    <div class="row">${['corporate', 'personal'].map((t) => `<label class="inline" style="font-size:14px;color:var(--ink)"><input type="radio" name="card_type" value="${t}" style="width:auto" ${r.card_type === t ? 'checked' : ''}> ${CARD[t]}</label>`).join('')}</div>
    <div class="grid3"><label>사용일자<input type="date" name="expense_date" value="${String(r.expense_date).slice(0, 10)}"></label>
      <label>항목<select name="category">${(EXP_CATS.includes(r.category) ? EXP_CATS : [...EXP_CATS, r.category]).map((x) => `<option ${x === r.category ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
      <label>금액 (원)<input name="amount" inputmode="numeric" value="${r.amount}"></label></div>
    <div class="grid2"><label>사용 목적<input name="purpose" value="${esc(r.purpose || '')}"></label>
      <label>차량<select name="vehicle_id"><option value="">-</option>${vehicles.map((v) => `<option value="${v.id}" ${v.id == r.vehicle_id ? 'selected' : ''}>${esc(v.plate)}</option>`).join('')}</select></label></div>
    <label>비고<input name="memo" value="${esc(r.memo || '')}"></label>
    ${photoPicker(r.photos)}
    <div class="modal-actions">${rec ? '<button class="btn danger" id="del">삭제</button><div style="flex:1"></div>' : ''}<button class="btn" data-close>취소</button><button class="btn primary" id="save">저장</button></div>`);
  bindPhotoPicker(c);
  $('#save', c).onclick = async () => {
    const fd = new FormData();
    fd.append('user_id', u.id);
    fd.append('card_type', $('[name=card_type]:checked', c)?.value || '');
    ['expense_date', 'category', 'amount', 'purpose', 'vehicle_id', 'memo'].forEach((n) => fd.append(n, $(`[name=${n}]`, c).value));
    for (const f of $('[name=photos]', c).files) fd.append('photos', await shrink(f));
    try { await api(rec ? `/api/expenses/${rec.id}` : '/api/expenses', { method: rec ? 'PUT' : 'POST', body: fd }); closeModal(); toast('저장되었습니다'); state.tab = 'expenses'; pageTrips(); } catch (e) { fail(e); }
  };
  $('#del', c)?.addEventListener('click', async () => {
    if (!confirmInline(c, '이 카드 사용 내역과 사진을 삭제합니다')) return;
    try { await api(`/api/expenses/${rec.id}`, { method: 'DELETE' }); closeModal(); pageTrips(); } catch (e) { fail(e); }
  });
}

// ========== 차량관리 및 점검일지 ==========
async function pageMaint() {
  const main = $('#main');
  const vehicles = await api('/api/vehicles');
  if (!state.vehicle) {
    const { map, rules } = await vehicleStatusMap();
    const order = { overdue: 0, unknown: 1, soon: 2, ok: 3 };
    const list = [...vehicles].sort((a, b) => (b.active - a.active) || (order[map[a.id]?.worst] ?? 9) - (order[map[b.id]?.worst] ?? 9));
    const cnt = (lv) => vehicles.filter((v) => v.active && map[v.id]?.alerts.some((a) => a.level === lv)).length;
    main.innerHTML = `<div class="page-head"><h1>차량관리 및 점검일지</h1></div>
      <div class="kpis"><div class="kpi"><div class="l">교체 필요 차량</div><div class="v" style="color:#b23b3b">${cnt('overdue')}대</div></div>
        <div class="kpi"><div class="l">이력 확인 필요</div><div class="v" style="color:#a86b00">${cnt('unknown')}대</div></div>
        <div class="kpi"><div class="l">교체 임박</div><div class="v" style="color:#c26a1b">${cnt('soon')}대</div></div>
        <div class="kpi"><div class="l">사용 차량</div><div class="v">${vehicles.filter((v) => v.active).length}대</div></div></div>
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
    return;
  }
  const v = state.vehicle;
  const [rows, vs1] = await Promise.all([api(`/api/maintenance?vehicle_id=${v.id}&${rq()}`), vehicleStatusMap([v.id])]);
  const total = rows.reduce((a, r) => a + r.amount, 0);
  const lastOdo = rows.find((r) => r.odometer_km)?.odometer_km;
  main.innerHTML = `<div class="crumb">${backBtn('maintenance')} <a id="back">차량관리 및 점검일지</a> / ${esc(v.plate)}</div>
    <div class="page-head"><h1>${esc(v.plate)} <span class="badge ${v.ownership === 'corporate' ? 'corp' : 'pers'}">${OWN[v.ownership]}</span></h1><div class="grow"></div>${rangeControls(pageMaint)}</div>
    <div class="kpis"><div class="kpi"><div class="l">차종 / 유종</div><div class="v" style="font-size:15px">${esc(v.model || '-')} / ${FUEL[v.fuel_type]}</div></div>
      <div class="kpi"><div class="l">공식연비</div><div class="v">${v.efficiency_km_l ? v.efficiency_km_l + ' km/L' : '데이터 확인 불가'}</div></div>
      <div class="kpi"><div class="l">최근 주행거리</div><div class="v">${lastOdo ? won(lastOdo) + ' km' : '-'}</div></div>
      <div class="kpi"><div class="l">기간 관리비용</div><div class="v">${won(total)}원</div></div></div>
    <div class="row" style="margin-bottom:10px"><button class="btn primary" id="add">+ 관리·점검 기록</button></div>
    <div class="table-wrap"><table><thead><tr><th>일자</th><th>구분</th><th class="n">주행거리</th><th>내용</th><th>업체</th><th>결제</th><th class="n">금액</th><th>다음 점검</th><th>사진</th><th>작성자</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${r.maint_date.slice(0, 10)}</td><td>${esc(r.maint_type)}</td><td class="n">${r.odometer_km ? won(r.odometer_km) : '-'}</td>
      <td class="wrap">${esc(r.description)}</td><td>${esc(r.vendor)}</td><td>${r.card_type ? `<span class="badge ${r.card_type === 'corporate' ? 'corp' : 'pers'}">${CARD[r.card_type]}</span>` : '-'}</td>
      <td class="n">${won(r.amount)}</td><td>${r.next_due_date ? r.next_due_date.slice(0, 10) : ''}${r.next_due_km ? ' / ' + won(r.next_due_km) + 'km' : ''}</td>
      <td>${thumbs(r.photos)}</td><td>${esc(r.user_name || '')}</td><td><button class="btn sm" data-edit="${r.id}">수정</button></td></tr>`).join('') || '<tr><td colspan="11" class="empty">기록 없음</td></tr>'}</tbody>
    <tfoot><tr><td colspan="6">합계</td><td class="n">${won(total)}</td><td colspan="4"></td></tr></tfoot></table></div>`;
  $('#back').onclick = () => go('maintenance');
  $('.kpis', main).insertAdjacentHTML('beforebegin', vehiclePanel(v, vs1.map[v.id]).replace('<button class="btn sm" data-gov="' + v.id + '">관리·점검일지 →</button>', ''));
  $('.veh-panel details', main)?.setAttribute('open', '');
  $('#add').onclick = () => maintForm(v, null);
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
async function pageSummary() {
  const main = $('#main');
  const ids = state.sumUsers.join(',');
  const [data, users] = await Promise.all([api(`/api/summary?${rq()}${ids ? '&user_ids=' + ids : ''}`), isAdmin() ? api('/api/users?all=1') : Promise.resolve([])]);
  const U = data.users;
  const sum = (k) => U.reduce((a, r) => a + Number(r[k] || 0), 0);
  const cols = [
    ['trip_count', '운행횟수', (v) => won(v)], ['distance_km', '운행km', km], ['fuel_cost_won', '연료비', won], ['toll_won', '통행료', won],
    ['parking_won', '주차비', won], ['operating_cost_won', '운행비 합계', won], ['fueling_won', '월 주유비(카드)', won],
    ['corporate_card_won', '법인카드', won], ['personal_card_won', '개인카드', won], ['maintenance_won', '관리·점검비', won],
  ];
  const maxOp = Math.max(1, ...data.monthly.map((m) => m.operating_cost_won));
  const maxCard = Math.max(1, ...data.monthly.map((m) => m.corporate_card_won + m.personal_card_won));
  main.innerHTML = `<div class="page-head"><h1>통합 합계관리</h1><div class="grow"></div>${rangeControls(pageSummary)}</div>
    ${isAdmin() ? `<div class="card" style="margin-bottom:14px"><div class="row"><b style="font-size:13px">직원 선택</b>
      <button class="btn sm" id="sel-all">전체 비교</button>
      ${users.map((u) => `<label class="inline" style="font-size:13px;color:var(--ink);font-weight:400"><input type="checkbox" value="${u.id}" style="width:auto" ${state.sumUsers.includes(u.id) ? 'checked' : ''}>${userLabel(u)}${u.active ? '' : ' <span class="badge off">퇴사</span>'}</label>`).join('')}
      </div></div>` : ''}
    <div class="kpis">
      <div class="kpi"><div class="l">총 운행거리</div><div class="v">${km(sum('distance_km'))} km</div></div>
      <div class="kpi"><div class="l">총 운행비</div><div class="v">${won(sum('operating_cost_won'))}원</div></div>
      <div class="kpi"><div class="l">주유비(카드)</div><div class="v">${won(sum('fueling_won'))}원</div></div>
      <div class="kpi"><div class="l">법인카드</div><div class="v">${won(sum('corporate_card_won'))}원</div></div>
      <div class="kpi"><div class="l">개인카드</div><div class="v">${won(sum('personal_card_won'))}원</div></div>
      <div class="kpi"><div class="l">관리·점검비</div><div class="v">${won(sum('maintenance_won'))}원</div></div></div>
    <h2>직원별 비교</h2>
    <div class="table-wrap"><table><thead><tr><th>부서</th><th>직원</th>${cols.map((c) => `<th class="n">${c[1]}</th>`).join('')}</tr></thead>
      <tbody>${U.map((r) => `<tr class="clickable" data-uid="${r.id}"><td>${esc(r.department || '')}</td><td>${userLabel(r)}${r.active ? '' : ' <span class="badge off">퇴사</span>'}</td>
        ${cols.map((c) => `<td class="n">${c[2](r[c[0]])}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length + 2}" class="empty">데이터 없음</td></tr>`}</tbody>
      <tfoot><tr><td colspan="2">합계</td>${cols.map((c) => `<td class="n">${c[2](sum(c[0]))}</td>`).join('')}</tr></tfoot></table></div>
    <p class="note">운행비 = 연료비(공식연비×유가) + 통행료 + 주차비. 행을 누르면 해당 직원 운행일지로 이동합니다.</p>
    <h2 style="margin-top:20px">월별 추이</h2>
    <div class="grid2"><div class="card"><div class="note" style="margin-bottom:8px">운행비 합계</div><div class="bars">${data.monthly.map((m) => `<div class="bar-row"><span>${m.ym}</span><div class="bar" style="width:${(m.operating_cost_won / maxOp) * 100}%"></div><span class="n">${won(m.operating_cost_won)}원</span></div>`).join('') || '<div class="empty">데이터 없음</div>'}</div></div>
      <div class="card"><div class="note" style="margin-bottom:8px">카드 사용 (법인+개인)</div><div class="bars">${data.monthly.map((m) => `<div class="bar-row"><span>${m.ym}</span><div class="bar alt" style="width:${((m.corporate_card_won + m.personal_card_won) / maxCard) * 100}%"></div><span class="n">${won(m.corporate_card_won + m.personal_card_won)}원</span></div>`).join('') || '<div class="empty">데이터 없음</div>'}</div></div></div>
    <div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>월</th><th class="n">운행km</th><th class="n">연료비</th><th class="n">통행료</th><th class="n">운행비</th><th class="n">월 주유비</th><th class="n">법인카드</th><th class="n">개인카드</th></tr></thead>
      <tbody>${data.monthly.map((m) => `<tr><td>${m.ym}</td><td class="n">${km(m.distance_km)}</td><td class="n">${won(m.fuel_cost_won)}</td><td class="n">${won(m.toll_won)}</td><td class="n">${won(m.operating_cost_won)}</td><td class="n">${won(m.fueling_won)}</td><td class="n">${won(m.corporate_card_won)}</td><td class="n">${won(m.personal_card_won)}</td></tr>`).join('')}</tbody></table></div>`;
  $$('[data-uid]', main).forEach((tr) => (tr.onclick = async () => {
    if (!isAdmin()) return go('trips');
    go('trips/u/' + tr.dataset.uid);
  }));
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
      openModal(`<h2>임시 비밀번호 발급</h2><p>아래 임시 비밀번호를 직원에게 전달하세요. 최초 로그인 시 변경해야 합니다. 이 창을 닫으면 다시 볼 수 없습니다.</p><input readonly value="${esc(r.temp_password)}" onclick="this.select()"><div class="modal-actions"><button class="btn primary" data-close>확인</button></div>`);
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
    const body = {}; ['name', 'nickname', 'department', 'position', 'role', 'email'].forEach((n) => (body[n] = $(`[name=${n}]`, c).value));
    if (!u) body.vehicle = vehicleBody(c);
    try {
      const r = await api(u ? `/api/users/${u.id}` : '/api/users', { method: u ? 'PUT' : 'POST', body });
      if (u) for (const box of $$('.veh-edit', c)) {
        const g = (n) => $(`[name=${n}]`, box);
        await api(`/api/vehicles/${box.dataset.vid}`, { method: 'PUT', body: { user_id: u.id, plate: g('v_plate').value, ownership: g('v_ownership').value, fuel_type: g('v_fuel').value, model: g('v_model').value, efficiency_km_l: g('v_eff').value, active: g('v_active').checked } });
      }
      if (r.temp_password) openModal(`<h2>직원 등록 완료</h2><p>초기 비밀번호를 직원에게 전달하세요. 최초 로그인 시 변경해야 합니다. 이 창을 닫으면 다시 볼 수 없습니다.</p><input readonly value="${esc(r.temp_password)}" onclick="this.select()"><div class="modal-actions"><button class="btn primary" data-close>확인</button></div>`);
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
}

boot();
