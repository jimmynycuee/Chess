import { loadSettings } from './settings.js';

const OFFSCREEN_URL = 'src/offscreen.html';
let creating = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

// 建立背景引擎頁。電腦睡眠醒來、瀏覽器剛啟動時，Chrome／Brave 偶爾會回「Page failed to load」，
// 這時先把殘留的頁面關掉，稍等一下再試，不要直接把錯誤丟給面板。
async function createOffscreen() {
  let lastError;
  for (const wait of [0, 300, 1000, 2500]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      if (await hasOffscreen()) return;
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS'],
        justification: '在背景執行 Stockfish 引擎分析棋局',
      });
      return;
    } catch (e) {
      lastError = e;
      await chrome.offscreen.closeDocument().catch(() => {});
    }
  }
  throw lastError;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creating ||= createOffscreen().finally(() => (creating = null));
  await creating;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen') return;

  if (msg?.type === 'live') {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ ...msg, target: 'offscreen' }))
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }

  if (msg?.type === 'prepare') {
    (async () => {
      const existing = (await chrome.storage.local.get(msg.key))[msg.key];
      if (existing?.done) return;
      await ensureOffscreen();
      await chrome.runtime.sendMessage({ ...msg, existing, target: 'offscreen' });
    })().catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  if (msg?.type === 'harvest-pieces') {
    savePieces(msg.template).catch(() => {});
    return;
  }

  if (msg?.type === 'pre-progress') {
    savePrep(msg.key, msg.data);
    return;
  }

  if (msg?.type === 'open-report') {
    const key = `game:${Date.now()}`;
    chrome.storage.local
      .set({ [key]: msg.game })
      .then(() => chrome.tabs.create({ url: chrome.runtime.getURL(`src/report.html?id=${encodeURIComponent(key)}`) }))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});

// 預先分析的結果：只存最近 10 盤，避免佔太多空間。一次只寫一筆，避免互相覆蓋。
let saving = Promise.resolve();
function savePrep(key, data) {
  saving = saving
    .then(async () => {
      const { preKeys = [] } = await chrome.storage.local.get('preKeys');
      const keys = [key, ...preKeys.filter((k) => k !== key)];
      const drop = keys.slice(10);
      await chrome.storage.local.set({ [key]: data, preKeys: keys.slice(0, 10) });
      if (drop.length) await chrome.storage.local.remove(drop);
    })
    .catch(() => {});
}

const PIECE_CODES = ['wp', 'wn', 'wb', 'wr', 'wq', 'wk', 'bp', 'bn', 'bb', 'br', 'bq', 'bk'];

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// 下載 chess.com 的 12 張棋子圖，存成 data URL（只存在這台電腦的瀏覽器裡）。
async function savePieces(template) {
  if (!/^https:\/\/([\w-]+\.)*chesscomfiles\.com\//.test(template) && !/^https:\/\/www\.chess\.com\//.test(template)) return;
  const { pieceImages } = await chrome.storage.local.get('pieceImages');
  if (pieceImages?.template === template && Object.keys(pieceImages.imgs || {}).length === 12) return;
  const imgs = {};
  for (const code of PIECE_CODES) {
    const res = await fetch(template.replace('{p}', code));
    if (!res.ok) return;
    const type = res.headers.get('content-type') || 'image/png';
    imgs[code] = `data:${type};base64,${toBase64(await res.arrayBuffer())}`;
  }
  const theme = template.match(/pieces\/([^/]+)\//)?.[1] || 'chess.com';
  await chrome.storage.local.set({ pieceImages: { template, theme, imgs, at: Date.now() } });
}

// 安裝或更新插件後，把新版注入已經開著的 chess.com 分頁，不用手動重新整理。
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'update') return;
  const tabs = await chrome.tabs.query({ url: 'https://www.chess.com/*' });
  for (const tab of tabs) {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['src/content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content.js'] });
    } catch {
      // 分頁可能已經關閉或還在載入，略過
    }
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-best-move') {
    const s = await loadSettings();
    await chrome.storage.sync.set({ showBestMove: !s.showBestMove });
  }
});
