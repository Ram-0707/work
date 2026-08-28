/* 웹툰 작업량 관리 — 컷 단위 자동 분배 캘린더 */

const KEY = 'webtoon-workload-v1';
const PALETTE = ['#EF4444', '#F97316', '#F59E0B', '#22C55E', '#06B6D4', '#3B82F6', '#8B5CF6', '#EC4899', '#0EA5E9', '#737373'];
const OLD_COLORS = { '#64748B': '#737373' };   // 푸른 기가 돌던 회색을 무채색으로
const TRACKS = { main: '', draft: '초안', clean: '클린업' };

let state = load();
let mode = null;        // {type:'days'|'deadline', id} — 캘린더 클릭 동작
let lastPick = null;    // Shift 범위 선택 기준일
let editingId = null;   // 프로젝트 모달 편집 대상
let formColor = PALETTE[0];
let formDeadline = '';
let dayDate = null;     // 날짜 모달 대상
const openCards = new Set();   // 사이드바에서 펼쳐 둔 프로젝트

/* 하루의 경계는 자정이 아니라 새벽 6시.
   새벽 2시에 한 작업은 전날 몫으로 잡힌다. */
const DAY_START_HOUR = 6;
function logicalDate(t) {
  const d = new Date(t);
  d.setHours(d.getHours() - DAY_START_HOUR);
  return d;
}
const TODAY = ymd(logicalDate(Date.now()));

