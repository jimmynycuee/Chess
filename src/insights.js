// 賽後總結的進階分析：開局、三階段表現、好棋、錯誤統計、對局故事、練習建議。
import { CLASSES, gameAccuracy, whiteWinPercent } from './analysis.js';
import { isSacrifice, MISTAKE_TYPES } from './explain.js';

const BAD = ['inaccuracy', 'mistake', 'blunder'];
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const moverWin = (winWhite, c) => (c === 'w' ? winWhite : 100 - winWhite);
const moveNo = (ply) => Math.ceil(ply / 2);
const label = (r) => `${moveNo(r.ply)}${r.color === 'w' ? '.' : '...'} ${r.san}`;

// ---------- 開局 ----------

const OPENING_ZH = {
  'Italian Game': '義大利開局',
  'Ruy Lopez': '西班牙開局',
  'Scotch Game': '蘇格蘭開局',
  'Four Knights Game': '四馬開局',
  'Three Knights Opening': '三馬開局',
  'Petrov\'s Defense': '俄羅斯防禦（彼得羅夫防禦）',
  'Philidor Defense': '菲利多爾防禦',
  'King\'s Gambit': '王翼棄兵',
  'King\'s Gambit Accepted': '王翼棄兵（接受）',
  'King\'s Gambit Declined': '王翼棄兵（拒絕）',
  'Vienna Game': '維也納開局',
  'Bishop\'s Opening': '主教開局',
  'Center Game': '中心開局',
  'Danish Gambit': '丹麥棄兵',
  'Ponziani Opening': '蓬齊亞尼開局',
  'King\'s Pawn Game': '王兵開局',
  'King\'s Knight Opening': '王翼騎士開局',
  'Sicilian Defense': '西西里防禦',
  'French Defense': '法蘭西防禦',
  'Caro-Kann Defense': '卡羅-康防禦',
  'Scandinavian Defense': '斯堪的納維亞防禦',
  'Alekhine Defense': '阿廖欣防禦',
  'Pirc Defense': '皮爾茨防禦',
  'Modern Defense': '現代防禦',
  'Owen Defense': '歐文防禦',
  'Nimzowitsch Defense': '尼姆佐維奇防禦',
  'Queen\'s Gambit Declined': '后翼棄兵（拒絕）',
  'Queen\'s Gambit Accepted': '后翼棄兵（接受）',
  'Queen\'s Gambit': '后翼棄兵',
  'Slav Defense': '斯拉夫防禦',
  'Semi-Slav Defense': '半斯拉夫防禦',
  'Queen\'s Pawn Game': '后兵開局',
  'London System': '倫敦體系',
  'Indian Defense': '印度防禦',
  'King\'s Indian Defense': '古印度防禦',
  'King\'s Indian Attack': '古印度攻擊',
  'Nimzo-Indian Defense': '尼姆佐-印度防禦',
  'Queen\'s Indian Defense': '新印度防禦',
  'Grünfeld Defense': '格林菲爾德防禦',
  'Benoni Defense': '別諾尼防禦',
  'Dutch Defense': '荷蘭防禦',
  'Catalan Opening': '卡塔蘭開局',
  'English Opening': '英國式開局',
  'Réti Opening': '列蒂開局',
  'Zukertort Opening': '祖克托特開局',
  'Bird Opening': '伯德開局',
  'Englund Gambit': '恩格倫棄兵',
  'Englund Gambit Complex': '恩格倫棄兵',
  'Van Geet Opening': '范吉特開局',
  'Hungarian Opening': '匈牙利開局',
  'Nimzo-Larsen Attack': '尼姆佐-拉森攻擊',
  'Elephant Gambit': '大象棄兵',
  'Latvian Gambit': '拉脫維亞棄兵',
  'Trompowsky Attack': '特羅姆波夫斯基攻擊',
  'Colle System': '科勒體系',
  'Blackmar-Diemer Gambit': '布萊克瑪-迪默棄兵',
  'Budapest Defense': '布達佩斯防禦',
  'Old Indian Defense': '老印度防禦',
};

const posKey = (fen) => fen.split(' ').slice(0, 4).join(' ');

// 找出這盤的開局名稱，以及最後一個還在開局庫裡的半步。
export function openingInfo(fens, table) {
  let found = null;
  let lastBookPly = 0;
  const bookPlies = new Set();
  for (let i = 1; i < fens.length; i++) {
    const hit = table[posKey(fens[i])];
    if (!hit) {
      if (i - lastBookPly > 2) break; // 離開開局庫幾步後就不再找
      continue;
    }
    found = hit;
    lastBookPly = i;
    bookPlies.add(i);
  }
  if (!found) return { bookPlies, lastBookPly: 0 };
  const [eco, name] = found;
  const family = name.split(':')[0];
  return { eco, name, family, zh: OPENING_ZH[family] || null, lastBookPly, bookPlies };
}

// ---------- 三階段 ----------

