// 用規則把引擎結果翻成初學者看得懂的話：哪個子沒保護、捉雙、殺棋、子力得失。
import { Chess } from '../vendor/chess.js';

const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
const NAME = { p: '兵', n: '騎士', b: '主教', r: '城堡', q: '皇后', k: '國王' };
const opp = (c) => (c === 'w' ? 'b' : 'w');

export const pieceName = (type) => NAME[type];

function uciMove(chess, uci) {
  try {
    return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' });
  } catch {
    return null;
  }
}

function pieces(chess, color) {
  const out = [];
  for (const row of chess.board()) for (const p of row) if (p && p.color === color) out.push(p);
  return out;
}

// 子力差（color 的子力 − 對方子力），國王不計。
function balance(chess, color) {
  let s = 0;
  for (const row of chess.board()) {
    for (const p of row) {
      if (!p || p.type === 'k') continue;
      s += (p.color === color ? 1 : -1) * VAL[p.type];
    }
  }
  return s;
}

// 沿著引擎變化走下去，回傳 color 的子力變化（停在吃子交換結束後）。
function materialSwing(fen, uciLine, color, maxPlies = 8) {
  const chess = new Chess(fen);
  const start = balance(chess, color);
  let settled = 0;
  for (let i = 0; i < Math.min(maxPlies, uciLine.length); i++) {
    const m = uciMove(chess, uciLine[i]);
    if (!m) break;
    const next = uciLine[i + 1];
    const nextIsCapture = next && chess.get(next.slice(2, 4));
    if (!nextIsCapture) settled = balance(chess, color) - start;
  }
  return settled;
}

// 這個子會不會被白白吃掉：沒人保護，或攻擊者比它便宜。
function isHanging(chess, sq) {
  const p = chess.get(sq);
  if (!p || p.type === 'k') return false;
  const attackers = chess.attackers(sq, opp(p.color));
  if (!attackers.length) return false;
  const defenders = chess.attackers(sq, p.color);
  if (!defenders.length) return true;
  const cheapest = Math.min(...attackers.map((a) => VAL[chess.get(a).type]));
  return cheapest < VAL[p.type];
}

function hangingPieces(chess, color) {
  const out = [];
  for (const row of chess.board()) {
    for (const p of row) {
      if (p && p.color === color && isHanging(chess, p.square)) out.push(p);
    }
  }
  return out;
}

// sq 上的子同時攻擊了哪些比它值錢（或沒保護、或國王）的敵子。
function forkTargets(chess, sq) {
  const me = chess.get(sq);
  if (!me) return [];
  return pieces(chess, opp(me.color)).filter((t) => {
    if (!chess.attackers(t.square, me.color).includes(sq)) return false;
    return t.type === 'k' || VAL[t.type] > VAL[me.type] || !chess.attackers(t.square, t.color).length;
  });
}

const list = (ps) => ps.map((p) => `${NAME[p.type]}（${p.square}）`).join('和');

function sanLine(fen, uciLine, max = 5) {
  const chess = new Chess(fen);
  const out = [];
  for (const u of uciLine.slice(0, max)) {
    const m = uciMove(chess, u);
    if (!m) break;
    out.push(m.san);
  }
  return out.join(' ');
}

function mateFor(score, color) {
  if (score.mate === undefined || score.mate === null || score.mate === 0) return null;
  const forWhite = score.mate > 0;
  return (forWhite ? 'w' : 'b') === color ? Math.abs(score.mate) : null;
}