/* ── 저장소 ─────────────────────────────── */
function load() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* 손상된 데이터는 무시 */ }
  if (!s || !Array.isArray(s.projects)) return { projects: [], weeks: {}, sort: 'added', entries: [] };
  s.weeks = s.weeks || {};                        // 주간 체크리스트 (일요일 날짜가 key)
  s.sort = s.sort || 'added';                     // 사이드바 정렬 방식
  s.entries = (Array.isArray(s.entries) ? s.entries : [])  // 입력 기록 (타임테이블)
    .filter(e => e && (e.text ? String(e.text).trim() : e.delta > 0))   // 마이너스 기록은 쓰지 않는다
    .map(e => e.text
      ? { id: e.id || uid(), ts: e.ts, d: e.d, text: String(e.text) }   // 메모
      : { id: e.id || uid(), ts: e.ts, p: e.p, t: e.t, d: e.d, delta: e.delta });
  for (const p of s.projects) {
    p.days = p.days || [];
    p.storyboard = !!p.storyboard;
    if (OLD_COLORS[p.color]) p.color = OLD_COLORS[p.color];
    if (!p.log) p.log = {};
    if (p.done || p.goal) {                       // 콘티 기능 이전 데이터 이행
      p.log.main = { done: p.done || {} };
      delete p.done; delete p.goal;
    }
    for (const k of Object.keys(TRACKS)) {
      p.log[k] = p.log[k] || {};
      p.log[k].done = p.log[k].done || {};
      delete p.log[k].goal;                       // 목표량은 저장하지 않고 매번 계산한다
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
   · 이미 입력한 날의 목표량은 날짜 순으로 되짚어 구한다. 그날까지 남아 있던
     컷수를 그때 남아 있던 작업일 수로 나눈 값이다. 저장해 두지 않고 매번 다시
     계산하므로 총 작업량을 고치면 입력한 실적은 그대로 둔 채 목표량만 새 총량
     기준으로 다시 잡힌다.
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
  const finished = total > 0 && remaining === 0;   // 총량을 다 채웠으면 남은 날은 할 일이 없다

  const byDate = {};
  let left = total, used = 0;
  for (const d of days) {
    if (has(lg.done, d)) {
      const open = days.length - used;             // 그 시점에 남아 있던 작업일 수
      const done = Number(lg.done[d]) || 0;
      byDate[d] = { goal: open > 0 ? Math.ceil(left / open) : 0, done, entered: true, missed: false };
      left = Math.max(0, left - done);
      used++;
    } else {
      byDate[d] = { goal: target, done: 0, entered: false, missed: !finished && d < TODAY, finished };
    }
  }
  return { byDate, target, doneSum, remaining, openCount, total, finished };
}
/* 그 날짜 이전까지 끝낸 누적 컷수 — 입력값은 "몇 번째 컷까지"라서 이 값을 뺀다 */
function prevTotal(p, track, date) {
  const lg = p.log[track];
  let sum = 0;
  for (const d of Object.keys(lg.done)) {
    if (d < date) sum += Number(lg.done[d]) || 0;
  }
  return sum;
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
let anchor = addDays(sundayOf(parseYmd(TODAY)), -8 * 7);   // 화면에 그리는 첫 주(일요일)
let weekCount = 40;
const MAX_WEEKS = 520;
let extending = false;
let labelYm = null;

/* ── 정렬 ───────────────────────────────── */
function sortProjects() {
  const arr = state.projects.slice();             // 등록 순서 자체는 건드리지 않는다
  const byName = (a, b) => a.name.localeCompare(b.name, 'ko');
  if (state.sort === 'color') {
    const rank = p => (PALETTE.indexOf(p.color) + 1) || 99;
    arr.sort((a, b) => rank(a) - rank(b) || byName(a, b));
  } else if (state.sort === 'due') {
    arr.sort((a, b) => (a.deadline || '9999-99-99').localeCompare(b.deadline || '9999-99-99') || byName(a, b));
  }
  return arr;
}

/* ── 렌더 ───────────────────────────────── */
let SCH = {};
let PSORT = [];
function render(keepInputs) {
  SCH = allSchedules();
  PSORT = sortProjects();
  renderSidebar();
  renderTimeline(keepInputs);
  renderCalendar();
  renderTopbar();
  renderBanner();
}

/* ── 작업량 입력 줄 (날짜 모달 · 타임테이블 공용) ──
   입력칸은 "몇 번째 컷까지 했는지"를 받는다. */
function hintOf(p, tk, d) {
  const s = SCH[p.id][tk].byDate[d];
  const prev = prevTotal(p, tk, d);
  if (s.finished && !s.entered) return '작업 완료 — 남은 컷 없음';
  return '목표 ' + num(prev + s.goal) + '번째 · 오늘 ' + num(s.done) + '컷' + (s.missed ? ' · 미입력' : '');
}
function inputRow(p, t, d) {
  const s = SCH[p.id][t.k].byDate[d];
  const prev = prevTotal(p, t.k, d);
  return '<div class="dline">' +
      (t.label ? '<span class="tk">' + t.label + '</span>' : '') +
      '<span class="dgap"></span>' +
      '<input type="number" min="0" step="1" data-p="' + p.id + '" data-t="' + t.k + '"' +
        ' placeholder="' + prev + '" value="' + (s.entered ? prev + s.done : '') + '">' +
      '<span class="unit">번째</span></div>' +
    '<div class="dhint" data-goal="' + p.id + ':' + t.k + '">' + hintOf(p, t.k, d) + '</div>';
}
/* 입력 중에는 칸을 그대로 두고 안내 문구와 다른 칸 값만 맞춘다 */
function refreshRows(root, d) {
  root.querySelectorAll('[data-goal]').forEach(el => {
    const [pid, tk] = el.dataset.goal.split(':');
    const p = byId(pid);
    if (p && SCH[pid] && SCH[pid][tk]) el.textContent = hintOf(p, tk, d);
  });
  root.querySelectorAll('input[data-p]').forEach(el => {
    if (el === document.activeElement) return;
    const p = byId(el.dataset.p);
    const s = p && SCH[el.dataset.p][el.dataset.t].byDate[d];
    const prev = p ? prevTotal(p, el.dataset.t, d) : 0;
    el.placeholder = prev;
    el.value = s && s.entered ? prev + s.done : '';
  });
}

/* ── 타임테이블 ─────────────────────────── */
let tlDate = TODAY;

function tlRows() {
  return PSORT.filter(p => p.days.includes(tlDate));
}

function renderTimeline(keepInputs) {
  const lbl = document.getElementById('tlDateLabel');
  lbl.textContent = fmtShort(tlDate) + ' (' + ['일', '월', '화', '수', '목', '금', '토'][parseYmd(tlDate).getDay()] + ')';
  lbl.title = '하루 기준: 오전 ' + DAY_START_HOUR + '시 ~ 다음날 오전 ' + DAY_START_HOUR + '시';
  document.getElementById('tlToday').style.visibility = tlDate === TODAY ? 'hidden' : '';

  const rows = tlRows();
  const list = entriesOf(tlDate);
  const work = list.filter(e => !e.text);
  const notes = list.length - work.length;
  const dayTotal = work.reduce((a, e) => a + e.delta, 0);
  document.getElementById('tlSum').innerHTML = list.length
    ? '<span>이 날 입력 <b>' + num(dayTotal) + '컷</b></span><span>' + work.length + '회' +
      (notes ? ' · 메모 ' + notes : '') + '</span>'
    : '<span>아직 입력한 기록이 없습니다.</span>';

  if (!keepInputs) {
    document.getElementById('tlInputs').innerHTML = rows.length ? rows.map(p =>
      '<div class="tl-r" style="border-left:3px solid ' + p.color + '">' +
        '<div class="tl-rh"><b>' + esc(p.name) + '</b>' + (p.storyboard ? '<span class="tag">콘티</span>' : '') + '</div>' +
        tracksOf(p).map(t => inputRow(p, t, tlDate)).join('') +
      '</div>').join('')
      : '<div class="empty">이 날짜에 지정된 작업이 없습니다.</div>';
  } else {
    refreshRows(document.getElementById('tlInputs'), tlDate);
  }

  const cum = cumulative(list);
  const acts = '<span class="tl-act">' +
    '<button data-act="tle-edit" title="수정">&#9998;</button>' +
    '<button data-act="tle-del" title="삭제">&#10005;</button></span>';
  document.getElementById('tlLog').innerHTML = list.length ? '<ul class="tl-log">' + list.map(e => {
    if (e.text) {
      return '<li class="tl-e tl-note" data-id="' + e.id + '">' +
        '<span class="tl-time">' + fmtTime(e.ts) + '</span>' +
        '<span class="tl-nt">' + esc(e.text) + '</span>' + acts + '</li>';
    }
    const p = byId(e.p);
    return '<li class="tl-e" data-id="' + e.id + '">' +
      '<span class="tl-time">' + fmtTime(e.ts) + '</span>' +
      '<span class="tl-dot" style="background:' + (p ? p.color : 'var(--muted)') + '"></span>' +
      '<span class="tl-n">' + esc(p ? p.name : '삭제된 프로젝트') +
        '<small>' + (TRACKS[e.t] || '') + '</small></span>' +
      '<span class="tl-d">+' + num(e.delta) + '<i>컷</i><small>누적 ' + num(cum[e.id]) + '</small></span>' +
      acts + '</li>';
  }).join('') + '</ul>' : '';
}

function renderTopbar() {
  let goal = 0, done = 0;
  for (const p of state.projects) {
    for (const t of tracksOf(p)) {
      if (t.k === 'draft') continue;              // 콘티 초안은 오늘 합계에서 뺀다
      const s = SCH[p.id][t.k].byDate[TODAY];
      if (s) { goal += s.goal; done += s.done; }
    }
  }
  const sum = document.getElementById('todaySum');
  sum.title = '콘티 프로젝트는 클린업만 합산합니다. 초안은 제외됩니다.';
  sum.innerHTML =
    '<span>오늘 목표 <b>' + num(goal) + '컷</b></span>' +
    '<span>완료 <b>' + num(done) + '컷</b></span>' +
    '<span>남은 <b>' + num(Math.max(0, goal - done)) + '컷</b></span>';
}

function renderSidebar() {
  document.querySelectorAll('#sortBar button').forEach(b =>
    b.classList.toggle('on', b.dataset.sort === state.sort));
  const el = document.getElementById('projects');
  if (!state.projects.length) {
    el.innerHTML = '<div class="empty">아직 프로젝트가 없습니다.<br>아래 버튼으로 추가해 주세요.</div>';
    return;
  }
  el.innerHTML = PSORT.map(p => {
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
        '<div class="trk-f">' + (s.finished ? '작업 완료' : s.openCount ? '하루 ' + num(s.target) + '컷' : '남은 작업 없음') +
          (td && !s.finished ? ' · 오늘 ' + num(td.done) + '/' + num(td.goal) + '컷' : '') + '</div>' +
      '</div>';
    }).join('');
    const openDays = tracks[0] ? SCH[p.id][tracks[0].k].openCount : 0;
    const open = openCards.has(p.id) || active;   // 날짜 지정 중인 프로젝트는 항상 펼침
    return '<div class="card' + (active ? ' sel' : '') + (open ? ' open' : '') + '">' +
      '<div class="card-top" data-act="toggle" data-id="' + p.id + '">' +
        '<span class="chev">&#8250;</span>' +
        '<span class="dot" style="background:' + p.color + '"></span>' +
        '<span class="pname">' + esc(p.name) + '</span>' +
        (p.storyboard ? '<span class="tag">콘티</span>' : '') +
        '<button class="icon" data-act="edit" data-id="' + p.id + '" title="수정">&#8942;</button>' +
      '</div>' +
      (open ? '<div class="card-body">' + trk +
        '<div class="meta">남은 작업일 ' + openDays + '일' +
          (p.deadline ? ' · 마감 ' + fmtShort(p.deadline) : ' · 마감 미지정') + '</div>' +
        '<div class="card-btns">' +
          '<button class="btn ghost sm" data-act="days" data-id="' + p.id + '">' +
            (active && mode.type === 'days' ? '선택 완료' : '작업일 (' + p.days.length + '일)') + '</button>' +
          '<button class="btn ghost sm" data-act="deadline" data-id="' + p.id + '">' +
            (active && mode.type === 'deadline' ? '지정 취소' : '마감일') + '</button>' +
        '</div></div>' : '') +
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
    if (s.finished && !s.entered) {               // 총량을 다 채운 뒤의 날 — 남은 할 일이 없다
      tip += ' · ' + pre + '작업 완료';
      grps += '<div class="grp"><span class="cline fin"><span>' + pre + '완료</span></span></div>';
      continue;
    }
    const ok = s.entered && s.done >= s.goal;
    tip += ' · ' + pre + '목표 ' + s.goal + '컷' + (s.entered ? ' / 작업 ' + s.done + '컷' : '');
    grps += '<div class="grp">' +
      '<span class="cline"><span>' + pre + '목표</span><b>' + s.goal + '</b></span>' +
      '<span class="cline' + (s.entered ? '' : ' na') + (ok ? ' ok' : '') + '"><span>' + pre + '작업</span><b>' +
        (s.entered ? s.done : '—') + '</b></span>' +
    '</div>';
  }
  if (!any) return '';
  return '<div class="chip"' + (mode ? '' : ' draggable="true"') + ' data-p="' + p.id + '"' +
    ' style="border-left-color:' + p.color + ';background:' + p.color + '14"' +
    ' title="' + tip + '&#10;드래그해서 다른 날짜로 이동 (Alt+드래그: 이 날짜만)">' +
    '<span class="cn" style="color:' + p.color + '">' + esc(p.name) + '</span>' + grps + '</div>';
}

/* ── 주간 체크리스트 ────────────────────── */
function itemHtml(it) {
  return '<li class="wc-row wc-i' + (it.d ? ' done' : '') + '" data-id="' + it.id + '">' +
    '<span class="wc-g" title="드래그해서 옮기기">&#10250;</span>' +
    '<input type="checkbox"' + (it.d ? ' checked' : '') + '>' +
    '<span class="wc-t" contenteditable="plaintext-only">' + esc(it.t) + '</span>' +
    '<button class="wc-x" title="삭제">&#10005;</button></li>';
}
function weekCellHtml(wk) {
  const items = state.weeks[wk] || [];
  return '<div class="wcell" data-week="' + wk + '">' +
    '<ul class="wc-list">' + items.map(itemHtml).join('') + '</ul>' +
    '<div class="wc-row wc-new"><span class="wc-g"></span>' +
      '<input type="checkbox" tabindex="-1" aria-hidden="true">' +
      '<input class="wc-add" type="text" data-week="' + wk + '" aria-label="체크리스트 항목 추가">' +
    '</div></div>';
}
function weekItems(wk) {
  if (!state.weeks[wk]) state.weeks[wk] = [];
  return state.weeks[wk];
}
function pruneWeek(wk) {
  if (state.weeks[wk] && !state.weeks[wk].length) delete state.weeks[wk];
}

/* 다시 그릴 때 보고 있던 위치를 그대로 유지한다.
   화면 맨 위에 걸친 주를 날짜로 기억했다가 같은 자리에 돌려놓는 방식이라
   주를 앞뒤로 더 붙여도 화면이 튀지 않는다. */
function viewAnchor() {
  const top = wrap.getBoundingClientRect().top;
  for (const w of document.getElementById('cal').children) {
    const r = w.getBoundingClientRect();
    if (r.bottom > top + 1) return { wk: w.dataset.wk, off: r.top - top };
  }
  return null;
}
function restoreAnchor(a) {
  if (!a) return;
  const el = document.getElementById('cal').querySelector('.week[data-wk="' + a.wk + '"]');
  if (!el) return;
  const top = el.getBoundingClientRect().top - wrap.getBoundingClientRect().top + wrap.scrollTop;
  wrap.scrollTop = Math.max(0, top - a.off);
}

function renderCalendar(keepView) {
  const keep = keepView === false ? null : viewAnchor();
  const target = mode ? byId(mode.id) : null;
  let html = '';
  for (let w = 0; w < weekCount; w++) {
    html += '<div class="week" data-wk="' + ymd(addDays(anchor, w * 7)) + '">';
    for (let i = 0; i < 7; i++) {
      const cur = addDays(anchor, w * 7 + i);
      const d = ymd(cur);
      const dow = cur.getDay();
      const picked = target && mode.type === 'days' && target.days.includes(d);
      const dlPick = target && mode.type === 'deadline' && target.deadline === d;

      let chips = '', flags = '', missed = false;
      for (const p of PSORT) {
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
    html += weekCellHtml(ymd(addDays(anchor, w * 7))) + '</div>';
  }
  document.getElementById('cal').innerHTML = html;
  restoreAnchor(keep);
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
  anchor = addDays(anchor, -12 * 7);
  weekCount += 12;
  renderCalendar();                                  // 앵커 복원이 위치를 맞춰준다
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
  renderCalendar(false);
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
    for (const k of Object.keys(TRACKS)) log[k] = { done: {} };
    const p = { id: uid(), name, color: formColor, totalCuts: cuts, deadline: formDeadline, storyboard: sb, days: [], log };
    state.projects.push(p);
    mode = { type: 'days', id: p.id };
    lastPick = null;
  }
  save();
  document.getElementById('pMask').hidden = true;
  render();                                       // 보고 있던 화면 위치를 그대로 둔다
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
  const rows = PSORT.filter(p => p.days.includes(d));
  const dues = PSORT.filter(p => p.deadline === d);

  let html = rows.length ? rows.map(p => {
    const lines = tracksOf(p).map(t => inputRow(p, t, d)).join('');
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

/* 입력 중 포커스가 날아가지 않도록 안내 문구만 갱신한다 */
function refreshDayGoals() {
  if (dayDate) refreshRows(document.getElementById('dBody'), dayDate);
}

/* 실적을 바꿀 때마다 이번 입력분(delta)과 시각을 남긴다.
   10컷이 들어 있는 날에 20을 넣으면 "+10컷"으로 기록된다. */
function setDone(pid, track, raw, date) {
  const p = byId(pid);
  if (!p) return;
  const d = date || dayDate;
  const lg = p.log[track];
  const before = has(lg.done, d) ? Number(lg.done[d]) || 0 : 0;
  const v = String(raw).trim();
  // 입력값은 "몇 번째 컷까지"이므로 전날까지의 누적을 빼면 그날 한 양이 된다
  const after = v === '' ? 0 : Math.max(0, (parseInt(v, 10) || 0) - prevTotal(p, track, d));

  if (after > before) {
    state.entries.push({ id: uid(), ts: Date.now(), p: pid, t: track, d, delta: after - before });
  } else if (after < before) {
    trimEntries(pid, track, d, before - after);   // 마이너스 대신 최근 기록부터 깎는다
  }
  if (v === '') delete lg.done[d];
  else lg.done[d] = after;

  save();
  render(true);
  refreshDayGoals();
}

/* 줄어든 만큼을 최근 기록부터 거꾸로 깎아 낸다 */
function trimEntries(pid, track, d, amount) {
  const list = state.entries
    .filter(e => e.p === pid && e.t === track && e.d === d)
    .sort((a, b) => b.ts - a.ts);
  for (const e of list) {
    if (amount <= 0) break;
    const cut = Math.min(e.delta, amount);
    e.delta -= cut;
    amount -= cut;
  }
  state.entries = state.entries.filter(e => e.delta > 0);
}

/* 시각이 찍힌 메모 기록 */
function addNote(text, date) {
  const t = String(text).trim();
  if (!t) return null;
  const e = { id: uid(), ts: Date.now(), d: date || tlDate, text: t };
  state.entries.push(e);
  save();
  return e;
}
function editNote(id, text) {
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  const t = String(text).trim();
  if (t) e.text = t;
  else state.entries = state.entries.filter(x => x.id !== id);
  save();
  render();
}
function removeEntry(id) {
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  if (e.text) { state.entries = state.entries.filter(x => x.id !== id); save(); render(); }
  else editEntry(id, 0);
}

/* 기록 한 줄을 고치거나(0이면 삭제) 지운다. 실적 합계도 그만큼 따라 움직인다. */
function editEntry(id, value) {
  const e = state.entries.find(x => x.id === id);
  const p = e && byId(e.p);
  if (!p) return;
  const n = Math.max(0, parseInt(value, 10) || 0);
  if (n === e.delta) return;
  const lg = p.log[e.t];
  const cur = has(lg.done, e.d) ? Number(lg.done[e.d]) || 0 : 0;
  const next = Math.max(0, cur + (n - e.delta));
  if (next === 0) delete lg.done[e.d];
  else lg.done[e.d] = next;
  if (n === 0) state.entries = state.entries.filter(x => x.id !== id);
  else e.delta = n;
  save();
  render();
}

function entriesOf(d) {
  return state.entries.filter(e => e.d === d).sort((a, b) => a.ts - b.ts);
}
function fmtTime(ts) {
  const t = new Date(ts);
  return String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
}
/* 기록별 누적값 — 기록 없이 들어 있던 값(예전 데이터)을 바닥에 깔고 더해 나간다 */
function cumulative(list) {
  const base = {}, run = {}, out = {};
  for (const e of list) {
    if (e.text) continue;                          // 메모는 누적에서 제외
    const k = e.p + '|' + e.t;
    if (base[k] === undefined) {
      const p = byId(e.p);
      const done = p && has(p.log[e.t].done, e.d) ? Number(p.log[e.t].done[e.d]) || 0 : 0;
      const sum = list.filter(x => x.p === e.p && x.t === e.t).reduce((a, x) => a + x.delta, 0);
      base[k] = Math.max(0, done - sum);
      run[k] = base[k];
    }
    run[k] += e.delta;
    out[e.id] = run[k];
  }
  return out;
}

/* ── 캘린더 클릭 동작 ───────────────────── */
function clearDay(p, d) {
  for (const k of Object.keys(TRACKS)) delete p.log[k].done[d];
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

/* 드래그한 날짜를 포함하는 "연달아 붙어 있는" 작업일 묶음 */
function blockOf(p, d) {
  const days = p.days.slice().sort();
  const i = days.indexOf(d);
  if (i < 0) return [d];
  let a = i, b = i;
  while (a > 0 && dayDiff(parseYmd(days[a - 1]), parseYmd(days[a])) === 1) a--;
  while (b < days.length - 1 && dayDiff(parseYmd(days[b]), parseYmd(days[b + 1])) === 1) b++;
  return days.slice(a, b + 1);
}

/* 마감일도 같이 움직여야 하는 이동인지 — 마지막 작업일이 포함된 경우만 */
function movesDeadline(p, src) {
  if (!p.deadline || !p.days.length) return false;
  return src.includes(p.days[p.days.length - 1]);
}

/* 작업일과 그날의 기록을 통째로 delta일 만큼 옮긴다 */
function moveDays(p, src, delta) {
  if (!delta || !src.length) return;
  const shiftDl = movesDeadline(p, src);
  const dest = src.map(d => ymd(addDays(parseYmd(d), delta)));
  const srcSet = new Set(src);
  const days = new Set(p.days.filter(d => !srcSet.has(d)));
  dest.forEach(d => days.add(d));

  for (const k of Object.keys(TRACKS)) {
    const lg = p.log[k];
    const done = {};
    src.forEach((d, i) => {                       // 옮길 기록을 먼저 떠낸다
      if (has(lg.done, d)) done[dest[i]] = lg.done[d];
    });
    for (const d of src) delete lg.done[d];
    Object.assign(lg.done, done);                 // 목적지에 기록이 있었다면 옮긴 쪽이 이긴다
    for (const d of Object.keys(lg.done)) if (!days.has(d)) delete lg.done[d];
  }
  p.days = [...days].sort();
  if (shiftDl) p.deadline = ymd(addDays(parseYmd(p.deadline), delta));
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

/* 사이드바 탭 전환 */
document.getElementById('tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x === b));
  document.getElementById('paneProjects').hidden = b.dataset.tab !== 'projects';
  document.getElementById('paneTimeline').hidden = b.dataset.tab !== 'timeline';
});

document.getElementById('tlPrev').onclick = () => { tlDate = ymd(addDays(parseYmd(tlDate), -1)); renderTimeline(); };
document.getElementById('tlNext').onclick = () => { tlDate = ymd(addDays(parseYmd(tlDate), 1)); renderTimeline(); };
document.getElementById('tlToday').onclick = () => { tlDate = TODAY; renderTimeline(); };
document.getElementById('tlInputs').addEventListener('change', e => {
  const i = e.target;
  if (i.dataset.p) setDone(i.dataset.p, i.dataset.t, i.value, tlDate);
});

/* 기록 수정 · 삭제 */
document.getElementById('tlLog').addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const li = b.closest('.tl-e');
  const id = li.dataset.id;
  const cur = state.entries.find(x => x.id === id);
  if (!cur) return;

  if (b.dataset.act === 'tle-del') {
    const msg = cur.text ? '이 메모를 지울까요?' : '이 기록 ' + num(cur.delta) + '컷을 지울까요?\n작업량 합계에서도 빠집니다.';
    if (confirm(msg)) removeEntry(id);
    return;
  }

  const cell = li.querySelector(cur.text ? '.tl-nt' : '.tl-d');
  if (cell.querySelector('input')) return;
  cell.innerHTML = cur.text
    ? '<input class="tl-edit wide" type="text" value="' + esc(cur.text) + '">'
    : '<input class="tl-edit" type="number" min="0" step="1" value="' + cur.delta + '">';
  const inp = cell.querySelector('input');
  inp.focus();
  inp.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    if (cur.text) editNote(id, inp.value); else editEntry(id, inp.value);
    renderTimeline();
  };
  inp.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') commit();
    else if (ev.key === 'Escape') { done = true; renderTimeline(); }
  });
  inp.addEventListener('blur', commit);
});

document.getElementById('tlNote').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (addNote(e.target.value)) { e.target.value = ''; renderTimeline(); }
});

