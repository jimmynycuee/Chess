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

const R = (type, text) => ({ type, text });

// 錯誤類型的中文名稱（賽後統計用）。
export const MISTAKE_TYPES = {
  mated: '讓對手有 Checkmate',
  hang: '子沒保護好、被吃',
  fork: '被對手 Fork',
  threat: '漏看對手的威脅',
  material: '交換後吃虧',
  positional: '局面變差（沒有立即戰術）',
};

// 這步是不是棄子：走到會被白白吃掉的格子，而且不是吃了更值錢的子。
export function isSacrifice(fenBefore, uci) {
  const chess = new Chess(fenBefore);
  const m = uciMove(chess, uci);
  if (!m || m.piece === 'p' || m.piece === 'k') return false;
  if (m.captured && VAL[m.captured] >= VAL[m.piece]) return false;
  return isHanging(chess, m.to);
}

// 為什麼這步不好。回傳 [{ type, text }]。before/after 為引擎分析（白方視角），mover 為走子方。
export function explainMistake({ fenBefore, uci, after, mover }) {
  const reasons = [];
  const chess = new Chess(fenBefore);
  const played = uciMove(chess, uci);
  if (!played) return reasons;
  const fenAfter = chess.fen();

  const mateAgainst = mateFor(after.score, opp(mover));
  if (mateAgainst) {
    const line = sanLine(fenAfter, after.pv, Math.min(mateAgainst * 2 - 1, 5)) + (mateAgainst > 3 ? ' …' : '');
    reasons.push(R('mated', mateAgainst === 1 ? `這步讓對手可以直接 Checkmate（${line}）。` : `這步之後對手有 Mate in ${mateAgainst}：${line}。`));
    return reasons;
  }

  if (isHanging(chess, played.to)) {
    reasons.push(R('hang', `你把${NAME[played.piece]}走到 ${played.to}，那裡保護不夠，會被對手吃掉。`));
  } else {
    const before = new Chess(fenBefore);
    const wasHanging = new Set(hangingPieces(before, mover).map((p) => p.square));
    const newly = hangingPieces(chess, mover).filter((p) => !wasHanging.has(p.square));
    if (newly.length) reasons.push(R('hang', `這步之後你的${list(newly.slice(0, 2))}變得沒有保護。`));
  }

  const reply = after.pv?.[0];
  if (reply && !mateAgainst) {
    const c2 = new Chess(fenAfter);
    const m = uciMove(c2, reply);
    if (m) {
      const targets = forkTargets(c2, m.to);
      if (targets.length >= 2) {
        reasons.push(R('fork', `對手可以走 ${m.san}，用${NAME[m.piece]}同時攻擊你的${list(targets.slice(0, 2))}（Fork）。`));
      } else if (m.captured && !reasons.length) {
        reasons.push(R('hang', `對手可以走 ${m.san} 吃掉你的${NAME[m.captured]}。`));
      } else if (!reasons.length) {
        const already = new Set(hangingPieces(new Chess(fenAfter), mover).map((p) => p.square));
        const threatened = hangingPieces(c2, mover).filter((p) => !already.has(p.square));
        if (threatened.length) reasons.push(R('threat', `對手可以走 ${m.san}，攻擊你的${list(threatened.slice(0, 2))}。`));
      }
    }
  }

  if (!mateAgainst && after.pv?.length) {
    const swing = materialSwing(fenAfter, after.pv, mover);
    if (swing <= -2 && reasons.length < 2) {
      reasons.push(R('material', `照最好的應對下去，你會少掉約 ${-swing} 分子力（${sanLine(fenAfter, after.pv)}）。`));
    }
  }
  if (!reasons.length && reply) {
    reasons.push(R('positional', `對手最好的應對是 ${sanLine(fenAfter, [reply], 1)}，之後你的局面會變差。`));
  }
  return reasons;
}

