import { expect, it } from 'vitest';
import type { AuditInput, Clock } from '../../platform/index.ts';
import { aiConsentVersionSaveCheck } from './ai-consent-version-save-check.ts';
import {
  ConfigItemAdmin,
  ConfigItemFieldsError,
  combineConfigItemSaveChecks,
  type ConfigItemActor,
  type ConfigItemRow,
  type ConfigItemStore,
  type ConfigItemTx,
  type ConfigItemWrite,
} from './config-item-admin.ts';

const AT = new Date('2026-10-01T00:00:00.000Z');
const clock: Clock = { now: () => AT } as Clock;
const actor: ConfigItemActor = {
  appId: 'couli',
  adminId: 'admin-1',
  loginName: 'ops',
  ip: null,
  traceId: 'trace-1',
};

interface Fake {
  readonly admin: ConfigItemAdmin;
  readonly writes: ConfigItemWrite[];
  readonly audits: AuditInput[];
  readonly alerts: unknown[];
  /** Transaction calls in order: `ai-lock`, `lock:<key>`, `values:<keys>`, `write:<key>`. */
  readonly calls: string[];
}

function fake(
  rows: Record<string, ConfigItemRow>,
  history: Record<string, unknown> = {},
  options: { readonly aiLock?: boolean } = {},
): Fake {
  const calls: string[] = [];
  const writes: ConfigItemWrite[] = [];
  const audits: AuditInput[] = [];
  const alerts: unknown[] = [];
  const tx: ConfigItemTx = {
    lock: (_app, key) => {
      calls.push(`lock:${key}`);
      return Promise.resolve(rows[key]);
    },
    version: (_app, key, version) => {
      const id = `${key}@${version}`;
      return Promise.resolve(
        Object.hasOwn(history, id) ? { value: history[id] as ConfigItemRow['value'] } : undefined,
      );
    },
    change: (input) => {
      calls.push(`write:${input.key}`);
      writes.push(input);
      return Promise.resolve({
        key: input.key,
        value: input.value,
        version: input.expectedVersion + 1,
        updatedBy: input.actor.adminId,
        updatedAt: input.at,
      });
    },
    history: () => Promise.resolve(),
    lockInviteReward: () => Promise.resolve(),
    ...(options.aiLock === false
      ? {}
      : {
          lockAiConsentVersion: (app: string) => {
            calls.push(`ai-lock:${app}`);
            return Promise.resolve();
          },
        }),
    values: (_app, keys) => {
      calls.push(`values:${keys.join(',')}`);
      return Promise.resolve(
        new Map(keys.flatMap((key) => (rows[key] === undefined ? [] : [[key, rows[key].value]]))),
      );
    },
    audit: (input) => {
      audits.push(input);
      return Promise.resolve();
    },
  };
  const store: ConfigItemStore = {
    rows: () => Promise.resolve(Object.values(rows)),
    row: (_app, key) => Promise.resolve(rows[key]),
    versions: () => Promise.reject(new Error('unused')),
    transaction: (work) => work(tx),
  };
  const admin = new ConfigItemAdmin(store, clock, { warn: (obj: unknown) => alerts.push(obj) });
  return { admin, writes, audits, alerts, calls };
}

function row(key: string, value: ConfigItemRow['value'], version: number): ConfigItemRow {
  return { key, value, version, updatedBy: 'seed', updatedAt: AT };
}

async function fieldsOf(work: Promise<unknown>): Promise<readonly string[]> {
  const error: unknown = await work.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ConfigItemFieldsError);
  return (error as ConfigItemFieldsError).fields;
}

it('[AC-F1-02zj#8] PUT settle.bill_day out of range is 20001 [value] with no write', async () => {
  const { admin, writes, audits, alerts } = fake({
    'settle.bill_day': row('settle.bill_day', 24, 1),
  });
  expect(
    await fieldsOf(admin.update(actor, 'settle.bill_day', { value: 29, expected_version: 1 })),
  ).toStrictEqual(['value']);
  expect([writes, audits, alerts]).toStrictEqual([[], [], []]);
  const item = await admin.update(actor, 'settle.bill_day', { value: 22, expected_version: 1 });
  expect(item.value).toBe(22);
  expect(writes).toHaveLength(1);
  expect(audits).toHaveLength(1);
});

