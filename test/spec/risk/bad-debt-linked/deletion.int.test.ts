// B2-12g (claude-independent): the marks follow risk_hits on account deletion (brief §10, D10-758:
// BR-ID-30 留存待法务，确认前不删除). After the real approval marked B, both B (marked) and A
// (written off) go through identity's real deletion processing (createDeletionProcessing through
// ../../identity/deletion-processing/kit.ts controls, its ports answering as for a member with
// nothing pending); the rows are still there and unchanged. users.status deleting and the processing
// request are seeded, as that kit seeds them.
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  controls,
  ports,
  request,
  seedRequest,
  userRow,
} from '../../identity/deletion-processing/kit.ts';
import { close, open, type Kit } from '../../identity/payout-account/kit.ts';
import { answer, withWriteoffAdmin } from '../../ledger/bad-debt-writeoffs/kit.ts';
import { CHAIN_TIMEOUT, T } from '../../payout/risk-rule-toggle/chain-kit.ts';
import { newApp, registerDevice } from '../blocklist-device-scope/kit.ts';
import { enrol, expectMarks, marks, owing, requireMarksTable, writeoffFixture } from './kit.ts';

let database: TestDatabase;
let redis: TestRedis;
let kit: Kit;
beforeAll(async () => {
  database = await createTestDatabase();
  redis = await acquireTestRedis();
  kit = await open(database, redis);
}, 180_000);
afterAll(async () => {
  try {
    await close(kit);
  } finally {
    try {
      await redis?.stop();
    } finally {
      await database?.drop();
    }
  }
}, 60_000);
beforeEach(() => {
  kit.clock.set(T);
});

it(
  '[AC-B2-12g#9] 注销口径同 risk_hits（D10-758）：被打标的 B 与被核销的 A 都走完注销处理（请求 done、users 为 deleted）后，标记行仍在、逐字段不变',
  async () => {
    await requireMarksTable(kit.db);
    const appId = await newApp(kit);
    const f = writeoffFixture(kit, redis.url, appId);
    const d1 = await registerDevice(kit, appId);
    const a = await enrol(kit, appId, d1);
    const b = await enrol(kit, appId, d1);
    const { row } = await owing(f, a);
    await withWriteoffAdmin(f, async (h) => {
      await answer(await h.approve(row.id), 0);
    });
    const before = await expectMarks(
      kit.db,
      appId,
      { userId: a.userId, row },
      [{ user: b, dimension: 'device' }],
      f.clock.now(),
    );

    const deletion = await controls(kit.db, kit.crypto, await ports());
    const requests: string[] = [];
    for (const who of [b, a]) {
      await sql`UPDATE app.users SET status = 'deleting', row_version = row_version + 1
        WHERE app_id = ${appId} AND id = ${who.userId}`.execute(kit.db);
      const seeded = await seedRequest(kit.db, { appId, uid: who.userId, phoneHmac: null });
      requests.push(seeded.id);
    }
    await deletion.runner().runOnce();
    for (const id of requests) {
      expect((await request(kit.db, id)).status, `deletion request ${id}`).toBe('done');
    }
    for (const who of [b, a]) {
      expect((await userRow(kit.db, { appId, uid: who.userId })).status).toBe('deleted');
    }
    expect(await marks(kit.db, appId), '注销后标记行仍在、不改').toEqual(before);
  },
  CHAIN_TIMEOUT,
);