document.getElementById('sortBar').addEventListener('click', e => {
  const b = e.target.closest('[data-sort]');
  if (!b || b.dataset.sort === state.sort) return;
  state.sort = b.dataset.sort;
  save();
  render();
});

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
  if (act === 'toggle') {
    if (openCards.has(id)) openCards.delete(id); else openCards.add(id);
    renderSidebar();
    return;
  }
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

/* ── 드래그로 작업일 옮기기 ─────────────── */
let drag = null, dragPaint = '';
const cal = document.getElementById('cal');

function paintDrop(dates, dl) {
  const key = dates.join() + '|' + (dl || '');
  if (key === dragPaint) return;
  dragPaint = key;
  cal.querySelectorAll('.cell.drop, .cell.drop-dl').forEach(c => c.classList.remove('drop', 'drop-dl'));
  for (const d of dates) {
    const c = cal.querySelector('.cell[data-date="' + d + '"]');
    if (c) c.classList.add('drop');
  }
  if (dl) {
    const c = cal.querySelector('.cell[data-date="' + dl + '"]');
    if (c) c.classList.add('drop-dl');
  }
}
function clearDrag() {
  cal.querySelectorAll('.cell.drop, .cell.drop-dl').forEach(c => c.classList.remove('drop', 'drop-dl'));
  cal.querySelectorAll('.chip.dragging').forEach(c => c.classList.remove('dragging'));
  drag = null;
  dragPaint = '';
}

