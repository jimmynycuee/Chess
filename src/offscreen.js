// 常駐的 offscreen 文件：持有 Stockfish worker，替內容腳本分析目前局面。
import { Engine, analyseAll, poolSize } from './engine.js';
import { replay, evaluateMove, whiteWinPercent, formatScore, uciLineToSan } from './analysis.js';
import { explainMistake, explainBest } from './explain.js';

const engine = new Engine();
const cache = new Map();
let seq = 0;

async function analyseCached(fen, depth, isStale) {
  const key = `${fen}|${depth}`;
  if (cache.has(key)) return cache.get(key);
  const res = await engine.analyse(fen, { depth, isStale });
  if (!res) return null;
  // 被 stop 中斷的搜尋深度不足，不放進快取。
  const complete = res.depth >= depth || res.score.mate !== undefined || !res.bestmove;
  if (!complete) return res;
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  cache.set(key, res);
  return res;
}

async function live({ sans, depth }) {
  const token = ++seq;
  const isStale = () => token !== seq;
  engine.stop();

  const { fens, moves } = replay(sans);
  const fen = fens[fens.length - 1];
  const cur = await analyseCached(fen, depth, isStale);
  if (!cur || isStale()) return { stale: true };

  const result = {
    fen,
    plies: moves.length,
    parsedAll: moves.length === sans.length,
    score: cur.score,
    scoreText: formatScore(cur.score),
    winW: whiteWinPercent(cur.score),
    depth: cur.depth,
    best: cur.bestmove
      ? {
          uci: cur.bestmove,
          pvSan: uciLineToSan(fen, cur.pv.length ? cur.pv : [cur.bestmove]),
          reasons: explainBest({ fenBefore: fen, before: cur, mover: fen.split(' ')[1] })?.reasons || [],
        }
      : null,
    last: null,
  };

  if (moves.length) {
    const prevFen = fens[fens.length - 2];
    const before = await analyseCached(prevFen, depth, isStale);
    if (!before || isStale()) return { stale: true };
    const ev = evaluateMove({ before, after: cur, move: moves[moves.length - 1], ply: moves.length });
    ev.bestSan = before.bestmove ? uciLineToSan(prevFen, [before.bestmove])[0] : null;
    if (ev.cls !== 'best') {
      ev.betterWhy =
        explainBest({ fenBefore: prevFen, before, mover: ev.color, playedAfter: cur.score })?.reasons[0] || null;
    }
    if (['inaccuracy', 'mistake', 'blunder'].includes(ev.cls)) {
      ev.why = explainMistake({ fenBefore: prevFen, uci: ev.uci, after: cur, mover: ev.color })[0]?.text || null;
    }
    result.last = ev;
  }
  return result;
}

// ---------- 賽後預先分析：用另一個引擎，不影響即時分析 ----------

let preEngines = null; // 幾個引擎平行分析，加快速度
let preJob = null;

async function prepare({ key, sans, depth, existing }) {
  if (preJob?.key === key) return;
  if (preJob) preJob.cancelled = true;
  const job = { key, cancelled: false };
  preJob = job;
  preEngines ||= Array.from({ length: poolSize() }, () => new Engine());
  const { fens } = replay(sans);
  const total = fens.length;
  // 進度由 background 存進 storage（offscreen 文件不能直接用 storage）
  const report = (count, evals) =>
    chrome.runtime.sendMessage({ type: 'pre-progress', key, data: { done: count === total, count, total, evals } });
  const evals = await analyseAll(preEngines, fens, { depth, multipv: 2 }, {
    start: existing?.evals || [],
    isCancelled: () => job.cancelled,
    onProgress: (count, prefix) => {
      if (count < total && count % 4 === 0) report(count, prefix);
    },
  });
  if (!job.cancelled) report(total, evals);
  if (preJob === job) preJob = null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'prepare') {
    prepare(msg);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'live') {
    live(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
});