const DIRS = {
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
};
DIRS.q = [...DIRS.r, ...DIRS.b];
const sqName = (f, r) => String.fromCharCode(97 + f) + (r + 1);
const fileOf = (sq) => sq.charCodeAt(0) - 97;
const rankOf = (sq) => Number(sq[1]) - 1;

// 從 sq 上的長距離子（城堡、主教、皇后）往各方向看，找牽制與串擊。
function linePressure(chess, sq) {
  const me = chess.get(sq);
  if (!me || !DIRS[me.type]) return null;
  for (const [df, dr] of DIRS[me.type]) {
    let f = fileOf(sq) + df;
    let r = rankOf(sq) + dr;
    const hit = [];
    while (f >= 0 && f < 8 && r >= 0 && r < 8 && hit.length < 2) {
      const p = chess.get(sqName(f, r));
      if (p) hit.push({ ...p, square: sqName(f, r) });
      f += df;
      r += dr;
    }
    if (hit.length < 2 || hit[0].color === me.color || hit[1].color === me.color) continue;
    const [front, back] = hit;
    // 前面的子如果能直接把攻擊者吃掉（而且不虧），就不算真的牽制。
    if (chess.attackers(sq, front.color).includes(front.square) && VAL[front.type] <= VAL[me.type]) continue;
    // 後面的子要真的有危險：是國王、比攻擊者值錢，或沒有保護。
    const backAtRisk =
      back.type === 'k' || VAL[back.type] > VAL[me.type] || !chess.attackers(back.square, back.color).length;
    if (!backAtRisk) continue;
    if (back.type === 'k' || VAL[back.type] > VAL[front.type]) {
      return back.type === 'k'
        ? `Pin：對手的${NAME[front.type]}（${front.square}）不能動，因為後面是國王。`
        : `Pin：對手的${NAME[front.type]}（${front.square}）動了，後面的${NAME[back.type]}（${back.square}）就會被吃。`;
    }
    if ((front.type === 'k' || VAL[front.type] > VAL[back.type]) && VAL[back.type] >= 3) {
      return `Skewer：先攻擊對手的${NAME[front.type]}，它讓開之後就能吃到後面的${NAME[back.type]}（${back.square}）。`;
    }
  }
  return null;
}

// 走完後，除了走動的子以外，有沒有其他子因為路線打開而攻擊到對手的重要子。
function discoveredAttack(before, after, moveTo, mover) {
  for (const t of pieces(after, opp(mover))) {
    if (t.type !== 'k' && VAL[t.type] < 3) continue;
    const was = new Set(before.attackers(t.square, mover));
    const fresh = after.attackers(t.square, mover).filter((a) => a !== moveTo && !was.has(a));
    if (fresh.length) {
      const by = after.get(fresh[0]);
      return { by, target: t };
    }
  }
  return null;
}

function isPassedPawn(chess, sq, color) {
  const f = fileOf(sq);
  const r = rankOf(sq);
  for (const p of pieces(chess, opp(color))) {
    if (p.type !== 'p' || Math.abs(fileOf(p.square) - f) > 1) continue;
    const pr = rankOf(p.square);
    if (color === 'w' ? pr > r : pr < r) return false;
  }
  return true;
}

function isEndgame(chess) {
  let total = 0;
  for (const row of chess.board()) for (const p of row) if (p && p.type !== 'p' && p.type !== 'k') total += VAL[p.type];
  return total <= 14;
}

const centerDist = (sq) => Math.max(Math.abs(fileOf(sq) - 3.5), Math.abs(rankOf(sq) - 3.5));

