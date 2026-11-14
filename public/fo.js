// ===== 가맹운영팀 업무 (가맹운영팀·관리자 전용) =====
// 라운딩일정: 달력 + 일자별 전체 인원 + 인원 선택 + 이름·매장 검색 + 일정 등록·수정
// 시트형 자료: 구글시트 탭을 그대로 표로 보관, 셀 수정·행 추가·직전 기록 복사·전체 검색
const FO_BOARDS = {
  store: '가맹점관리 히스토리',
  machine: '가맹운영팀 머신관리 매뉴얼 및 주간회의 직영관리',
  manual: '가맹운영팀 업무 매뉴얼',
  as_before: '매장 AS 히스토리 · 2026.07월 이전',
};
const foState = { month: null, persons: [], day: null, q: '', stores: null, sheet: {}, tabFilter: '' };
const foCan = () => !!(state.me && state.me.fo_access);
const foLeadOk = () => !!(state.me && state.me.fo_lead);
const fmtD = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${m}/${dd}(${'일월화수목금토'[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]})`; };
const nl = (s) => esc(s || '').replace(/\n/g, '<br>');
const hl = (s, k) => { const t = nl(s); if (!k) return t; const e = esc(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return t.replace(new RegExp(e, 'gi'), (m) => `<mark>${m}</mark>`); };

async function foStores() {
  if (!foState.stores) foState.stores = await api('/api/fo/stores').catch(() => []);
  return foState.stores;
}
const storeLabel = (s) => `${s.name}${s.kind ? ` (${s.kind})` : ''}`;
async function storeDatalist() {
  const st = await foStores();
  return `<datalist id="fo-stores"><option value="본사"><option value="성수본사">${st.map((s) => `<option value="${esc(storeLabel(s))}">`).join('')}</datalist>`;
}

// 좌측 메뉴: 가맹운영팀 업무 묶음 펼치기
function foNav() {
  $$('.fo-only').forEach((el) => el.classList.toggle('hidden', !foCan()));
  const tog = (btn, box) => { if (btn && box) btn.onclick = (e) => { e.preventDefault(); box.classList.toggle('open'); btn.classList.toggle('open', box.classList.contains('open')); }; };
  tog($('#fo-toggle'), $('#fo-sub')); tog($('#fo-as-toggle'), $('#fo-as-sub'));
  $$('#nav a[data-page]').forEach((a) => (a.onclick = () => go(a.dataset.page)));
  const page = (location.hash.replace('#', '') || '').split('/')[0];
  if (page.startsWith('fo-')) { $('#fo-sub')?.classList.add('open'); $('#fo-toggle')?.classList.add('open'); }
  if (page.startsWith('fo-as')) { $('#fo-as-sub')?.classList.add('open'); $('#fo-as-toggle')?.classList.add('open'); }
}

function foPage(page, arg) {
  if (!foCan()) { location.hash = 'trips'; return; }
  foNav();
  if (page === 'fo-rounding') return pageRounding();
  if (page === 'fo-as_after') return pageAsAfter();
  const board = page.slice(3);
  if (FO_BOARDS[board]) return pageFoBoard(board, arg);
  location.hash = 'fo-rounding';
}

// ---------------- 라운딩일정 ----------------
const ymNow = () => today().slice(0, 7);
const ymAdd = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const ymLast = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

async function pageRounding() {
  const main = $('#main');
  const meta = await api('/api/fo/rounding/meta');
  if (!foState.month) foState.month = meta.months.some((m) => m.ym === ymNow()) ? ymNow() : (meta.months[0]?.ym || ymNow());
  const ym = foState.month;
  const from = ym + '-01', to = ymLast(ym);
  const rows = await api(`/api/fo/rounding?from=${from}&to=${to}`);
  const memberNicks = meta.members.map((m) => m.nickname || m.name);
  const persons = [...new Set([...memberNicks, ...rows.map((r) => r.person)])];
  const sel = foState.persons.filter((p) => persons.includes(p));
  const vis = sel.length ? rows.filter((r) => sel.includes(r.person)) : rows;
  const byDay = {}; vis.forEach((r) => (byDay[r.day] ||= []).push(r));
  const pOrder = (a, b) => persons.indexOf(a.person) - persons.indexOf(b.person);
  // 달력
  const [y, m] = ym.split('-').map(Number);
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const nDays = Number(to.slice(8));
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push('<div class="cal-cell empty"></div>');
  for (let d = 1; d <= nDays; d++) {
    const ds = `${ym}-${String(d).padStart(2, '0')}`;
    const L = (byDay[ds] || []).sort(pOrder);
    const dow = (firstDow + d - 1) % 7;
    cells.push(`<div class="cal-cell${ds === foState.day ? ' sel' : ''}${ds === today() ? ' today' : ''}${dow === 0 ? ' sun' : dow === 6 ? ' sat' : ''}" data-day="${ds}">
      <div class="cal-d">${d}${L.length ? `<span class="cal-n">${L.length}명</span>` : ''}</div>
      ${L.slice(0, sel.length ? 8 : 6).map((r) => `<div class="cal-l"><b>${esc(r.person)}</b> ${esc(r.start_time || '')} ${esc(r.items.map((x) => x.store || x.task).filter(Boolean).slice(0, 2).join(', '))}</div>`).join('')}
      ${L.length > (sel.length ? 8 : 6) ? `<div class="cal-l note">+${L.length - (sel.length ? 8 : 6)}</div>` : ''}</div>`);
  }
  main.innerHTML = `${await storeDatalist()}
    <div class="page-head"><h1>가맹운영팀 라운딩일정</h1><div class="grow"></div>
      <button class="btn sm" id="r-prev">◀</button><input type="month" id="r-month" value="${ym}" style="width:auto"><button class="btn sm" id="r-next">▶</button>
      <button class="btn sm" id="r-today">이번 달</button>
      <button class="btn primary" id="r-add">+ 일정 등록</button></div>
    <div class="card" style="margin-bottom:12px"><div class="row" style="flex-wrap:wrap;gap:6px">
      <span class="note">인원</span><button class="chip${sel.length ? '' : ' on'}" data-p="">전체</button>
      ${persons.map((p) => `<button class="chip${sel.includes(p) ? ' on' : ''}" data-p="${esc(p)}">${esc(p)}</button>`).join('')}
      <div class="grow"></div>
      <input id="r-q" placeholder="이름 또는 매장명 검색 (전체 기간)" value="${esc(foState.q)}" style="width:260px"><button class="btn sm" id="r-qb">검색</button></div></div>
    <div id="r-search"></div>
    <div class="cal"><div class="cal-h">일</div><div class="cal-h">월</div><div class="cal-h">화</div><div class="cal-h">수</div><div class="cal-h">목</div><div class="cal-h">금</div><div class="cal-h">토</div>${cells.join('')}</div>
    <div id="r-detail" style="margin-top:14px"></div>`;
  const reload = () => pageRounding();
  $('#r-prev').onclick = () => { foState.month = ymAdd(ym, -1); foState.day = null; reload(); };
  $('#r-next').onclick = () => { foState.month = ymAdd(ym, 1); foState.day = null; reload(); };
  $('#r-today').onclick = () => { foState.month = ymNow(); foState.day = today(); reload(); };
  $('#r-month').onchange = (e) => { if (e.target.value) { foState.month = e.target.value; foState.day = null; reload(); } };
  $$('[data-p]', main).forEach((b) => (b.onclick = () => {
    const p = b.dataset.p;
    if (!p) foState.persons = []; else foState.persons = sel.includes(p) ? sel.filter((x) => x !== p) : [...sel, p];
    reload();
  }));
  $$('.cal-cell[data-day]', main).forEach((c) => (c.onclick = () => { foState.day = foState.day === c.dataset.day ? null : c.dataset.day; reload(); }));
  $('#r-add').onclick = () => roundingForm(null, foState.day || today(), meta, reload);
  const doSearch = async () => {
    foState.q = $('#r-q').value.trim();
    const box = $('#r-search');
    if (!foState.q) { box.innerHTML = ''; return; }
    const R = await api('/api/fo/rounding/search?q=' + encodeURIComponent(foState.q));
    box.innerHTML = `<div class="card" style="margin-bottom:12px"><div class="row" style="justify-content:space-between"><h2 style="margin:0">'${esc(foState.q)}' 검색 결과 ${R.length}건${R.length >= 1500 ? ' (최근 1500건)' : ''}</h2><button class="btn sm" id="r-qx">닫기</button></div>
      <div class="table-wrap" style="max-height:420px;overflow:auto;margin-top:8px"><table><thead><tr><th>날짜</th><th>인원</th><th>출근</th><th>지점명 · 업무</th></tr></thead><tbody>
      ${R.map((r) => `<tr class="clickable" data-go="${r.day}"><td>${r.day.slice(0, 4)}. ${fmtD(r.day)}</td><td>${hl(r.person, foState.q)}</td><td>${esc(r.start_time || '')}</td>
        <td>${r.items.map((x) => `${hl(x.store, foState.q)}${x.task ? ` <span class="note">· ${hl(x.task, foState.q)}</span>` : ''}`).join('<br>')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">없음</td></tr>'}</tbody></table></div></div>`;
    $('#r-qx').onclick = () => { foState.q = ''; $('#r-q').value = ''; box.innerHTML = ''; };
    $$('[data-go]', box).forEach((tr) => (tr.onclick = () => { foState.month = tr.dataset.go.slice(0, 7); foState.day = tr.dataset.go; reload(); }));
  };
  $('#r-qb').onclick = doSearch; $('#r-q').onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
  if (foState.q) doSearch();
  // 상세: 선택한 날짜의 전체(또는 선택 인원) 일정 / 인원만 선택 시 그 인원의 월간 일정
  const det = $('#r-detail');
  const dayTable = (L, showDate) => `<div class="table-wrap"><table class="r-table"><thead><tr>${showDate ? '<th>날짜</th>' : ''}<th>인원</th><th>출근</th><th>방문 지점 · 업무 (방문 순서)</th><th></th></tr></thead><tbody>
    ${L.map((r) => `<tr><td>${showDate ? `${fmtD(r.day)}</td><td>` : ''}<b>${esc(r.person)}</b></td><td>${esc(r.start_time || '')}${r.end_time ? ` ~ ${esc(r.end_time)}` : ''}</td>
      <td>${r.items.map((x, i) => `<div class="r-item"><span class="r-no">${i + 1}</span>${nl(x.store) || '<span class="note">-</span>'}${x.task ? `<span class="note"> · ${nl(x.task)}</span>` : ''}</div>`).join('')}</td>
      <td>${foLeadOk() || r.person === state.me.nickname ? `<button class="btn sm" data-edit="${r.id}">수정</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="${showDate ? 5 : 4}" class="empty">등록된 일정 없음</td></tr>`}</tbody></table></div>`;
  if (foState.day) {
    const L = (byDay[foState.day] || []).sort(pOrder);
    det.innerHTML = `<div class="card"><div class="row" style="justify-content:space-between;margin-bottom:8px"><h2 style="margin:0">${foState.day.slice(0, 4)}. ${fmtD(foState.day)} ${sel.length ? sel.map(esc).join(', ') : '운영팀 전체'} 일정 (${L.length}명)</h2>
      <button class="btn sm" id="r-add-day">+ 이 날짜에 등록</button></div>${dayTable(L, false)}</div>`;
    $('#r-add-day').onclick = () => roundingForm(null, foState.day, meta, reload);
  } else if (sel.length) {
    const L = vis.sort((a, b) => a.day.localeCompare(b.day) || pOrder(a, b));
    det.innerHTML = `<div class="card"><h2>${sel.map(esc).join(', ')} · ${ym.replace('-', '년 ')}월 일정 (${L.length}건)</h2>${dayTable(L, true)}</div>`;
  } else det.innerHTML = '<div class="note">날짜를 누르면 그날 운영팀 전체 일정이, 인원을 고르면 그 인원의 일별 일정이 표시됩니다.</div>';
  $$('[data-edit]', det).forEach((b) => (b.onclick = () => roundingForm(rows.find((r) => r.id == b.dataset.edit), null, meta, reload)));
}

function roundingForm(rec, day, meta, after) {
  const me = state.me.nickname || state.me.name;
  const recent = meta.persons.filter((p) => p.last_day >= ymAdd(ymNow(), -3) + '-01').map((p) => p.person);
  const persons = [...new Set([...meta.members.map((m) => m.nickname || m.name), ...recent, ...(rec ? [rec.person] : [])])];
  const items = rec?.items?.length ? rec.items : [{ store: '', task: '' }];
  const lead = foLeadOk();
  const c = openModal(`<h2>${rec ? '라운딩 일정 수정' : '라운딩 일정 등록'}</h2>
    <div class="grid2"><label>인원<select name="person" ${lead ? '' : 'disabled'}>${(lead ? persons : [me]).map((p) => `<option ${p === (rec?.person || me) ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
      <label>날짜<input type="date" name="day" value="${rec?.day || day}"></label></div>
    <label>출근 예정시간 <span class="note">(예: 09:00 · 휴무/연차는 그대로 적어도 됨)</span><input name="start_time" list="fo-times" value="${esc(rec?.start_time || '09:00')}">
      <datalist id="fo-times">${['08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '13:00', 'DAY OFF (휴무)', 'DAY OFF (연차)', '오전반차', '오후반차'].map((t) => `<option value="${t}">`).join('')}</datalist></label>
    <div class="note" style="margin-top:6px">방문 순서대로 지점명과 업무내용을 적습니다. 지점명은 등록된 매장 목록에서 고를 수 있습니다. (본사 근무는 지점명에 '본사')</div>
    <div id="r-items">${items.map((x) => itemRow(x)).join('')}</div>
    <button class="btn sm" id="r-more">+ 방문 지점 추가</button>
    ${rec && rec.note && /^시트:/.test(rec.note) ? `<div class="note" style="margin-top:6px">구글시트 이관 일정 (${esc(rec.note.slice(3))} 탭)</div>` : ''}
    <div class="row" style="margin-top:14px;justify-content:space-between">${rec ? '<button class="btn danger" id="r-del">삭제</button>' : '<span></span>'}
      <div class="row"><button class="btn" data-close>취소</button><button class="btn primary" id="r-save">저장</button></div></div>`, true);
  const bindDel = () => $$('[data-rm]', c).forEach((b) => (b.onclick = () => { b.closest('.r-irow').remove(); }));
  bindDel();
  $('#r-more', c).onclick = () => { $('#r-items', c).insertAdjacentHTML('beforeend', itemRow({})); bindDel(); };
  $('#r-save', c).onclick = async () => {
    const body = {
      id: rec?.id, person: $('[name=person]', c).value, day: $('[name=day]', c).value, start_time: $('[name=start_time]', c).value,
      items: $$('.r-irow', c).map((r) => ({ store: $('[name=store]', r).value, task: $('[name=task]', r).value })),
    };
    try { await api('/api/fo/rounding', { method: 'PUT', body }); closeModal(); toast('저장되었습니다'); foState.month = body.day.slice(0, 7); foState.day = body.day; after(); } catch (e) { fail(e); }
  };
  if (rec) $('#r-del', c).onclick = async () => {
    if (!confirm(`${rec.person} ${rec.day} 일정을 삭제할까요?`)) return;
    try { await api('/api/fo/rounding/' + rec.id, { method: 'DELETE' }); closeModal(); toast('삭제되었습니다'); after(); } catch (e) { fail(e); }
  };
}
const itemRow = (x) => `<div class="r-irow"><input name="store" list="fo-stores" placeholder="지점명 (목록에서 선택 또는 입력)" value="${esc(x.store || '')}">
  <textarea name="task" rows="1" placeholder="업무내용">${esc(x.task || '')}</textarea><button class="btn sm" data-rm title="삭제">×</button></div>`;

// ---------------- 매장 AS 히스토리 · 2026.07월 이후 ----------------
function pageAsAfter() {
  $('#main').innerHTML = `<div class="page-head"><h1>매장 AS 히스토리 · 2026.07월 이후</h1></div>
    <div class="card"><p>2026년 7월 이후 AS 내역은 AS 사이트와 API로 연동해 이 화면에 자동으로 표시할 예정입니다.</p>
    <p class="note">연동 전까지 2026.07월 이전 기록과 AS 처리 기록표는 '2026.07월 이전' 메뉴에서 조회·추가할 수 있습니다.</p>
    <button class="btn" onclick="go('fo-as_before')">2026.07월 이전 AS 히스토리 열기</button></div>`;
}

// ---------------- 시트형 자료 ----------------
async function pageFoBoard(board, sheetId) {
  const main = $('#main');
  const tabs = await api('/api/fo/sheets?board=' + board);
  const cur = sheetId ? Number(sheetId) : (foState.sheet[board] || tabs[0]?.id);
  foState.sheet[board] = cur;
  const f = foState.tabFilter.trim();
  const groups = board === 'store'
    ? [['공통', tabs.filter((t) => !t.is_store)], [`매장 (${tabs.filter((t) => t.is_store).length})`, tabs.filter((t) => t.is_store)]]
    : [['', tabs]];
  main.innerHTML = `${await storeDatalist()}
    <div class="page-head"><h1>${esc(FO_BOARDS[board])}</h1><div class="grow"></div>
      <input id="fb-q" placeholder="전체 탭에서 검색 (매장명·내용)" style="width:260px"><button class="btn sm" id="fb-qb">검색</button>
      ${board === 'store' ? '<button class="btn primary" id="fb-newstore">+ 새 매장 등록</button>' : ''}<button class="btn" id="fb-newtab">+ 새 탭</button></div>
    <div id="fb-search"></div>
    <div class="fb-layout"><aside class="fb-tabs card"><input id="fb-tf" placeholder="탭 이름 찾기" value="${esc(f)}">
      ${groups.map(([g, L]) => `${g ? `<div class="fb-g">${esc(g)}</div>` : ''}${L.filter((t) => !f || t.name.toLowerCase().includes(f.toLowerCase())).map((t) => `<a class="fb-tab${t.id === cur ? ' on' : ''}" data-tab="${t.id}" title="${esc(t.name)}">${esc(t.name)}</a>`).join('')}`).join('')}
      ${tabs.length ? '' : '<div class="note">자료가 없습니다. 관리자가 설정 › 이관 패키지로 구글시트 자료를 올리면 표시됩니다.</div>'}</aside>
    <section id="fb-sheet" class="fb-sheet">${cur ? '<div class="note">불러오는 중…</div>' : ''}</section></div>`;
  $$('[data-tab]', main).forEach((a) => (a.onclick = () => { foState.sheet[board] = Number(a.dataset.tab); pageFoBoard(board); }));
  $('#fb-tf').oninput = (e) => {
    foState.tabFilter = e.target.value; const v = e.target.value.trim().toLowerCase();
    $$('[data-tab]', main).forEach((a) => a.classList.toggle('hidden', !!v && !a.textContent.toLowerCase().includes(v)));
  };
  $('#fb-newtab').onclick = () => newTabForm(board);
  if (board === 'store') $('#fb-newstore').onclick = () => newStoreForm(tabs);
  const doSearch = async () => {
    const k = $('#fb-q').value.trim(); const box = $('#fb-search');
    if (!k) { box.innerHTML = ''; return; }
    const R = await api(`/api/fo/search?board=${board}&q=${encodeURIComponent(k)}`);
    box.innerHTML = `<div class="card" style="margin-bottom:12px"><div class="row" style="justify-content:space-between"><h2 style="margin:0">'${esc(k)}' 검색 결과 ${R.length}건${R.length >= 500 ? ' (앞 500건)' : ''}</h2><button class="btn sm" id="fb-qx">닫기</button></div>
      <div class="table-wrap" style="max-height:380px;overflow:auto;margin-top:8px"><table><thead><tr><th>탭</th><th>내용</th></tr></thead><tbody>
      ${R.map((r) => `<tr class="clickable" data-hit="${r.sheet_id}:${r.row_id}"><td style="white-space:nowrap">${hl(r.sheet, k)}</td><td>${hl(r.cells.filter((x) => String(x).trim()).join(' | ').slice(0, 400), k)}</td></tr>`).join('') || '<tr><td colspan="2" class="empty">없음</td></tr>'}</tbody></table></div></div>`;
    $('#fb-qx').onclick = () => { box.innerHTML = ''; $('#fb-q').value = ''; };
    $$('[data-hit]', box).forEach((tr) => (tr.onclick = async () => {
      const [sid, rid] = tr.dataset.hit.split(':').map(Number);
      foState.sheet[board] = sid; $$('[data-tab]', main).forEach((a) => a.classList.toggle('on', Number(a.dataset.tab) === sid));
      await renderSheet(board, sid, rid, k);
    }));
  };
  $('#fb-qb').onclick = doSearch; $('#fb-q').onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
  if (cur) await renderSheet(board, cur);
}

async function renderSheet(board, sid, focusRow, mark) {
  const box = $('#fb-sheet'); if (!box) return;
  const s = await api('/api/fo/sheets/' + sid);
  const ncol = Math.max(1, ...s.rows.map((r) => r.cells.length));
  const colL = (i) => { let t = ''; i++; while (i > 0) { const m = (i - 1) % 26; t = String.fromCharCode(65 + m) + t; i = Math.floor((i - 1) / 26); } return t; };
  const isDateCell = (v) => /^\d{4}[-.]\s?\d{1,2}[-.]\s?\d{1,2}/.test(String(v || '').trim());
  box.innerHTML = `<div class="card fb-card"><div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:8px">
      <h2 style="margin:0">${esc(s.name)} <span class="note">${s.rows.length}행 · 최근 수정 ${esc(String(s.updated_at || '').slice(0, 10))}</span></h2>
      <div class="row" style="gap:6px">${s.is_store ? '<button class="btn primary sm" id="fs-visit">+ 방문 기록 추가 (직전 기록 복사)</button>' : ''}
        <button class="btn sm" id="fs-row">+ 맨 아래 행 추가</button><button class="btn sm" id="fs-ren">탭 이름 변경</button>${foLeadOk() ? '<button class="btn sm danger" id="fs-del">탭 삭제</button>' : ''}</div></div>
    <div class="note" style="margin-bottom:6px">셀을 누르면 내용을 고칠 수 있습니다. 행 번호를 누르면 행 추가·복사·삭제 메뉴가 열립니다.</div>
    <div class="fb-grid-wrap"><table class="fb-grid"><thead><tr><th class="rn"></th>${Array.from({ length: ncol }, (_, i) => `<th>${colL(i)}</th>`).join('')}</tr></thead>
      <tbody>${s.rows.map((r, ri) => `<tr data-row="${r.id}"${r.id === focusRow ? ' class="focus"' : ''}><td class="rn" data-rmenu="${r.id}">${ri + 1}</td>${Array.from({ length: ncol }, (_, i) => {
    const v = r.cells[i] ?? '';
    return `<td data-c="${i}"${isDateCell(v) && i <= 2 ? ' class="dcell"' : ''}>${mark ? hl(v, mark) : nl(v)}</td>`;
  }).join('')}</tr>`).join('')}</tbody></table></div></div>`;
  const reload = (fr) => renderSheet(board, sid, fr, mark);
  if (focusRow) $(`tr[data-row="${focusRow}"]`, box)?.scrollIntoView({ block: 'center' });
  $$('td[data-c]', box).forEach((td) => (td.onclick = () => {
    const rid = Number(td.parentElement.dataset.row); const col = Number(td.dataset.c);
    const row = s.rows.find((r) => r.id === rid);
    const c = openModal(`<h2>${esc(s.name)} · ${colL(col)}${s.rows.indexOf(row) + 1}</h2>
      <textarea id="fc-v" rows="8" list="fo-stores" style="width:100%">${esc(row.cells[col] ?? '')}</textarea>
      <div class="row" style="margin-top:6px;gap:6px"><span class="note">매장명 넣기</span><input id="fc-store" list="fo-stores" placeholder="매장 선택" style="flex:1"><button class="btn sm" id="fc-ins">넣기</button></div>
      <div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn" data-close>취소</button><button class="btn primary" id="fc-save">저장</button></div>`, true);
    $('#fc-ins', c).onclick = () => { const v = $('#fc-store', c).value; if (v) { const ta = $('#fc-v', c); ta.value = ta.value ? `${ta.value}${ta.value.endsWith('\n') ? '' : '\n'}${v}` : v; } };
    $('#fc-v', c).focus();
    $('#fc-save', c).onclick = async () => {
      try { await api('/api/fo/rows/' + rid, { method: 'PUT', body: { col, value: $('#fc-v', c).value } }); closeModal(); reload(rid); } catch (e) { fail(e); }
    };
  }));
  $$('[data-rmenu]', box).forEach((td) => (td.onclick = () => {
    const rid = Number(td.dataset.rmenu); const row = s.rows.find((r) => r.id === rid);
    const c = openModal(`<h2>${s.rows.indexOf(row) + 1}행</h2><div class="note" style="margin-bottom:8px">${esc(row.cells.filter((x) => String(x).trim()).join(' | ').slice(0, 200))}</div>
      <div style="display:grid;gap:8px"><button class="btn" id="rm-add">아래에 빈 행 추가</button><button class="btn" id="rm-copy">이 행을 복사해 아래에 추가</button>
      <button class="btn danger" id="rm-del">이 행 삭제</button><button class="btn" data-close>닫기</button></div>`);
    $('#rm-add', c).onclick = async () => { try { const r = await api(`/api/fo/sheets/${sid}/rows`, { method: 'POST', body: { after: rid, count: 1 } }); closeModal(); reload(r.ids[0]); } catch (e) { fail(e); } };
    $('#rm-copy', c).onclick = async () => { try { const r = await api(`/api/fo/sheets/${sid}/rows`, { method: 'POST', body: { after: rid, rows: [row.cells] } }); closeModal(); reload(r.ids[0]); } catch (e) { fail(e); } };
    $('#rm-del', c).onclick = async () => { if (!confirm('이 행을 삭제할까요?')) return; try { await api('/api/fo/rows/' + rid, { method: 'DELETE' }); closeModal(); reload(); } catch (e) { fail(e); } };
  }));
  $('#fs-row', box).onclick = async () => { try { const r = await api(`/api/fo/sheets/${sid}/rows`, { method: 'POST', body: { count: 1 } }); reload(r.ids[0]); } catch (e) { fail(e); } };
  $('#fs-ren', box).onclick = async () => {
    const n = prompt('새 탭 이름', s.name); if (!n || n === s.name) return;
    try { await api('/api/fo/sheets/' + sid, { method: 'PUT', body: { name: n } }); pageFoBoard(board, sid); } catch (e) { fail(e); }
  };
  if ($('#fs-del', box)) $('#fs-del', box).onclick = async () => {
    if (!confirm(`'${s.name}' 탭과 모든 내용을 삭제할까요? 되돌릴 수 없습니다.`)) return;
    try { await api('/api/fo/sheets/' + sid, { method: 'DELETE' }); foState.sheet[board] = null; pageFoBoard(board); } catch (e) { fail(e); }
  };
  // 매장 탭: 마지막 방문 기록(방문일자 칸에 날짜가 있는 마지막 행부터 끝까지)을 복사해 이어 적기
  if ($('#fs-visit', box)) $('#fs-visit', box).onclick = async () => {
    const hi = s.rows.findIndex((r) => r.cells.some((x) => String(x).trim() === '방문일자'));
    const dc = hi >= 0 ? s.rows[hi].cells.findIndex((x) => String(x).trim() === '방문일자') : 1;
    let st = -1;
    for (let i = s.rows.length - 1; i > hi; i--) if (isDateCell(s.rows[i].cells[dc])) { st = i; break; }
    if (st < 0) { toast('복사할 직전 방문 기록이 없습니다. 맨 아래 행 추가로 적어 주세요', true); return; }
    const block = s.rows.slice(st).map((r) => [...r.cells]);
    while (block.length > 1 && !block[block.length - 1].some((x) => String(x).trim())) block.pop();
    block[0][dc] = today();
    const who = s.rows[hi]?.cells.findIndex((x) => String(x).trim() === '담당자');
    if (who > 0) block[0][who] = state.me.nickname || state.me.name;
    if (!confirm(`직전 방문 기록(${s.rows[st].cells[dc]}, ${block.length}행)을 복사해 오늘 날짜로 추가합니다.\n추가된 행의 셀을 눌러 이번 방문 내용으로 고쳐 주세요.`)) return;
    try { const r = await api(`/api/fo/sheets/${sid}/rows`, { method: 'POST', body: { rows: block } }); reload(r.ids[0]); toast('추가되었습니다. 내용을 이번 방문 기준으로 고쳐 주세요'); } catch (e) { fail(e); }
  };
}

function newTabForm(board) {
  const c = openModal(`<h2>새 탭</h2><label>탭 이름<input name="name"></label>
    <label>첫 행(머리글) <span class="note">쉼표로 구분, 비우면 빈 표</span><input name="header" placeholder="예: 날짜, 매장명, 내용, 담당자"></label>
    <div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn" data-close>취소</button><button class="btn primary" id="nt-save">만들기</button></div>`);
  $('#nt-save', c).onclick = async () => {
    const h = $('[name=header]', c).value.trim();
    try {
      const r = await api('/api/fo/sheets', { method: 'POST', body: { board, name: $('[name=name]', c).value, header: h ? h.split(',').map((x) => x.trim()) : undefined } });
      closeModal(); foState.sheet[board] = r.id; pageFoBoard(board);
    } catch (e) { fail(e); }
  };
}

async function newStoreForm(tabs) {
  const info = tabs.find((t) => t.name === '지점 정보');
  let head = [];
  if (info) {
    const s = await api('/api/fo/sheets/' + info.id);
    const hr = s.rows.find((r) => r.cells.some((x) => String(x).trim() === '번호'));
    head = hr ? hr.cells.map((x) => String(x).replace(/\s*\n\s*/g, ' ').trim()) : [];
  }
  const meta = await api('/api/fo/rounding/meta');
  const svs = meta.members.map((m) => m.nickname || m.name);
  const storeTabs = tabs.filter((t) => t.is_store);
  const skip = (i, h) => i <= 1 || /경과/.test(h);
  const c = openModal(`<h2>새 매장 등록</h2>
    <div class="grid2"><label>지점명<input name="name" placeholder="예: 청량리한신점"></label>
      <label>매장 구분<input name="kind" list="fo-kinds" placeholder="비우면 일반 가맹"><datalist id="fo-kinds"><option value="직영"><option value="양수도"><option value="점포이전"><option value="폐점"></datalist></label>
      <label>담당 SV<select name="sv"><option value="">선택</option>${svs.map((p) => `<option>${esc(p)}</option>`).join('')}</select></label>
      <label>오픈일<input type="date" name="open_date"></label>
      <label>유로머신 정보<input name="machine"></label>
      <label>탭 양식 (기존 매장 탭 복사)<select name="tpl">${storeTabs.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label></div>
    ${head.length ? `<h2 style="margin-top:12px">지점 정보 <span class="note">('지점 정보' 탭에 한 줄로 추가됩니다)</span></h2><div class="grid2">${head.map((h, i) => skip(i, h) || !h ? '' : `<label>${esc(h)}<input data-ic="${i}"></label>`).join('')}</div>` : ''}
    <div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn" data-close>취소</button><button class="btn primary" id="ns-save">등록</button></div>`, 'full');
  $('[name=sv]', c).onchange = (e) => { const i = head.findIndex((h) => /담당\s*SV/.test(h)); if (i >= 0 && $(`[data-ic="${i}"]`, c)) $(`[data-ic="${i}"]`, c).value = e.target.value; };
  $('#ns-save', c).onclick = async () => {
    const name = $('[name=name]', c).value.trim(); const kind = $('[name=kind]', c).value.trim();
    const cells = head.map((h, i) => (i === 1 ? name : $(`[data-ic="${i}"]`, c)?.value || ''));
    try {
      const r = await api('/api/fo/stores', { method: 'POST', body: { name, kind, history: true, sv: $('[name=sv]', c).value, open_date: $('[name=open_date]', c).value, machine: $('[name=machine]', c).value, template_id: $('[name=tpl]', c).value, info_cells: cells } });
      closeModal(); foState.stores = null; toast(`등록되었습니다 (번호 ${r.no})`); foState.sheet.store = r.sheet_id; pageFoBoard('store');
    } catch (e) { fail(e); }
  };
}
