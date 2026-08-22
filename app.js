/* 웹툰 작업량 관리 — 컷 단위 자동 분배 캘린더 */

const KEY = 'webtoon-workload-v1';
const PALETTE = ['#EF4444', '#F97316', '#F59E0B', '#22C55E', '#06B6D4', '#3B82F6', '#8B5CF6', '#EC4899', '#0EA5E9', '#64748B'];
const TRACKS = { main: '', draft: '초안', clean: '클린업' };

let state = load();
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
    p.storyboard = !!p.storyboard;
    if (!p.log) p.log = {};
    if (p.done || p.goal) {                       // 콘티 기능 이전 데이터 이행
      p.log.main = { done: p.done || {}, goal: p.goal || {} };
      delete p.done; delete p.goal;
    }
    for (const k of Object.keys(TRACKS)) {
      p.log[k] = p.log[k] || {};
      p.log[k].done = p.log[k].done || {};
      p.log[k].goal = p.log[k].goal || {};
    }
  }
  return s;
}
function save() { localStorage.setItem(KEY, JSON.stringify(state)); }

/* ── 유틸 ───────────────────────────────── */
function uid() { return Math.random().toString(36).slice(2, 9); }
function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function sundayOf(d) { return addDays(d, -d.getDay()); }
function dayDiff(a, b) {
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) -
    Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
}
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
function tracksOf(p) {
  return p.storyboard ? [{ k: 'draft', label: TRACKS.draft }, { k: 'clean', label: TRACKS.clean }]
                      : [{ k: 'main', label: '' }];
}

/* ── 핵심: 일자별 목표 컷수 계산 ──────────
   · 실적을 입력하지 않은 날은 모두 "남은 날"이며, 남은 컷수를 균등하게 나눠 갖는다.
     (50컷 / 5일 → 매일 10컷)
   · 실적을 입력하면 그만큼 남은 컷수에서 빠지고, 남은 날 수도 하나 줄어
     나머지 날들의 목표량이 다시 계산된다.
   · 이미 입력한 날은 입력 당시의 목표량(goal 스냅샷)을 그대로 보여준다.
   · 하루를 쉬었다면 0을 입력하면 된다 → 그날이 남은 날에서 빠지고 뒤로 재분배.
   · 콘티(초안·클린업)를 켜면 각 트랙이 총 컷수를 따로 가지고 독립적으로 계산된다. */
function schedule(p, track) {
  const lg = p.log[track];
  const days = p.days.slice().sort();
  const total = Math.max(0, Number(p.totalCuts) || 0);
  let doneSum = 0, openCount = 0;
  for (const d of days) {
    if (has(lg.done, d)) doneSum += Number(lg.done[d]) || 0;
    else openCount++;
  }
  const remaining = Math.max(0, total - doneSum);
  const target = openCount ? Math.ceil(remaining / openCount) : 0;

  const byDate = {};
  for (const d of days) {
    const entered = has(lg.done, d);
    const done = entered ? Number(lg.done[d]) || 0 : 0;
    const goal = entered ? (lg.goal[d] != null ? lg.goal[d] : target) : target;
    byDate[d] = { goal, done, entered, missed: !entered && d < TODAY };
  }
  return { byDate, target, doneSum, remaining, openCount, total };
}
function allSchedules() {
  const m = {};
  for (const p of state.projects) {
    m[p.id] = {};
    for (const t of tracksOf(p)) m[p.id][t.k] = schedule(p, t.k);
  }
  return m;
}

/* ── 캘린더 범위 (연속 스크롤) ──────────── */
let anchor = addDays(sundayOf(new Date()), -8 * 7);   // 화면에 그리는 첫 주(일요일)
let weekCount = 40;
const MAX_WEEKS = 520;
let extending = false;
let labelYm = null;

/* ── 렌더 ───────────────────────────────── */
let SCH = {};
function render() {
  SCH = allSchedules();
  renderSidebar();
  renderCalendar();
  renderTopbar();
  renderBanner();
}

