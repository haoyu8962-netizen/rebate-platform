// B2-02zf unit tests (no database): registerReconDiffWriteOnly sends exactly one
// INSERT … ON CONFLICT DO NOTHING chain on the caller's transaction and never reads back; a
// recording chain stub stands in for the transaction. The static part reads this module's source
// (D10-2997 ①: compiled / raw statements are not seen by the rule tests' Kysely plugin).
import { readFileSync } from 'node:fs';
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { LedgerError } from './errors.ts';
import { registerReconDiffWriteOnly, type RegisterReconDiffInput } from './recon-diffs.ts';

interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** Every property is a recorded method returning the chain; executeTakeFirst resolves `result`. */
function chainStub(result: unknown): { trx: Transaction<DB>; calls: Call[] } {
  const calls: Call[] = [];
  const chain: object = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== 'string' || property === 'then') return undefined;
        return (...args: unknown[]) => {
          calls.push({ method: property, args });
          if (property.startsWith('execute')) return Promise.resolve(result);
          return chain;
        };
      },
    },
  );
  return { trx: chain as Transaction<DB>, calls };
}

const NOW = '2026-11-25T00:00:00.000Z';
const clock = new FixedClock(NOW);

// 自拟 input, the bill callers' shape (union_mismatch, null dedupeKey and resolution).
const BILL_INPUT: RegisterReconDiffInput = {
  appId: 'app-unit',
  type: 'union_mismatch',
  source: 'R1',
  period: '2026-10',
  refType: 'order',
  refId: 'order-unit-1',
  expectedFen: 1200n,
  actualFen: -300n,
  diffFen: -1500n,
  dedupeKey: null,
  resolution: null,
};

const READS = ['selectFrom', 'updateTable', 'deleteFrom', 'executeQuery', 'selectNoFrom'];

it('[AC-B2-02zf#UNIT-1] 插入返回行 → { inserted: true }，只发一条 insertInto(recon_diffs) 链', async () => {
  const { trx, calls } = chainStub({ id: 'x' });
  const result = await registerReconDiffWriteOnly(trx, BILL_INPUT, { clock });
  expect(result).toEqual({ inserted: true });
  expect(calls.map((call) => call.method)).toEqual([
    'withSchema',
    'insertInto',
    'values',
    'onConflict',
    'returningAll',
    'executeTakeFirst',
  ]);
  expect(calls[0]?.args).toEqual(['app']);
  expect(calls[1]?.args).toEqual(['recon_diffs']);
});

it('[AC-B2-02zf#UNIT-2] 插入返回 undefined → { inserted: false }，不回读、不发别的语句', async () => {
  const { trx, calls } = chainStub(undefined);
  const result = await registerReconDiffWriteOnly(trx, BILL_INPUT, { clock });
  expect(result).toEqual({ inserted: false });
  const methods = calls.map((call) => call.method);
  expect(methods.filter((method) => method === 'insertInto')).toHaveLength(1);
  expect(methods.filter((method) => method.startsWith('execute'))).toEqual(['executeTakeFirst']);
  for (const read of READS) expect(methods).not.toContain(read);
  expect(methods).toHaveLength(6);
});

it('[AC-B2-02zf#UNIT-3] dedupeKey 与 resolution 为 null 的入参过校验、原样到达插入，行与现有口相同', async () => {
  const { trx, calls } = chainStub({ id: 'x' });
  await registerReconDiffWriteOnly(trx, BILL_INPUT, { clock });
  const values = calls.find((call) => call.method === 'values')?.args[0] as Record<string, unknown>;
  expect(values).toBeDefined();
  expect(values.dedupe_key).toBeNull();
  expect(values.resolution).toBeNull();
  expect(values).toMatchObject({
    app_id: 'app-unit',
    type: 'union_mismatch',
    source: 'R1',
    period: '2026-10',
    ref_type: 'order',
    ref_id: 'order-unit-1',
    expected_fen: 1200n,
    actual_fen: -300n,
    diff_fen: -1500n,
    status: 'open',
    handler_id: null,
    closed_at: null,
  });
  expect((values.created_at as Date).toISOString()).toBe(NOW);
  expect((values.updated_at as Date).toISOString()).toBe(NOW);
  expect(typeof values.id).toBe('string');
});

it.each<[string, Partial<Record<keyof RegisterReconDiffInput, unknown>>]>([
  ['appId 空', { appId: '' }],
  ['type 非枚举', { type: 'nope' }],
  ['source 非 R1–R4', { source: 'R5' }],
  ['period 形状不对', { period: '2026-13' }],
  ['refId 空', { refId: '' }],
  ['金额不是 bigint', { diffFen: 1 }],
  ['dedupeKey 空串', { dedupeKey: '' }],
  ['resolution 不是普通对象', { resolution: [] }],
])(
  '[AC-B2-02zf#UNIT-4] 非法入参（%s）在碰到事务前抛 LedgerError INVALID_INPUT',
  async (_name, patch) => {
    const { trx, calls } = chainStub({ id: 'x' });
    const input = { ...BILL_INPUT, ...patch } as RegisterReconDiffInput;
    const error: unknown = await registerReconDiffWriteOnly(trx, input, { clock }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LedgerError);
    expect((error as LedgerError).code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  },
);

const SOURCE = readFileSync(new URL('./recon-diffs.ts', import.meta.url), 'utf8');

/** From the export declaration to the next top-level export, or the end of the file. */
function writeOnlyBody(): string {
  const start = SOURCE.indexOf('export async function registerReconDiffWriteOnly(');
  if (start < 0) return '';
  const next = SOURCE.indexOf('\nexport ', start + 1);
  return SOURCE.slice(start, next < 0 ? undefined : next);
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

it('[AC-B2-02zf#UNIT-5] 函数体：checkInput 与 insertReconDiffIfAbsent 各一次，无回读、无原始 SQL', () => {
  const body = writeOnlyBody();
  expect(body.length).toBeGreaterThan(0);
  expect(body).toContain('return { inserted:');
  expect(count(body, 'checkInput(')).toBe(1);
  expect(count(body, 'insertReconDiffIfAbsent(')).toBe(1);
  for (const forbidden of [
    'findExisting',
    'findReconDiff',
    'findUnresolvedReconDiff',
    'selectReconDiffs',
    'executeQuery',
    'CompiledQuery',
    'selectFrom',
    'updateTable',
    'deleteFrom',
  ]) {
    expect(body).not.toContain(forbidden);
  }
  expect(body).not.toMatch(/\bsql\s*(<[^>]*>)?\s*`/);
});

it('[AC-B2-02zf#UNIT-6] recon-diffs.ts 不从 kysely 导入 CompiledQuery 或 sql', () => {
  const imports = [...SOURCE.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'kysely'/g)];
  expect(imports.length).toBeGreaterThan(0);
  const names = imports
    .flatMap((match) => (match[1] ?? '').split(','))
    .map(
      (name) =>
        name
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0],
    );
  expect(names).not.toContain('CompiledQuery');
  expect(names).not.toContain('sql');
  expect(SOURCE).not.toMatch(/import\s+\*\s+as\s+\w+\s+from\s*'kysely'/);
  expect(SOURCE).not.toMatch(/import\s+sql\b[^;]*from\s*'kysely'/);
});
