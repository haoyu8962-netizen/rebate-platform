// B1-06zm: the ban / unban ports (binding-risk.ts; BR-ID-20, BR-ID-31; F1-07c) judge every step
// through the generated union-binding transition(): ban is U8 (+ BLOCK), unban is U7 (blocked +
// INVALIDATE) and, on a union other than Taobao, U4 right after it (invalid + ACTIVATE, the same
// operation: the generated table has no blocked → active). With the real table the rows change as
// before; with a step refused by the gate nothing is written (row_version unchanged), the whole
// operation rolled back on the caller's transaction. Only the orchestrator runs this file.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import * as domain from '@couli/domain';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { blockForBan, restoreAfterUnban } from '../../../../apps/api/src/modules/linking/index.ts';
import { AT, bind, bindingsOf, subject } from '../deletion-cleanup/kit.ts';
import { asked, edge } from './kit.ts';

const gate = vi.hoisted(() => ({
  deny: new Set<string>(),
  table: null as ReadonlySet<string> | null,
}));

vi.mock('@couli/domain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@couli/domain')>();
  const { gatedTransition } = await import('./kit.ts');
  return {
    ...actual,
    transitionUnionBinding: vi.fn(gatedTransition(gate, actual.transitionUnionBinding)),
  };
});

const transition = vi.mocked(domain.transitionUnionBinding);
const clock = { now: () => AT };

let database: TestDatabase | undefined;
let db: Kysely<DB>;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
});

afterAll(async () => {
  try {
    if (db) await destroyDb(db);
  } finally {
    await database?.drop();
  }
});

beforeEach(() => {
  gate.deny.clear();
  transition.mockClear();
});

afterEach(() => {
  gate.deny.clear();
});

it('[AC-B1-06zm#9] 封禁联动经生成的 transition() 判定每一行：active / invalid / pending_auth 各问一次 + BLOCK，照常改 blocked(ban)', async () => {
  const s = await subject(db, { status: 'normal' });
  const rows = [
    await bind(db, s, { platform: 'taobao', status: 'active' }),
    await bind(db, s, { platform: 'jd', status: 'invalid' }),
    await bind(db, s, { platform: 'pdd', status: 'pending_auth' }),
  ];

  await db
    .transaction()
    .execute((trx) => blockForBan(trx, { appId: s.appId, userId: s.userId, clock }));

  expect(asked(transition)).toEqual(
    expect.arrayContaining([
      edge('active', 'BLOCK'),
      edge('invalid', 'BLOCK'),
      edge('pending_auth', 'BLOCK'),
    ]),
  );
  const after = await bindingsOf(db, s);
  for (const row of rows) {
    expect(
      after.find((candidate) => candidate.id === row.id),
      row.status,
    ).toStrictEqual({
      ...row,
      status: 'blocked',
      blocked_reason: 'ban',
      updated_at: AT,
      row_version: row.row_version + 1,
    });
  }
});

it('[AC-B1-06zm#10] 封禁联动：生成物拒绝 invalid + BLOCK 时该迁移被拒，绑定原样（status、row_version 不变）', async () => {
  const s = await subject(db, { status: 'normal' });
  const row = await bind(db, s, { platform: 'taobao', status: 'invalid' });
  gate.deny.add(edge('invalid', 'BLOCK'));

  await db
    .transaction()
    .execute((trx) => blockForBan(trx, { appId: s.appId, userId: s.userId, clock }))
    .catch(() => undefined);

  expect(asked(transition)).toContain(edge('invalid', 'BLOCK'));
  expect(await bindingsOf(db, s)).toStrictEqual([row]);
});

const UNBAN = [
  { platform: 'taobao', status: 'invalid', edges: [edge('blocked', 'INVALIDATE')] },
  {
    platform: 'pdd',
    status: 'active',
    edges: [edge('blocked', 'INVALIDATE'), edge('invalid', 'ACTIVATE')],
  },
] as const;

it.each(UNBAN)(
  '[AC-B1-06zm#11] 解封联动 $platform：blocked(ban) 经生成的 transition() 回到 $status（其他联盟 blocked → invalid → active 同一操作两步）',
  async ({ platform, status, edges }) => {
    const s = await subject(db, { status: 'normal' });
    const row = await bind(db, s, { platform, status: 'blocked', blocked_reason: 'ban' });

    await db
      .transaction()
      .execute((trx) => restoreAfterUnban(trx, { appId: s.appId, userId: s.userId, clock }));

    expect(asked(transition)).toEqual(expect.arrayContaining([...edges]));
    const [after] = await bindingsOf(db, s);
    expect(after).toMatchObject({
      id: row.id,
      status,
      blocked_reason: null,
      bound_at: row.bound_at,
      relation_id: row.relation_id,
      released_at: null,
      cooldown_until: null,
      updated_at: AT,
    });
    // Taobao: one step (+1, as before); another union: not the number of internal steps.
    if (platform === 'taobao') expect(after?.row_version).toBe(row.row_version + 1);
    else expect(after?.row_version).toBeGreaterThan(row.row_version);
  },
);

const UNBAN_DENIED = [
  { platform: 'taobao', denied: edge('blocked', 'INVALIDATE') },
  { platform: 'pdd', denied: edge('blocked', 'INVALIDATE') },
  { platform: 'pdd', denied: edge('invalid', 'ACTIVATE') },
] as const;

it.each(UNBAN_DENIED)(
  '[AC-B1-06zm#12] 解封联动 $platform：生成物拒绝 $denied 时整次恢复被拒，绑定仍是 blocked(ban)、row_version 不变',
  async ({ platform, denied }) => {
    const s = await subject(db, { status: 'normal' });
    const row = await bind(db, s, { platform, status: 'blocked', blocked_reason: 'ban' });
    gate.deny.add(denied);

    await db
      .transaction()
      .execute((trx) => restoreAfterUnban(trx, { appId: s.appId, userId: s.userId, clock }))
      .catch(() => undefined);

    expect(asked(transition)).toContain(denied);
    expect(await bindingsOf(db, s)).toStrictEqual([row]);
  },
);