function renderTopbar() {
  let goal = 0, done = 0;
  for (const p of state.projects) {
    for (const t of tracksOf(p)) {
      const s = SCH[p.id][t.k].byDate[TODAY];
      if (s) { goal += s.goal; done += s.done; }
    }
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
    const tracks = tracksOf(p);
    const active = mode && mode.id === p.id;
    const trk = tracks.map(t => {
      const s = SCH[p.id][t.k];
      const pct = s.total ? Math.min(100, Math.round(s.doneSum / s.total * 100)) : 0;
      const td = s.byDate[TODAY];
      return '<div class="trk">' +
        '<div class="trk-h"><span>' + (t.label || '진행') + '</span>' +
          '<span>' + num(s.doneSum) + ' / ' + num(s.total) + '컷 · ' + pct + '%</span></div>' +
        '<div class="bar"><span style="width:' + pct + '%;background:' + p.color + '"></span></div>' +
        '<div class="trk-f">' + (s.openCount ? '하루 ' + num(s.target) + '컷' : '남은 작업 없음') +
          (td ? ' · 오늘 ' + num(td.done) + '/' + num(td.goal) + '컷' : '') + '</div>' +
      '</div>';
    }).join('');
    const openDays = tracks[0] ? SCH[p.id][tracks[0].k].openCount : 0;
    return '<div class="card' + (active ? ' sel' : '') + '">' +
      '<div class="card-top">' +
        '<span class="dot" style="background:' + p.color + '"></span>' +
        '<span class="pname">' + esc(p.name) + '</span>' +
        (p.storyboard ? '<span class="tag">콘티</span>' : '') +
        '<button class="icon" data-act="edit" data-id="' + p.id + '" title="수정">&#8942;</button>' +
      '</div>' + trk +
      '<div class="meta">남은 작업일 ' + openDays + '일' +
        (p.deadline ? ' · 마감 ' + fmtShort(p.deadline) : ' · 마감 미지정') + '</div>' +
      '<div class="card-btns">' +
        '<button class="btn ghost sm" data-act="days" data-id="' + p.id + '">' +
          (active && mode.type === 'days' ? '선택 완료' : '작업일 (' + p.days.length + '일)') + '</button>' +
        '<button class="btn ghost sm" data-act="deadline" data-id="' + p.id + '">' +
          (active && mode.type === 'deadline' ? '지정 취소' : '마감일') + '</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function chipHtml(p, d) {
  const tracks = tracksOf(p);
  let grps = '', any = false, tip = esc(p.name);
  for (const t of tracks) {
    const s = SCH[p.id][t.k].byDate[d];
    if (!s) continue;
    any = true;
    const pre = t.label ? t.label + ' ' : '';
    const ok = s.entered && s.done >= s.goal;
    tip += ' · ' + (t.label ? t.label + ' ' : '') + '목표 ' + s.goal + '컷' + (s.entered ? ' / 작업 ' + s.done + '컷' : '');
    grps += '<div class="grp">' +
      '<span class="cline"><span>' + pre + '목표</span><b>' + s.goal + '</b></span>' +
      '<span class="cline' + (s.entered ? '' : ' na') + (ok ? ' ok' : '') + '"><span>' + pre + '작업</span><b>' +
        (s.entered ? s.done : '—') + '</b></span>' +
    '</div>';
  }
  if (!any) return '';
  return '<div class="chip" style="border-left-color:' + p.color + ';background:' + p.color + '14" title="' + tip + '">' +
    '<span class="cn" style="color:' + p.color + '">' + esc(p.name) + '</span>' + grps + '</div>';
}

function renderCalendar() {
  const target = mode ? byId(mode.id) : null;
  let html = '';
  for (let w = 0; w < weekCount; w++) {
    html += '<div class="week">';
    for (let i = 0; i < 7; i++) {
      const cur = addDays(anchor, w * 7 + i);
      const d = ymd(cur);
      const dow = cur.getDay();
      const picked = target && mode.type === 'days' && target.days.includes(d);
      const dlPick = target && mode.type === 'deadline' && target.deadline === d;

      let chips = '', flags = '', missed = false;
      for (const p of state.projects) {
        if (p.deadline === d) flags += '<span class="flag" style="background:' + p.color + '">마감</span>';
        if (!p.days.includes(d)) continue;
        for (const t of tracksOf(p)) {
          const s = SCH[p.id][t.k].byDate[d];
          if (s && s.missed) missed = true;
        }
        chips += chipHtml(p, d);
      }
      const first = cur.getDate() === 1;
      html += '<div class="cell' + (cur.getMonth() % 2 ? ' alt' : '') + (d === TODAY ? ' today' : '') +
        (dow === 0 ? ' sun' : dow === 6 ? ' sat' : '') +
        (mode ? ' picking' : '') + (picked || dlPick ? ' picked' : '') + '" data-date="' + d + '">' +
        '<div class="dhead"><span class="dnum">' +
          (first ? '<em>' + (cur.getMonth() + 1) + '월</em> ' : '') + cur.getDate() + '</span>' + flags +
        (missed ? '<span class="warn">미입력</span>' : '') + '</div>' + chips +
      '</div>';
    }
    html += '</div>';
  }
  document.getElementById('cal').innerHTML = html;
  updateMonthLabel();
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

/* ── 스크롤: 달 경계 없이 주 단위로 계속 이어짐 ── */
const wrap = document.getElementById('calWrap');

function updateMonthLabel() {
  const weeks = document.getElementById('cal').children;
  if (!weeks.length) return;
  const top = wrap.getBoundingClientRect().top;
  let pick = weeks[0];
  for (const w of weeks) {
    if (w.getBoundingClientRect().bottom > top + 24) { pick = w; break; }
  }
  const idx = [].indexOf.call(weeks, pick);
  const mid = addDays(anchor, idx * 7 + 3);          // 그 주의 수요일 기준
  labelYm = { y: mid.getFullYear(), m: mid.getMonth() };
  document.getElementById('monthLabel').textContent = labelYm.y + '년 ' + (labelYm.m + 1) + '월';
}

function extendDown() {
  if (weekCount >= MAX_WEEKS) return false;
  weekCount += 12;
  renderCalendar();
  return true;
}
function extendUp() {
  if (weekCount >= MAX_WEEKS) return false;
  const before = wrap.scrollHeight;
  anchor = addDays(anchor, -12 * 7);
  weekCount += 12;
  renderCalendar();
  wrap.scrollTop += wrap.scrollHeight - before;      // 위에 붙인 만큼 보정
  return true;
}

let ticking = false;
wrap.addEventListener('scroll', () => {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    if (!extending) {
      extending = true;
      if (wrap.scrollTop < 400) extendUp();
      else if (wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 700) extendDown();
      extending = false;
    }
    updateMonthLabel();
  });
});

