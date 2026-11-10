// B1-06zm: the account merge's release (BR-ID-06 as applied by B1-20c: active / invalid → released
// without cooling) judges its source statuses through the generated union-binding transition()
// (U9: active / invalid + RELEASE). The gate refuses invalid + RELEASE for this whole file, from
// before linking is loaded (the release may derive its status set once, at load): an invalid row
// must then stay as it is while the active one is still released. Only the orchestrator runs it.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import * as domain from '@couli/domain';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { releaseForMerge } from '../../../../apps/api/src/modules/linking/index.ts';
import { AT, bind, bindingsOf, subject } from '../deletion-cleanup/kit.ts';
import { asked, edge } from './kit.ts';

const gate = vi.hoisted(() => ({
  deny: new Set<string>(['invalid→RELEASE']),
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

it('[AC-B1-06zm#8] 合并释放的起点由生成的 transition() 判定：生成物拒绝 invalid + RELEASE 时 invalid 行原样（row_version 不变），active 照常 released（released_at = cooldown_until = at），blocked 不动', async () => {
  expect(gate.deny.has(edge('invalid', 'RELEASE'))).toBe(true);
  const s = await subject(db, { status: 'normal' });
  const active = await bind(db, s, { platform: 'taobao', status: 'active' });
  const invalid = await bind(db, s, { platform: 'pdd', status: 'invalid' });
  const banned = await bind(db, s, { platform: 'jd', status: 'blocked', blocked_reason: 'ban' });

  await db
    .transaction()
    .execute((trx) => releaseForMerge(trx, { appId: s.appId, userId: s.userId, at: AT }));

  expect(asked(transition)).toEqual(
    expect.arrayContaining([edge('active', 'RELEASE'), edge('invalid', 'RELEASE')]),
  );
  const after = await bindingsOf(db, s);
  expect(after).toHaveLength(3);
  const byId = (id: string) => after.find((row) => row.id === id);
  expect(byId(invalid.id), 'invalid（生成物拒绝）').toStrictEqual(invalid);
  expect(byId(active.id), 'active').toStrictEqual({
    ...active,
    status: 'released',
    released_at: AT,
    cooldown_until: AT,
    updated_at: AT,
    row_version: active.row_version + 1,
  });
  expect(byId(banned.id), 'blocked(ban)').toStrictEqual(banned);
});
