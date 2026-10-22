import { Engine } from './engine.js';
import { loadSettings } from './settings.js';
import {
  replay,
  evaluateMove,
  whiteWinPercent,
  formatScore,
  uciLineToSan,
  gameAccuracy,
  CLASSES,
} from './analysis.js';

const PIECES = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const COUNTED = ['best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'blunder'];
const $ = (sel) => document.querySelector(sel);

const id = new URLSearchParams(location.search).get('id');
const stored = (await chrome.storage.local.get(id))[id];
if (!stored) {
  $('.progress-text').textContent = '找不到這盤棋的資料，請從 chess.com 頁面重新開啟賽後總結。';
  throw new Error('no game');
}

const game = stored;
const { fens, moves } = replay(game.sans);
let sel = moves.length;
let flipped = false;

$('#title').textContent = `${game.white} vs ${game.black}`;
$('#sub').textContent = `${game.result} · ${moves.length} 個半步 · ${new Date(game.date).toLocaleString()}`;
document.title = `賽後總結：${game.white} vs ${game.black}`;

// ---------- 分析 ----------

async function analyseGame() {
  const settings = await loadSettings();
  if (game.analysis?.depth === settings.reportDepth && game.analysis.evals.length === fens.length) {
    return game.analysis.evals;
  }
  const engine = new Engine();
  const evals = [];
  for (let i = 0; i < fens.length; i++) {
    $('.progress-text').textContent = `Stockfish 分析中… ${i}/${fens.length - 1}（深度 ${settings.reportDepth}）`;
    $('.progress-bar').style.width = `${(i / (fens.length - 1 || 1)) * 100}%`;
    evals.push(await engine.analyse(fens[i], { depth: settings.reportDepth }));
  }
  engine.worker.terminate();
  game.analysis = { depth: settings.reportDepth, evals };
  await chrome.storage.local.set({ [id]: game });
  return evals;
}

const evals = await analyseGame();
const results = moves.map((move, i) => {
  const ev = evaluateMove({ before: evals[i], after: evals[i + 1], move, ply: i + 1 });
  ev.bestSan = evals[i].bestmove ? uciLineToSan(fens[i], [evals[i].bestmove])[0] : null;
  ev.bestPv = uciLineToSan(fens[i], evals[i].pv.length ? evals[i].pv : [evals[i].bestmove || ''], 5);
  return ev;
});
const winW = evals.map((e) => whiteWinPercent(e.score));

$('#progress').hidden = true;
$('#main').hidden = false;
$('#copy').disabled = false;
$('#pgn').disabled = false;

// ---------- 準確率卡片 ----------

function sideStats(color) {
  const mine = results.filter((r) => r.color === color);
  const counts = Object.fromEntries(COUNTED.map((c) => [c, 0]));
  mine.forEach((r) => counts[r.cls]++);
  return { acc: gameAccuracy(mine.map((r) => r.accuracy)), counts, n: mine.length };
}
const stats = { w: sideStats('w'), b: sideStats('b') };

function renderCards() {
  const card = (color, name) => {
    const s = stats[color];
    const rows = COUNTED.map(
      (c) => `<tr><td><span class="cls-dot" style="background:${CLASSES[c].color}"></span>${CLASSES[c].label}</td><td>${s.counts[c]}</td></tr>`
    ).join('');
    return `<div class="card">
      <div class="who"><span class="swatch" style="background:${color === 'w' ? '#fff' : '#1a1a1a'}"></span>${escapeHtml(name)}（${color === 'w' ? '白' : '黑'}）</div>
      <div class="acc">${s.acc === null ? '–' : s.acc.toFixed(1)}<small> 準確率</small></div>
      <table>${rows}</table></div>`;
  };
  $('#cards').innerHTML = card('w', game.white) + card('b', game.black);
}

// ---------- 勝率走勢圖 ----------

function renderChart() {
  const W = 1000;
  const H = 180;
  const n = winW.length - 1 || 1;
  const x = (i) => (i / n) * W;
  const y = (p) => 6 + (1 - p / 100) * (H - 12);
  const pts = winW.map((p, i) => `${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  const marks = results
    .filter((r) => ['inaccuracy', 'mistake', 'blunder'].includes(r.cls))
    .map(
      (r) =>
        `<circle cx="${x(r.ply)}" cy="${y(winW[r.ply])}" r="5" fill="${CLASSES[r.cls].color}" stroke="var(--chart-bg)" stroke-width="2" vector-effect="non-scaling-stroke"/>`
    )
    .join('');
  $('#chart').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="白方勝率走勢">
      <rect width="${W}" height="${H}" fill="var(--chart-bg)"/>
      <polygon points="0,${H} ${pts} ${W},${H}" fill="var(--chart-fill)"/>
      <line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="#8a8783" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>
      <line class="cursor" x1="${x(sel)}" x2="${x(sel)}" y1="0" y2="${H}" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
      <line class="hover" x1="-10" x2="-10" y1="0" y2="${H}" stroke="#8a8783" vector-effect="non-scaling-stroke"/>
      ${marks}
    </svg>
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
  svg.addEventListener('click', (ev) => select(plyAt(ev)));
}

// ---------- 棋盤 ----------

function renderBoard() {
  const fen = fens[sel];
  const rows = fen.split(' ')[0].split('/');
  const grid = [];
  rows.forEach((row) => {
    const out = [];
    for (const ch of row) {
      if (/\d/.test(ch)) for (let k = 0; k < Number(ch); k++) out.push(null);
      else out.push(ch);
    }
    grid.push(out);
  });
  const played = sel > 0 ? results[sel - 1] : null;
  const hl = played ? [played.uci.slice(0, 2), played.uci.slice(2, 4)] : [];
  let html = '';
  for (let vr = 0; vr < 8; vr++) {
    for (let vf = 0; vf < 8; vf++) {
      const r = flipped ? 7 - vr : vr;
      const f = flipped ? 7 - vf : vf;
      const sq = String.fromCharCode(97 + f) + (8 - r);
      const p = grid[r][f];
      const light = (r + f) % 2 === 0;
      const coordF = vr === 7 ? `<span class="coord f">${sq[0]}</span>` : '';
      const coordR = vf === 0 ? `<span class="coord r">${sq[1]}</span>` : '';
      const piece = p ? `<span class="pc ${p === p.toUpperCase() ? 'w' : 'b'}">${PIECES[p.toLowerCase()]}</span>` : '';
      html += `<div class="sq ${light ? 'l' : 'd'} ${hl.includes(sq) ? 'hl' : ''}">${coordR}${coordF}${piece}</div>`;
    }
  }
  if (played && played.cls !== 'best' && played.cls !== 'book' && played.bestUci) {
    html += arrowSvg(played.bestUci, '#3ba55d');
  }
  $('#board').innerHTML = html;

  const info = $('#pos-info');
  $('#pos-title').textContent = played ? moveLabel(played) : '起始局面';
  if (!played) {
    info.innerHTML = `<div class="line">白方勝率 ${winW[0].toFixed(0)}%</div>`;
    return;
  }
  const c = CLASSES[played.cls];
  const mover = played.color === 'w' ? '白方' : '黑方';
  const before = played.color === 'w' ? played.winBeforeW : 100 - played.winBeforeW;
  const after = played.color === 'w' ? played.winAfterW : 100 - played.winAfterW;
  let html2 = `<div class="line"><span class="badge" style="background:${c.color}">${c.label}</span>
    ${mover}勝率 ${before.toFixed(0)}% → ${after.toFixed(0)}%（評分 ${formatScore(evals[sel].score)}）</div>`;
  if (played.cls !== 'best' && played.bestSan) {
    html2 += `<div class="line"><span class="legend-arrow" style="background:#3ba55d"></span>更好的著法：<b>${escapeHtml(played.bestSan)}</b>
      <span class="muted">${escapeHtml(played.bestPv.join(' '))}</span></div>`;
  }
  info.innerHTML = html2;
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
  const ex = x2 - ((x2 - x1) / len) * 3.2;
  const ey = y2 - ((y2 - y1) / len) * 3.2;
  return `<svg viewBox="0 0 100 100"><defs><marker id="ah" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto">
    <path d="M0,0 L4,2 L0,4 z" fill="${color}"/></marker></defs>
    <line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke="${color}" stroke-opacity="0.85" stroke-width="2.2" stroke-linecap="round" marker-end="url(#ah)"/></svg>`;
}

// ---------- 關鍵時刻與著法列表 ----------

function renderMoments() {
  const top = [...results]
    .filter((r) => r.loss >= 5)
    .sort((a, b) => b.loss - a.loss)
    .slice(0, 5)
    .sort((a, b) => a.ply - b.ply);
  if (!top.length) {
    $('#moments').outerHTML = '<p class="muted" id="moments">這盤沒有明顯的失誤，雙方都下得很穩！</p>';
    return;
  }
  $('#moments').innerHTML = top
    .map((r) => {
      const c = CLASSES[r.cls];
      return `<li data-ply="${r.ply}"><span class="san">${escapeHtml(moveLabel(r))}</span>
        <span class="badge" style="background:${c.color}">${c.label}</span>
        <span class="muted">勝率 −${r.loss.toFixed(0)}%</span><br>
        <span class="muted small">更好是 ${escapeHtml(r.bestSan || '?')}：${escapeHtml(r.bestPv.join(' '))}</span></li>`;
    })
    .join('');
  $('#moments').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-ply]');
    if (li) select(Number(li.dataset.ply));
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
      const sym = ['inaccuracy', 'mistake', 'blunder'].includes(r.cls) ? c.symbol : '';
      html += `<div class="mv" data-ply="${r.ply}"><span>${escapeHtml(r.san)}</span><span class="sym" style="color:${c.color}" title="${c.label}">${sym}</span></div>`;
    }
  }
  $('#moves').innerHTML = html;
  $('#moves').addEventListener('click', (e) => {
    const mv = e.target.closest('.mv');
    if (mv) select(Number(mv.dataset.ply));
  });
}

function select(ply) {
  sel = Math.max(0, Math.min(moves.length, ply));
  renderBoard();
  const svg = $('#chart svg');
  const cur = svg.querySelector('.cursor');
  const x = (sel / (winW.length - 1 || 1)) * 1000;
  cur.setAttribute('x1', x);
  cur.setAttribute('x2', x);
  document.querySelectorAll('.mv').forEach((el) => el.classList.toggle('sel', Number(el.dataset.ply) === sel));
  document.querySelector(`.mv[data-ply="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
}

// ---------- 匯出 ----------

function moveLabel(r) {
  return `${Math.ceil(r.ply / 2)}${r.color === 'w' ? '.' : '...'} ${r.san}`;
}

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
  let pgn = tags.map(([k, v]) => `[${k} "${String(v).replace(/"/g, "'")}"]`).join('\n') + '\n\n';
  const parts = [];
  results.forEach((r, i) => {
    if (r.color === 'w') parts.push(`${Math.ceil(r.ply / 2)}.`);
    let tok = r.san + (nag[r.cls] || '');
    let comment = `[%eval ${formatScore(evals[i + 1].score).replace('+M', '#').replace('-M', '#-')}]`;
    if (nag[r.cls] && r.bestSan) comment += ` ${CLASSES[r.cls].label}，更好是 ${r.bestSan}`;
    parts.push(`${tok} {${comment}}`);
  });
  parts.push(game.result);
  return pgn + parts.join(' ') + '\n';
}

function buildSummary() {
  const line = (c, name) => {
    const s = stats[c];
    return `${name}（${c === 'w' ? '白' : '黑'}）準確率 ${s.acc?.toFixed(1) ?? '–'}｜不精確 ${s.counts.inaccuracy}、失誤 ${s.counts.mistake}、大失誤 ${s.counts.blunder}`;
  };
  const moments = [...results]
    .filter((r) => r.loss >= 10)
    .sort((a, b) => b.loss - a.loss)
    .slice(0, 3)
    .map((r) => `・${moveLabel(r)}（${CLASSES[r.cls].label}，勝率 −${r.loss.toFixed(0)}%），更好是 ${r.bestSan}`);
  return [
    `♞ ${game.white} vs ${game.black}  ${game.result}`,
    line('w', game.white),
    line('b', game.black),
    moments.length ? '關鍵時刻：' : '',
    ...moments,
    game.url,
  ]
    .filter(Boolean)
    .join('\n');
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

document.querySelector('.nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-nav]');
  if (!b) return;
  const to = { first: 0, prev: sel - 1, next: sel + 1, last: moves.length }[b.dataset.nav];
  select(to);
});
$('#flip').addEventListener('click', () => {
  flipped = !flipped;
  renderBoard();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') select(sel - 1);
  if (e.key === 'ArrowRight') select(sel + 1);
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

renderCards();
renderChart();
renderMoments();
renderMoves();
select(sel);