cal.addEventListener('dragstart', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;                              // 체크리스트 드래그는 아래에서 따로 처리
  if (mode) { e.preventDefault(); return; }
  const p = byId(chip.dataset.p);
  const d = chip.closest('.cell').dataset.date;
  if (!p) { e.preventDefault(); return; }
  drag = { pid: p.id, date: d, block: blockOf(p, d) };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', p.id);   // Firefox 대응
  chip.classList.add('dragging');
});

cal.addEventListener('dragover', e => {
  if (!drag) return;
  const cell = e.target.closest('.cell');
  if (!cell) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const delta = dayDiff(parseYmd(drag.date), parseYmd(cell.dataset.date));
  const src = e.altKey ? [drag.date] : drag.block;
  const p = byId(drag.pid);
  const dl = p && movesDeadline(p, src) ? ymd(addDays(parseYmd(p.deadline), delta)) : '';
  paintDrop(src.map(d => ymd(addDays(parseYmd(d), delta))), dl);
});

cal.addEventListener('drop', e => {
  if (!drag) return;
  const cell = e.target.closest('.cell');
  if (!cell) return;
  e.preventDefault();
  const p = byId(drag.pid);
  const delta = dayDiff(parseYmd(drag.date), parseYmd(cell.dataset.date));
  const src = e.altKey ? [drag.date] : drag.block;
  clearDrag();
  if (p && delta) { moveDays(p, src, delta); save(); render(); }
});

