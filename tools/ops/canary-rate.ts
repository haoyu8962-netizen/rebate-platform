// Review canary hit rate (规划/11 §3.3, §7.1 第 6 类; FU-REVIEW-CANARY, D10-886 / D10-1011).
//
//   node tools/ops/canary-rate.ts [--csv <file>] [--last <n>] [--json]
//
// Reads the canary CSV (tools/agent/canary/apply.ts record; default <couli-runs>/metrics/
// review-canary.csv) and prints, per engine, the hit rate of the last n judged rows (default 10).
// Only rows with hit 1 or 0 count; n/a (nothing landed) and error rows are left out. First
// version (CT-06zzzza): print only, nothing is refused; the < 80% stop is CT-06zzzzb.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { runsDir } from '../lib/paths.ts';
import { runMain, UsageError } from './cli.ts';

export const DEFAULT_LAST = 10;
export const THRESHOLD = 0.8;

export type EngineRate = {
  engine: string;
  judged: number;
  hits: number;
  rate: number | null;
  below_threshold: boolean;
  skipped: number;
};

/** RFC 4180 rows (quoted fields, doubled quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] ?? '';
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Per engine, in file order: the last `last` rows with hit 1 or 0. */
export function canaryRates(text: string, last: number = DEFAULT_LAST): EngineRate[] {
  const rows = parseCsv(text);
  const header = rows.shift() ?? [];
  const at = (name: string) => header.indexOf(name);
  const iEngine = at('engine');
  const iHit = at('hit');
  if (iEngine < 0 || iHit < 0) throw new UsageError('the CSV has no engine / hit column');
  const judged = new Map<string, boolean[]>();
  const skipped = new Map<string, number>();
  for (const r of rows) {
    const engine = r[iEngine] ?? '';
    if (engine === '') continue;
    const hit = r[iHit] ?? '';
    if (hit === '1' || hit === '0') {
      const list = judged.get(engine) ?? [];
      list.push(hit === '1');
      judged.set(engine, list);
    } else {
      skipped.set(engine, (skipped.get(engine) ?? 0) + 1);
      if (!judged.has(engine)) judged.set(engine, []);
    }
  }
  return [...judged.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([engine, all]) => {
      const recent = all.slice(-last);
      const hits = recent.filter(Boolean).length;
      const rate = recent.length === 0 ? null : hits / recent.length;
      return {
        engine,
        judged: recent.length,
        hits,
        rate,
        below_threshold: rate !== null && rate < THRESHOLD,
        skipped: skipped.get(engine) ?? 0,
      };
    });
}

export function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: { csv: { type: 'string' }, last: { type: 'string' }, json: { type: 'boolean' } },
  });
  const last = values.last ?? String(DEFAULT_LAST);
  if (!/^[1-9][0-9]*$/.test(last)) throw new UsageError('--last must be a positive integer');
  const csv = values.csv ?? join(runsDir(), 'metrics', 'review-canary.csv');
  const text = existsSync(csv) ? readFileSync(csv, 'utf8') : '';
  const rates = text.trim() === '' ? [] : canaryRates(text, Number(last));
  if (values.json === true) {
    console.log(JSON.stringify({ csv, last: Number(last), engines: rates }, null, 2));
    return 0;
  }
  if (rates.length === 0) {
    console.log(`canary: no rows in ${csv}`);
    return 0;
  }
  for (const r of rates) {
    const pct = r.rate === null ? '—' : `${Math.round(r.rate * 100)}%`;
    const flag = r.below_threshold ? '  低于 80%（首版只提示，规划/11 §7.1 第 6 类）' : '';
    console.log(
      `${r.engine}: 近 ${r.judged} 次命中 ${r.hits}（${pct}），未计 n/a / error ${r.skipped} 行${flag}`,
    );
  }
  return 0;
}

if (import.meta.main) runMain(main);
