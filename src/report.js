import { Chess } from '../vendor/chess.js';
import { Engine } from './engine.js';
import { loadSettings, preKey } from './settings.js';
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
import { findGuide, GENERAL_PRINCIPLES } from './opening-guides.js';

const COUNTED = ['best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'blunder'];
const BAD = ['inaccuracy', 'mistake', 'blunder'];
const LESSON_LOSS = 8; // 自己這步勝率掉超過這個值，才算一課
const OPP_MISTAKE_LOSS = 10; // 對手這步勝率掉超過這個值，才算「可以利用的機會」
const PRACTICE_OK_LOSS = 3; // 練習時，比最佳著法只差這麼多也算答對
const ANALYSIS_VERSION = 2; // 分析格式改變時遞增，讓舊的快取重新分析
const PIECE_SETS = ['chesscom', 'papercut', 'spatial', 'cburnett'];
const LEVELS = {
  easy: { label: '簡單', skill: 2, depth: 6 },
  normal: { label: '普通', skill: 8, depth: 10 },
  hard: { label: '困難', skill: 16, depth: 14 },
};
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
let tab = 'review';
let practice = null; // 練習模式
let explore = null; // 變化模式：free 試走、replay 重新下、drill 開局練習
let lineView = null; // 看主線
let picked = null; // 目前選取（或拖曳中）的棋子所在格
let showBest = !!settings.reviewBestMove; // Best Move 常設開關（會記住）
let engine = null;
let oppEngine = null;
let oppSkill = null;
const evalCache = new Map();

$('#title').textContent = `${game.white} vs ${game.black}`;
document.title = `賽後復盤：${game.white} vs ${game.black}`;

// ---------- 引擎與分析 ----------

function getEngine() {
  if (!engine) engine = new Engine();
  return engine;
}

// 電腦對手：另開一個引擎並調低棋力。
function getOppEngine(level) {
  if (!oppEngine) oppEngine = new Engine();
  const skill = LEVELS[level].skill;
  if (oppSkill !== skill) {
    oppEngine.ready.then(() => oppEngine.send(`setoption name Skill Level value ${skill}`));
    oppSkill = skill;
  }
  return oppEngine;
}

async function quickEval(fen) {
  if (evalCache.has(fen)) return evalCache.get(fen);
  const res = await getEngine().analyse(fen, { depth: Math.min(settings.reportDepth, 14) });
  evalCache.set(fen, res);
  return res;
}

function showProgress(i, label) {
  $('.progress-text').textContent = `${label} ${i}/${fens.length - 1}（深度 ${settings.reportDepth}）`;
  $('.progress-bar').style.width = `${(i / (fens.length - 1 || 1)) * 100}%`;
}

// 等背景的預先分析跑完；超過 10 秒沒有進度就改成自己接著算。
async function waitForPrep(key) {
  let lastCount = -1;
  let lastChange = Date.now();
  for (;;) {
    const v = (await chrome.storage.local.get(key))[key];
    if (v?.done && v.evals?.length === fens.length) return v.evals;
    const count = v?.count || 0;
    if (count !== lastCount) {
      lastCount = count;
      lastChange = Date.now();
      showProgress(count, '背景分析中…');
    }
    if (Date.now() - lastChange > 10000) return v?.evals || [];
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function analyseGame() {
  const a = game.analysis;
  if (a?.v === ANALYSIS_VERSION && a.depth === settings.reportDepth && a.evals.length === fens.length) {
    return a.evals;
  }
  const key = preKey(game.sans, settings.reportDepth);
  const pre = (await chrome.storage.local.get(key))[key];
  let out = [];
  if (pre?.done && pre.evals?.length === fens.length) out = pre.evals;
  else if (pre) out = await waitForPrep(key);
  for (let i = out.length; i < fens.length; i++) {
    showProgress(i, 'Stockfish 分析中…');
    // 多算第二好的走法，用來找「唯一好棋」
    out.push(await getEngine().analyse(fens[i], { depth: settings.reportDepth, multipv: 2 }));
  }
  game.analysis = { v: ANALYSIS_VERSION, depth: settings.reportDepth, evals: out };
  await chrome.storage.local.set({ [id]: game });
  return out;
}

const openingTable = await fetch(chrome.runtime.getURL('vendor/openings.json')).then((r) => r.json());
const posKey = (fen) => fen.split(' ').slice(0, 4).join(' ');
const opening = openingInfo(fens, openingTable);
const guide = findGuide(opening);
const evals = await analyseGame();
const winW = evals.map((e) => whiteWinPercent(e.score));
const results = moves.map((move, i) => {
  const ev = evaluateMove({ before: evals[i], after: evals[i + 1], move, ply: i + 1 });
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
  ev.bestPv = uciLineToSan(fens[i], evals[i].pv.length ? evals[i].pv : [evals[i].bestmove || ''], 5);
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
$('#app').hidden = false;
$('#copy').disabled = false;
$('#pgn').disabled = false;

// ---------- 共用小工具 ----------

const sideName = (c) => (c === 'w' ? '白方' : '黑方');
const playerName = (c) => (c === 'w' ? game.white : game.black);
const moverWin = (winWhite, c) => (c === 'w' ? winWhite : 100 - winWhite);
const other = (c) => (c === 'w' ? 'b' : 'w');
const pieceSet = () => (PIECE_SETS.includes(settings.pieceSet) ? settings.pieceSet : 'chesscom');

// chess.com 的棋子圖不放進專案，直接從 chess.com 網站載入（只在自己的瀏覽器裡顯示）；載不到就改用 papercut。
const CHESSCOM_PIECES = 'https://images.chesscomfiles.com/chess-themes/pieces/neo/150/';
function pieceSrc(color, type) {
  if (pieceSet() === 'chesscom') return `${CHESSCOM_PIECES}${color}${type.toLowerCase()}.png`;
  return `../pieces/${pieceSet()}/${color}${type.toUpperCase()}.svg`;
}
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (img.tagName !== 'IMG' || !img.src.startsWith(CHESSCOM_PIECES)) return;
    const name = img.src.slice(CHESSCOM_PIECES.length, -4); // 例如 wp
    img.src = `../pieces/papercut/${name[0]}${name[1].toUpperCase()}.svg`;
  },
  true
);

function moveLabel(r) {
  return `${Math.ceil(r.ply / 2)}${r.color === 'w' ? '.' : '...'} ${r.san}`;
}

function badge(cls) {
  const c = CLASSES[cls];
  return `<span class="badge" style="background:${c.color}">${c.label}</span>`;
}

const missedTag = '<span class="tag">Miss</span>';

// 說明文字都是以走子方為「你」寫的；如果走子方是對手，就把「你」和「對手」對調。
function pov(text, color) {
  if (color === me) return text;
  return text.replace(/對手|你/g, (w) => (w === '你' ? '對手' : '你'));
}
const povBetter = (better, color) => better && { ...better, reasons: better.reasons.map((t) => pov(t, color)) };

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

function sideStats(color) {
  const mine = results.filter((r) => r.color === color);
  const counts = Object.fromEntries(COUNTED.map((c) => [c, 0]));
  mine.forEach((r) => counts[r.cls]++);
  return { acc: gameAccuracy(mine.map((r) => r.accuracy)), counts, missed: mine.filter((r) => r.missed).length };
}

// 依序列出著法（給變化、主線顯示用）。
function numberedLine(sans, startPly) {
  return sans.map((san, i) => {
    const ply = startPly + i;
    const white = ply % 2 === 1;
    const num = white ? `${Math.ceil(ply / 2)}. ` : i === 0 ? `${Math.ceil(ply / 2)}... ` : '';
    return `${num}${san}`;
  });
}

// 這個局面下，開局庫裡有哪些常見的下一步。
function bookMoves(fen) {
  const chess = new Chess(fen);
  const out = [];
  for (const m of chess.moves({ verbose: true })) {
    chess.move(m);
    const hit = openingTable[posKey(chess.fen())];
    chess.undo();
    if (hit) out.push({ san: m.san, uci: m.from + m.to + (m.promotion || ''), name: hit[1] });
  }
  return out;
}

// ---------- 分頁 ----------

function setTab(t) {
  tab = t;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.tab').forEach((el) => (el.hidden = el.dataset.tab !== t));
  $('.tab-body').scrollTop = 0;
}

$('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) setTab(b.dataset.tab);
});

// 從其他分頁跳到某一步：切回復盤分頁，讓教練框顯示說明。
function jumpTo(ply) {
  leaveModes();
  setTab('review');
  select(ply);
}

// ---------- 棋盤 ----------

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
        ? `<img class="pc" src="${pieceSrc(p === p.toUpperCase() ? 'w' : 'b', p)}" alt="${p}" draggable="false">`
        : '';
      html += `<div class="${cls}" data-sq="${sq}">${coordR}${coordF}${piece}</div>`;
    }
  }
  if (arrow?.uci) html += arrowSvg(arrow.uci, arrow.color);
  $('#board').innerHTML = html;
  $('#board').classList.toggle('interactive', !!boardFen());
  renderPlayers(fen);
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

