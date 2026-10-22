// 設定的預設值；popup、background、report 共用。content.js 無法 import，另有一份相同的預設值。
export const DEFAULT_SETTINGS = {
  enabled: true,
  showBestMove: false,
  reviewBestMove: false,
  showArrow: true,
  liveDepth: 16,
  reportDepth: 14,
  panelScale: 1,
  pieceSet: 'chesscom',
  autoOpenReport: false,
  soundOn: true,
};

// 賽後預先分析的鍵值（content.js 裡有一份相同的算法）。
export function preKey(sans, depth) {
  let h = 5381;
  const str = sans.join(' ');
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return `pre:${depth}:${(h >>> 0).toString(36)}:${sans.length}`;
}

export async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}
