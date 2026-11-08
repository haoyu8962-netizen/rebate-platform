// Unit tests for the review canary hit rate (CT-06zzzza; D10-886 / D10-1011).
import { expect, it } from 'vitest';
import { canaryRates, parseCsv } from './canary-rate.ts';

const HEADER =
  'date,task,round,engine,model,effort,review_type,mutation_id,category,file,line,hit,s0s1_count,duration_s,reason';

function row(engine: string, hit: string, reason = ''): string {
  return `2026-11-08T00:00:00Z,B1-01,1,${engine},m,medium,money,ROUND-01,rounding,a.ts,1,${hit},1,10,${reason}`;
}

it('[CT-06zzzza] rates are per engine over the last 10 judged rows; n/a and error rows do not count', () => {
  const lines = [HEADER];
  for (let i = 0; i < 5; i += 1) lines.push(row('codex', '0'));
  for (let i = 0; i < 10; i += 1) lines.push(row('codex', '1'));
  lines.push(row('codex', 'n/a', 'no added lines'));
  lines.push(row('claude-independent', '1'), row('claude-independent', '0'));
  lines.push(row('claude-independent', 'error', '"canary review: no usable output (exit 10)"'));
  const rates = canaryRates(lines.join('\n') + '\n');
  expect(rates).toEqual([
    {
      engine: 'claude-independent',
      judged: 2,
      hits: 1,
      rate: 0.5,
      below_threshold: true,
      skipped: 1,
    },
    { engine: 'codex', judged: 10, hits: 10, rate: 1, below_threshold: false, skipped: 1 },
  ]);
});

it('[CT-06zzzza] an engine with only n/a rows has no rate', () => {
  const rates = canaryRates([HEADER, row('codex', 'n/a', 'x')].join('\n'));
  expect(rates).toEqual([
    { engine: 'codex', judged: 0, hits: 0, rate: null, below_threshold: false, skipped: 1 },
  ]);
});

it('[CT-06zzzza] quoted CSV fields keep commas and quotes', () => {
  expect(parseCsv('a,"b,c","d ""e"""\n')).toEqual([['a', 'b,c', 'd "e"']]);
});