// ---------- 雙方資訊列與勝率條 ----------

const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9 };
function materialDiff(fen) {
  let d = 0;
  for (const ch of fen.split(' ')[0]) {
    const v = VAL[ch.toLowerCase()];
    if (v) d += ch === ch.toUpperCase() ? v : -v;
  }
  return d;
}

function renderPlayers(fen) {
  const diff = materialDiff(fen);
  const bar = (c) => {
    const s = sideStats(c);
    const adv = c === 'w' ? diff : -diff;
    return `<span class="avatar ${c}">${c === 'w' ? '♔' : '♚'}</span>
      <span>${escapeHtml(playerName(c))}</span>
      ${c === me ? '<span class="tag you">你</span>' : ''}
      ${s.acc !== null ? `<span class="acc-chip" title="Accuracy">${s.acc.toFixed(1)}</span>` : ''}
      ${adv > 0 ? `<span class="mat">+${adv}</span>` : ''}`;
  };
  const top = flipped ? 'w' : 'b';
  $('#player-top').innerHTML = bar(top);
  $('#player-bottom').innerHTML = bar(other(top));
}

function renderEvalBar(score) {
  const bar = $('#evalbar');
  bar.classList.toggle('flipped', flipped);
  if (!score) return;
  const w = whiteWinPercent(score);
  bar.querySelector('.eval-white').style.height = `${w}%`;
  const text = bar.querySelector('.eval-text');
  text.textContent = formatScore(score).replace('+', '');
  // 數字顯示在領先那一方的那一端
  const whiteAhead = w >= 50;
  const atBottom = whiteAhead !== flipped;
  text.className = 'eval-text';
  text.style.color = whiteAhead ? '#403d39' : '#f0eee9';
  text.style.top = atBottom ? '' : '6px';
  text.style.bottom = atBottom ? '6px' : '';
}

// ---------- 主要繪製：依目前模式畫棋盤與教練框 ----------

function render() {
  if (practice) renderPractice();
  else if (explore) renderExplore();
  else if (lineView) renderLine();
  else renderReview();
}

// 目前局面的 Best Move 區塊（藍色）。
function bestNowHtml(next, label = 'Best Move') {
  return `<div class="better best-now">
    <div class="line"><span class="legend-arrow" style="background:var(--blue)"></span>${label}：<b>${escapeHtml(next.san)}</b></div>
    <ul class="why">${next.reasons.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
    ${next.line ? `<div class="muted small">接下來的變化：${escapeHtml(next.line)}</div>` : ''}</div>`;
}

function setCoach(title, html) {
  $('#coach-title').innerHTML = title;
  $('#coach-body').innerHTML = html;
}

// 「更好的著法」區塊：著法、為什麼好（最多三點）、接下來的變化。
function betterHtml(better, label = 'Best Move') {
  return `<div class="better">
    <div class="line"><span class="legend-arrow" style="background:#3ba55d"></span>${label}：<b>${escapeHtml(better.san)}</b></div>
    <ul class="why">${better.reasons.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
    <div class="muted small">接下來的變化：${escapeHtml(better.line)}</div>
  </div>`;
}

