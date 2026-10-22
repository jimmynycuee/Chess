// 設定的預設值；popup、background、report 共用。content.js 無法 import，另有一份相同的預設值。
export const DEFAULT_SETTINGS = {
  enabled: true,
  showBestMove: false,
  showArrow: true,
  liveDepth: 16,
  reportDepth: 14,
  panelScale: 1,
  pieceSet: 'papercut',
};

export async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}