// 為什麼這步不好。before/after 為引擎分析（白方視角），mover 為走子方。
export function explainMistake({ fenBefore, uci, after, mover }) {
  const reasons = [];
  const chess = new Chess(fenBefore);
  const played = uciMove(chess, uci);
  if (!played) return reasons;
  const fenAfter = chess.fen();

  const mateAgainst = mateFor(after.score, opp(mover));
  if (mateAgainst) {
    const line = sanLine(fenAfter, after.pv, mateAgainst * 2 - 1);
    reasons.push(mateAgainst === 1 ? `這步讓對手可以直接將死你（${line}）。` : `這步之後對手有 ${mateAgainst} 步殺：${line}。`);
    return reasons;
  }

  if (isHanging(chess, played.to)) {
    reasons.push(`你把${NAME[played.piece]}走到 ${played.to}，那裡保護不夠，會被對手吃掉。`);
  } else {
    const before = new Chess(fenBefore);
    const wasHanging = new Set(hangingPieces(before, mover).map((p) => p.square));
    const newly = hangingPieces(chess, mover).filter((p) => !wasHanging.has(p.square));
    if (newly.length) reasons.push(`這步之後你的${list(newly.slice(0, 2))}變得沒有保護。`);
  }

  const reply = after.pv?.[0];
  if (reply && !mateAgainst) {
    const c2 = new Chess(fenAfter);
    const m = uciMove(c2, reply);
    if (m) {
      const targets = forkTargets(c2, m.to);
      if (targets.length >= 2) {
        reasons.push(`對手可以走 ${m.san}，用${NAME[m.piece]}同時攻擊你的${list(targets.slice(0, 2))}（捉雙）。`);
      } else if (m.captured && !reasons.length) {
        reasons.push(`對手可以走 ${m.san} 吃掉你的${NAME[m.captured]}。`);
      } else if (!reasons.length) {
        const already = new Set(hangingPieces(new Chess(fenAfter), mover).map((p) => p.square));
        const threatened = hangingPieces(c2, mover).filter((p) => !already.has(p.square));
        if (threatened.length) reasons.push(`對手可以走 ${m.san}，攻擊你的${list(threatened.slice(0, 2))}。`);
      }
    }
  }

  if (!mateAgainst && after.pv?.length) {
    const swing = materialSwing(fenAfter, after.pv, mover);
    if (swing <= -2 && reasons.length < 2) {
      reasons.push(`照最好的應對下去，你會少掉約 ${-swing} 分子力（${sanLine(fenAfter, after.pv)}）。`);
    }
  }
  if (!reasons.length && reply) {
    reasons.push(`對手最好的應對是 ${sanLine(fenAfter, [reply], 1)}，之後你的局面會變差。`);
  }
  return reasons;
}

// 更好的那步好在哪裡，並附上練習用的分段提示。
export function explainBest({ fenBefore, before, mover }) {
  const best = before.bestmove;
  if (!best) return null;
  const chess = new Chess(fenBefore);
  const target = chess.get(best.slice(2, 4));
  const targetHanging = target && isHanging(chess, best.slice(2, 4));
  const m = uciMove(chess, best);
  if (!m) return null;
  const line = sanLine(fenBefore, before.pv.length ? before.pv : [best]);
  const mate = mateFor(before.score, mover);
  const forks = forkTargets(chess, m.to);
  const swing = materialSwing(fenBefore, before.pv.length ? before.pv : [best], mover);

  let theme;
  let text;
  if (mate) {
    theme = 'mate';
    text = mate === 1 ? `${m.san} 直接將死！` : `${m.san} 開始可以 ${mate} 步將死對手：${line}`;
  } else if (m.captured && targetHanging) {
    theme = 'free';
    text = `${m.san} 可以直接吃掉對手沒保護好的${NAME[m.captured]}。`;
  } else if (forks.length >= 2) {
    theme = 'fork';
    text = `${m.san} 捉雙：${NAME[m.piece]}同時攻擊對手的${list(forks.slice(0, 2))}。`;
  } else if (swing >= 2) {
    theme = 'win';
    text = `${m.san} 之後可以贏得約 ${swing} 分子力：${line}`;
  } else {
    theme = 'quiet';
    text = `${m.san} 能保持比較好的局面：${line}`;
  }

  const hint1 = {
    mate: '這裡有殺棋！先看看所有能將軍的走法。',
    free: '對手有一個子沒保護好，找找看。',
    fork: '找找看有沒有能同時攻擊兩個子的走法。',
    win: '這裡有辦法贏得子力，看看吃子和將軍的走法。',
    quiet: '先想想：對手在威脅什麼？你的子都安全嗎？',
  }[theme];
  return {
    theme,
    san: m.san,
    text,
    hints: [hint1, `動你的${NAME[m.piece]}（${m.from}）。`, `答案是 ${m.san}。`],
  };
}