function renderReview() {
  const played = sel > 0 ? results[sel - 1] : null;
  const showBetter = played && played.better && !['best', 'book'].includes(played.cls);
  const nowBest =
    showBest && evals[sel].bestmove
      ? explainBest({ fenBefore: fens[sel], before: evals[sel], mover: new Chess(fens[sel]).turn() })
      : null;
  let arrow = null;
  if (!picked && nowBest) arrow = { uci: evals[sel].bestmove, color: '#4a9eff' };
  else if (!picked && showBetter) arrow = { uci: played.bestUci, color: '#3ba55d' };
  drawBoard({
    fen: fens[sel],
    highlight: played ? [played.uci.slice(0, 2), played.uci.slice(2, 4)] : [],
    selected: picked,
    targets: targetsOf(fens[sel]),
    arrow,
  });
  renderEvalBar(evals[sel].score);

  const tail = `<div class="muted small">可以直接拖曳棋子試走其他下法。</div>
    <div class="actions-row"><button class="primary" data-review="replay">從這裡重新下</button></div>`;
  const turn = new Chess(fens[sel]).turn();
  const bestBlock = nowBest ? bestNowHtml(povBetter(nowBest, turn), `Best Move（輪到${sideName(turn)}）`) : '';
  if (!played) {
    setCoach('起始局面', `<div class="line">白方勝率 ${winW[0].toFixed(0)}%</div>${bestBlock}${tail}`);
    return;
  }
  const bookName = opening.bookPlies.has(played.ply) ? openingTable[posKey(fens[sel])]?.[1] : null;
  let html = `<div class="line">${sideName(played.color)}勝率 ${moverWin(played.winBeforeW, played.color).toFixed(0)}% → ${moverWin(played.winAfterW, played.color).toFixed(0)}%
    <span class="muted">（Eval ${formatScore(evals[sel].score)}）</span></div>`;
  if (bookName) html += `<div class="muted small">Book：${escapeHtml(bookName)}</div>`;
  if (played.missed) html += `<div class="line">${missedTag} 對手上一步下錯了，這裡有機會反擊。</div>`;
  if (played.why.length) html += `<ul class="why">${played.why.map((t) => `<li>${escapeHtml(pov(t, played.color))}</li>`).join('')}</ul>`;
  if (showBetter) html += betterHtml(povBetter(played.better, played.color), `這步的 Best Move`);
  setCoach(`${escapeHtml(moveLabel(played))} ${badge(played.cls)}`, html + bestBlock + tail);
}

// ---------- 練習模式（本局三課） ----------

function startPractice(ply) {
  const r = results[ply - 1];
  if (!r || !r.better) return;
  leaveModes();
  flipped = r.color === 'b';
  practice = { ply, r, hints: 0, solved: false, busy: false, feedback: null };
  sel = ply - 1;
  setTab('review');
  updateCursor();
  render();
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
  renderEvalBar(evals[ply - 1].score);

  const intro = r.missed
    ? `對手上一步 ${prev.san} 下錯了！找出懲罰他的走法。`
    : `你實戰下的是 ${r.san}，但這裡有更好的走法，找找看。`;
  const lessons = lessonList();
  const idx = lessons.findIndex((l) => l.ply === ply);
  const next = idx >= 0 ? lessons[idx + 1] : null;

  let html = `<div class="line">${escapeHtml(intro)} <span class="muted small">拖曳棋子，或點棋子再點目的地。</span></div>`;
  if (feedback) html += `<div class="feedback ${feedback.kind}">${escapeHtml(feedback.text)}</div>`;
  if (solved) html += betterHtml(r.better);
  if (hints && !solved) {
    html += `<ol class="hints">${r.better.hints.slice(0, hints).map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ol>`;
  }
  html += '<div class="actions-row">';
  if (!solved) {
    html += `<button data-act="hint" ${hints >= 2 ? 'disabled' : ''}>提示（${hints}/2）</button>
      <button data-act="answer">看答案</button>`;
  }
  if (solved && next) html += `<button class="primary" data-act="next" data-ply="${next.ply}">下一課 →</button>`;
  html += '<button data-act="exit">結束練習</button></div>';
  setCoach(`練習：${Math.ceil(ply / 2)}${r.color === 'w' ? '.' : '...'} 輪到${sideName(r.color)}`, html);
}

async function checkAnswer(uci, san) {
  const { r, ply } = practice;
  if (uci === r.bestUci) return solve(uci, { kind: 'ok', text: `答對了！${r.better.san} 就是最好的走法。` });

  const pr = practice;
  pr.busy = true;
  pr.feedback = { kind: 'info', text: `${san}… 檢查中` };
  render();
  const chess = new Chess(fens[ply - 1]);
  chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  const res = await quickEval(chess.fen());
  if (practice !== pr) return;
  pr.busy = false;
  const loss = moverWin(r.winBeforeW, r.color) - moverWin(whiteWinPercent(res.score), r.color);
  if (loss <= PRACTICE_OK_LOSS) {
    return solve(uci, { kind: 'ok', text: `${san} 也是好棋，答對了！引擎的首選是 ${r.better.san}：` }, false, chess.fen());
  }
  pr.hints = Math.max(pr.hints, 1);
  pr.feedback = { kind: 'bad', text: `${san} 還不夠好（勝率會掉 ${loss.toFixed(0)}%）。再想想，看看下面的提示。` };
  render();
}

function solve(uci, feedback, showAnswerArrow = false, fenAfter = null) {
  const chess = new Chess(fens[practice.ply - 1]);
  if (!fenAfter) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  practice.solved = true;
  practice.solvedUci = uci;
  practice.solvedFen = showAnswerArrow ? fens[practice.ply - 1] : fenAfter || chess.fen();
  practice.showAnswerArrow = showAnswerArrow;
  practice.feedback = feedback;
  render();
}

// ---------- 變化模式：試走、重新下、開局練習 ----------

function leaveModes() {
  practice = null;
  explore = null;
  lineView = null;
  picked = null;
}

// kind：free（自己兩邊都走）、replay（對手照實戰，偏離後換電腦）、drill（對手照開局庫）
// start：{ fen, evalRes, label } 可指定非實戰的起點（例如主線上的某一步）。
async function startVariation(kind, base, start = null) {
  const level = explore?.level || 'normal';
  leaveModes();
  const fen0 = start?.fen || fens[base];
  explore = {
    kind,
    base,
    fens: [fen0],
    evals: [start?.evalRes || evals[base]],
    steps: [],
    busy: false,
    redo: [],
    level,
    myColor: me,
    startLabel: start?.label || null,
  };
  if (kind !== 'free') {
    flipped = me === 'b';
    setTab('review');
  }
  if (!start) sel = base;
  updateCursor();
  render();
  const ex = explore;
  if (kind !== 'free' && new Chess(fen0).turn() !== ex.myColor) {
    ex.busy = true;
    render();
    await opponentMove(ex);
    if (explore === ex) {
      ex.busy = false;
      render();
    }
  }
}

// 目前的變化是否還跟實戰一模一樣。
function onGameLine(ex) {
  return !ex.startLabel && ex.steps.every((st, i) => results[ex.base + i]?.uci === st.uci);
}

async function analyseStep(ex, step, k) {
  const res = await quickEval(ex.fens[k + 1]);
  if (explore !== ex || ex.steps[k] !== step) return false;
  ex.evals[k + 1] = res;
  const before = ex.evals[k];
  step.result = evaluateMove({ before, after: res, move: step, ply: ex.base + k + 1 });
  step.book = openingTable[posKey(ex.fens[k + 1])]?.[1] || null;
  if (step.book && !BAD.includes(step.result.cls)) step.result.cls = 'book';
  step.why = BAD.includes(step.result.cls)
    ? explainMistake({ fenBefore: ex.fens[k], uci: step.uci, after: res, mover: step.color }).map((x) => x.text)
    : [];
  step.better = !['best', 'book'].includes(step.result.cls)
    ? explainBest({ fenBefore: ex.fens[k], before, mover: step.color, playedAfter: res.score })
    : null;
  step.next = explainBest({ fenBefore: ex.fens[k + 1], before: res, mover: new Chess(ex.fens[k + 1]).turn() });
  return true;
}