it('[AC-F1-02zj#9] batch lists only the out-of-range key and writes nothing', async () => {
  const { admin, writes, audits } = fake({});
  expect(
    await fieldsOf(
      admin.batch(actor, {
        items: [
          { key: 'settle.batch.max_orders', value: 0, expected_version: 0 },
          { key: 'settle.statement.grace_days', value: 10, expected_version: 0 },
        ],
      }),
    ),
  ).toStrictEqual(['settle.batch.max_orders']);
  expect([writes, audits]).toStrictEqual([[], []]);
});

it('[AC-F1-02zj#10] rollback to an out-of-range historical value is 20001 [to_version]', async () => {
  const { admin, writes, audits } = fake(
    { 'settle.bill_day': row('settle.bill_day', 24, 3) },
    { 'settle.bill_day@2': 30, 'settle.bill_day@1': 23 },
  );
  expect(
    await fieldsOf(
      admin.rollback(actor, 'settle.bill_day', { to_version: 2, expected_version: 3 }),
    ),
  ).toStrictEqual(['to_version']);
  expect([writes, audits]).toStrictEqual([[], []]);
  const item = await admin.rollback(actor, 'settle.bill_day', {
    to_version: 1,
    expected_version: 3,
  });
  expect(item.value).toBe(23);
  expect(writes).toHaveLength(1);
});

it('[AC-F1-02zj#11] list exposes the enum options of settle.* items', async () => {
  const { admin } = fake({});
  const page = await admin.list('couli', { page: 1, page_size: 100 });
  const source = page.items.find((item) => item.key === 'settle.statement_source.taobao');
  expect(source?.options).toStrictEqual(['api', 'upload']);
  expect(page.total).toBe(176);
});

it('[AC-B1-05m] combined save checks run only for their own written keys and read only their keys', () => {
  const seen: string[][] = [];
  const check = (keys: string[], refuse: string[]) => ({
    keys,
    refusals: (stored: ReadonlyMap<string, unknown>, written: ReadonlyMap<string, unknown>) => {
      seen.push([...stored.keys()]);
      return refuse.filter((key) => written.has(key));
    },
  });
  const combined = combineConfigItemSaveChecks(
    check(['a', 'b'], ['a']),
    check(['b', 'c'], ['b', 'c']),
  );
  expect(combined.keys).toEqual(['a', 'b', 'c']);
  const stored = new Map<string, unknown>([
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ]);
  expect(combined.refusals(stored, new Map([['c', 0]]))).toEqual(['c']);
  expect(seen).toEqual([['b', 'c']]);
  seen.length = 0;
  expect(
    combined.refusals(
      stored,
      new Map([
        ['a', 0],
        ['b', 0],
      ]),
    ),
  ).toEqual(['a', 'b']);
  expect(seen).toEqual([
    ['a', 'b'],
    ['b', 'c'],
  ]);
  expect(combined.refusals(stored, new Map([['z', 0]]))).toEqual([]);
});

const AI = 'legal.ai_third_party.version';
const GUEST = 'agent.guest_daily_quota';
const AI_LOCK = `ai-lock:${actor.appId}`;

