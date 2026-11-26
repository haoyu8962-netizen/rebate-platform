// B2-17 implementer unit tests (no database): registerReconDiffOnce writes the involved-members list
// (§9.3 ⑭) in its one INSERT — lower case, unique, ascending — and leaves the column out (NULL)
// when there is no list; a malformed list is refused before the transaction is touched. A
// recording chain stub stands in for the transaction (as in recon-diffs.test.ts).
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { LedgerError } from './errors.ts';
import { registerReconDiffOnce, type RegisterReconDiffInput } from './recon-diffs.ts';

interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

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

const clock = new FixedClock('2026-11-26T00:00:00.000Z');
const U1 = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a01';
const U2 = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a02';

const INPUT: RegisterReconDiffInput = {
  appId: 'app-unit',
  type: 'ledger_mismatch',
  source: 'R3',
  period: '2026-11-25',
  refType: 'ledger_account',
  refId: '01:acc',
  expectedFen: 0n,
  actualFen: 0n,
  diffFen: 0n,
  dedupeKey: 'R3:2026-11-25:01:acc',
  resolution: null,
};

async function valuesOf(input: RegisterReconDiffInput): Promise<Record<string, unknown>> {
  const { trx, calls } = chainStub({ id: 'x' });
  await registerReconDiffOnce(trx, input, { clock });
  const values = calls.find((call) => call.method === 'values')?.args[0];
  expect(values).toBeDefined();
  return values as Record<string, unknown>;
}

it('[AC-B2-17#26] 名单随 INSERT 写入：小写、去重、升序', async () => {
  const values = await valuesOf({ ...INPUT, involvedUserIds: [U2.toUpperCase(), U1, U2] });
  expect(values['involved_user_ids']).toEqual([U1, U2]);
});

it('[AC-B2-17#26] 没有名单（未给、null、空数组）→ 不写该列（NULL）', async () => {
  for (const involvedUserIds of [undefined, null, []]) {
    const input =
      involvedUserIds === undefined ? INPUT : { ...INPUT, involvedUserIds: involvedUserIds };
    const values = await valuesOf(input);
    expect(Object.hasOwn(values, 'involved_user_ids'), String(involvedUserIds)).toBe(false);
  }
});

it('[AC-B2-17#26] 名单里有不是用户 id 的值 → 碰事务前 LedgerError INVALID_INPUT', async () => {
  const { trx, calls } = chainStub({ id: 'x' });
  const error: unknown = await registerReconDiffOnce(
    trx,
    { ...INPUT, involvedUserIds: [U1, 'nope'] },
    { clock },
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(LedgerError);
  expect((error as LedgerError).code).toBe('INVALID_INPUT');
  expect(calls).toHaveLength(0);
});