function pushStep(ex, m, uci, by, source = null) {
  const chess = new Chess(ex.fens.at(-1));
  chess.move({ from: m.from, to: m.to, promotion: uci[4] });
  const step = { san: m.san, uci, color: m.color, by, source };
  ex.steps.push(step);
  ex.fens.push(chess.fen());
  return step;
}

async function opponentMove(ex) {
  const fen = ex.fens.at(-1);
  const chess = new Chess(fen);
  if (chess.isGameOver()) return;
  let uci = null;
  let source = '電腦';
  const ply = ex.base + ex.steps.length;
  if (ex.kind === 'replay' && onGameLine(ex) && ply < moves.length) {
    uci = results[ply].uci;
    source = '照實戰';
  } else if (ex.kind === 'drill') {
    const mainline = (guide?.variation?.line || guide?.line || '').split(' ').filter(Boolean);
    const played = ex.steps.map((s) => s.san);
    const followsMain = played.every((san, i) => mainline[i] === san);
    const book = bookMoves(fen);
    const mainNext = followsMain ? book.find((b) => b.san === mainline[played.length]) : null;
    const pick = mainNext || book[Math.floor(Math.random() * book.length)];
    if (pick) {
      uci = pick.uci;
      source = mainNext ? '主線' : '開局庫';
    }
  }
  if (!uci) {
    const lv = LEVELS[ex.level];
    const res = await getOppEngine(ex.level).analyse(fen, { depth: lv.depth });
    if (explore !== ex) return;
    uci = res.bestmove;
    source = `電腦・${lv.label}`;
  }
  if (!uci) return;
  const m = chess.moves({ verbose: true }).find((x) => x.from + x.to === uci.slice(0, 4));
  if (!m) return;
  const step = pushStep(ex, m, uci, 'opp', source);
  await analyseStep(ex, step, ex.steps.length - 1);
}

async function exploreMove(m, uci) {
  // 一般復盤時走的正好是實戰的下一步，就直接沿著實戰前進
  if (!explore && !lineView && sel < moves.length && results[sel].uci === uci) return select(sel + 1);
  if (lineView) {
    const lv = lineView;
    const fen = lv.fens[lv.idx];
    await startVariation('free', 0, { fen, evalRes: await quickEval(fen), label: `主線第 ${Math.ceil(lv.idx / 2)} 步` });
  } else if (!explore) {
    await startVariation('free', sel);
  }
  const ex = explore;
  const step = pushStep(ex, m, uci, 'me');
  ex.redo = [];
  ex.busy = true;
  render();
  const ok = await analyseStep(ex, step, ex.steps.length - 1);
  if (!ok) return;
  if (ex.kind !== 'free') {
    render();
    await opponentMove(ex);
  }
  if (explore !== ex) return;
  ex.busy = false;
  render();
}

// ◀：撤回一步（重新下／Opening 練習時，連同對手的回應一起撤回）。
function undoExplore() {
  const ex = explore;
  if (!ex || ex.busy) return;
  const group = [];
  const popOne = () => {
    group.unshift({ step: ex.steps.pop(), fen: ex.fens.pop(), eval: ex.evals[ex.fens.length] });
    ex.evals.length = ex.fens.length;
  };
  if (!ex.steps.length) {
    if (ex.kind === 'free') {
      const base = ex.base;
      leaveModes();
      select(base);
    }
    return;
  }
  if (ex.kind === 'free') {
    popOne();
  } else {
    while (ex.steps.length && ex.steps.at(-1).by === 'opp') popOne();
    if (ex.steps.length) popOne();
  }
  ex.redo.push(group);
  picked = null;
  if (!ex.steps.length && ex.kind === 'free' && !ex.redo.length) {
    const base = ex.base;
    leaveModes();
    return select(base);
  }
  render();
}

// ▶：把撤回的步重新走回來。
function redoExplore() {
  const ex = explore;
  if (!ex || ex.busy || !ex.redo.length) return;
  for (const it of ex.redo.pop()) {
    ex.steps.push(it.step);
    ex.fens.push(it.fen);
    ex.evals[ex.fens.length - 1] = it.eval;
  }
  picked = null;
  render();
}

// Opening 練習：在哪一步離開開局庫（-1 表示還在開局庫裡）。
function openingEndIndex(ex) {
  return ex.steps.findIndex((st) => st.result && !st.book);
}

// Opening 練習時的 Best Move：照 Main Line 的下一步，沒有的話用引擎的首選。
function drillBest(ex, fen, engineNext) {
  const mainline = (guide?.variation?.line || guide?.line || '').split(' ').filter(Boolean);
  const played = ex.steps.map((st) => st.san);
  const follows = played.every((san, i) => mainline[i] === san);
  const san = follows ? mainline[played.length] : null;
  const book = san ? bookMoves(fen).find((b) => b.san === san) : null;
  if (book) {
    return {
      san: book.san,
      uci: book.uci,
      reasons: [`Main Line：這是${guide.zh}的標準下法（${book.name}）。`, ...(engineNext?.san === book.san && engineNext.theme !== 'quiet' ? engineNext.reasons : [])],
      line: '',
    };
  }
  return engineNext ? { ...engineNext, uci: ex.evals[ex.fens.length - 1]?.bestmove } : null;
}

