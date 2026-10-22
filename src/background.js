import { loadSettings } from './settings.js';

const OFFSCREEN_URL = 'src/offscreen.html';
let creating = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS'],
        justification: '在背景執行 Stockfish 引擎分析棋局',
      })
      .finally(() => (creating = null));
  }
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

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-best-move') {
    const s = await loadSettings();
    await chrome.storage.sync.set({ showBestMove: !s.showBestMove });
  }
});
