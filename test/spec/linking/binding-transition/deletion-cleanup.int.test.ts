// B1-06zm: the deletion cleanup's source statuses (BR-ID-20: 注销 → blocked(deletion); B1-06zc)
// come from the generated union-binding transition() (U8: pending_auth / active / invalid + BLOCK).
// The gate refuses invalid + BLOCK for this whole file, from before linking is loaded (the cleanup
// may derive its status set once, at load): an invalid row must then stay as it is while active and
// pending_auth still become blocked(deletion). Only the orchestrator runs this file.
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import * as domain from '@couli/domain';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { blockForDeletion } from '../../../../apps/api/src/modules/linking/index.ts';
import { AT, bind, bindingsOf, blockedForDeletion, subject } from '../deletion-cleanup/kit.ts';
import { asked, edge } from './kit.ts';

const gate = vi.hoisted(() => ({
  deny: new Set<string>(['invalid→BLOCK']),
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

it('[AC-B1-06zm#7] 注销清理的可停用起点由生成的 transition() 判定：生成物拒绝 invalid + BLOCK 时 invalid 行原样（row_version 不变），active / pending_auth 照常 blocked(deletion)，released 不动', async () => {
  expect(gate.deny.has(edge('invalid', 'BLOCK'))).toBe(true);
  const s = await subject(db);
  const active = await bind(db, s, { platform: 'taobao', status: 'active' });
  const invalid = await bind(db, s, { platform: 'jd', status: 'invalid' });
  const pending = await bind(db, s, { platform: 'pdd', status: 'pending_auth' });
  const released = await bind(db, s, { platform: 'eleme', status: 'released' });

  await db
    .transaction()
    .execute((trx) => blockForDeletion(trx, { appId: s.appId, userId: s.userId, at: AT }));

  expect(asked(transition)).toEqual(
    expect.arrayContaining([
      edge('active', 'BLOCK'),
      edge('pending_auth', 'BLOCK'),
      edge('invalid', 'BLOCK'),
    ]),
  );
  const after = await bindingsOf(db, s);
  expect(after).toHaveLength(4);
  const byId = (id: string) => after.find((row) => row.id === id);
  expect(byId(invalid.id), 'invalid（生成物拒绝）').toStrictEqual(invalid);
  expect(byId(active.id), 'active').toStrictEqual(blockedForDeletion(active));
  expect(byId(pending.id), 'pending_auth').toStrictEqual(blockedForDeletion(pending));
  expect(byId(released.id), 'released').toStrictEqual(released);
});
