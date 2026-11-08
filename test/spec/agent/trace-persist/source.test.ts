// B3-08q · BR-AI-19: once the production RunTraceSink is wired, the two TODOs of
// stream/mount/assembly.ts that waited for it (the deterministic path's onTrace and the intent
// port's trace.record, both 「blocked on followups 第 31 条（生产没有 RunTraceSink）」) are gone.
// Source scan only: no database, no Nest.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const ASSEMBLY = new URL(
  '../../../../apps/api/src/modules/agent/stream/mount/assembly.ts',
  import.meta.url,
);

it('[AC-B3-08q#7][BR-AI-19] stream/mount/assembly.ts 不再含「blocked on followups 第 31 条」的两处 TODO（确定性路径 onTrace、意图 trace 落库）', () => {
  const lines = readFileSync(ASSEMBLY, 'utf8').split('\n');
  expect(lines.length, 'assembly.ts was read').toBeGreaterThan(100);
  expect(lines.filter((line) => line.includes('blocked on followups 第 31 条'))).toEqual([]);
  expect(lines.filter((line) => line.includes('生产没有 RunTraceSink'))).toEqual([]);
});
