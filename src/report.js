import { Chess } from '../vendor/chess.js';
import { Engine } from './engine.js';
import { loadSettings } from './settings.js';
import {
  replay,
  evaluateMove,
  whiteWinPercent,
  formatScore,
  uciLineToSan,
  gameAccuracy,
  classifyMove,
  CLASSES,
} from './analysis.js';
import { explainMistake, explainBest } from './explain.js';
import {
  openingInfo,
  phaseOf,
  phaseStats,
  PHASES,
  goodMoves,
  mistakeStats,
  suggestions,
  buildStory,
} from './insights.js';

const COUNTED = ['best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'blunder'];
const BAD = ['inaccuracy', 'mistake', 'blunder'];
const LESSON_LOSS = 8; // 自己這步勝率掉超過這個值，才算一課
const OPP_MISTAKE_LOSS = 10; // 對手這步勝率掉超過這個值，才算「可以利用的機會」
const PRACTICE_OK_LOSS = 3; // 練習時，比最佳著法只差這麼多也算答對
const ANALYSIS_VERSION = 2; // 分析格式改變時遞增，讓舊的快取重新分析
const $ = (sel) => document.querySelector(sel);

const id = new URLSearchParams(location.search).get('id');
const stored = (await chrome.storage.local.get(id))[id];
if (!stored) {
  $('.progress-text').textContent = '找不到這盤棋的資料，請從 chess.com 頁面重新開啟賽後總結。';
  throw new Error('no game');
}

const game = stored;
const settings = await loadSettings();
const { fens, moves } = replay(game.sans);
let me = game.me || 'w';
let sel = moves.length;
let flipped = me === 'b';
let practice = null;
let explore = null; // 試走模式：{ base, fens, evals, steps, busy, showBest }
let picked = null; // 目前選取（或拖曳中）的棋子所在格
let engine = null;
const PIECE_SETS = ['papercut', 'spatial', 'cburnett'];
const pieceSet = () => (PIECE_SETS.includes(settings.pieceSet) ? settings.pieceSet : 'papercut');

$('#title').textContent = `${game.white} vs ${game.black}`;
$('#sub').textContent = `${game.result} · ${moves.length} 個半步 · ${new Date(game.date).toLocaleString()}`;
document.title = `賽後總結：${game.white} vs ${game.black}`;

// ---------- 分析 ----------

function getEngine() {
  if (!engine) engine = new Engine();
  return engine;
}

async function analyseGame() {
  const a = game.analysis;
  if (a?.v === ANALYSIS_VERSION && a.depth === settings.reportDepth && a.evals.length === fens.length) {
    return game.analysis.evals;
  }
  const evals = [];
  for (let i = 0; i < fens.length; i++) {
    $('.progress-text').textContent = `Stockfish 分析中… ${i}/${fens.length - 1}（深度 ${settings.reportDepth}）`;
    $('.progress-bar').style.width = `${(i / (fens.length - 1 || 1)) * 100}%`;
    // 多算第二好的走法，用來找「唯一好棋」
    evals.push(await getEngine().analyse(fens[i], { depth: settings.reportDepth, multipv: 2 }));
  }
  game.analysis = { v: ANALYSIS_VERSION, depth: settings.reportDepth, evals };
  await chrome.storage.local.set({ [id]: game });
  return evals;
}

const openingTable = await fetch(chrome.runtime.getURL('vendor/openings.json')).then((r) => r.json());
const opening = openingInfo(fens, openingTable);
const evals = await analyseGame();
const winW = evals.map((e) => whiteWinPercent(e.score));
const results = moves.map((move, i) => {
  const ev = evaluateMove({ before: evals[i], after: evals[i + 1], move, ply: i + 1 });
  ev.bestPv = uciLineToSan(fens[i], evals[i].pv.length ? evals[i].pv : [evals[i].bestmove || ''], 5);
  // 開局庫裡的著法標成「開局」；不在庫裡的就照勝率損失重新分類。
  if (opening.bookPlies.has(ev.ply)) {
    if (!BAD.includes(ev.cls)) ev.cls = 'book';
  } else if (ev.cls === 'book') {
    ev.cls = classifyMove(ev.loss, ev.uci === ev.bestUci, Infinity);
  }
  const reasons = BAD.includes(ev.cls)
    ? explainMistake({ fenBefore: fens[i], uci: ev.uci, after: evals[i + 1], mover: ev.color })
    : [];
  ev.why = reasons.map((x) => x.text);
  ev.whyTypes = reasons.map((x) => x.type);
  ev.better =
    ev.cls !== 'best'
      ? explainBest({ fenBefore: fens[i], before: evals[i], mover: ev.color, playedAfter: evals[i + 1].score })
      : null;
  return ev;
});
// 錯失良機：對手剛犯了大錯，你這步卻沒有把握住。
results.forEach((r, i) => {
  const prev = results[i - 1];
  r.missed = !!prev && prev.loss >= OPP_MISTAKE_LOSS && r.loss >= LESSON_LOSS;
});

const phases = phaseOf(results, fens);

$('#progress').hidden = true;
$('#main').hidden = false;
$('#copy').disabled = false;
$('#pgn').disabled = false;

// ---------- 共用小工具 ----------

const sideName = (c) => (c === 'w' ? '白方' : '黑方');
const playerName = (c) => (c === 'w' ? game.white : game.black);
const moverWin = (winWhite, c) => (c === 'w' ? winWhite : 100 - winWhite);

function moveLabel(r) {
  return `${Math.ceil(r.ply / 2)}${r.color === 'w' ? '.' : '...'} ${r.san}`;
}

function badge(cls) {
  const c = CLASSES[cls];
  return `<span class="badge" style="background:${c.color}">${c.label}</span>`;
}

const missedTag = '<span class="tag">錯失良機</span>';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function lessonList() {
  return results
    .filter((r) => r.color === me && r.loss >= LESSON_LOSS)
    .sort((a, b) => b.loss - a.loss)
    .slice(0, 3)
    .sort((a, b) => a.ply - b.ply);
}

// ---------- 準確率卡片 ----------

function sideStats(color) {
  const mine = results.filter((r) => r.color === color);
  const counts = Object.fromEntries(COUNTED.map((c) => [c, 0]));
  mine.forEach((r) => counts[r.cls]++);
  return { acc: gameAccuracy(mine.map((r) => r.accuracy)), counts, missed: mine.filter((r) => r.missed).length };
}

function renderCards() {
  const card = (color) => {
    const s = sideStats(color);
    const rows = COUNTED.map(
      (c) => `<tr><td><span class="cls-dot" style="background:${CLASSES[c].color}"></span>${CLASSES[c].label}</td><td>${s.counts[c]}</td></tr>`
    ).join('');
    return `<div class="card ${color === me ? 'mine' : ''}">
      <div class="who"><span class="swatch" style="background:${color === 'w' ? '#fff' : '#1a1a1a'}"></span>
        ${escapeHtml(playerName(color))}（${color === 'w' ? '白' : '黑'}）${color === me ? '<span class="tag you">你</span>' : ''}</div>
      <div class="acc">${s.acc === null ? '–' : s.acc.toFixed(1)}<small> 準確率</small></div>
      <table>${rows}<tr><td><span class="cls-dot" style="background:transparent;border:2px solid #8a6fd1"></span>錯失良機</td><td>${s.missed}</td></tr></table></div>`;
  };
  $('#cards').innerHTML = card(me) + card(me === 'w' ? 'b' : 'w');
}

// ---------- 對局故事 ----------

function renderStory() {
  const lines = buildStory({ results, winW, evals, me, opening, result: game.result });
  $('#story').innerHTML = lines.map((t) => `<p>${escapeHtml(t)}</p>`).join('');
}

// ---------- 三階段表現 ----------

function renderPhases() {
  const mine = phaseStats(results, phases, me);
  const theirs = phaseStats(results, phases, me === 'w' ? 'b' : 'w');
  $('#phases').innerHTML = Object.entries(PHASES)
    .map(([key, name]) => {
      const s = mine.stats[key];
      const o = theirs.stats[key];
      if (!s.n) return `<div class="phase empty"><div class="phase-name">${name}</div><div class="muted">這盤沒有走到${name}</div></div>`;
      const weakest = mine.weakest === key;
      return `<div class="phase ${weakest ? 'weak' : ''}" ${s.worst ? `data-ply="${s.worst.ply}"` : ''}>
        <div class="phase-name">${name} ${weakest ? '<span class="tag warn">最需要加強</span>' : ''}</div>
        <div class="phase-acc">${s.acc.toFixed(0)}<small> 準確率</small></div>
        <div class="muted small">你走了 ${s.n} 步，${s.bad ? `有 ${s.bad} 步不精確以上` : '沒有明顯失誤'}</div>
        <div class="muted small">對手：${o.acc === null ? '–' : o.acc.toFixed(0)}</div>
      </div>`;
    })
    .join('');
}

$('#phases').addEventListener('click', (e) => {
  const el = e.target.closest('[data-ply]');
  if (el) {
    leaveModes();
    select(Number(el.dataset.ply));
  }
});

// ---------- 你下得好的地方 ----------

function renderGoods() {
  const goods = goodMoves({ results, evals, fens, me, oppMistakeLoss: OPP_MISTAKE_LOSS });
  const icon = { only: '🎯', punish: '⚡', sac: '💎' };
  $('#goods').innerHTML = goods.length
    ? goods
        .map(
          (g) => `<li data-ply="${g.ply}"><span class="good-icon">${icon[g.kind]}</span>
            <div><b>${escapeHtml(moveLabel(results[g.ply - 1]))}</b> <span class="tag good">${g.title}</span>
            <div class="muted small">${escapeHtml(g.text)}</div></div></li>`
        )
        .join('')
    : '<li class="muted">這盤沒有特別突出的好棋。下次試著多留意對手的失誤，抓住了就會出現在這裡！</li>';
}

$('#goods').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-ply]');
  if (li) {
    leaveModes();
    select(Number(li.dataset.ply));
  }
});