function ensureRange(d) {
  const dt = parseYmd(d);
  let idx = Math.floor(dayDiff(anchor, dt) / 7);
  while (idx < 2) {                                   // 앞쪽이 모자라면 확장
    anchor = addDays(anchor, -12 * 7);
    weekCount += 12;
    idx += 12;
  }
  while (idx > weekCount - 3) weekCount += 12;
  return idx;
}
function scrollToDate(d, smooth) {
  const idx = ensureRange(d);
  renderCalendar();
  const wk = document.getElementById('cal').children[idx];
  if (!wk) return;
  const top = wk.getBoundingClientRect().top - wrap.getBoundingClientRect().top + wrap.scrollTop;
  wrap.scrollTo({ top: Math.max(0, top - 6), behavior: smooth ? 'smooth' : 'auto' });
  updateMonthLabel();
}

/* ── 프로젝트 모달 ──────────────────────── */
function openProject(id, presetDeadline) {
  editingId = id || null;
  const p = id ? byId(id) : null;
  document.getElementById('pTitle').textContent = p ? '프로젝트 수정' : '새 프로젝트';
  document.getElementById('fName').value = p ? p.name : '';
  document.getElementById('fCuts').value = p ? p.totalCuts : '';
  document.getElementById('fStoryboard').checked = p ? !!p.storyboard : false;
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
  const sb = document.getElementById('fStoryboard').checked;
  if (!name) { alert('프로젝트 이름을 입력해 주세요.'); return; }
  if (!cuts || cuts < 1) { alert('총 작업량(컷)을 1 이상으로 입력해 주세요.'); return; }

  if (editingId) {
    Object.assign(byId(editingId), { name, totalCuts: cuts, color: formColor, storyboard: sb });
  } else {
    const log = {};
    for (const k of Object.keys(TRACKS)) log[k] = { done: {}, goal: {} };
    const p = { id: uid(), name, color: formColor, totalCuts: cuts, deadline: formDeadline, storyboard: sb, days: [], log };
    state.projects.push(p);
    mode = { type: 'days', id: p.id };
    lastPick = null;
  }
  save();
  document.getElementById('pMask').hidden = true;
  render();
  if (!editingId && formDeadline) scrollToDate(formDeadline);
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
  const rows = state.projects.filter(p => p.days.includes(d));
  const dues = state.projects.filter(p => p.deadline === d);

  let html = rows.length ? rows.map(p => {
    const lines = tracksOf(p).map(t => {
      const s = SCH[p.id][t.k].byDate[d];
      return '<div class="dline">' +
        (t.label ? '<span class="tk">' + t.label + '</span>' : '') +
        '<small data-goal="' + p.id + ':' + t.k + '">목표 ' + num(s.goal) + '컷' + (s.missed ? ' · 미입력' : '') + '</small>' +
        '<input type="number" min="0" step="1" data-p="' + p.id + '" data-t="' + t.k + '" placeholder="0" value="' +
          (s.entered ? s.done : '') + '"><span class="unit">컷</span>' +
      '</div>';
    }).join('');
    return '<div class="drow" style="border-left:3px solid ' + p.color + '">' +
      '<div class="dtop"><b>' + esc(p.name) + '</b>' + (p.storyboard ? '<span class="tag">콘티</span>' : '') +
        '<button class="icon" data-act="unassign" data-id="' + p.id + '" title="이 날짜를 작업일에서 제외">&#10005;</button></div>' +
      lines + '</div>';
  }).join('') : '<div class="empty">이 날짜에 지정된 작업이 없습니다.<br>프로젝트의 <b>작업일</b> 버튼으로 날짜를 지정하세요.</div>';

  if (dues.length) {
    html += '<div class="dsec">이 날짜가 마감</div>' + dues.map(p =>
      '<div class="drow due"><span class="dot" style="background:' + p.color + '"></span>' +
      '<div class="dn"><b>' + esc(p.name) + '</b><small>총 ' + num(p.totalCuts) + '컷' +
        (p.storyboard ? ' · 초안 + 클린업' : '') + '</small></div>' +
      '<button class="icon" data-act="undue" data-id="' + p.id + '" title="마감일 해제">&#10005;</button></div>'
    ).join('');
  }
  document.getElementById('dBody').innerHTML = html;
}

