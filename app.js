/* 웹툰 작업량 관리 — 컷 단위 자동 분배 캘린더 */

const KEY = 'webtoon-workload-v1';
const PALETTE = ['#EF4444', '#F97316', '#F59E0B', '#22C55E', '#06B6D4', '#3B82F6', '#8B5CF6', '#EC4899', '#0EA5E9', '#64748B'];

let state = load();
let view = startOfMonth(new Date());
let mode = null;        // {type:'days'|'deadline', id} — 캘린더 클릭 동작
let lastPick = null;    // Shift 범위 선택 기준일
let editingId = null;   // 프로젝트 모달 편집 대상
let formColor = PALETTE[0];
let formDeadline = '';
let dayDate = null;     // 날짜 모달 대상

const TODAY = ymd(new Date());

/* ── 저장소 ─────────────────────────────── */
function load() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* 손상된 데이터는 무시 */ }
  if (!s || !Array.isArray(s.projects)) return { projects: [] };
  for (const p of s.projects) {
    p.days = p.days || [];
    p.done = p.done || {};
    p.goal = p.goal || {};   // 실적 입력 시점의 목표량 스냅샷
  }
  return s;
}
function save() { localStorage.setItem(KEY, JSON.stringify(state)); }

/* ── 유틸 ───────────────────────────────── */
function uid() { return Math.random().toString(36).slice(2, 9); }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function fmtShort(s) { const [, m, d] = s.split('-'); return +m + '월 ' + +d + '일'; }
function fmtFull(s) {
  const dt = parseYmd(s);
  const w = ['일', '월', '화', '수', '목', '금', '토'][dt.getDay()];
  return dt.getFullYear() + '년 ' + (dt.getMonth() + 1) + '월 ' + dt.getDate() + '일 (' + w + ')';
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function num(n) { return n.toLocaleString('ko-KR'); }
function byId(id) { return state.projects.find(p => p.id === id); }
function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

/* ── 핵심: 일자별 목표 컷수 계산 ──────────
   · 실적을 입력하지 않은 날은 모두 "남은 날"이며, 남은 컷수를 균등하게 나눠 갖는다.
     (50컷 / 5일 → 매일 10컷)
   · 실적을 입력하면 그만큼 남은 컷수에서 빠지고, 남은 날 수도 하나 줄어
     나머지 날들의 목표량이 다시 계산된다.
   · 이미 입력한 날은 입력 당시의 목표량(goal 스냅샷)을 그대로 보여준다.
   · 하루를 쉬었다면 0을 입력하면 된다 → 그날이 남은 날에서 빠지고 뒤로 재분배. */
function schedule(p) {
  const days = p.days.slice().sort();
  const total = Math.max(0, Number(p.totalCuts) || 0);
  let doneSum = 0;
  let openCount = 0;
  for (const d of days) {
    if (has(p.done, d)) doneSum += Number(p.done[d]) || 0;
    else openCount++;
  }
  const remaining = Math.max(0, total - doneSum);
  const target = openCount ? Math.ceil(remaining / openCount) : 0;

  const byDate = {};
  for (const d of days) {
    const entered = has(p.done, d);
    const done = entered ? Number(p.done[d]) || 0 : 0;
    const goal = entered ? (p.goal[d] != null ? p.goal[d] : target) : target;
    byDate[d] = { goal, done, entered, missed: !entered && d < TODAY };
  }
  return { byDate, target, doneSum, remaining, openCount, total };
}
function allSchedules() {
  const m = {};
  for (const p of state.projects) m[p.id] = schedule(p);
  return m;
}

/* ── 렌더 ───────────────────────────────── */
let SCH = {};
function render() {
  SCH = allSchedules();
  renderSidebar();
  renderCalendar();
  renderTopbar();
  renderBanner();
  renderLegend();
}

function renderTopbar() {
  document.getElementById('monthLabel').textContent = view.getFullYear() + '년 ' + (view.getMonth() + 1) + '월';
  let goal = 0, done = 0;
  for (const p of state.projects) {
    const s = SCH[p.id].byDate[TODAY];
    if (s) { goal += s.goal; done += s.done; }
  }
  document.getElementById('todaySum').innerHTML =
    '<span>오늘 목표 <b>' + num(goal) + '컷</b></span>' +
    '<span>완료 <b>' + num(done) + '컷</b></span>' +
    '<span>남은 <b>' + num(Math.max(0, goal - done)) + '컷</b></span>';
}

function renderSidebar() {
  const el = document.getElementById('projects');
  if (!state.projects.length) {
    el.innerHTML = '<div class="empty">아직 프로젝트가 없습니다.<br>아래 버튼으로 추가해 주세요.</div>';
    return;
  }
  el.innerHTML = state.projects.map(p => {
    const s = SCH[p.id];
    const pct = s.total ? Math.min(100, Math.round(s.doneSum / s.total * 100)) : 0;
    const t = s.byDate[TODAY];
    const active = mode && mode.id === p.id;
    return '<div class="card' + (active ? ' sel' : '') + '">' +
      '<div class="card-top">' +
        '<span class="dot" style="background:' + p.color + '"></span>' +
        '<span class="pname">' + esc(p.name) + '</span>' +
        '<button class="icon" data-act="edit" data-id="' + p.id + '" title="수정">&#8942;</button>' +
      '</div>' +
      '<div class="bar"><span style="width:' + pct + '%;background:' + p.color + '"></span></div>' +
      '<div class="meta">' + num(s.doneSum) + ' / ' + num(s.total) + '컷 · ' + pct + '%</div>' +
      '<div class="meta">남은 ' + num(s.remaining) + '컷 · 남은 작업일 ' + s.openCount + '일' +
        (p.deadline ? ' · 마감 ' + fmtShort(p.deadline) : ' · 마감 미지정') + '</div>' +
      (s.openCount
        ? '<div class="need" style="background:' + p.color + '14;color:' + p.color + '"><span>하루 목표</span><span>' + num(s.target) + '컷</span></div>'
        : '') +
      (t ? '<div class="meta" style="margin-top:6px">오늘 ' + num(t.done) + ' / ' + num(t.goal) + '컷</div>' : '') +
      '<div class="card-btns">' +
        '<button class="btn ghost sm" data-act="days" data-id="' + p.id + '">' +
          (active && mode.type === 'days' ? '선택 완료' : '작업일 (' + p.days.length + '일)') + '</button>' +
        '<button class="btn ghost sm" data-act="deadline" data-id="' + p.id + '">' +
          (active && mode.type === 'deadline' ? '지정 취소' : '마감일') + '</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function renderCalendar() {
  const first = startOfMonth(view);
  const dim = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const weeks = Math.ceil((first.getDay() + dim) / 7);
  const cur = new Date(first);
  cur.setDate(1 - first.getDay());
  const target = mode ? byId(mode.id) : null;

  let html = '';
  for (let i = 0; i < weeks * 7; i++) {
    const d = ymd(cur);
    const dow = cur.getDay();
    const out = cur.getMonth() !== view.getMonth();
    const picked = target && mode.type === 'days' && target.days.includes(d);
    const dlPick = target && mode.type === 'deadline' && target.deadline === d;

    let chips = '', flags = '', missed = false;
    for (const p of state.projects) {
      if (p.deadline === d) flags += '<span class="flag" style="background:' + p.color + '">마감</span>';
      const s = SCH[p.id].byDate[d];
      if (!s) continue;
      if (s.missed) missed = true;
      const complete = s.entered && s.done >= s.goal;
      chips += '<div class="chip' + (complete ? ' ok' : '') + '" style="border-left-color:' + p.color +
        ';background:' + p.color + '14" title="' + esc(p.name) + ' · 목표 ' + s.goal + '컷' +
        (s.entered ? ' / 완료 ' + s.done + '컷' : '') + '">' +
        '<span class="cn" style="color:' + p.color + '">' + esc(p.name) + '</span>' +
        '<span class="cline"><span>목표</span><b>' + s.goal + '</b></span>' +
        '<span class="cline' + (s.entered ? '' : ' na') + '"><span>작업</span><b>' +
          (s.entered ? s.done : '—') + '</b></span>' +
      '</div>';
    }

    html += '<div class="cell' + (out ? ' out' : '') + (d === TODAY ? ' today' : '') +
      (dow === 0 ? ' sun' : dow === 6 ? ' sat' : '') +
      (mode ? ' picking' : '') + (picked || dlPick ? ' picked' : '') + '" data-date="' + d + '">' +
      '<div class="dhead"><span class="dnum">' + cur.getDate() + '</span>' + flags +
      (missed ? '<span class="warn">미입력</span>' : '') + '</div>' + chips +
    '</div>';
    cur.setDate(cur.getDate() + 1);
  }
  document.getElementById('cal').innerHTML = html;
}

function renderLegend() {
  document.getElementById('legend').innerHTML = state.projects.length
    ? state.projects.map(p => '<span><i style="background:' + p.color + '"></i>' + esc(p.name) + '</span>').join('') +
      '<span style="margin-left:auto">목표 = 그날 해야 할 컷수 · 작업 = 실제로 한 컷수</span>'
    : '';
}

function renderBanner() {
  const b = document.getElementById('banner');
  if (!mode) { b.hidden = true; return; }
  const p = byId(mode.id);
  if (!p) { mode = null; b.hidden = true; return; }
  b.hidden = false;
  document.getElementById('bdot').style.background = p.color;
  if (mode.type === 'days') {
    document.getElementById('bannerText').textContent = p.name + ' — 작업일 ' + p.days.length + '일 선택됨';
    document.getElementById('bannerHint').textContent = '날짜를 클릭해 작업일을 추가/제거하세요. Shift+클릭으로 범위 선택.';
    document.getElementById('bannerDone').textContent = '선택 완료';
  } else {
    document.getElementById('bannerText').textContent = p.name + ' — 마감일 지정';
    document.getElementById('bannerHint').textContent = '마감일로 지정할 날짜를 클릭하세요.' +
      (p.deadline ? ' (현재 ' + fmtShort(p.deadline) + ')' : '');
    document.getElementById('bannerDone').textContent = '취소';
  }
}

/* ── 프로젝트 모달 ──────────────────────── */
function openProject(id, presetDeadline) {
  editingId = id || null;
  const p = id ? byId(id) : null;
  document.getElementById('pTitle').textContent = p ? '프로젝트 수정' : '새 프로젝트';
  document.getElementById('fName').value = p ? p.name : '';
  document.getElementById('fCuts').value = p ? p.totalCuts : '';
  formDeadline = p ? (p.deadline || '') : (presetDeadline || '');
  document.getElementById('fDeadlineText').textContent = formDeadline ? fmtShort(formDeadline) : '미지정';
  formColor = p ? p.color : PALETTE[state.projects.length % PALETTE.length];
  document.getElementById('fColors').innerHTML = PALETTE.map(c =>
    '<button class="sw' + (c === formColor ? ' on' : '') + '" data-color="' + c + '" style="background:' + c + '"></button>'
  ).join('');
  document.getElementById('pDelete').style.display = p ? '' : 'none';
  document.getElementById('pMask').hidden = false;
  document.getElementById('fName').focus();
}

function saveProject() {
  const name = document.getElementById('fName').value.trim();
  const cuts = parseInt(document.getElementById('fCuts').value, 10);
  if (!name) { alert('프로젝트 이름을 입력해 주세요.'); return; }
  if (!cuts || cuts < 1) { alert('총 작업량(컷)을 1 이상으로 입력해 주세요.'); return; }

  if (editingId) {
    Object.assign(byId(editingId), { name, totalCuts: cuts, color: formColor });
  } else {
    const p = { id: uid(), name, color: formColor, totalCuts: cuts, deadline: formDeadline, days: [], done: {}, goal: {} };
    state.projects.push(p);
    mode = { type: 'days', id: p.id };
    lastPick = null;
    if (formDeadline) view = startOfMonth(parseYmd(formDeadline));
  }
  save();
  document.getElementById('pMask').hidden = true;
  render();
}

function deleteProject() {
  const p = byId(editingId);
  if (!p) return;
  if (!confirm('"' + p.name + '" 프로젝트를 삭제할까요? 입력한 작업 기록도 함께 지워집니다.')) return;
  state.projects = state.projects.filter(x => x.id !== editingId);
  if (mode && mode.id === editingId) mode = null;
  save();
  document.getElementById('pMask').hidden = true;
  render();
}

/* ── 날짜 모달 ──────────────────────────── */
function openDay(d) {
  dayDate = d;
  document.getElementById('dTitle').textContent = fmtFull(d);
  renderDayBody();
  document.getElementById('dMask').hidden = false;
}

function renderDayBody() {
  const d = dayDate;
  const body = document.getElementById('dBody');
  const rows = state.projects.filter(p => p.days.includes(d));
  const dues = state.projects.filter(p => p.deadline === d);

  let html = rows.length ? rows.map(p => {
    const s = SCH[p.id].byDate[d];
    return '<div class="drow" style="border-left:3px solid ' + p.color + '">' +
      '<div class="dn"><b>' + esc(p.name) + '</b><small>목표 ' + num(s.goal) + '컷' +
        (s.missed ? ' · 미입력' : '') + '</small></div>' +
      '<input type="number" min="0" step="1" data-done="' + p.id + '" placeholder="0" value="' +
        (s.entered ? s.done : '') + '"><span class="unit">컷</span>' +
      '<button class="icon" data-act="unassign" data-id="' + p.id + '" title="이 날짜를 작업일에서 제외">&#10005;</button>' +
    '</div>';
  }).join('') : '<div class="empty">이 날짜에 지정된 작업이 없습니다.<br>프로젝트의 <b>작업일</b> 버튼으로 날짜를 지정하세요.</div>';

  if (dues.length) {
    html += '<div class="dsec">이 날짜가 마감</div>' + dues.map(p =>
      '<div class="drow due"><span class="dot" style="background:' + p.color + '"></span>' +
      '<div class="dn"><b>' + esc(p.name) + '</b><small>총 ' + num(p.totalCuts) + '컷</small></div>' +
      '<button class="icon" data-act="undue" data-id="' + p.id + '" title="마감일 해제">&#10005;</button></div>'
    ).join('');
  }
  body.innerHTML = html;
}

function setDone(pid, raw) {
  const p = byId(pid);
  if (!p) return;
  const v = String(raw).trim();
  if (v === '') {
    delete p.done[dayDate];
    delete p.goal[dayDate];
  } else {
    if (p.goal[dayDate] == null) p.goal[dayDate] = SCH[pid].target;  // 입력 시점 목표량 고정
    p.done[dayDate] = Math.max(0, parseInt(v, 10) || 0);
  }
  save();
  render();
  renderDayBody();
}

/* ── 캘린더 클릭 동작 ───────────────────── */
function toggleDay(p, d, shift) {
  if (shift && lastPick) {
    const a = lastPick < d ? lastPick : d;
    const b = lastPick < d ? d : lastPick;
    const cur = parseYmd(a), end = parseYmd(b);
    while (cur <= end) {
      const s = ymd(cur);
      if (!p.days.includes(s)) p.days.push(s);
      cur.setDate(cur.getDate() + 1);
    }
  } else {
    const i = p.days.indexOf(d);
    if (i >= 0) { p.days.splice(i, 1); delete p.done[d]; delete p.goal[d]; }
    else p.days.push(d);
  }
  lastPick = d;
  p.days.sort();
  save();
  render();
}

function setDeadline(p, d) {
  p.deadline = p.deadline === d ? '' : d;
  mode = p.days.length ? null : { type: 'days', id: p.id };
  lastPick = null;
  save();
  render();
}

/* ── 이벤트 ─────────────────────────────── */
document.getElementById('prevM').onclick = () => { view.setMonth(view.getMonth() - 1); render(); };
document.getElementById('nextM').onclick = () => { view.setMonth(view.getMonth() + 1); render(); };
document.getElementById('todayBtn').onclick = () => { view = startOfMonth(new Date()); render(); };
document.getElementById('addProject').onclick = () => openProject(null, '');
document.getElementById('bannerDone').onclick = () => { mode = null; lastPick = null; render(); };
document.getElementById('pSave').onclick = saveProject;
document.getElementById('pDelete').onclick = deleteProject;
document.getElementById('dNewDeadline').onclick = () => {
  const d = dayDate;
  document.getElementById('dMask').hidden = true;
  openProject(null, d);
};

document.getElementById('fColors').addEventListener('click', e => {
  const b = e.target.closest('[data-color]');
  if (!b) return;
  formColor = b.dataset.color;
  [...e.currentTarget.children].forEach(c => c.classList.toggle('on', c === b));
});

document.getElementById('projects').addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act, id = b.dataset.id;
  if (act === 'edit') { openProject(id); return; }
  mode = (mode && mode.id === id && mode.type === act) ? null : { type: act, id };
  lastPick = null;
  render();
});

document.getElementById('cal').addEventListener('click', e => {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  const d = cell.dataset.date;
  if (!mode) { openDay(d); return; }
  const p = byId(mode.id);
  if (!p) { mode = null; render(); return; }
  if (mode.type === 'days') toggleDay(p, d, e.shiftKey);
  else setDeadline(p, d);
});

document.getElementById('dBody').addEventListener('change', e => {
  if (e.target.dataset.done) setDone(e.target.dataset.done, e.target.value);
});
document.getElementById('dBody').addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const p = byId(b.dataset.id);
  if (!p) return;
  if (b.dataset.act === 'unassign') {
    p.days = p.days.filter(x => x !== dayDate);
    delete p.done[dayDate];
    delete p.goal[dayDate];
  } else if (b.dataset.act === 'undue') {
    p.deadline = '';
  }
  save();
  render();
  renderDayBody();
});

document.addEventListener('click', e => {
  const c = e.target.closest('[data-close]');
  if (c) document.getElementById(c.dataset.close).hidden = true;
});
document.querySelectorAll('.mask').forEach(m => {
  m.addEventListener('mousedown', e => { if (e.target === m) m.hidden = true; });
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const open = [...document.querySelectorAll('.mask')].find(m => !m.hidden);
    if (open) open.hidden = true;
    else if (mode) { mode = null; render(); }
  }
});

render();