function nonPawnMaterial(fen) {
  let total = 0;
  for (const ch of fen.split(' ')[0]) {
    const t = ch.toLowerCase();
    if ('nbrq'.includes(t)) total += VAL[t];
  }
  return total;
}

export const PHASES = { opening: '開局', middlegame: '中局', endgame: '殘局' };

// 每一步屬於哪個階段：前 10 步算開局；雙方子力（不含兵與國王）合計 ≤ 13 起算殘局。
export function phaseOf(results, fens) {
  let inEndgame = false;
  return results.map((r, i) => {
    if (!inEndgame && nonPawnMaterial(fens[i]) <= 13) inEndgame = true;
    if (inEndgame) return 'endgame';
    return r.ply <= 20 ? 'opening' : 'middlegame';
  });
}

export function phaseStats(results, phases, color) {
  const out = {};
  for (const key of Object.keys(PHASES)) {
    const mine = results.filter((r, i) => r.color === color && phases[i] === key);
    out[key] = {
      n: mine.length,
      acc: gameAccuracy(mine.map((r) => r.accuracy)),
      bad: mine.filter((r) => BAD.includes(r.cls)).length,
      worst: [...mine].sort((a, b) => b.loss - a.loss)[0] || null,
    };
  }
  const ranked = Object.entries(out).filter(([, s]) => s.n >= 3 && s.acc !== null);
  ranked.sort((a, b) => a[1].acc - b[1].acc);
  return { stats: out, weakest: ranked.length >= 2 ? ranked[0][0] : null };
}

// ---------- 你下得好的地方 ----------

export function goodMoves({ results, evals, fens, me, oppMistakeLoss }) {
  const out = [];
  results.forEach((r, i) => {
    if (r.color !== me) return;
    const prev = results[i - 1];
    const before = moverWin(r.winBeforeW, me);
    if (prev && prev.loss >= oppMistakeLoss && r.loss < 3) {
      out.push({ ply: r.ply, kind: 'punish', title: '抓住對手的失誤', text: `對手 ${label(prev)} 下錯了，你馬上用 ${r.san} 懲罰他。` });
      return;
    }
    if (r.uci !== r.bestUci || before > 97 || before < 3) return;
    if (isSacrifice(fens[i], r.uci)) {
      out.push({ ply: r.ply, kind: 'sac', title: '漂亮的棄子', text: `${r.san} 看起來在送子，其實是引擎認為最好的一步。` });
      return;
    }
    const second = evals[i].lines?.[1];
    const recapture = prev && prev.uci.slice(2, 4) === r.uci.slice(2, 4);
    if (second && !recapture) {
      const gap = before - moverWin(whiteWinPercent(second.score), me);
      if (gap >= 20) {
        out.push({ ply: r.ply, kind: 'only', title: '找到唯一好棋', text: `這裡只有 ${r.san} 能維持局面，第二好的走法勝率會少 ${gap.toFixed(0)}%，你找到了。` });
      }
    }
  });
  return out.slice(0, 6);
}

// ---------- 錯誤統計 ----------

export const MISSED_THEMES = {
  mate: '殺棋',
  free: '白吃對手的子',
  trade: '划算的交換',
  fork: '捉雙',
  pin: '牽制／串擊',
  discovered: '閃擊',
  win: '贏子的組合',
  promote: '升變',
};

export function mistakeStats(results, me) {
  const types = {};
  const missed = {};
  for (const r of results) {
    if (r.color !== me) continue;
    if (BAD.includes(r.cls) && r.whyTypes?.[0]) (types[r.whyTypes[0]] ||= []).push(r.ply);
    if (r.loss >= 5 && r.better && MISSED_THEMES[r.better.theme]) (missed[r.better.theme] ||= []).push(r.ply);
  }
  const toList = (obj, names) =>
    Object.entries(obj)
      .map(([k, plies]) => ({ key: k, name: names[k], plies }))
      .sort((a, b) => b.plies.length - a.plies.length);
  return { types: toList(types, MISTAKE_TYPES), missed: toList(missed, MISSED_THEMES) };
}

// ---------- 練習建議 ----------

const LICHESS = (theme) => `https://lichess.org/training/${theme}`;
const THEME_LINKS = {
  missed: {
    mate: ['mateIn2', '殺棋謎題'],
    free: ['hangingPiece', '吃掉沒保護的子'],
    trade: ['hangingPiece', '找出划算的吃子'],
    fork: ['fork', '捉雙謎題'],
    pin: ['pin', '牽制謎題'],
    discovered: ['discoveredAttack', '閃擊謎題'],
    win: ['advantage', '贏得優勢的謎題'],
    promote: ['promotion', '升變謎題'],
  },
  types: {
    mated: ['defensiveMove', '防守謎題：找出唯一的防守'],
    hang: ['hangingPiece', '沒保護的子'],
    fork: ['fork', '捉雙謎題（學會看出對手的捉雙）'],
    threat: ['defensiveMove', '防守謎題：先看對手的威脅'],
    material: ['hangingPiece', '沒保護的子'],
  },
  phase: {
    opening: ['opening', '開局階段的謎題'],
    middlegame: ['middlegame', '中局謎題'],
    endgame: ['endgame', '殘局謎題'],
  },
};