// ---------- 錯誤統計與練習建議 ----------

function renderStats() {
  const st = mistakeStats(results, me);
  const chips = (plies) =>
    plies.map((p) => `<button class="chip" data-ply="${p}">${escapeHtml(moveLabel(results[p - 1]))}</button>`).join('');
  const block = (title, list, empty) =>
    `<h3>${title}</h3>` +
    (list.length
      ? `<ul class="stat-list">${list
          .map((x) => `<li><span class="stat-name">${x.name}</span><span class="stat-count">${x.plies.length} 次</span><div>${chips(x.plies)}</div></li>`)
          .join('')}</ul>`
      : `<p class="muted small">${empty}</p>`);
  $('#stats').innerHTML =
    block('你犯的錯', st.types, '這盤沒有不精確以上的錯誤。') + block('你漏看的機會', st.missed, '這盤沒有漏看明顯的戰術。');

  const sug = suggestions({ stats: st, phase: phaseStats(results, phases, me), opening });
  $('#suggest').innerHTML = sug.length
    ? sug
        .map(
          (x) => `<a class="suggest" href="${x.url}" target="_blank" rel="noopener">
            <b>${escapeHtml(x.title)} ↗</b><span class="muted small">${escapeHtml(x.why)}</span></a>`
        )
        .join('')
    : '<p class="muted small">這盤下得很穩，繼續保持！</p>';
}