function renderExplore() {
  const ex = explore;
  const fen = ex.fens.at(-1);
  const last = ex.steps.at(-1);
  const lastMine = [...ex.steps].reverse().find((st) => st.by === 'me' && st.result);
  const nowEval = ex.evals[ex.fens.length - 1] || ex.evals[ex.evals.length - 1];
  const engineNext = last ? last.next : explainBest({ fenBefore: fen, before: ex.evals[0], mover: new Chess(fen).turn() });
  const endIdx = ex.kind === 'drill' ? openingEndIndex(ex) : -1;
  const inOpening = ex.kind === 'drill' && endIdx < 0;
  const myTurn = ex.kind === 'free' || new Chess(fen).turn() === ex.myColor;
  // Opening 練習時，Best Move 預設開啟直到開局結束
  const wantBest = (showBest || inOpening) && myTurn && !ex.busy;
  let best = null;
  if (wantBest) best = inOpening ? drillBest(ex, fen, engineNext) : engineNext && { ...engineNext, uci: nowEval?.bestmove };
  drawBoard({
    fen,
    highlight: last ? [last.uci.slice(0, 2), last.uci.slice(2, 4)] : [],
    selected: picked,
    targets: targetsOf(fen),
    arrow: !picked && best?.uci ? { uci: best.uci, color: '#4a9eff' } : null,
  });
  if (nowEval) renderEvalBar(nowEval.score);

  const baseLabel = ex.startLabel || (ex.base ? moveLabel(results[ex.base - 1]) : '起始局面');
  const titles = {
    free: `試走 <span class="muted small">從 ${escapeHtml(baseLabel)} 之後</span>`,
    replay: `重新下 <span class="muted small">你執${sideName(ex.myColor)}・從 ${escapeHtml(baseLabel)} 之後</span>`,
    drill: `Opening 練習 <span class="muted small">${escapeHtml(guide?.zh || opening.zh || opening.family || '')}・你執${sideName(ex.myColor)}</span>`,
  };

  let html = '';
  if (ex.kind !== 'free' && nowEval) {
    const myWin = moverWin(whiteWinPercent(nowEval.score), ex.myColor);
    const startWin = moverWin(whiteWinPercent(ex.evals[0].score), ex.myColor);
    const d = myWin - startWin;
    const tone = d < -2 ? 'bad' : d > 2 ? 'ok' : 'info';
    html += `<div class="line"><span class="big-win">你的勝率 ${myWin.toFixed(0)}%</span>
      <span class="feedback ${tone} small" style="padding:1px 6px">${d >= 0 ? '+' : ''}${d.toFixed(0)}（和起點相比）</span></div>`;
  }
  if (!ex.steps.length) {
    if (ex.kind === 'replay') html += '<div class="line">輪到你走。對手會先照實戰回應；你一旦走得跟實戰不一樣，就換電腦接手。</div>';
    if (ex.kind === 'drill') html += '<div class="line">對手會照 Main Line 或 Book 回應。Opening 結束前會一直顯示 Best Move，照著走走看。</div>';
  }
  if (ex.kind === 'drill' && endIdx >= 0) {
    const st = ex.steps[endIdx];
    const ply = ex.base + endIdx + 1;
    html += `<div class="feedback info">此 Opening 已結束：第 ${Math.ceil(ply / 2)} 步${st.by === 'me' ? '你' : '對手'}走 ${escapeHtml(st.san)} 之後離開了 Book。接下來進入 Middlegame，Best Move 依照上方開關顯示。</div>`;
  }

  if (ex.busy) {
    html += '<div class="muted">分析中…</div>';
  } else {
    const focus = ex.kind === 'free' ? last : lastMine;
    if (focus?.result) {
      const r = focus.result;
      html += `<div class="line">${ex.kind !== 'free' ? '你走的 ' : ''}<b>${escapeHtml(focus.san)}</b> ${badge(r.cls)}
        <span class="muted small">${sideName(r.color)}勝率 ${moverWin(r.winBeforeW, r.color).toFixed(0)}% → ${moverWin(r.winAfterW, r.color).toFixed(0)}%</span></div>`;
      if (focus.book) html += `<div class="muted small">Book：${escapeHtml(focus.book)}</div>`;
      if (focus.why.length) html += `<ul class="why">${focus.why.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`;
      if (focus.better && !['excellent', 'good'].includes(r.cls)) html += betterHtml(focus.better, '這步的 Best Move');
    }
    if (ex.kind !== 'free' && last?.by === 'opp') {
      html += `<div class="line muted">對手回應 <b style="color:var(--fg)">${escapeHtml(last.san)}</b>（${escapeHtml(last.source)}）</div>`;
    }
    const pos = new Chess(fen);
    if (pos.isGameOver()) html += `<div class="feedback info">${pos.isCheckmate() ? 'Checkmate，棋局結束。' : '棋局結束（和棋）。'}</div>`;
    if (best) html += bestNowHtml(best);
  }
  html += '<div class="muted small">◀ 撤回一步　▶ 重走撤回的步</div><div class="actions-row">';
  if (ex.kind !== 'free') {
    html += `<select data-ex="level" title="電腦對手的強度">${Object.entries(LEVELS)
      .map(([k, v]) => `<option value="${k}" ${k === ex.level ? 'selected' : ''}>電腦：${v.label}</option>`)
      .join('')}</select>`;
  }
  html += `<button data-ex="exit">${ex.kind === 'free' ? '回到實戰' : '結束'}</button></div>`;
  setCoach(titles[ex.kind], html);
}

$('#coach-body').addEventListener('click', (e) => {
  if (e.target.closest('[data-review="replay"]')) return startVariation('replay', sel);
  const b = e.target.closest('button[data-ex]');
  if (b && explore) {
    const act = b.dataset.ex;
    if (act === 'exit') {
      leaveModes();
      select(sel);
    }
    return;
  }
  const p = e.target.closest('button[data-act]');
  if (p && practice) {
    const act = p.dataset.act;
    if (act === 'hint') practice.hints = Math.min(2, practice.hints + 1);
    if (act === 'answer') solve(practice.r.bestUci, { kind: 'info', text: `答案是 ${practice.r.better.san}。` }, true);
    if (act === 'next') return startPractice(Number(p.dataset.ply));
    if (act === 'exit') {
      const ply = practice.ply;
      leaveModes();
      return select(ply);
    }
    render();
    return;
  }
  const l = e.target.closest('[data-line]');
  if (l && lineView) {
    if (l.dataset.line === 'exit') {
      leaveModes();
      return select(sel);
    }
    if (l.dataset.line === 'drill') return startVariation('drill', 0);
    lineView.idx = Number(l.dataset.line);
    render();
  }
});

$('#coach-body').addEventListener('change', (e) => {
  if (e.target.matches('select[data-ex="level"]') && explore) explore.level = e.target.value;
});

// ---------- 看主線 ----------

function startLine() {
  const g = guide;
  const sans = (g?.variation?.line || g?.line || '').split(' ').filter(Boolean);
  if (!sans.length) return;
  const { fens: lf, moves: lm } = replay(sans);
  leaveModes();
  lineView = { sans, fens: lf, moves: lm, idx: 1, title: g.variation ? `${g.zh}・${g.variation.zh}` : g.zh };
  flipped = me === 'b';
  setTab('review');
  render();
}

