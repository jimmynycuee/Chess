// 網頁版（手機）用：在一般網頁裡提供復盤頁需要的那一小部分 chrome.* API，
// 讓 src/ 底下的程式不用改就能跑。在插件裡執行時什麼都不做。
(() => {
  if (globalThis.chrome?.runtime?.id) return;

  const root = new URL('../', document.currentScript.src).href;
  const listeners = [];
  const PREFIX = 'crb:';
  const keyOf = (area, k) => `${PREFIX}${area}:${k}`;

  function read(area, k) {
    try {
      const v = localStorage.getItem(keyOf(area, k));
      return v === null ? undefined : JSON.parse(v);
    } catch {
      return undefined;
    }
  }

  function allKeys(area) {
    const p = `${PREFIX}${area}:`;
    return Object.keys(localStorage)
      .filter((k) => k.startsWith(p))
      .map((k) => k.slice(p.length));
  }

  // 空間不夠時，先刪掉最舊的對局分析
  function dropOldestGame(area) {
    const games = allKeys(area)
      .filter((k) => k.startsWith('game:'))
      .map((k) => ({ k, at: read(area, k)?.openedAt || 0 }))
      .sort((a, b) => a.at - b.at);
    if (!games.length) return false;
    localStorage.removeItem(keyOf(area, games[0].k));
    return true;
  }

  function makeArea(area) {
    return {
      async get(keys) {
        if (keys == null) keys = allKeys(area);
        if (typeof keys === 'string') keys = [keys];
        const out = Array.isArray(keys) ? {} : { ...keys };
        for (const k of Array.isArray(keys) ? keys : Object.keys(keys)) {
          const v = read(area, k);
          if (v !== undefined) out[k] = v;
        }
        return out;
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: read(area, k), newValue: v };
          const text = JSON.stringify(v);
          for (;;) {
            try {
              localStorage.setItem(keyOf(area, k), text);
              break;
            } catch (e) {
              if (!dropOldestGame(area)) throw e;
            }
          }
        }
        listeners.forEach((fn) => fn(changes, area));
      },
      async remove(keys) {
        for (const k of [].concat(keys)) localStorage.removeItem(keyOf(area, k));
      },
    };
  }

  globalThis.chrome = {
    runtime: { getURL: (path) => new URL(path, root).href },
    storage: {
      local: makeArea('local'),
      sync: makeArea('sync'),
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
  };
  document.documentElement.dataset.web = '1';
})();