$('#stats').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip[data-ply]');
  if (chip) {
    leaveModes();
    select(Number(chip.dataset.ply));
    $('#board-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

// ---------- 本局三課 ----------

function renderLessons() {
  const lessons = lessonList();
  if (!lessons.length) {
    $('#lessons').innerHTML = `<p class="good-news">這盤你沒有勝率掉超過 ${LESSON_LOSS}% 的失誤，下得很穩，做得好！</p>`;
    return;
  }
  $('#lessons').innerHTML = lessons
    .map((r, i) => {
      const prev = results[r.ply - 2];
      const reasons = r.missed
        ? [`對手上一步 ${prev.san} 下錯了，這是反擊的機會，但你沒有抓住。`, r.better?.hints[0]].filter(Boolean)
        : [...r.why];
      if (!reasons.length) reasons.push(`這步讓你的勝率掉了 ${r.loss.toFixed(0)}%。`);
      return `<article class="lesson">
        <div class="lesson-head">
          <span class="lesson-num">第 ${i + 1} 課</span>
          <b>${escapeHtml(moveLabel(r))}</b> ${badge(r.cls)} ${r.missed ? missedTag : ''}
          <span class="muted small">你的勝率 ${moverWin(r.winBeforeW, me).toFixed(0)}% → ${moverWin(r.winAfterW, me).toFixed(0)}%</span>
        </div>
        <ul class="why">${reasons.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
        <div class="lesson-actions">
          <button class="primary" data-practice="${r.ply}">🧩 自己找找看</button>
          <button data-show="${r.ply}">直接看答案</button>
        </div>
      </article>`;
    })
    .join('');
}

$('#lessons').addEventListener('click', (e) => {
  const p = e.target.closest('[data-practice]');
  const s = e.target.closest('[data-show]');
  if (p) startPractice(Number(p.dataset.practice));
  if (s) {
    leaveModes();
    select(Number(s.dataset.show));
    $('#board-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});

// ---------- 對手的失誤 ----------

function renderOpp() {
  const theirs = results.filter((r) => r.color !== me && r.loss >= OPP_MISTAKE_LOSS);
  if (!theirs.length) {
    $('#opp').innerHTML = '<li class="muted">對手這盤沒有明顯的失誤。</li>';
    return;
  }
  $('#opp').innerHTML = theirs
    .map((r) => {
      const reply = results[r.ply];
      let verdict = '<span class="muted">（對局在這裡結束）</span>';
      if (reply) {
        verdict =
          reply.loss < 5
            ? '<span class="ok">✓ 你抓住了</span>'
            : `<span class="bad">✗ 你錯過了</span> <button class="small-btn" data-practice="${reply.ply}">🧩 練習懲罰這步</button>`;
      }
      return `<li data-ply="${r.ply}"><b>${escapeHtml(moveLabel(r))}</b> ${badge(r.cls)}
        <span class="muted small">對手勝率 −${r.loss.toFixed(0)}%</span> ${verdict}</li>`;
    })
    .join('');
}

$('#opp').addEventListener('click', (e) => {
  const p = e.target.closest('[data-practice]');
  if (p) return startPractice(Number(p.dataset.practice));
  const li = e.target.closest('li[data-ply]');
  if (li) {
    leaveModes();
    select(Number(li.dataset.ply));
  }
});

// ---------- 勝率走勢圖 ----------

function renderChart() {
  const W = 1000;
  const H = 180;
  const n = winW.length - 1 || 1;
  const x = (i) => (i / n) * W;
  const y = (p) => 6 + (1 - p / 100) * (H - 12);
  const pts = winW.map((p, i) => `${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  // 階段分界：某一步的階段和前一步不同，就在那步之前畫一條線
  const phaseLines = [];
  phases.forEach((p, i) => {
    if (i > 0 && p !== phases[i - 1]) phaseLines.push(i);
  });
  const starts = [0, ...phaseLines];
  const phaseLabels = starts
    .map((i) => `<span class="phase-label" style="left:${(x(i) / W) * 100}%">${PHASES[phases[i]]}</span>`)
    .join('');
  const marks = results
    .filter((r) => BAD.includes(r.cls))
    .map(
      (r) =>
        `<circle cx="${x(r.ply)}" cy="${y(winW[r.ply])}" r="${r.color === me ? 6 : 4}" fill="${CLASSES[r.cls].color}" stroke="var(--chart-bg)" stroke-width="2" vector-effect="non-scaling-stroke"/>`
    )
    .join('');
  $('#chart').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="白方勝率走勢">
      <rect width="${W}" height="${H}" fill="var(--chart-bg)"/>
      <polygon points="0,${H} ${pts} ${W},${H}" fill="var(--chart-fill)"/>
      <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="#8a8783" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>
      <line class="cursor" x1="${x(sel)}" x2="${x(sel)}" y1="0" y2="${H}" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
      <line class="hover" x1="-10" x2="-10" y1="0" y2="${H}" stroke="#8a8783" vector-effect="non-scaling-stroke"/>
      ${phaseLines.map((i) => `<line x1="${x(i)}" x2="${x(i)}" y1="0" y2="${H}" stroke="#8a8783" stroke-width="1" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>`).join('')}
      ${marks}
    </svg>
    ${phaseLabels}
    <div class="tooltip" hidden></div>`;

  const svg = $('#chart svg');
  const tip = $('#chart .tooltip');
  const plyAt = (ev) => {
    const r = svg.getBoundingClientRect();
    return Math.max(0, Math.min(winW.length - 1, Math.round(((ev.clientX - r.left) / r.width) * n)));
  };
  svg.addEventListener('mousemove', (ev) => {
    const i = plyAt(ev);
    const r = svg.getBoundingClientRect();
    svg.querySelector('.hover').setAttribute('x1', x(i));
    svg.querySelector('.hover').setAttribute('x2', x(i));
    tip.hidden = false;
    tip.style.left = `${(x(i) / W) * r.width}px`;
    tip.style.top = `${(y(winW[i]) / H) * r.height}px`;
    tip.textContent = `${i === 0 ? '開局' : moveLabel(results[i - 1])} · 白 ${winW[i].toFixed(0)}% · ${formatScore(evals[i].score)}`;
  });
  svg.addEventListener('mouseleave', () => {
    tip.hidden = true;
    svg.querySelector('.hover').setAttribute('x1', -10);
    svg.querySelector('.hover').setAttribute('x2', -10);
  });
  svg.addEventListener('click', (ev) => {
    leaveModes();
    select(plyAt(ev));
  });
}

// ---------- 棋盤 ----------

// opts: { fen, highlight: [sq], selected, targets: [sq], arrow: {uci, color} }
function drawBoard({ fen, highlight = [], selected = null, targets = [], arrow = null }) {
  const rows = fen.split(' ')[0].split('/');
  const grid = rows.map((row) => {
    const out = [];
    for (const ch of row) {
      if (/\d/.test(ch)) for (let k = 0; k < Number(ch); k++) out.push(null);
      else out.push(ch);
    }
    return out;
  });
  let html = '';
  for (let vr = 0; vr < 8; vr++) {
    for (let vf = 0; vf < 8; vf++) {
      const r = flipped ? 7 - vr : vr;
      const f = flipped ? 7 - vf : vf;
      const sq = String.fromCharCode(97 + f) + (8 - r);
      const p = grid[r][f];
      const cls = [
        'sq',
        (r + f) % 2 === 0 ? 'l' : 'd',
        highlight.includes(sq) ? 'hl' : '',
        selected === sq ? 'sel' : '',
        targets.includes(sq) ? (p ? 'cap' : 'dot') : '',
      ].join(' ');
      const coordF = vr === 7 ? `<span class="coord f">${sq[0]}</span>` : '';
      const coordR = vf === 0 ? `<span class="coord r">${sq[1]}</span>` : '';
      const piece = p
        ? `<img class="pc" src="../pieces/${pieceSet()}/${p === p.toUpperCase() ? 'w' : 'b'}${p.toUpperCase()}.svg" alt="${p}" draggable="false">`
        : '';
      html += `<div class="${cls}" data-sq="${sq}">${coordR}${coordF}${piece}</div>`;
    }
  }
  if (arrow) html += arrowSvg(arrow.uci, arrow.color);
  $('#board').innerHTML = html;
  $('#board').classList.toggle('interactive', !!boardFen());
}

function arrowSvg(uci, color) {
  const c = (sq) => {
    const f = sq.charCodeAt(0) - 97;
    const r = Number(sq[1]) - 1;
    return [(flipped ? 7 - f : f) * 12.5 + 6.25, (flipped ? r : 7 - r) * 12.5 + 6.25];
  };
  const [x1, y1] = c(uci.slice(0, 2));
  const [x2, y2] = c(uci.slice(2, 4));
  const len = Math.hypot(x2 - x1, y2 - y1);
  const ex = x2 - ((x2 - x1) / len) * 2.4;
  const ey = y2 - ((y2 - y1) / len) * 2.4;
  return `<svg viewBox="0 0 100 100"><defs><marker id="ah" markerWidth="3" markerHeight="3" refX="1.2" refY="1.5" orient="auto">
    <path d="M0,0 L3,1.5 L0,3 z" fill="${color}"/></marker></defs>
    <line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke="${color}" stroke-opacity="0.85" stroke-width="2.2" stroke-linecap="round" marker-end="url(#ah)"/></svg>`;
}

function targetsOf(fen) {
  return picked ? new Chess(fen).moves({ square: picked, verbose: true }).map((m) => m.to) : [];
}

function renderPosition() {
  if (practice) return renderPractice();
  if (explore) return renderExplore();
  const played = sel > 0 ? results[sel - 1] : null;
  const showBetter = played && played.better && !['best', 'book'].includes(played.cls);
  drawBoard({
    fen: fens[sel],
    highlight: played ? [played.uci.slice(0, 2), played.uci.slice(2, 4)] : [],
    selected: picked,
    targets: targetsOf(fens[sel]),
    arrow: !picked && showBetter && played.bestUci ? { uci: played.bestUci, color: '#3ba55d' } : null,
  });

  $('#pos-title').textContent = played ? moveLabel(played) : '起始局面';
  const info = $('#pos-info');
  const tryHint = '<div class="muted small try-hint">💡 可以直接在棋盤上拖曳棋子，試走其他下法。</div>';
  if (!played) {
    info.innerHTML = `<div class="line">白方勝率 ${winW[0].toFixed(0)}%</div>${tryHint}`;
    return;
  }
  let html = `<div class="line">${badge(played.cls)} ${played.missed ? missedTag : ''}
    ${sideName(played.color)}勝率 ${moverWin(played.winBeforeW, played.color).toFixed(0)}% → ${moverWin(played.winAfterW, played.color).toFixed(0)}%
    <span class="muted">（評分 ${formatScore(evals[sel].score)}）</span></div>`;
  if (played.why.length) {
    html += `<ul class="why">${played.why.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`;
  }
  if (showBetter) {
    html += betterHtml(played.better);
  }
  info.innerHTML = html + tryHint;
}

// 「更好的著法」區塊：著法、為什麼好（最多三點）、接下來的變化。
function betterHtml(better) {
  return `<div class="better">
    <div class="line"><span class="legend-arrow" style="background:#3ba55d"></span>更好的著法：<b>${escapeHtml(better.san)}</b>　為什麼比較好：</div>
    <ul class="why">${better.reasons.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
    <div class="muted small">接下來的變化：${escapeHtml(better.line)}</div>
  </div>`;
}

// ---------- 練習模式 ----------

function startPractice(ply) {
  const r = results[ply - 1];
  if (!r || !r.better) return;
  flipped = r.color === 'b';
  explore = null;
  picked = null;
  practice = { ply, r, hints: 0, solved: false, busy: false, feedback: null };
  sel = ply - 1;
  updateCursor();
  renderPractice();
  $('#board-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPractice() {
  const { ply, r, solved, feedback, hints } = practice;
  const fen = fens[ply - 1];
  const prev = results[ply - 2];
  drawBoard({
    fen: solved ? practice.solvedFen : fen,
    highlight: solved ? [practice.solvedUci.slice(0, 2), practice.solvedUci.slice(2, 4)] : prev ? [prev.uci.slice(0, 2), prev.uci.slice(2, 4)] : [],
    selected: solved ? null : picked,
    targets: solved ? [] : targetsOf(fen),
    arrow: solved && practice.showAnswerArrow ? { uci: r.bestUci, color: '#3ba55d' } : null,
  });

  $('#pos-title').textContent = `🧩 練習：${Math.ceil(ply / 2)}${r.color === 'w' ? '.' : '...'} 輪到${sideName(r.color)}`;
  const intro = r.missed
    ? `對手上一步 ${prev.san} 下錯了！找出懲罰他的走法。`
    : `你實戰下的是 ${r.san}，但這裡有更好的走法，找找看。`;
  const lessons = lessonList();
  const idx = lessons.findIndex((l) => l.ply === ply);
  const next = idx >= 0 ? lessons[idx + 1] : null;

  let html = `<div class="practice">
    <div class="line">${escapeHtml(intro)} <span class="muted small">拖曳棋子，或點棋子再點目的地。</span></div>`;
  if (feedback) html += `<div class="feedback ${feedback.kind}">${escapeHtml(feedback.text)}</div>`;
  if (solved) html += betterHtml(r.better);
  if (hints && !solved) {
    html += `<ol class="hints">${r.better.hints.slice(0, hints).map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ol>`;
  }
  html += '<div class="lesson-actions">';
  if (!solved) {
    html += `<button data-act="hint" ${hints >= 2 ? 'disabled' : ''}>💡 提示（${hints}/2）</button>
      <button data-act="answer">看答案</button>`;
  }
  if (solved && next) html += `<button class="primary" data-act="next" data-ply="${next.ply}">下一課 →</button>`;
  html += '<button data-act="exit">結束練習</button></div></div>';
  $('#pos-info').innerHTML = html;
}

$('#pos-info').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || !practice) return;
  const act = b.dataset.act;
  if (act === 'hint') practice.hints = Math.min(2, practice.hints + 1);
  if (act === 'answer') solve(practice.r.bestUci, { kind: 'info', text: `答案是 ${practice.r.better.san}。` }, true);
  if (act === 'next') return startPractice(Number(b.dataset.ply));
  if (act === 'exit') {
    const ply = practice.ply;
    leaveModes();
    return select(ply);
  }
  renderPractice();
});

// ---------- 棋盤操作：拖曳或點擊 ----------

// 目前可以操作的局面；不能操作時回傳 null。
function boardFen() {
  if (practice) return practice.solved || practice.busy ? null : fens[practice.ply - 1];
  if (explore) return explore.busy ? null : explore.fens.at(-1);
  return fens[sel];
}

function rerender() {
  if (practice) renderPractice();
  else renderPosition();
}

function tryMove(from, to) {
  const fen = boardFen();
  if (!fen || !from) return false;
  const legal = new Chess(fen).moves({ square: from, verbose: true }).find((m) => m.to === to);
  if (!legal) return false;
  const uci = from + to + (legal.promotion ? 'q' : '');
  picked = null;
  if (practice) checkAnswer(uci, legal.san);
  else exploreMove(legal, uci);
  return true;
}

let drag = null;

$('#board').addEventListener('pointerdown', (e) => {
  const fen = boardFen();
  const cell = e.target.closest('[data-sq]');
  if (!fen || !cell || e.button !== 0) return;
  const sq = cell.dataset.sq;
  const chess = new Chess(fen);
  const piece = chess.get(sq);
  if (piece && piece.color === chess.turn()) {
    e.preventDefault();
    const wasPicked = picked === sq;
    picked = sq;
    rerender();
    const img = $(`#board [data-sq="${sq}"] .pc`);
    const rect = img.getBoundingClientRect();
    const ghost = img.cloneNode();
    ghost.className = 'pc-ghost';
    ghost.style.width = ghost.style.height = `${rect.width}px`;
    ghost.style.left = `${e.clientX - rect.width / 2}px`;
    ghost.style.top = `${e.clientY - rect.height / 2}px`;
    document.body.append(ghost);
    img.classList.add('lifted');
    drag = { from: sq, ghost, size: rect.width, wasPicked, x0: e.clientX, y0: e.clientY, moved: false };
    $('#board').setPointerCapture(e.pointerId);
  } else if (picked) {
    drag = { target: sq };
  }
});

$('#board').addEventListener('pointermove', (e) => {
  if (!drag?.ghost) return;
  drag.ghost.style.left = `${e.clientX - drag.size / 2}px`;
  drag.ghost.style.top = `${e.clientY - drag.size / 2}px`;
  if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 4) drag.moved = true;
});

function endDrag(e, cancelled = false) {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.ghost) {
    d.ghost.remove();
    const to = cancelled ? null : document.elementFromPoint(e.clientX, e.clientY)?.closest('#board [data-sq]')?.dataset.sq;
    if (to && to !== d.from && tryMove(d.from, to)) return;
    // 拖到不合法的格子就放回原位；原地第二次點同一個子則取消選取
    if (d.moved || d.wasPicked) picked = null;
    return rerender();
  }
  if (d.target && !cancelled && !tryMove(picked, d.target)) {
    picked = null;
    rerender();
  }
}
$('#board').addEventListener('pointerup', (e) => endDrag(e));
$('#board').addEventListener('pointercancel', (e) => endDrag(e, true));

// ---------- 試走模式 ----------

function leaveModes() {
  practice = null;
  explore = null;
  picked = null;
}

async function exploreMove(m, uci) {
  // 走的正好是實戰的下一步，就直接沿著實戰前進
  if (!explore && sel < moves.length && results[sel].uci === uci) return select(sel + 1);
  if (!explore) explore = { base: sel, fens: [fens[sel]], evals: [evals[sel]], steps: [], busy: false, showBest: false };
  const ex = explore;
  const chess = new Chess(ex.fens.at(-1));
  chess.move({ from: m.from, to: m.to, promotion: uci[4] });
  const step = { san: m.san, uci, color: m.color };
  ex.steps.push(step);
  ex.fens.push(chess.fen());
  ex.busy = true;
  ex.showBest = false;
  renderExplore();

  const k = ex.steps.length - 1;
  const res = await getEngine().analyse(chess.fen(), { depth: Math.min(settings.reportDepth, 14) });
  if (explore !== ex || ex.steps[k] !== step) return; // 已經離開或撤回
  ex.evals.push(res);
  const before = ex.evals[k];
  step.result = evaluateMove({ before, after: res, move: step, ply: ex.base + k + 1 });
  step.why = BAD.includes(step.result.cls)
    ? explainMistake({ fenBefore: ex.fens[k], uci, after: res, mover: step.color }).map((x) => x.text)
    : [];
  step.better =
    step.result.cls !== 'best' ? explainBest({ fenBefore: ex.fens[k], before, mover: step.color, playedAfter: res.score }) : null;
  step.next = explainBest({ fenBefore: chess.fen(), before: res, mover: chess.turn() });
  ex.busy = false;
  renderExplore();
}

function undoExplore() {
  if (!explore || explore.busy) return;
  explore.steps.pop();
  explore.fens.pop();
  explore.evals.length = Math.min(explore.evals.length, explore.fens.length);
  explore.showBest = false;
  picked = null;
  if (!explore.steps.length) {
    const base = explore.base;
    explore = null;
    return select(base);
  }
  renderExplore();
}

function renderExplore() {
  const ex = explore;
  const last = ex.steps.at(-1);
  const fen = ex.fens.at(-1);
  const next = last.next;
  drawBoard({
    fen,
    highlight: [last.uci.slice(0, 2), last.uci.slice(2, 4)],
    selected: picked,
    targets: targetsOf(fen),
    arrow: !picked && ex.showBest && next ? { uci: ex.evals.at(-1).bestmove, color: '#4a9eff' } : null,
  });

  const baseLabel = ex.base ? moveLabel(results[ex.base - 1]) : '起始局面';
  $('#pos-title').textContent = `🔀 試走（從 ${baseLabel} 之後）`;
  const line = ex.steps
    .map((st, i) => {
      const ply = ex.base + 1 + i;
      const num = st.color === 'w' ? `${Math.ceil(ply / 2)}. ` : i === 0 ? `${Math.ceil(ply / 2)}... ` : '';
      return `${num}${st.san}`;
    })
    .join(' ');

  let html = `<div class="line">你的變化：<b>${escapeHtml(line)}</b></div>`;
  if (ex.busy) {
    html += '<div class="muted">分析中…</div>';
  } else {
    const r = last.result;
    html += `<div class="line">${badge(r.cls)} ${sideName(r.color)}勝率 ${moverWin(r.winBeforeW, r.color).toFixed(0)}% → ${moverWin(r.winAfterW, r.color).toFixed(0)}%
      <span class="muted">（評分 ${formatScore(ex.evals.at(-1).score)}）</span></div>`;
    if (last.why.length) html += `<ul class="why">${last.why.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`;
    if (last.better && !['best', 'book', 'excellent'].includes(r.cls)) html += betterHtml(last.better);
    if (ex.showBest && next) {
      html += `<div class="better best-now">
        <div class="line"><span class="legend-arrow" style="background:#4a9eff"></span>現在${sideName(new Chess(fen).turn())}最好的下法：<b>${escapeHtml(next.san)}</b></div>
        <ul class="why">${next.reasons.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
        <div class="muted small">接下來的變化：${escapeHtml(next.line)}</div></div>`;
    }
  }
  html += `<div class="lesson-actions">
    <button data-ex="undo" ${ex.busy ? 'disabled' : ''}>↶ 撤回一步</button>
    ${next && !ex.busy ? `<button data-ex="best">${ex.showBest ? '隱藏最佳下法' : '💡 現在最好的下法'}</button>` : ''}
    <button data-ex="exit">回到實戰</button></div>`;
  $('#pos-info').innerHTML = html;
}

$('#pos-info').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-ex]');
  if (!b || !explore) return;
  if (b.dataset.ex === 'undo') undoExplore();
  if (b.dataset.ex === 'best') {
    explore.showBest = !explore.showBest;
    renderExplore();
  }
  if (b.dataset.ex === 'exit') {
    const base = explore.base;
    leaveModes();
    select(base);
  }
});

