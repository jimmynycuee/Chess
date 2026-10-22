// 在 chess.com 頁面上讀取著法列表、判斷是否允許分析，並顯示浮動面板。
// 真人對局進行中一律不分析（chess.com Fair Play 規則，友誼賽也一樣）。
(() => {
  const DEFAULTS = { enabled: true, showBestMove: false, showArrow: true, liveDepth: 16, reportDepth: 14 };
  const SAN_RE = /^(O-O-O|O-O|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?)[+#]?/;
  const RESULT_RE = /^(1-0|0-1|½-½|1\/2-1\/2)$/;
  const CLASS_INFO = {
    best: ['最佳', '#5c9e31'],
    excellent: ['優秀', '#7fa650'],
    good: ['良好', '#95b776'],
    book: ['開局', '#a88865'],
    inaccuracy: ['不精確', '#e6b422'],
    mistake: ['失誤', '#e58f2a'],
    blunder: ['大失誤', '#ca3431'],
  };

  let settings = { ...DEFAULTS };
  let lastKey = '';
  let lastResult = null;
  let panel = null;

  // ---------- 讀取頁面 ----------

  function moveListRoot() {
    return document.querySelector(
      'wc-simple-move-list, wc-move-list, vertical-move-list, .move-list-component, .move-list, .play-controller-moves'
    );
  }

  function sanFromNode(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll('[data-figurine]').forEach((el) => {
      el.replaceWith(document.createTextNode(el.getAttribute('data-figurine')));
    });
    const text = clone.textContent.replace(/\s+/g, '').replace(/0-0-0/g, 'O-O-O').replace(/0-0/g, 'O-O');
    const m = text.match(SAN_RE);
    return m ? m[0] : null;
  }

  function readMoves() {
    const root = moveListRoot();
    if (!root) return null;
    let nodes = [...root.querySelectorAll('.node.main-line-ply')];
    if (!nodes.length) {
      nodes = [...root.querySelectorAll('.node.white-move, .node.black-move, .move .white, .move .black')].filter(
        (n) => !n.closest('[class*="subline"], [class*="variation"]')
      );
    }
    const sans = [];
    let selected = -1;
    for (const n of nodes) {
      const san = sanFromNode(n);
      if (!san) continue;
      sans.push(san);
      if (n.classList.contains('selected') || n.querySelector('.selected')) selected = sans.length;
    }
    return { sans, ply: selected > 0 ? selected : sans.length };
  }

  function hasLiveControls() {
    return !!document.querySelector(
      '.resign-button-component, .draw-button-component, [data-cy="resign-button-with-confirmation"], ' +
        '[data-cy="draw-button"], button[aria-label="Resign"], button[aria-label="Abort"], button[aria-label="Offer Draw"]'
    );
  }

  function isGameOver() {
    if (document.querySelector('.game-over-modal-content, [class*="game-over-modal"], [class*="game-review-buttons"]')) {
      return true;
    }
    const root = moveListRoot();
    if (!root) return false;
    const resultEl = root.querySelector('.game-result, [class*="game-result"], [class*="result-row"]');
    if (resultEl && RESULT_RE.test(resultEl.textContent.trim())) return true;
    return [...root.querySelectorAll('div, span')].some(
      (el) => el.childElementCount === 0 && RESULT_RE.test(el.textContent.trim())
    );
  }

  // 'analysis'：分析棋盤或對電腦，可即時分析
  // 'review'：對局已結束，可分析
  // 'blocked'：真人對局進行中（或無法確定已結束），停用
  // 'none'：頁面上沒有棋局
  function pageMode() {
    const path = location.pathname;
    if (/^\/(analysis|play\/computer|computer)/.test(path)) return 'analysis';
    if (!moveListRoot() && !findBoard()) return 'none';
    if (hasLiveControls()) return 'blocked';
    if (isGameOver()) return 'review';
    return 'blocked';
  }

  function readPlayers() {
    const names = [...document.querySelectorAll('[data-test-element="user-tagline-username"], .user-username-component, .cc-user-username-component')]
      .map((el) => el.textContent.trim())
      .filter(Boolean);
    const flipped = findBoard()?.classList.contains('flipped');
    // 上方是對手、下方是自己；未翻轉時下方是白方。
    if (names.length >= 2) {
      const [top, bottom] = names;
      return flipped ? { white: top, black: bottom, me: 'b' } : { white: bottom, black: top, me: 'w' };
    }
    return { white: '白方', black: '黑方', me: flipped ? 'b' : 'w' };
  }

  function readResult() {
    const root = moveListRoot();
    const el = root && [...root.querySelectorAll('div, span')].find((e) => e.childElementCount === 0 && RESULT_RE.test(e.textContent.trim()));
    return el ? el.textContent.trim() : '*';
  }

  function findBoard() {
    return document.querySelector('wc-chess-board, chess-board, #board-single, #board-play-computer, #board-analysis-board');
  }

  // ---------- 面板 ----------

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'crb-panel';
    panel.innerHTML = `
      <div class="crb-head">
        <span class="crb-title">♞ 勝率分析</span>
        <button class="crb-min" title="收合">–</button>
      </div>
      <div class="crb-body">
        <div class="crb-status"></div>
        <div class="crb-eval">
          <div class="crb-bar"><div class="crb-bar-white"></div><span class="crb-bar-text"></span></div>
          <div class="crb-wins"><span class="crb-w"></span><span class="crb-b"></span></div>
        </div>
        <div class="crb-last"></div>
        <div class="crb-best"></div>
        <label class="crb-toggle"><input type="checkbox" class="crb-best-toggle"> 顯示最佳著法 <kbd>Alt+B</kbd></label>
        <button class="crb-report">📊 賽後總結</button>
      </div>`;
    document.body.appendChild(panel);

    panel.querySelector('.crb-min').addEventListener('click', () => {
      panel.classList.toggle('crb-collapsed');
    });
    panel.querySelector('.crb-best-toggle').addEventListener('change', (e) => {
      chrome.storage.sync.set({ showBestMove: e.target.checked });
    });
    panel.querySelector('.crb-report').addEventListener('click', openReport);
    makeDraggable(panel, panel.querySelector('.crb-head'));
  }

  function makeDraggable(el, handle) {
    let sx, sy, ox, oy;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      const r = el.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      const move = (ev) => {
        el.style.left = `${ox + ev.clientX - sx}px`;
        el.style.top = `${oy + ev.clientY - sy}px`;
        el.style.right = 'auto';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  function setStatus(text, kind = '') {
    const s = panel.querySelector('.crb-status');
    s.textContent = text;
    s.className = `crb-status ${kind}`;
  }

  function render(mode) {
    if (!panel) buildPanel();
    panel.hidden = !settings.enabled || mode === 'none';
    panel.classList.toggle('crb-blocked', mode === 'blocked');
    panel.querySelector('.crb-best-toggle').checked = settings.showBestMove;
    panel.querySelector('.crb-report').disabled = mode === 'blocked';

    if (mode === 'blocked') {
      setStatus('對局進行中：分析已停用。賽後會自動開啟。', 'crb-warn');
      clearArrow();
      return;
    }
    const r = lastResult;
    if (!r) return;

    panel.querySelector('.crb-bar-white').style.width = `${r.winW.toFixed(1)}%`;
    panel.querySelector('.crb-bar-text').textContent = r.scoreText;
    panel.querySelector('.crb-w').textContent = `白 ${r.winW.toFixed(0)}%`;
    panel.querySelector('.crb-b').textContent = `黑 ${(100 - r.winW).toFixed(0)}%`;

    const last = panel.querySelector('.crb-last');
    if (r.last) {
      const [label, color] = CLASS_INFO[r.last.cls];
      const num = Math.ceil(r.last.ply / 2) + (r.last.color === 'w' ? '.' : '...');
      const d = r.last.deltaMover;
      const sign = d >= 0 ? '+' : '−';
      last.innerHTML = '';
      const line1 = document.createElement('div');
      line1.innerHTML = `<b></b> <span class="crb-badge"></span>`;
      line1.querySelector('b').textContent = `${num} ${r.last.san}`;
      const badge = line1.querySelector('.crb-badge');
      badge.textContent = label;
      badge.style.background = color;
      const line2 = document.createElement('div');
      line2.className = 'crb-delta';
      const moverName = r.last.color === 'w' ? '白方' : '黑方';
      const before = r.last.color === 'w' ? r.last.winBeforeW : 100 - r.last.winBeforeW;
      const after = r.last.color === 'w' ? r.last.winAfterW : 100 - r.last.winAfterW;
      line2.textContent = `${moverName}勝率 ${before.toFixed(0)}% → ${after.toFixed(0)}%（${sign}${Math.abs(d).toFixed(1)}）`;
      line2.classList.toggle('crb-neg', d < -2);
      last.append(line1, line2);
      if (r.last.why) {
        const why = document.createElement('div');
        why.className = 'crb-why';
        why.textContent = r.last.why;
        last.append(why);
      }
      if (settings.showBestMove && r.last.cls !== 'best' && r.last.bestSan) {
        const line3 = document.createElement('div');
        line3.className = 'crb-muted';
        line3.textContent = `這步更好的是：${r.last.bestSan}`;
        last.append(line3);
      }
    } else {
      last.textContent = '起始局面';
    }

    const best = panel.querySelector('.crb-best');
    best.hidden = !settings.showBestMove;
    if (settings.showBestMove && r.best) {
      best.textContent = `最佳著法：${r.best.pvSan[0] || r.best.uci}　${r.best.pvSan.slice(1).join(' ')}`;
      if (settings.showArrow) drawArrow(r.best.uci);
      else clearArrow();
    } else {
      best.textContent = '';
      clearArrow();
    }
    setStatus(`深度 ${r.depth}${r.parsedAll ? '' : '（部分著法無法解析）'}`);
  }

  // ---------- 棋盤箭頭 ----------

  function clearArrow() {
    document.getElementById('crb-arrow')?.remove();
  }

  function drawArrow(uci) {
    const board = findBoard();
    if (!board || !uci) return clearArrow();
    let svg = document.getElementById('crb-arrow');
    if (!svg || svg.parentElement !== board) {
      clearArrow();
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.id = 'crb-arrow';
      svg.setAttribute('viewBox', '0 0 100 100');
      board.appendChild(svg);
    }
    const flipped = board.classList.contains('flipped');
    const center = (sq) => {
      const f = sq.charCodeAt(0) - 97;
      const r = Number(sq[1]) - 1;
      const x = (flipped ? 7 - f : f) * 12.5 + 6.25;
      const y = (flipped ? r : 7 - r) * 12.5 + 6.25;
      return [x, y];
    };
    const [x1, y1] = center(uci.slice(0, 2));
    const [x2, y2] = center(uci.slice(2, 4));
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ex = x2 - ((x2 - x1) / len) * 3.2;
    const ey = y2 - ((y2 - y1) / len) * 3.2;
    svg.innerHTML = `
      <defs><marker id="crb-head" markerWidth="4" markerHeight="4" refX="2" refY="2" orient="auto">
        <path d="M0,0 L4,2 L0,4 z" fill="rgba(40,140,255,0.85)"/></marker></defs>
      <line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke="rgba(40,140,255,0.85)" stroke-width="2.2"
        stroke-linecap="round" marker-end="url(#crb-head)"/>`;
  }

  // ---------- 主流程 ----------

  async function update() {
    if (!settings.enabled) {
      if (panel) panel.hidden = true;
      clearArrow();
      return;
    }
    const mode = pageMode();
    if (mode !== 'analysis' && mode !== 'review') {
      lastKey = '';
      lastResult = null;
      render(mode);
      return;
    }
    const data = readMoves();
    if (!data) {
      render('none');
      return;
    }
    const sans = data.sans.slice(0, data.ply);
    const key = `${sans.join(' ')}|${settings.liveDepth}`;
    if (key === lastKey) {
      render(mode);
      return;
    }
    lastKey = key;
    render(mode);
    setStatus('分析中…');
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'live', sans, depth: settings.liveDepth });
    } catch (e) {
      setStatus('引擎連線失敗，請重新整理頁面', 'crb-warn');
      return;
    }
    if (!res || res.stale || key !== lastKey) return;
    if (res.error) {
      setStatus(`引擎錯誤：${res.error}`, 'crb-warn');
      return;
    }
    // 回應抵達前若已進入真人對局，就丟棄結果。
    const nowMode = pageMode();
    if (nowMode !== 'analysis' && nowMode !== 'review') return render(nowMode);
    lastResult = res;
    render(nowMode);
  }

  async function openReport() {
    const mode = pageMode();
    if (mode === 'blocked') return;
    const data = readMoves();
    if (!data || !data.sans.length) {
      setStatus('找不到著法列表', 'crb-warn');
      return;
    }
    const game = {
      ...readPlayers(),
      result: readResult(),
      sans: data.sans,
      url: location.href,
      date: new Date().toISOString(),
    };
    await chrome.runtime.sendMessage({ type: 'open-report', game });
  }

  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(update, 200);
  };

  chrome.storage.sync.get(DEFAULTS).then((s) => {
    settings = { ...DEFAULTS, ...s };
    // 忽略面板與箭頭自己造成的變動，避免無限重繪。
    const own = (n) => n.nodeType === 1 && (n.id === 'crb-panel' || n.id === 'crb-arrow' || n.closest?.('#crb-panel, #crb-arrow'));
    new MutationObserver((records) => {
      if (records.every((r) => own(r.target) || [...r.addedNodes, ...r.removedNodes].some(own))) return;
      schedule();
    }).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    schedule();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
    lastKey = '';
    schedule();
  });
})();