cal.addEventListener('dragend', clearDrag);

/* ── 체크리스트 조작 (전체 렌더 없이 해당 칸만 갱신) ── */
cal.addEventListener('change', e => {
  if (e.target.type !== 'checkbox') return;
  const li = e.target.closest('.wc-i');
  if (!li) return;                                // 빈 줄의 네모는 표시용
  const wk = e.target.closest('.wcell').dataset.week;
  const it = (state.weeks[wk] || []).find(x => x.id === li.dataset.id);
  if (!it) return;
  it.d = e.target.checked;
  li.classList.toggle('done', it.d);
  save();
});

cal.addEventListener('keydown', e => {
  if (e.target.classList.contains('wc-add') && e.key === 'Enter') {
    const t = e.target.value.trim();
    if (!t) return;
    const wk = e.target.dataset.week;
    const it = { id: uid(), t, d: false };
    weekItems(wk).push(it);
    save();
    e.target.closest('.wcell').querySelector('.wc-list').insertAdjacentHTML('beforeend', itemHtml(it));
    e.target.value = '';
  } else if (e.target.classList.contains('wc-t') && e.key === 'Enter') {
    e.preventDefault();
    e.target.blur();
  }
});

cal.addEventListener('click', e => {
  const blank = e.target.closest('.wcell');       // 빈 곳이나 빈 줄을 누르면 바로 입력
  if (blank && (e.target === blank || e.target.closest('.wc-new'))) {
    if (e.target.tagName !== 'INPUT' || e.target.type === 'checkbox') {
      e.preventDefault();
      blank.querySelector('.wc-add').focus();
    }
    return;
  }
  const x = e.target.closest('.wc-x');
  if (!x) return;
  const li = x.closest('.wc-i');
  const wk = x.closest('.wcell').dataset.week;
  state.weeks[wk] = (state.weeks[wk] || []).filter(i => i.id !== li.dataset.id);
  pruneWeek(wk);
  save();
  li.remove();
});