async function checkAnswer(uci, san) {
  const { r, ply } = practice;
  if (uci === r.bestUci) return solve(uci, { kind: 'ok', text: `答對了！${r.better.san} 就是最好的走法。` });

  practice.busy = true;
  practice.feedback = { kind: 'info', text: `${san}… 檢查中` };
  renderPractice();
  const chess = new Chess(fens[ply - 1]);
  chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  const res = await getEngine().analyse(chess.fen(), { depth: Math.min(settings.reportDepth, 14) });
  practice.busy = false;
  const loss = moverWin(r.winBeforeW, r.color) - moverWin(whiteWinPercent(res.score), r.color);
  if (loss <= PRACTICE_OK_LOSS) {
    return solve(uci, { kind: 'ok', text: `${san} 也是好棋，答對了！引擎的首選是 ${r.better.san}，理由如下：` }, false, chess.fen());
  }
  practice.hints = Math.max(practice.hints, 1);
  practice.feedback = { kind: 'bad', text: `${san} 還不夠好（勝率會掉 ${loss.toFixed(0)}%）。再想想，看看下面的提示。` };
  renderPractice();
}

function solve(uci, feedback, showAnswerArrow = false, fenAfter = null) {
  const chess = new Chess(fens[practice.ply - 1]);
  if (!fenAfter) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  practice.solved = true;
  practice.solvedUci = uci;
  practice.solvedFen = fenAfter || chess.fen();
  practice.showAnswerArrow = showAnswerArrow;
  practice.feedback = feedback;
  if (showAnswerArrow) practice.solvedFen = fens[practice.ply - 1];
  renderPractice();
}

