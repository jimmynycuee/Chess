import { loadSettings } from './settings.js';

const s = await loadSettings();
for (const key of ['enabled', 'showBestMove', 'showArrow']) {
  const el = document.getElementById(key);
  el.checked = s[key];
  el.addEventListener('change', () => chrome.storage.sync.set({ [key]: el.checked }));
}
for (const key of ['liveDepth', 'reportDepth']) {
  const el = document.getElementById(key);
  const out = document.getElementById(`${key}Val`);
  el.value = s[key];
  out.textContent = s[key];
  el.addEventListener('input', () => (out.textContent = el.value));
  el.addEventListener('change', () => chrome.storage.sync.set({ [key]: Number(el.value) }));
}
