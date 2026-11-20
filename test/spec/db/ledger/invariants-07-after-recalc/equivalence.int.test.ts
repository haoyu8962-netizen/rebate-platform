// B2-02zb / BR-FUND-19 ⑦ (D10-2224): with no recalculation in the history the cache always
// matches the entries, so the replacement must give the same rows as 07, row for row. Both SQL
// texts are executed as they are; the test does not compute the expected differences itself.
// Runs and seed only through @couli/testing; one database for all runs, each run in fresh apps
// (both checks read the whole history, so earlier runs stay in the comparison).
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createTestDatabase } from '@couli/db/testing';
import { subFen } from '@couli/money';
import { createPropStats, propRuns, propSeed } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  LEDGER_TYPES,
  LEGACY,
  active,
  book,
  openPlatform,
  openUser,
  registration,
  scenario,
  type Line,
  type PlatformAccount,
  type Result,
  type UserAccount,
} from './kit.ts';

const ALLOWED: readonly string[] = ['CLAWBACK', 'SETTLE_ADJUST', 'ADMIN_ADJUST'];

const amount = fc.oneof(
  fc.constantFrom(-1n, 1n),
  fc.bigInt({ min: -300n, max: -1n }),
  fc.bigInt({ min: 1n, max: 300n }),
);
const plannedLine = fc.record({
  account: fc.integer({ min: 0, max: 2 }),
  sub: fc.constantFrom('available' as const, 'available' as const, 'frozen' as const),
  amount,
  type: fc.constantFrom(...LEDGER_TYPES),
});
const plannedVoucher = fc.record({
  app: fc.integer({ min: 0, max: 1 }),
  // reassign: R14 reversal key; decoys: an underscore wildcard and a longer segment name.
  key: fc.constantFrom(
    'plain' as const,
    'plain' as const,
    'reverse' as const,
    'reassign' as const,
    'wildcard' as const,
    'prefixed' as const,
  ),
  lines: fc.array(plannedLine, { minLength: 1, maxLength: 4 }),
});
const history = fc.array(plannedVoucher, { minLength: 1, maxLength: 12 });

function uniqKey(kind: string, owner: string): string {
  const id = randomUUID();
  if (kind === 'reverse') return `taobao:${id}:${owner}:self:REVERSE`;
  if (kind === 'reassign') return `taobao:${id}:${owner}:self:REASSIGN_REV:${randomUUID()}`;
  if (kind === 'wildcard') return `taobao:${id}:${owner}:self:REASSIGNXREV:${randomUUID()}`;
  if (kind === 'prefixed') return `taobao:${id}:${owner}:self:NOT_REASSIGN_REV:${randomUUID()}`;
  return `fixture:${id}`;
}

function stable(value: unknown): string {
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** Every output field the comparison covers: invariant, scope, app_id, account_id, detail. */
function lines(rows: readonly Result[]): string[] {
  return rows
    .map((row) =>
      stable({
        invariant: row.invariant,
        scope: row.scope,
        app_id: row.app_id,
        account_id: row.account_id,
        detail: row.detail,
      }),
    )
    .sort();
}

it('[AC-B2-02zb#5] 属性：不含重算的随机过账历史（多分录凭证、同凭证同子户多条、available / frozen、首笔为负、白名单类型、改派红冲与相似键、多账户多 app），缓存始终与分录一致时，当前生效的替换版与旧 07 输出的行逐行相同', async () => {
  // The replacement must be registered; a missing one is an assertion failure, never skipped.
  registration();
  const file = active();
  expect(file, 'the daily run must load a replacement of 07').not.toBe(LEGACY);

  const runs = Math.max(20, Math.floor(propRuns() / 100));
  const stats = createPropStats('B2-02zb#5 07 vs replacement');
  let seen = 0;
  let mismatch: unknown = null;
  await scenario(createTestDatabase, async ({ db, check }) => {
    await fc.assert(
      fc.asyncProperty(history, async (plans) => {
        const apps = [`inv07-${randomUUID()}`, `inv07-${randomUUID()}`];
        const shared = randomUUID();
        const users: UserAccount[][] = [];
        const counters: PlatformAccount[] = [];
        for (const app of apps) {
          // The first owner has an account in both apps: no comparison across apps.
          users.push([
            await openUser(db, app, shared),
            await openUser(db, app),
            await openUser(db, app),
          ]);
          counters.push(await openPlatform(db, app));
        }
        const model = new Map<string, { available: bigint; frozen: bigint }>();
        const state = (a: UserAccount) => {
          const known = model.get(a.id) ?? { available: 0n, frozen: 0n };
          model.set(a.id, known);
          return known;
        };
        for (const plan of plans) {
          const accounts = users[plan.app]!;
          const planned: Line[] = plan.lines.map((l) => ({
            account: accounts[l.account]!,
            sub: l.sub,
            amount: l.amount,
            type: l.type,
          }));
          // The ledger never takes frozen below zero (applyEntries): such lines go to available.
          const frozen = new Map<string, bigint>();
          for (const line of planned) {
            if (line.sub !== 'frozen') continue;
            const base = frozen.get(line.account.id) ?? state(line.account).frozen;
            frozen.set(line.account.id, subFen(base, line.amount));
          }
          const voucherLines = planned.map((line): Line =>
            line.sub === 'frozen' && (frozen.get(line.account.id) ?? 0n) < 0n
              ? { ...line, sub: 'available' }
              : line,
          );
          const groups = new Map<string, number>();
          for (const line of voucherLines) {
            const s = state(line.account);
            if (line.sub === 'available') s.available = subFen(s.available, line.amount);
            else s.frozen = subFen(s.frozen, line.amount);
            const group = `${line.account.id}:${line.sub}`;
            groups.set(group, (groups.get(group) ?? 0) + 1);
            if (line.sub === 'frozen') stats.hit('frozen-line');
            if (ALLOWED.includes(line.type)) stats.hit('allowed-type');
          }
          if ([...groups.values()].some((count) => count > 1)) stats.hit('same-sub-multi-line');
          if (plan.key === 'reassign') stats.hit('reassign-key');
          await book(db, {
            appId: apps[plan.app]!,
            counter: counters[plan.app]!,
            uniqKey: uniqKey(plan.key, voucherLines[0]!.account.owner_id),
            lines: voucherLines,
          });
        }
        const [legacy, current] = await check([LEGACY, file]);
        const mine = new Set(apps);
        if (legacy!.some((row) => row.app_id !== null && mine.has(row.app_id))) {
          stats.hit('legacy-reports');
        }
        if ([...model.values()].some((s) => s.available < 0n)) stats.hit('negative-balance');
        seen += 1;
        const same = isDeepStrictEqual(lines(current!), lines(legacy!));
        if (!same) mismatch ??= { legacy: lines(legacy!), current: lines(current!) };
        return same;
      }),
      { numRuns: runs, seed: propSeed() },
    );
  });
  const record = stats.flush();
  expect({ seen, mismatch }).toEqual({ seen: runs, mismatch: null });
  // The generator must reach the cases the comparison is about.
  for (const bucket of ['legacy-reports', 'negative-balance', 'frozen-line', 'reassign-key']) {
    expect(record.hits[bucket] ?? 0, `generator coverage: ${bucket}`).toBeGreaterThan(0);
  }
}, 900_000);