// ---------- 著法列表 ----------

function renderMoves() {
  let html = '';
  for (let i = 0; i < results.length; i += 2) {
    html += `<div class="num">${i / 2 + 1}.</div>`;
    for (const r of [results[i], results[i + 1]]) {
      if (!r) {
        html += '<div></div>';
        continue;
      }
      const c = CLASSES[r.cls];
      const sym = BAD.includes(r.cls) ? c.symbol : '';
      html += `<div class="mv ${r.color === me ? 'mine' : ''}" data-ply="${r.ply}"><span>${escapeHtml(r.san)}</span>
        <span class="sym" style="color:${c.color}" title="${c.label}${r.missed ? '・錯失良機' : ''}">${sym}${r.missed ? '◇' : ''}</span></div>`;
    }
  }
  $('#moves').innerHTML = html;
}

$('#moves').addEventListener('click', (e) => {
  const mv = e.target.closest('.mv');
  if (mv) {
    leaveModes();
    select(Number(mv.dataset.ply));
  }
});

function updateCursor() {
  const cur = $('#chart svg .cursor');
  const x = (sel / (winW.length - 1 || 1)) * 1000;
  cur?.setAttribute('x1', x);
  cur?.setAttribute('x2', x);
  document.querySelectorAll('.mv').forEach((el) => el.classList.toggle('sel', Number(el.dataset.ply) === sel));
  document.querySelector(`.mv[data-ply="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
}

function select(ply) {
  sel = Math.max(0, Math.min(moves.length, ply));
  renderPosition();
  updateCursor();
}

// ---------- 匯出 ----------

function buildPgn() {
  const nag = { inaccuracy: '?!', mistake: '?', blunder: '??' };
  const tags = [
    ['Event', 'Chess Review Buddy 賽後分析'],
    ['Site', game.url],
    ['Date', game.date.slice(0, 10).replace(/-/g, '.')],
    ['White', game.white],
    ['Black', game.black],
    ['Result', game.result],
  ];
  const head = tags.map(([k, v]) => `[${k} "${String(v).replace(/"/g, "'")}"]`).join('\n') + '\n\n';
  const parts = [];
  results.forEach((r, i) => {
    if (r.color === 'w') parts.push(`${Math.ceil(r.ply / 2)}.`);
    let comment = `[%eval ${formatScore(evals[i + 1].score).replace('+M', '#').replace('-M', '#-')}]`;
    if (nag[r.cls]) {
      comment += ` ${CLASSES[r.cls].label}${r.missed ? '（錯失良機）' : ''}。`;
      if (r.why[0]) comment += r.why[0];
      if (r.better) comment += ` 更好：${r.better.text}`;
    }
    parts.push(`${r.san}${nag[r.cls] || ''} {${comment.replace(/[{}]/g, '')}}`);
  });
  parts.push(game.result);
  return head + parts.join(' ') + '\n';
}