cal.addEventListener('focusout', e => {
  if (!e.target.classList || !e.target.classList.contains('wc-t')) return;
  const li = e.target.closest('.wc-i');
  const wk = e.target.closest('.wcell').dataset.week;
  const arr = state.weeks[wk] || [];
  const it = arr.find(x => x.id === li.dataset.id);
  if (!it) return;
  const v = e.target.textContent.trim();
  if (!v) {                                       // 내용을 지우면 항목 삭제
    state.weeks[wk] = arr.filter(x => x.id !== it.id);
    pruneWeek(wk);
    save();
    li.remove();
    return;
  }
  it.t = v;
  e.target.textContent = v;
  save();
});

/* ── 체크리스트 항목 드래그 (순서 바꾸기 · 다른 주로 옮기기) ── */
let cdrag = null;

/* 손잡이를 눌렀을 때만 끌 수 있게 한다 (글자 편집과 충돌 방지) */
cal.addEventListener('mousedown', e => {
  const g = e.target.closest('.wc-g');
  const li = g && g.closest('.wc-i');
  if (li) li.draggable = true;
});
document.addEventListener('mouseup', () => {
  cal.querySelectorAll('.wc-i[draggable="true"]').forEach(li => li.removeAttribute('draggable'));
});

function endCDrag() {
  cal.querySelectorAll('.cdragging').forEach(el => el.classList.remove('cdragging'));
  cal.querySelectorAll('.wcell.cdrop').forEach(el => el.classList.remove('cdrop'));
  cal.querySelectorAll('.wc-i[draggable="true"]').forEach(li => li.removeAttribute('draggable'));
}

