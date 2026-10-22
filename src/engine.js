// 包裝 Stockfish WASM worker 的 UCI 介面。一次只跑一個搜尋，其餘排隊。
export class Engine {
  constructor(url = chrome.runtime.getURL('vendor/stockfish.js')) {
    this.worker = new Worker(url);
    this.listeners = new Set();
    this.worker.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : String(e.data);
      for (const fn of [...this.listeners]) fn(line);
    };
    this.queue = Promise.resolve();
    this.searching = false;
    this.ready = this.init();
  }

  send(cmd) {
    this.worker.postMessage(cmd);
  }

  waitFor(prefix) {
    return new Promise((resolve) => {
      const fn = (line) => {
        if (line.startsWith(prefix)) {
          this.listeners.delete(fn);
          resolve(line);
        }
      };
      this.listeners.add(fn);
    });
  }

  async init() {
    const ok = this.waitFor('uciok');
    this.send('uci');
    await ok;
    this.send('setoption name Hash value 32');
    const ready = this.waitFor('readyok');
    this.send('isready');
    await ready;
  }

  // 中止目前搜尋（排隊中的不受影響）。
  stop() {
    if (this.searching) this.send('stop');
  }

  // 回傳 { score: {cp}|{mate, mateWinner}（白方視角）, bestmove, pv: [uci...], depth }
  // isStale：輪到這個工作時若回傳 true，就略過搜尋並回傳 null。
  analyse(fen, { depth = 16, multipv = 1, isStale } = {}) {
    const job = this.queue.then(() => (isStale?.() ? null : this.run(fen, depth, multipv)));
    this.queue = job.catch(() => {});
    return job;
  }

  async run(fen, depth, multipv) {
    await this.ready;
    const stm = fen.split(' ')[1];
    const sign = stm === 'w' ? 1 : -1;
    const lines = [];
    let lastDepth = 0;
    const onLine = (line) => {
      if (!line.startsWith('info') || !line.includes(' score ')) return;
      const t = line.split(' ');
      const get = (k) => t[t.indexOf(k) + 1];
      const idx = t.includes('multipv') ? Number(get('multipv')) - 1 : 0;
      const kind = get('score');
      const val = Number(t[t.indexOf('score') + 2]);
      const pvAt = t.indexOf('pv');
      lastDepth = Number(get('depth'));
      let score;
      if (kind === 'mate') {
        score = val === 0 ? { mate: 0, mateWinner: stm === 'w' ? 'b' : 'w' } : { mate: sign * val };
      } else {
        score = { cp: sign * val };
      }
      lines[idx] = { score, pv: pvAt >= 0 ? t.slice(pvAt + 1) : [] };
    };
    this.listeners.add(onLine);
    this.searching = true;
    const done = this.waitFor('bestmove');
    this.send(`setoption name MultiPV value ${multipv}`);
    this.send(`position fen ${fen}`);
    this.send(`go depth ${depth}`);
    const bestLine = await done;
    this.searching = false;
    this.listeners.delete(onLine);
    const bestmove = bestLine.split(' ')[1];
    const main = lines[0] || { score: { cp: 0 }, pv: [] };
    return {
      score: main.score,
      bestmove: bestmove && bestmove !== '(none)' ? bestmove : null,
      pv: main.pv,
      lines: lines.filter(Boolean),
      depth: lastDepth,
    };
  }
}