/* 입력 중 포커스가 날아가지 않도록 목표 텍스트만 갱신한다 */
function refreshDayGoals() {
  document.querySelectorAll('#dBody [data-goal]').forEach(el => {
    const [pid, tk] = el.dataset.goal.split(':');
    const s = SCH[pid] && SCH[pid][tk] && SCH[pid][tk].byDate[dayDate];
    if (s) el.textContent = '목표 ' + num(s.goal) + '컷' + (s.missed ? ' · 미입력' : '');
  });
}

function setDone(pid, track, raw) {
  const p = byId(pid);
  if (!p) return;
  const lg = p.log[track];
  const v = String(raw).trim();
  if (v === '') {
    delete lg.done[dayDate];
    delete lg.goal[dayDate];
  } else {
    if (lg.goal[dayDate] == null) lg.goal[dayDate] = SCH[pid][track].target;  // 입력 시점 목표량 고정
    lg.done[dayDate] = Math.max(0, parseInt(v, 10) || 0);
  }
  save();
  render();
  refreshDayGoals();
}

/* ── 캘린더 클릭 동작 ───────────────────── */
function clearDay(p, d) {
  for (const k of Object.keys(TRACKS)) { delete p.log[k].done[d]; delete p.log[k].goal[d]; }
}
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
    if (i >= 0) { p.days.splice(i, 1); clearDay(p, d); }
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
document.getElementById('prevM').onclick = () => {
  const t = new Date(labelYm.y, labelYm.m - 1, 1);
  scrollToDate(ymd(t), true);
};
document.getElementById('nextM').onclick = () => {
  const t = new Date(labelYm.y, labelYm.m + 1, 1);
  scrollToDate(ymd(t), true);
};
document.getElementById('todayBtn').onclick = () => scrollToDate(TODAY, true);
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
  const i = e.target;
  if (i.dataset.p) setDone(i.dataset.p, i.dataset.t, i.value);
});
document.getElementById('dBody').addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const p = byId(b.dataset.id);
  if (!p) return;
  if (b.dataset.act === 'unassign') {
    p.days = p.days.filter(x => x !== dayDate);
    clearDay(p, dayDate);
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
scrollToDate(TODAY);