function buildSummary() {
  const s = sideStats(me);
  const lessons = lessonList().map((r, i) => {
    const why = r.missed ? `錯失良機，${r.why[0] || ''}` : r.why[0] || '';
    return `${i + 1}. ${moveLabel(r)}（${CLASSES[r.cls].label}）${why} ${r.better ? `→ 更好：${r.better.san}` : ''}`;
  });
  const ph = phaseStats(results, phases, me);
  return [
    `♞ ${game.white} vs ${game.black}  ${game.result}`,
    ...(opening.name ? [`開局：${opening.zh || opening.name}（${opening.eco}）`] : []),
    ...buildStory({ results, winW, evals, me, opening, result: game.result }).filter((t) => !t.startsWith('這盤下的是')),
    ...(ph.weakest ? [`最需要加強：${PHASES[ph.weakest]}（準確率 ${ph.stats[ph.weakest].acc.toFixed(0)}）`] : []),
    `我（${playerName(me)}，${me === 'w' ? '白' : '黑'}）準確率 ${s.acc?.toFixed(1) ?? '–'}｜不精確 ${s.counts.inaccuracy}、失誤 ${s.counts.mistake}、大失誤 ${s.counts.blunder}、錯失良機 ${s.missed}`,
    lessons.length ? '本局三課：' : '本局沒有明顯失誤 👍',
    ...lessons,
    game.url,
  ].join('\n');
}