export function suggestions({ stats, phase, opening }) {
  const out = [];
  const seen = new Set();
  const push = (theme, title, why) => {
    if (seen.has(theme)) return;
    seen.add(theme);
    out.push({ title, why, url: LICHESS(theme) });
  };
  for (const m of stats.missed) {
    const [theme, title] = THEME_LINKS.missed[m.key];
    push(theme, title, `這盤你漏看了 ${m.plies.length} 次${m.name}的機會。`);
  }
  for (const t of stats.types) {
    const link = THEME_LINKS.types[t.key];
    if (link) push(link[0], link[1], `這盤有 ${t.plies.length} 次失誤是「${t.name}」。`);
  }
  if (phase.weakest) {
    const [theme, title] = THEME_LINKS.phase[phase.weakest];
    push(theme, title, `你在${PHASES[phase.weakest]}的準確率最低。`);
  }
  const list = out.slice(0, 3);
  if (opening?.family) {
    list.push({
      title: `認識${opening.zh || opening.family}`,
      why: '看看這個開局的常見下法和想法。',
      url: `https://lichess.org/opening/${encodeURIComponent(opening.family.replace(/'/g, '').replace(/\s+/g, '_'))}`,
    });
  }
  return list;
}

// ---------- 對局故事 ----------

function status(p) {
  if (p >= 65) return 'ahead';
  if (p <= 35) return 'behind';
  return 'even';
}

export function buildStory({ results, winW, evals, me, opening, result }) {
  const lines = [];
  const mine = (i) => moverWin(winW[i], me);
  const n = results.length;

  if (opening?.name) {
    const nm = opening.zh ? `${opening.zh}（${opening.name}）` : opening.name;
    const n = moveNo(opening.lastBookPly);
    lines.push(
      opening.lastBookPly <= 3
        ? `這盤下的是${nm}，不過第 ${n + 1} 步就離開了常見的開局下法。`
        : `這盤下的是${nm}，前 ${n} 步都還在常見的開局下法裡。`
    );
  }

  // 找出局勢真正轉變的時刻（新的狀態至少維持 2 個半步，或一直到棋局結束）。
  const changes = [];
  let cur = status(mine(0));
  for (let i = 1; i <= n; i++) {
    const s = status(mine(i));
    if (s === cur) continue;
    const holds = i === n || status(mine(Math.min(n, i + 1))) === s;
    if (!holds) continue;
    changes.push({ i, from: cur, to: s, r: results[i - 1], a: mine(i - 1), b: mine(i) });
    cur = s;
  }
  const key = [...changes].sort((x, y) => Math.abs(y.b - y.a) - Math.abs(x.b - x.a)).slice(0, 4).sort((x, y) => x.i - y.i);

  if (!key.length) {
    const s = status(mine(n));
    lines.push(
      s === 'even' ? '整盤棋雙方大致保持均勢，沒有出現決定性的失誤。' : s === 'ahead' ? '你從頭到尾都保持領先。' : '整盤你都處在比較被動的局面。'
    );
  }
  for (const c of key) {
    const who = c.r.color === me ? '你' : '對手';
    const tag = BAD.includes(c.r.cls) ? `（${CLASSES[c.r.cls].label}）` : '';
    let what;
    if (c.to === 'ahead') what = '你取得了優勢';
    else if (c.to === 'behind') what = '局勢轉為對你不利';
    else if (c.from === 'ahead') what = '你的優勢消失，回到均勢';
    else what = '你把局面扳了回來';
    lines.push(`第 ${moveNo(c.r.ply)} 步${who}走 ${c.r.san}${tag}，${what}（你的勝率 ${c.a.toFixed(0)}% → ${c.b.toFixed(0)}%）。`);
  }

  const missed = results.filter((r) => r.color === me && r.missed).length;
  if (missed) lines.push(`過程中你有 ${missed} 次錯失良機：對手下錯了，但你沒有抓住。`);

  const won = (result === '1-0' && me === 'w') || (result === '0-1' && me === 'b');
  const lost = (result === '1-0' && me === 'b') || (result === '0-1' && me === 'w');
  let peak = 0;
  let peakPly = 0;
  for (let i = 0; i <= n; i++) if (mine(i) > peak) [peak, peakPly] = [mine(i), i];
  if (peak >= 80 && !won && peakPly > 0) {
    lines.push(`你最好的時候勝率有 ${peak.toFixed(0)}%（第 ${moveNo(peakPly)} 步），可惜沒能把優勢轉成勝利。`);
  }
  const mated = evals[n]?.score.mate === 0;
  if (won) lines.push(mated ? '最後你將死對手，贏下這盤！' : '最後你贏下這盤！');
  else if (lost) lines.push(mated ? '最後被對手將死，輸掉這盤。' : '最後輸掉這盤。');
  else if (result === '½-½' || result === '1/2-1/2') lines.push('最後以和棋收場。');
  return lines;
}