cal.addEventListener('dragstart', e => {
  const li = e.target.closest('.wc-i');
  if (!li || !li.draggable) return;
  cdrag = { wk: li.closest('.wcell').dataset.week, id: li.dataset.id };
  li.classList.add('cdragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', li.dataset.id);
});

cal.addEventListener('dragover', e => {
  if (!cdrag) return;
  const cell = e.target.closest('.wcell');
  if (!cell) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  cal.querySelectorAll('.wcell.cdrop').forEach(c => { if (c !== cell) c.classList.remove('cdrop'); });
  cell.classList.add('cdrop');

  const el = cal.querySelector('.wc-i.cdragging');
  const list = cell.querySelector('.wc-list');
  let before = null;                              // 커서 위쪽 절반이면 그 항목 앞에 끼운다
  for (const c of list.querySelectorAll('.wc-i:not(.cdragging)')) {
    const r = c.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) { before = c; break; }
  }
  if (before) list.insertBefore(el, before); else list.appendChild(el);
});

cal.addEventListener('drop', e => {
  if (!cdrag) return;
  const cell = e.target.closest('.wcell');
  const el = cal.querySelector('.wc-i.cdragging');
  if (!cell || !el) { cdrag = null; endCDrag(); renderCalendar(); return; }
  e.preventDefault();
  const destWk = el.closest('.wcell').dataset.week;
  const idx = [...el.closest('.wcell').querySelectorAll('.wc-i')].indexOf(el);

  const src = state.weeks[cdrag.wk] || [];
  const i = src.findIndex(x => x.id === cdrag.id);
  const item = i >= 0 ? src.splice(i, 1)[0] : null;
  pruneWeek(cdrag.wk);
  if (item) weekItems(destWk).splice(idx, 0, item);
  cdrag = null;
  save();
  endCDrag();
  renderCalendar();
});