function renderLine() {
  const lv = lineView;
  const fen = lv.fens[lv.idx];
  const mv = lv.idx > 0 ? lv.moves[lv.idx - 1] : null;
  drawBoard({
    fen,
    highlight: mv ? [mv.uci.slice(0, 2), mv.uci.slice(2, 4)] : [],
    selected: picked,
    targets: targetsOf(fen),
  });
  const cached = evalCache.get(fen);
  if (cached) renderEvalBar(cached.score);
  else
    quickEval(fen).then((res) => {
      if (lineView === lv && lv.fens[lv.idx] === fen) renderEvalBar(res.score);
    });
  const note = guide?.variation?.note || guide?.summary || '';
  const cur = mv ? numberedLine(lv.sans, 1)[lv.idx - 1] : '起始局面';
  const nextSan = lv.sans[lv.idx];
  const nextUci = nextSan ? lv.moves[lv.idx].uci : null;
  if (showBest && nextUci) {
    $('#board').insertAdjacentHTML('beforeend', arrowSvg(nextUci, '#4a9eff'));
  }
  setCoach(
    `Main Line <span class="muted small">${escapeHtml(lv.title)}</span>`,
    `<div class="line">第 ${lv.idx} / ${lv.sans.length} 步：<b>${escapeHtml(cur.replace(/^\d+\.+\s*/, ''))}</b></div>
     <div class="line">${escapeHtml(note)}</div>
     ${showBest && nextSan ? `<div class="better best-now"><div class="line"><span class="legend-arrow" style="background:var(--blue)"></span>Main Line 下一步：<b>${escapeHtml(nextSan)}</b></div></div>` : ''}
     ${!nextSan ? '<div class="feedback info">Main Line 到這裡結束。</div>' : ''}
     <div class="muted small">用 ◀ ▶ 或鍵盤方向鍵一步一步看；也可以直接拖曳棋子試別的下法。</div>
     <div class="actions-row"><button class="primary" data-line="drill">練習這個 Opening</button><button data-line="exit">結束</button></div>`
  );
}

// ---------- 棋盤操作：拖曳或點擊 ----------

// 目前可以操作的局面；不能操作時回傳 null。
function boardFen() {
  if (practice) return practice.solved || practice.busy ? null : fens[practice.ply - 1];
  if (explore) {
    if (explore.busy) return null;
    const fen = explore.fens.at(-1);
    if (explore.kind !== 'free' && new Chess(fen).turn() !== explore.myColor) return null;
    return fen;
  }
  if (lineView) return lineView.fens[lineView.idx];
  return fens[sel];
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
    render();
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
    return render();
  }
  if (d.target && !cancelled && !tryMove(picked, d.target)) {
    picked = null;
    render();
  }
}
$('#board').addEventListener('pointerup', (e) => endDrag(e));
$('#board').addEventListener('pointercancel', (e) => endDrag(e, true));

// ---------- 走勢圖與著法列表（復盤分頁） ----------

function renderChart() {
  const W = 1000;
  const H = 120;
  const n = winW.length - 1 || 1;
  const x = (i) => (i / n) * W;
  const y = (p) => 4 + (1 - p / 100) * (H - 8);
  const pts = winW.map((p, i) => `${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  const phaseLines = [];
  phases.forEach((p, i) => {
    if (i > 0 && p !== phases[i - 1]) phaseLines.push(i);
  });
  const phaseLabels = [0, ...phaseLines]
    .map((i) => {
      const left = (x(i) / W) * 100;
      return `<span class="phase-label ${left > 80 ? 'end' : ''}" style="left:${left > 80 ? 100 : left}%">${PHASES[phases[i]] || ''}</span>`;
    })
    .join('');
  const marks = results
    .filter((r) => BAD.includes(r.cls))
    .map(
      (r) =>
        `<circle cx="${x(r.ply)}" cy="${y(winW[r.ply])}" r="${r.color === me ? 5 : 3.5}" fill="${CLASSES[r.cls].color}" stroke="#403d39" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`
    )
    .join('');
  $('#chart').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="白方勝率走勢">
      <rect width="${W}" height="${H}" class="chart-bg"/>
      <polygon points="0,${H} ${pts} ${W},${H}" class="chart-fill"/>
      <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="#8a8783" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>
      ${phaseLines.map((i) => `<line x1="${x(i)}" x2="${x(i)}" y1="0" y2="${H}" stroke="#8a8783" stroke-dasharray="2 3" vector-effect="non-scaling-stroke"/>`).join('')}
      <line class="cursor" x1="${x(sel)}" x2="${x(sel)}" y1="0" y2="${H}" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
      <line class="hover" x1="-10" x2="-10" y1="0" y2="${H}" stroke="#8a8783" vector-effect="non-scaling-stroke"/>
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
    tip.textContent = `${i === 0 ? '開局' : moveLabel(results[i - 1])} · 白 ${winW[i].toFixed(0)}%`;
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
      const sym = BAD.includes(r.cls) || r.cls === 'book' ? c.symbol : '';
      html += `<div class="mv" data-ply="${r.ply}"><span>${escapeHtml(r.san)}</span>
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
  const el = document.querySelector(`.mv[data-ply="${sel}"]`);
  // 寬螢幕時只有著法列表會捲動；窄螢幕時整個面板一起捲
  const box = $('#moves').scrollHeight > $('#moves').clientHeight ? $('#moves') : $('.tab-body');
  if (el && tab === 'review' && box.scrollHeight > box.clientHeight) {
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
    if (top < 0 || top > box.clientHeight - 30) box.scrollTop += top - box.clientHeight / 2;
  }
}

function select(ply) {
  sel = Math.max(0, Math.min(moves.length, ply));
  picked = null;
  render();
  updateCursor();
}

// ---------- 總結分頁 ----------

function renderCards() {
  const card = (color) => {
    const s = sideStats(color);
    const rows = COUNTED.map(
      (c) => `<tr><td><span class="cls-dot" style="background:${CLASSES[c].color}"></span>${CLASSES[c].label}</td><td>${s.counts[c]}</td></tr>`
    ).join('');
    return `<div class="card ${color === me ? 'mine' : ''}">
      <div class="who"><span class="swatch" style="background:${color === 'w' ? '#fff' : '#1a1a1a'}"></span>
        ${escapeHtml(playerName(color))} ${color === me ? '<span class="tag you">你</span>' : ''}</div>
      <div class="acc">${s.acc === null ? '–' : s.acc.toFixed(1)}<small> Accuracy</small></div>
      <table>${rows}<tr><td><span class="cls-dot" style="border:2px solid #8a6fd1"></span>Miss</td><td>${s.missed}</td></tr></table></div>`;
  };
  $('#cards').innerHTML = card(me) + card(other(me));
}

function renderStory() {
  const lines = buildStory({ results, winW, evals, me, opening, result: game.result });
  $('#story').innerHTML = lines.map((t) => `<p>${escapeHtml(t)}</p>`).join('');
}

function renderPhases() {
  const mine = phaseStats(results, phases, me);
  const theirs = phaseStats(results, phases, other(me));
  $('#phases').innerHTML = Object.entries(PHASES)
    .map(([key, name]) => {
      const s = mine.stats[key];
      const o = theirs.stats[key];
      if (!s.n) return `<div class="phase empty"><div class="phase-name">${name}</div><div class="muted small">這盤沒有走到${name}</div></div>`;
      const weakest = mine.weakest === key;
      return `<div class="phase ${weakest ? 'weak' : ''}" ${s.worst ? `data-ply="${s.worst.ply}"` : ''}>
        <div class="phase-name">${name} ${weakest ? '<span class="tag warn">最需要加強</span>' : ''}</div>
        <div class="phase-acc">${s.acc.toFixed(0)}<small>Accuracy</small></div>
        <div class="muted small">你走了 ${s.n} 步，${s.bad ? `有 ${s.bad} 步不精確以上` : '沒有明顯失誤'}</div>
        <div class="muted small">對手：${o.acc === null ? '–' : o.acc.toFixed(0)}${key === 'opening' ? '・<a href="#" data-goto="opening" style="color:var(--accent)">看 Opening 教學</a>' : ''}</div>
      </div>`;
    })
    .join('');
}

$('#phases').addEventListener('click', (e) => {
  if (e.target.closest('[data-goto]')) {
    e.preventDefault();
    return setTab('opening');
  }
  const el = e.target.closest('[data-ply]');
  if (el) jumpTo(Number(el.dataset.ply));
});

function renderGoods() {
  const goods = goodMoves({ results, evals, fens, me, oppMistakeLoss: OPP_MISTAKE_LOSS });
  $('#goods').innerHTML = goods.length
    ? goods
        .map(
          (g) => `<li data-ply="${g.ply}">
            <div><b>${escapeHtml(moveLabel(results[g.ply - 1]))}</b> <span class="tag good">${g.title}</span>
            <div class="muted small">${escapeHtml(g.text)}</div></div></li>`
        )
        .join('')
    : '<li class="muted">這盤沒有特別突出的好棋。下次試著多留意對手的失誤，抓住了就會出現在這裡！</li>';
}

$('#goods').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-ply]');
  if (li) jumpTo(Number(li.dataset.ply));
});

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
        </div>
        <div class="muted small">你的勝率 ${moverWin(r.winBeforeW, me).toFixed(0)}% → ${moverWin(r.winAfterW, me).toFixed(0)}%</div>
        <ul class="why">${reasons.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
        <div class="actions-row">
          <button class="primary" data-practice="${r.ply}">自己找找看</button>
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
  if (s) jumpTo(Number(s.dataset.show));
});

