// 把 lichess-org/chess-openings 的 a–e.tsv（CC0）轉成以局面為索引的 vendor/openings.json。
// 用法：node tools/build-openings.mjs <tsv 資料夾>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Chess } from '../vendor/chess.js';

const dir = process.argv[2];
const table = {};
for (const f of ['a', 'b', 'c', 'd', 'e']) {
  const rows = readFileSync(join(dir, `${f}.tsv`), 'utf8').trim().split('\n').slice(1);
  for (const row of rows) {
    const [eco, name, pgn] = row.split('\t');
    const chess = new Chess();
    for (const tok of pgn.split(/\s+/)) if (!/^\d+\.$/.test(tok)) chess.move(tok);
    const key = chess.fen().split(' ').slice(0, 4).join(' ');
    // 同一局面有多個名稱時，保留步數較長（較具體）的那個
    const plies = chess.history().length;
    if (!table[key] || table[key][2] <= plies) table[key] = [eco, name, plies];
  }
}
const out = Object.fromEntries(Object.entries(table).map(([k, [eco, name]]) => [k, [eco, name]]));
writeFileSync(new URL('../vendor/openings.json', import.meta.url), JSON.stringify(out));
console.log(Object.keys(out).length, 'positions');