$('#pgn').addEventListener('click', () => {
  const blob = new Blob([buildPgn()], { type: 'application/x-chess-pgn' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${game.white}_vs_${game.black}.pgn`.replace(/[^\w.\-一-鿿]+/g, '_');
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(buildSummary());
  $('#copy').textContent = '已複製！';
  setTimeout(() => ($('#copy').textContent = '複製文字摘要'), 1500);
});

$('#me-toggle').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-me]');
  if (!b || b.dataset.me === me) return;
  me = b.dataset.me;
  flipped = me === 'b';
  leaveModes();
  game.me = me;
  await chrome.storage.local.set({ [id]: game });
  renderAll();
});

document.querySelector('.nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-nav]');
  if (!b) return;
  if (explore && b.dataset.nav === 'prev') return undoExplore();
  leaveModes();
  select({ first: 0, prev: sel - 1, next: sel + 1, last: moves.length }[b.dataset.nav]);
});
$('#flip').addEventListener('click', () => {
  flipped = !flipped;
  renderPosition();
});
document.addEventListener('keydown', (e) => {
  if (practice) return;
  if (explore) {
    if (e.key === 'ArrowLeft') undoExplore();
    return;
  }
  if (e.key === 'ArrowLeft') select(sel - 1);
  if (e.key === 'ArrowRight') select(sel + 1);
});

function renderAll() {
  document.querySelectorAll('#me-toggle button').forEach((b) => b.classList.toggle('on', b.dataset.me === me));
  renderCards();
  renderStory();
  renderPhases();
  renderGoods();
  renderLessons();
  renderStats();
  renderOpp();
  renderChart();
  renderMoves();
  select(sel);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.pieceSet) {
    settings.pieceSet = changes.pieceSet.newValue;
    rerender();
  }
});

renderAll();