// ---------- 開局分頁 ----------

function renderOpening() {
  const g = guide;
  let html = '';
  if (opening.name) {
    html += `<div class="block">
      <p class="op-title">${escapeHtml(g?.zh || opening.zh || opening.family)}<span class="op-eco">${escapeHtml(opening.eco)}</span></p>
      <div class="muted small">${escapeHtml(opening.name)}</div>`;
    if (g) {
      html += `<p class="op-summary">${escapeHtml(g.summary)}</p>`;
      if (g.variation) html += `<div class="op-var"><b>${escapeHtml(g.variation.zh)}</b><div>${escapeHtml(g.variation.note)}</div></div>`;
      html += `<div class="actions-row">
        <button data-op="line">看 Main Line</button>
        <button class="primary" data-op="drill">練習這個 Opening（你執${sideName(me)}）</button></div>`;
    } else {
      html += `<p class="op-summary muted">這個開局還沒有中文說明，先照下面的開局原則下。</p>
        <div class="actions-row"><button class="primary" data-op="drill">練習這個 Opening（你執${sideName(me)}）</button></div>`;
    }
    html += '</div>';
  }

  // 這盤在哪裡離開常見下法
  html += '<div class="block"><h2>你這盤的開局</h2>';
  const exit = opening.lastBookPly;
  const leaver = results[exit];
  if (!opening.name) {
    html += '<p class="muted">這盤一開始就離開了常見的開局下法。</p>';
  } else if (!leaver) {
    html += '<p>整盤都在開局庫的範圍內。</p>';
  } else {
    const who = leaver.color === me ? '你' : '對手';
    const sameMove = Math.ceil(leaver.ply / 2) === Math.ceil(exit / 2);
    html += `<p>雙方照常見下法走了 ${exit} 個半步，接著${sameMove ? '' : `第 ${Math.ceil(leaver.ply / 2)} 步`}${who}走 <b>${escapeHtml(moveLabel(leaver))}</b>，離開了 Book。</p>`;
    const book = bookMoves(fens[exit]);
    if (book.length) {
      html += `<div class="muted small">這個局面的 Book Moves：</div><div class="book-moves">${book
        .slice(0, 6)
        .map((b) => `<span title="${escapeHtml(b.name)}"><b>${escapeHtml(b.san)}</b> ${escapeHtml(b.name.split(':').slice(1).join(':').trim() || b.name)}</span>`)
        .join('')}</div>`;
    }
    if (leaver.color === me && leaver.better && !['best', 'excellent'].includes(leaver.cls)) {
      html += `<div style="margin-top:8px">${betterHtml(leaver.better)}</div>`;
    } else if (leaver.color !== me) {
      const reply = results[exit + 1];
      if (reply) {
        html += `<p style="margin-top:8px">你的回應 <b>${escapeHtml(reply.san)}</b> ${badge(reply.cls)}</p>`;
        if (reply.better && !['best', 'excellent', 'book'].includes(reply.cls)) html += betterHtml(reply.better);
        else html += '<p class="muted small">應對得不錯！遇到對手走冷門下法時，照開局原則正常出子就好。</p>';
      }
    }
  }
  html += '</div>';

  // 開局階段的失誤：怎麼下才對
  const opMistakes = results.filter((r, i) => r.color === me && phases[i] === 'opening' && BAD.includes(r.cls));
  html += `<div class="block"><h2>你在 Opening 的失誤${opMistakes.length ? `（${opMistakes.length}）` : ''}</h2>`;
  if (!opMistakes.length) html += '<p class="muted">Opening 階段沒有明顯失誤。</p>';
  for (const r of opMistakes) {
    html += `<div class="op-mistake" data-ply="${r.ply}">
      <div><b>${escapeHtml(moveLabel(r))}</b> ${badge(r.cls)}</div>
      ${r.why[0] ? `<div class="small">${escapeHtml(r.why[0])}</div>` : ''}
      ${r.better ? `<div class="small">Best Move <b>${escapeHtml(r.better.san)}</b>：${escapeHtml(r.better.reasons[0])}</div>` : ''}
    </div>`;
  }
  html += '</div>';

  if (g) {
    const mine = me === 'w' ? g.white : g.black;
    const theirs = me === 'w' ? g.black : g.white;
    html += `<div class="block"><h2>${sideName(me)}（你）的計畫</h2><ul class="op-list">${(mine || []).map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
      <h3>${sideName(other(me))}（對手）的想法</h3><ul class="op-list">${(theirs || []).map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul></div>`;
    html += `<div class="block"><h2>初學者常犯的錯</h2><ul class="op-list">${g.mistakes.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul></div>`;
  }
  html += `<div class="block"><h2>開局四原則</h2><ul class="op-list">${GENERAL_PRINCIPLES.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul></div>`;
  $('#opening').innerHTML = html;
}

