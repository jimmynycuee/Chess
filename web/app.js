// 手機網頁版首頁：從 chess.com 公開 API 抓最近的對局，選一盤後打開賽後復盤頁。
import { Chess } from '../vendor/chess.js';

const $ = (sel) => document.querySelector(sel);
const API = 'https://api.chess.com/pub/player';
const MAX_GAMES = 40;
const store = chrome.storage.local;

const params = new URLSearchParams(location.search);
let user = (await store.get('webUser')).webUser || '';
let lastOpened = (await store.get('webLastOpened')).webLastOpened || '';

$('#shortcut-url').textContent = `${new URL('./', location.href).href}?url=`;

function setStatus(text, kind = '') {
  const el = $('#status');
  el.hidden = !text;
  el.textContent = text || '';
  el.className = `status ${kind}`;
}

async function getJson(url) {
  const res = await fetch(url);
  if (res.status === 404) throw new Error('找不到這個帳號');
  if (!res.ok) throw new Error(`chess.com 回應錯誤（${res.status}）`);
  return res.json();
}

// 最近幾個月的對局，最新的在前面
async function recentGames(months = 2) {
  const { archives = [] } = await getJson(`${API}/${encodeURIComponent(user)}/games/archives`);
  const games = [];
  for (const url of archives.slice(-months).reverse()) {
    const { games: g = [] } = await getJson(url);
    games.push(...g.reverse());
  }
  return games.filter((g) => g.rules === 'chess' && g.pgn);
}

const gameId = (url) => url?.match(/\/game\/(?:live|daily)\/(\d+)/)?.[1] || url?.match(/(\d{6,})/)?.[1] || null;

function outcome(g) {
  const mine = g.white.username.toLowerCase() === user.toLowerCase() ? g.white : g.black;
  if (mine.result === 'win') return { text: 'W', cls: 'win' };
  if (['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'].includes(mine.result)) {
    return { text: 'D', cls: 'draw' };
  }
  return { text: 'L', cls: 'loss' };
}

const TIME_CLASS = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', daily: 'Daily' };