// 更好的那步好在哪裡：回傳最多 3 個理由，並附上練習用的分段提示。
// playedAfter（選填）：實戰那步之後的評分，用來說明「避開了什麼」。
export function explainBest({ fenBefore, before, mover, playedAfter = null }) {
  const best = before.bestmove;
  if (!best) return null;
  const pre = new Chess(fenBefore);
  const chess = new Chess(fenBefore);
  const target = chess.get(best.slice(2, 4));
  const targetHanging = target && isHanging(chess, best.slice(2, 4));
  const m = uciMove(chess, best);
  if (!m) return null;
  const pv = before.pv.length ? before.pv : [best];
  const line = sanLine(fenBefore, pv);
  const mate = mateFor(before.score, mover);
  const swing = materialSwing(fenBefore, pv, mover);
  const P = NAME[m.piece];

  // 依重要程度排序的候選理由：[主題, 說明]
  const found = [];
  const PRIORITY = ['mate', 'avoidmate', 'promote', 'free', 'trade', 'fork', 'pin', 'discovered', 'win', 'defend', 'threat',
    'check', 'castle', 'develop', 'center', 'passed', 'king', 'quiet'];
  const add = (theme, text) => {
    if (!found.some((f) => f.theme === theme)) found.push({ theme, text });
  };

  if (mate) add('mate', mate === 1 ? `${m.san} 直接 Checkmate！` : `${m.san} 開始可以 Mate in ${mate}：${line}。`);
  if (m.promotion) add('promote', `Promotion：兵走到底線變成${NAME[m.promotion]}，多了一個強力的子。`);
  if (m.captured && targetHanging) add('free', `可以直接吃掉對手沒保護好的${NAME[m.captured]}（${m.to}），白白多一個子。`);
  else if (m.captured && VAL[m.captured] > VAL[m.piece]) add('trade', `用${P}換對手更值錢的${NAME[m.captured]}，這筆交換你賺到。`);
  else if (m.captured && pieces(pre, mover).some((p) => pre.attackers(p.square, opp(mover)).includes(m.to))) {
    const victims = pieces(pre, mover)
      .filter((p) => pre.attackers(p.square, opp(mover)).includes(m.to))
      .sort((a, b) => VAL[b.type] - VAL[a.type]);
    add('trade', `吃掉對手很活躍的${NAME[m.captured]}（${m.to}），它原本在攻擊你的${list(victims.slice(0, 2))}。`);
  }

  const forks = forkTargets(chess, m.to);
  if (forks.length >= 2) add('fork', `Fork：${P}同時攻擊對手的${list(forks.slice(0, 2))}，對手只能救一個。`);
  const lineHit = linePressure(chess, m.to);
  if (lineHit) add('pin', lineHit);
  const disc = discoveredAttack(pre, chess, m.to, mover);
  if (disc) add('discovered', `Discovered Attack：${P}讓開路線，讓你的${NAME[disc.by.type]}攻擊對手的${NAME[disc.target.type]}（${disc.target.square}）。`);

  if (!mate && swing >= 2 && !found.some((f) => ['free', 'trade', 'fork', 'promote'].includes(f.theme))) {
    add('win', `照這個變化下去可以贏得約 ${swing} 分子力：${line}。`);
  }

  if (playedAfter && mateFor(playedAfter, opp(mover)) && !mateFor(before.score, opp(mover))) {
    add('avoidmate', `避開了對手的 Checkmate：你實戰那步之後，對手有 Mate in ${mateFor(playedAfter, opp(mover))}。`);
  }
  const hangingBefore = hangingPieces(pre, mover);
  const stillHanging = new Set(hangingPieces(chess, mover).map((p) => p.square));
  const saved = hangingBefore.filter((p) => !stillHanging.has(p.square) && p.square !== m.to);
  if (hangingBefore.some((p) => p.square === m.from) && !isHanging(chess, m.to)) {
    add('defend', `你的${P}原本在 ${m.from} 被攻擊，這步把它移到安全的地方。`);
  } else if (saved.length && !m.captured) {
    add('defend', `保護了原本被攻擊的${list(saved.slice(0, 2))}。`);
  }

  if (forks.length === 1 && forks[0].type !== 'k' && isHanging(chess, forks[0].square) && !found.some((f) => f.theme === 'pin')) {
    add('threat', `攻擊對手的${NAME[forks[0].type]}（${forks[0].square}），逼對手花一步去處理。`);
  }
  if (m.san.includes('+') && !found.length) {
    add('check', m.captured
      ? `吃掉對手的${NAME[m.captured]}還順便將軍，對手只能先處理國王，來不及吃回來。`
      : '將軍，逼對手先處理國王，你可以搶到主動權。');
  }

  const moveNo = Number(fenBefore.split(' ')[5]);
  if (m.flags.includes('k') || m.flags.includes('q')) {
    add('castle', 'Castling：國王躲到安全的角落，城堡也能出來參戰。');
  } else if (moveNo <= 12 && (m.piece === 'n' || m.piece === 'b') && rankOf(m.from) === (mover === 'w' ? 0 : 7)) {
    add('develop', `Development：把${P}從底線走出來，開局要盡快讓子都動起來。`);
  }
  if (!m.captured && ['d4', 'd5', 'e4', 'e5'].includes(m.to) && (m.piece === 'p' || m.piece === 'n')) {
    add('center', `Center：佔領中心 ${m.to}，中心的子能控制更多格子，也讓其他子更好出動。`);
  }
  if (m.piece === 'p' && !m.promotion && isPassedPawn(chess, m.to, mover)) {
    add('passed', `Passed Pawn：前面已經沒有對手的兵能擋，越接近底線越危險。`);
  }
  if (m.piece === 'k' && isEndgame(chess) && centerDist(m.to) < centerDist(m.from)) {
    add('king', '殘局中把國王走向中心：子少的時候，國王也是重要的戰力。');
  }

  if (!found.length) {
    add('quiet', `這步沒有立刻的戰術，但讓棋子站到更好的位置。引擎接下來的計畫：${line}。`);
  }

  found.sort((a, b) => PRIORITY.indexOf(a.theme) - PRIORITY.indexOf(b.theme));
  const reasons = found.slice(0, 3).map((f) => f.text);
  const theme = found[0].theme;
  const hint1 = {
    mate: '這裡有 Checkmate！先看看所有能將軍的走法。',
    promote: '你的兵快到底線了。',
    free: '對手有一個子沒保護好，找找看。',
    trade: '看看有沒有划算的吃子。',
    fork: '找找看有沒有 Fork：同時攻擊兩個子的走法。',
    pin: '找一條直線或斜線，攻擊對手排在一起的兩個子（Pin / Skewer）。',
    discovered: '移開一個子，讓後面的子發動攻擊（Discovered Attack）。',
    win: '這裡有辦法贏得子力，看看吃子和將軍的走法。',
    avoidmate: '小心！對手有 Checkmate 的威脅，先擋住它。',
    defend: '你有子正被攻擊，先處理它。',
    threat: '找一步能攻擊對手子力的走法。',
    check: '看看將軍的走法。',
    castle: '國王還在中間，考慮讓它更安全。',
    develop: '還有沒出動的子嗎？',
    center: '想想中心的四個格子。',
    passed: '你的兵能往前推嗎？',
    king: '殘局時國王也是戰力。',
    quiet: '先想想：對手在威脅什麼？你哪個子位置最差？',
  }[theme];
  return {
    theme,
    san: m.san,
    text: `${m.san}：${reasons[0]}`,
    reasons,
    line,
    hints: [hint1, `動你的${P}（${m.from}）。`, `答案是 ${m.san}。`],
    // 給 Show Moves 演示用：起始局面與這一串連續手法
    fen: fenBefore,
    combo: comboLine(fenBefore, pv, theme === 'quiet' ? 4 : 8),
  };
}

// 從引擎變化中取出要演示的連續手法：到最後一次吃子／將軍／升變之後，再多走一步對方的回應。
function comboLine(fen, pv, max) {
  const chess = new Chess(fen);
  const out = [];
  let lastTactic = 0;
  for (const uci of pv.slice(0, max)) {
    const m = uciMove(chess, uci);
    if (!m) break;
    out.push(uci);
    if (m.captured || m.promotion || m.san.includes('+') || m.san.includes('#')) lastTactic = out.length;
  }
  return out.slice(0, Math.min(out.length, Math.max(3, lastTactic + 1)));
}