cal.addEventListener('dragend', () => {
  const cancelled = !!cdrag;
  cdrag = null;
  endCDrag();
  if (cancelled) renderCalendar();                // 취소되면 원래 순서로 되돌린다
});

/* ── 백업 내보내기 / 불러오기 ───────────── */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '웹툰작업량_백업_' + TODAY + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importData(file) {
  const r = new FileReader();
  r.onload = () => {
    let obj;
    try { obj = JSON.parse(r.result); } catch (err) { obj = null; }
    if (!obj || !Array.isArray(obj.projects)) {
      alert('백업 파일을 읽을 수 없습니다.\n이 앱에서 내보낸 .json 파일이 맞는지 확인해 주세요.');
      return;
    }
    const now = state.projects.length;
    if (!confirm('백업 파일을 불러옵니다.\n\n' +
      '· 불러올 프로젝트: ' + obj.projects.length + '개\n' +
      '· 지금 있는 프로젝트: ' + now + '개 (모두 지워집니다)\n\n' +
      '계속할까요?')) return;
    localStorage.setItem(KEY, JSON.stringify(obj));
    state = load();
    render();
    scrollToDate(TODAY);
    alert('불러오기가 끝났습니다. 프로젝트 ' + state.projects.length + '개를 복원했습니다.');
  };
  r.onerror = () => alert('파일을 여는 데 실패했습니다.');
  r.readAsText(file);
}

document.getElementById('exportBtn').onclick = exportData;
document.getElementById('importBtn').onclick = () => document.getElementById('importFile').click();
document.getElementById('importFile').addEventListener('change', e => {
  const f = e.target.files[0];
  if (f) importData(f);
  e.target.value = '';                            // 같은 파일을 다시 골라도 동작하도록
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

/* 캘린더 스크롤바 폭을 요일 헤더 여백에 반영 */
function syncGutter() {
  document.documentElement.style.setProperty('--sbw', (wrap.offsetWidth - wrap.clientWidth) + 'px');
}
window.addEventListener('resize', syncGutter);

render();
syncGutter();
scrollToDate(TODAY);
