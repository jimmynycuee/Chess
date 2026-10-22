import { Chess } from '../vendor/chess.js';

// Lichess 使用的評分 → 勝率換算（cp 以白方視角）。
export function winPercentFromCp(cp) {
  const clamped = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
}

// score: { cp } 或 { mate }，皆為白方視角。回傳白方勝率 0–100。
export function whiteWinPercent(score) {
  if (score.mate !== undefined && score.mate !== null) {
    if (score.mate === 0) return score.mateWinner === 'w' ? 100 : 0;
    return score.mate > 0 ? 100 : 0;
  }
  return winPercentFromCp(score.cp);
}

// Lichess 的單步準確率公式，輸入為走子方的勝率損失（百分點）。
export function moveAccuracy(winLoss) {
  const acc = 103.1668 * Math.exp(-0.04354 * Math.max(0, winLoss)) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

// 整局準確率：算術平均與調和平均的平均，讓少數大失誤也有份量。
export function gameAccuracy(accs) {
  if (!accs.length) return null;
  const mean = accs.reduce((a, b) => a + b, 0) / accs.length;
  const harmonic = accs.length / accs.reduce((a, b) => a + 1 / Math.max(b, 1), 0);
  return (mean + harmonic) / 2;
}

export const CLASSES = {
  best: { label: 'Best', symbol: '★', color: '#5c9e31' },
  excellent: { label: 'Excellent', symbol: '!', color: '#7fa650' },
  good: { label: 'Good', symbol: '✓', color: '#95b776' },
  book: { label: 'Book', symbol: 'B', color: '#a88865' },
  inaccuracy: { label: 'Inaccuracy', symbol: '?!', color: '#e6b422' },
  mistake: { label: 'Mistake', symbol: '?', color: '#e58f2a' },
  blunder: { label: 'Blunder', symbol: '??', color: '#ca3431' },
};

// lossPct：走子方勝率損失；isBest：與引擎首選相同。
export function classifyMove(lossPct, isBest, ply) {
  if (isBest) return 'best';
  if (ply <= 8 && lossPct < 3) return 'book';
  if (lossPct < 2) return 'excellent';
  if (lossPct < 5) return 'good';
  if (lossPct < 10) return 'inaccuracy';
  if (lossPct < 20) return 'mistake';
  return 'blunder';
}

export function formatScore(score) {
  if (score.mate !== undefined && score.mate !== null) {
    if (score.mate === 0) return '#';
    return (score.mate > 0 ? '+M' : '-M') + Math.abs(score.mate);
  }
  const v = score.cp / 100;
  return (v > 0 ? '+' : '') + v.toFixed(1);
}

// 把 SAN 序列回放成每一步的 FEN；遇到非法著法就截斷。
export function replay(sans) {
  const chess = new Chess();
  const fens = [chess.fen()];
  const moves = [];
  for (const san of sans) {
    let move;
    try {
      move = chess.move(san, { strict: false });
    } catch {
      break;
    }
    if (!move) break;
    moves.push({ san: move.san, uci: move.from + move.to + (move.promotion || ''), color: move.color });
    fens.push(chess.fen());
  }
  return { fens, moves };
}

// UCI 著法列表 → SAN（給 PV 顯示用）。
export function uciLineToSan(fen, uciMoves, max = 6) {
  const chess = new Chess(fen);
  const out = [];
  for (const uci of uciMoves.slice(0, max)) {
    try {
      const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      out.push(m.san);
    } catch {
      break;
    }
  }
  return out;
}

// 把引擎結果套到「這一步」：before = 走之前局面的分析，after = 走之後局面的分析。
export function evaluateMove({ before, after, move, ply }) {
  const winBeforeW = whiteWinPercent(before.score);
  const winAfterW = whiteWinPercent(after.score);
  const sign = move.color === 'w' ? 1 : -1;
  const moverBefore = move.color === 'w' ? winBeforeW : 100 - winBeforeW;
  const moverAfter = move.color === 'w' ? winAfterW : 100 - winAfterW;
  const loss = Math.max(0, moverBefore - moverAfter);
  const isBest = before.bestmove === move.uci;
  return {
    ply,
    san: move.san,
    uci: move.uci,
    color: move.color,
    winBeforeW,
    winAfterW,
    deltaMover: sign * (winAfterW - winBeforeW),
    loss,
    accuracy: moveAccuracy(loss),
    cls: classifyMove(loss, isBest, ply),
    bestUci: before.bestmove,
  };
}
