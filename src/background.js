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

  if (msg?.type === 'open-report') {
    const key = `game:${Date.now()}`;
    chrome.storage.local
      .set({ [key]: msg.game })
      .then(() => chrome.tabs.create({ url: chrome.runtime.getURL(`src/report.html?id=${encodeURIComponent(key)}`) }))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-best-move') {
    const s = await loadSettings();
    await chrome.storage.sync.set({ showBestMove: !s.showBestMove });
  }
});