$('#opening').addEventListener('click', (e) => {
  const b = e.target.closest('[data-op]');
  if (b?.dataset.op === 'line') return startLine();
  if (b?.dataset.op === 'drill') return startVariation('drill', 0);
  const m = e.target.closest('.op-mistake[data-ply]');
  if (m) jumpTo(Number(m.dataset.ply));
});

// ---------- 統計分頁 ----------

function renderStats() {
  const st = mistakeStats(results, me);
  const chips = (plies) =>
    plies.map((p) => `<button class="chip" data-ply="${p}">${escapeHtml(moveLabel(results[p - 1]))}</button>`).join('');
  const block = (title, list, empty) =>
    `<h3>${title}</h3>` +
    (list.length
      ? `<ul class="stat-list">${list
          .map((x) => `<li><span>${x.name}</span><span class="stat-count">${x.plies.length} 次</span><div>${chips(x.plies)}</div></li>`)
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
  if (chip) jumpTo(Number(chip.dataset.ply));
});

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
            : `<span class="bad">✗ 你錯過了</span> <button class="small-btn" data-practice="${reply.ply}">練習</button>`;
      }
      return `<li data-ply="${r.ply}"><b>${escapeHtml(moveLabel(r))}</b> ${badge(r.cls)}
        <span class="muted small">−${r.loss.toFixed(0)}%</span> ${verdict}</li>`;
    })
    .join('');
}

$('#opp').addEventListener('click', (e) => {
  const p = e.target.closest('[data-practice]');
  if (p) return startPractice(Number(p.dataset.practice));
  const li = e.target.closest('li[data-ply]');
  if (li) jumpTo(Number(li.dataset.ply));
});

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
    ...(opening.eco ? [['ECO', opening.eco], ['Opening', opening.name]] : []),
  ];
  const head = tags.map(([k, v]) => `[${k} "${String(v).replace(/"/g, "'")}"]`).join('\n') + '\n\n';
  const parts = [];
  results.forEach((r, i) => {
    if (r.color === 'w') parts.push(`${Math.ceil(r.ply / 2)}.`);
    let comment = `[%eval ${formatScore(evals[i + 1].score).replace('+M', '#').replace('-M', '#-')}]`;
    if (nag[r.cls]) {
      comment += ` ${CLASSES[r.cls].label}${r.missed ? '（Miss）' : ''}。`;
      if (r.why[0]) comment += r.why[0];
      if (r.better) comment += ` Best Move：${r.better.text}`;
    }
    parts.push(`${r.san}${nag[r.cls] || ''} {${comment.replace(/[{}]/g, '')}}`);
  });
  parts.push(game.result);
  return head + parts.join(' ') + '\n';
}

function buildSummary() {
  const s = sideStats(me);
  const lessons = lessonList().map((r, i) => {
    const why = r.missed ? `Miss，${r.why[0] || ''}` : r.why[0] || '';
    return `${i + 1}. ${moveLabel(r)}（${CLASSES[r.cls].label}）${why} ${r.better ? `→ Best Move：${r.better.san}` : ''}`;
  });
  const ph = phaseStats(results, phases, me);
  return [
    `♞ ${game.white} vs ${game.black}  ${game.result}`,
    ...(opening.name ? [`開局：${opening.zh || opening.name}（${opening.eco}）`] : []),
    ...buildStory({ results, winW, evals, me, opening, result: game.result }).filter((t) => !t.startsWith('這盤下的是')),
    ...(ph.weakest ? [`最需要加強：${PHASES[ph.weakest]}（Accuracy ${ph.stats[ph.weakest].acc.toFixed(0)}）`] : []),
    `我（${playerName(me)}，${me === 'w' ? '白' : '黑'}）Accuracy ${s.acc?.toFixed(1) ?? '–'}｜Inaccuracy ${s.counts.inaccuracy}、Mistake ${s.counts.mistake}、Blunder ${s.counts.blunder}、Miss ${s.missed}`,
    lessons.length ? '本局三課：' : '本局沒有明顯失誤',
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
  setTimeout(() => ($('#copy').textContent = '複製摘要'), 1500);
});

// ---------- 控制列、快捷鍵、設定 ----------

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

function nav(dir) {
  if (practice) return;
  if (lineView) {
    const to = { first: 0, prev: lineView.idx - 1, next: lineView.idx + 1, last: lineView.sans.length }[dir];
    lineView.idx = Math.max(0, Math.min(lineView.sans.length, to));
    picked = null;
    return render();
  }
  if (explore) {
    if (dir === 'prev') undoExplore();
    if (dir === 'next') redoExplore();
    return;
  }
  select({ first: 0, prev: sel - 1, next: sel + 1, last: moves.length }[dir]);
}

$('.controls').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-nav]');
  if (b) nav(b.dataset.nav);
});
$('#flip').addEventListener('click', () => {
  flipped = !flipped;
  render();
});
$('#best-toggle').checked = showBest;
$('#best-toggle').addEventListener('change', (e) => {
  showBest = e.target.checked;
  chrome.storage.sync.set({ reviewBestMove: showBest });
  render();
});
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.key === 'ArrowLeft') nav('prev');
  if (e.key === 'ArrowRight') nav('next');
  if (e.key === 'Home') nav('first');
  if (e.key === 'End') nav('last');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.pieceSet) settings.pieceSet = changes.pieceSet.newValue;
  if (changes.reviewBestMove) {
    showBest = !!changes.reviewBestMove.newValue;
    $('#best-toggle').checked = showBest;
  }
  if (changes.pieceSet || changes.reviewBestMove) render();
});

function renderAll() {
  document.querySelectorAll('#me-toggle button').forEach((b) => b.classList.toggle('on', b.dataset.me === me));
  $('#sub').textContent = `${game.result} · ${opening.zh || opening.name || '未知開局'} · ${new Date(game.date).toLocaleString()}`;
  renderCards();
  renderStory();
  renderPhases();
  renderGoods();
  renderLessons();
  renderOpening();
  renderStats();
  renderOpp();
  renderChart();
  renderMoves();
  select(sel);
}

renderAll();