function renderGames(games) {
  $('#games-section').hidden = false;
  $('#games').innerHTML = '';
  for (const g of games.slice(0, MAX_GAMES)) {
    const meWhite = g.white.username.toLowerCase() === user.toLowerCase();
    const opp = meWhite ? g.black : g.white;
    const o = outcome(g);
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="result ${o.cls}">${o.text}</span>
      <span class="who"><b></b><span class="muted small"></span></span>
      <span class="when muted small"></span>`;
    li.querySelector('b').textContent = `vs ${opp.username}`;
    li.querySelector('.who .muted').textContent = `${meWhite ? '執白' : '執黑'}・${TIME_CLASS[g.time_class] || g.time_class}・對手 ${opp.rating}`;
    li.querySelector('.when').textContent = new Date(g.end_time * 1000).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    if (g.url === lastOpened) li.classList.add('seen');
    li.addEventListener('click', () => openGame(g));
    $('#games').append(li);
  }
}

// 轉成復盤頁用的格式後打開；同一盤之前分析過就直接沿用
async function openGame(g) {
  const key = `game:${gameId(g.url) || g.end_time}`;
  const existing = (await store.get(key))[key];
  let game = existing;
  if (!game) {
    const chess = new Chess();
    chess.loadPgn(g.pgn);
    const result = g.white.result === 'win' ? '1-0' : g.black.result === 'win' ? '0-1' : '½-½';
    game = {
      white: g.white.username,
      black: g.black.username,
      me: g.white.username.toLowerCase() === user.toLowerCase() ? 'w' : 'b',
      result,
      sans: chess.history(),
      url: g.url,
      date: new Date(g.end_time * 1000).toISOString(),
    };
  }
  game.openedAt = Date.now();
  await store.set({ [key]: game, webLastOpened: g.url });
  location.href = `../src/report.html?id=${encodeURIComponent(key)}`;
}

// ---------- 個人資料：頭像、名稱、國家、各時制 Elo 與勝率 ----------
let regionNames = null;
try {
  regionNames = new Intl.DisplayNames(['zh-TW'], { type: 'region' });
} catch {
  // 舊瀏覽器就直接顯示國家代碼
}
const countryName = (url) => {
  const code = url?.split('/').pop();
  if (!code) return '';
  try {
    return regionNames?.of(code) || code;
  } catch {
    return code; // chess.com 自訂的代碼（例如 XX）
  }
};

const RATING_KINDS = [
  ['chess_rapid', 'Rapid'],
  ['chess_blitz', 'Blitz'],
  ['chess_bullet', 'Bullet'],
  ['chess_daily', 'Daily'],
];

async function loadProfile() {
  const u = encodeURIComponent(user);
  const [p, stats] = await Promise.all([
    getJson(`${API}/${u}`),
    getJson(`${API}/${u}/stats`).catch(() => ({})),
  ]);
  $('#profile').hidden = false;
  const name = p.username || user;
  $('#pf-user').textContent = name;
  $('#pf-initial').textContent = name[0]?.toUpperCase() || '?';
  const img = $('#pf-img');
  if (p.avatar) {
    img.src = p.avatar;
    img.hidden = false;
    img.onerror = () => (img.hidden = true);
  } else img.hidden = true;
  $('#pf-title').hidden = !p.title;
  $('#pf-title').textContent = p.title || '';
  $('#pf-real').textContent = p.name || '';
  $('#pf-real').hidden = !p.name;
  const meta = [countryName(p.country)];
  if (p.joined) meta.push(`${new Date(p.joined * 1000).toLocaleDateString('zh-TW', { year: 'numeric', month: 'numeric' })} 加入`);
  if (p.followers) meta.push(`${p.followers} 位追蹤者`);
  $('#pf-meta').textContent = meta.filter(Boolean).join('・');

  const box = $('#pf-ratings');
  box.innerHTML = '';
  for (const [key, label] of RATING_KINDS) {
    const s = stats[key];
    if (!s?.last) continue;
    const { win = 0, loss = 0, draw = 0 } = s.record || {};
    const total = win + loss + draw;
    const el = document.createElement('div');
    el.className = 'pf-rating';
    el.innerHTML = `
      <div class="muted small"></div>
      <div class="pf-elo"></div>
      <div class="pf-rate"></div>
      <div class="muted small"></div>
      <div class="muted small"></div>`;
    el.children[0].textContent = label;
    el.children[1].textContent = s.last.rating;
    el.children[2].textContent = total ? `勝率 ${Math.round((win / total) * 100)}%` : '尚無對局';
    el.children[3].textContent = `${win}W ${loss}L ${draw}D`;
    el.children[4].textContent = s.best ? `最高 ${s.best.rating}` : '\u00a0';
    box.append(el);
  }
  box.hidden = !box.children.length;
}

// 最近 10 盤的 W / L / D
function renderForm(games) {
  const el = $('#pf-form');
  const last = games.slice(0, 10);
  el.hidden = !last.length || $('#profile').hidden;
  el.innerHTML = `<span class="muted small">最近 ${last.length} 盤</span>`;
  for (const g of last) {
    const o = outcome(g);
    const b = document.createElement('span');
    b.className = `result mini ${o.cls}`;
    b.textContent = o.text;
    el.append(b);
  }
}

async function load({ autoOpen = true } = {}) {
  setStatus('正在讀取你的對局…');
  const profile = loadProfile().catch(() => {
    $('#profile').hidden = true; // 個人資料讀不到不影響對局列表
  });
  let games;
  try {
    games = await recentGames(params.get('url') ? 3 : 2);
  } catch (e) {
    setStatus(`${e.message}。請確認帳號，或稍後再試。`, 'error');
    $('#user-form').hidden = false;
    return;
  }
  if (!games.length) {
    setStatus('最近兩個月沒有找到對局。', 'error');
    return;
  }
  renderGames(games);
  profile.then(() => renderForm(games));

  // 從 chess.com App 分享過來的那一盤
  const shared = gameId(params.get('url'));
  if (shared) {
    history.replaceState(null, '', location.pathname);
    const g = games.find((x) => gameId(x.url) === shared);
    if (g) return openGame(g);
    setStatus('還找不到你分享的那盤棋：chess.com 的公開資料可能還沒更新，過幾分鐘再試一次。', 'error');
    return;
  }

  // 有新下完的對局就自動打開
  if (autoOpen && games[0].url !== lastOpened) {
    setStatus(`正在打開最新一盤：vs ${games[0].white.username.toLowerCase() === user.toLowerCase() ? games[0].black.username : games[0].white.username}…`);
    return openGame(games[0]);
  }
  setStatus('');
}

$('#user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  user = $('#user-input').value.trim();
  if (!user) return;
  $('#profile').hidden = true;
  $('#games-section').hidden = true;
  await store.set({ webUser: user });
  $('#user-form').hidden = true;
  $('#change-user').hidden = false;
  load();
});
$('#change-user').addEventListener('click', () => {
  $('#user-form').hidden = false;
  $('#user-input').value = user;
  $('#user-input').focus();
});
$('#refresh').addEventListener('click', () => load({ autoOpen: false }));

if (user) {
  $('#change-user').hidden = false;
  load();
} else {
  $('#user-form').hidden = false;
}