it('[AC-B1-22zb unit] single update of the AI consent version takes its lock first, before the current value is read', async () => {
  const f = fake({ [AI]: row(AI, 3, 1) });
  const admin = f.admin.withChecks({ save: aiConsentVersionSaveCheck() });
  expect(await fieldsOf(admin.update(actor, AI, { value: 2, expected_version: 1 }))).toStrictEqual([
    'value',
  ]);
  expect(f.calls).toStrictEqual([AI_LOCK, `lock:${AI}`, `values:${AI}`]);
  expect(f.writes).toStrictEqual([]);
  f.calls.length = 0;
  // A first write (no row yet) takes the same lock.
  const first = fake({});
  await first.admin
    .withChecks({ save: aiConsentVersionSaveCheck() })
    .update(actor, AI, { value: 1, expected_version: 0 });
  expect(first.calls[0]).toBe(AI_LOCK);
  expect(first.calls.filter((call) => call === AI_LOCK)).toHaveLength(1);
  expect(first.writes).toHaveLength(1);
});

it('[AC-B1-22zb unit] a batch with the AI consent version takes its lock first, once', async () => {
  const f = fake({ [AI]: row(AI, 3, 1), [GUEST]: row(GUEST, 20, 1) });
  const admin = f.admin.withChecks({ save: aiConsentVersionSaveCheck() });
  expect(
    await fieldsOf(
      admin.batch(actor, {
        items: [
          { key: GUEST, value: 10, expected_version: 1 },
          { key: AI, value: 2, expected_version: 1 },
        ],
      }),
    ),
  ).toStrictEqual([AI]);
  expect(f.calls).toStrictEqual([AI_LOCK, `lock:${AI}`, `values:${AI}`]);
  expect(f.writes).toStrictEqual([]);
  f.calls.length = 0;
  await admin.batch(actor, { items: [{ key: AI, value: 4, expected_version: 1 }] });
  expect(f.calls).toStrictEqual([
    AI_LOCK,
    `lock:${AI}`,
    `values:${AI}`,
    `lock:${AI}`,
    `write:${AI}`,
  ]);
});

it('[AC-B1-22zb unit] a rollback of the AI consent version takes its lock first', async () => {
  const f = fake({ [AI]: row(AI, 3, 3) }, { [`${AI}@1`]: 5, [`${AI}@2`]: 2 });
  const admin = f.admin.withChecks({ save: aiConsentVersionSaveCheck() });
  expect(
    await fieldsOf(admin.rollback(actor, AI, { to_version: 2, expected_version: 3 })),
  ).toStrictEqual(['to_version']);
  expect(f.calls[0]).toBe(AI_LOCK);
  expect(f.calls.indexOf(AI_LOCK)).toBeLessThan(f.calls.indexOf(`values:${AI}`));
  expect(f.writes).toStrictEqual([]);
  f.calls.length = 0;
  const item = await admin.rollback(actor, AI, { to_version: 1, expected_version: 3 });
  expect(item.value).toBe(5);
  expect(f.calls[0]).toBe(AI_LOCK);
});

it('[AC-B1-22zb unit] saves of other keys take no AI consent lock on any path', async () => {
  const f = fake({ [GUEST]: row(GUEST, 20, 2) }, { [`${GUEST}@1`]: 5 });
  const admin = f.admin.withChecks({ save: aiConsentVersionSaveCheck() });
  await admin.update(actor, GUEST, { value: 30, expected_version: 2 });
  await admin.batch(actor, { items: [{ key: GUEST, value: 40, expected_version: 2 }] });
  await admin.rollback(actor, GUEST, { to_version: 1, expected_version: 2 });
  expect(f.writes).toHaveLength(3);
  expect(f.calls.filter((call) => call.startsWith('ai-lock'))).toStrictEqual([]);
});

it('[AC-B1-22zb unit] a store without the AI consent lock refuses to write the key at all', async () => {
  const f = fake({}, {}, { aiLock: false });
  const admin = f.admin.withChecks({ save: aiConsentVersionSaveCheck() });
  await expect(admin.update(actor, AI, { value: 1, expected_version: 0 })).rejects.toThrow(
    'cannot lock',
  );
  await expect(
    admin.batch(actor, { items: [{ key: AI, value: 1, expected_version: 0 }] }),
  ).rejects.toThrow('cannot lock');
  expect(f.writes).toStrictEqual([]);
  expect(f.calls).toStrictEqual([]);
});
