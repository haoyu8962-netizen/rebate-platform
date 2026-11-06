// B2-12g (claude-independent): the linked accounts' mark is a trace only (brief §10: 不改提现判定、
// 不发通知、无后台接口). The marked member's withdrawal rules answer, users row and notices are what
// they were before the write-off, and a withdrawal applied after it is created as before. Real
// approval on the admin entry, real logins and withdrawals on the api entry (./kit.ts).
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { close, open, type Kit } from '../../identity/payout-account/kit.ts';
import { answer, withWriteoffAdmin } from '../../ledger/bad-debt-writeoffs/kit.ts';
import { CHAIN_TIMEOUT, T } from '../../payout/risk-rule-toggle/chain-kit.ts';
import {
  apply,
  newApp,
  registerDevice,
  rules,
  withdrawalRow,
} from '../blocklist-device-scope/kit.ts';
import {
  enrol,
  expectMarks,
  noticesOf,
  owing,
  requireMarksTable,
  userRowOf,
  writeoffFixture,
} from './kit.ts';

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
  '[AC-B2-12g#8] 只留痕：B 因与 A 同设备被打标后，B 的 GET /v1/withdrawals/rules 应答与打标前相同，users 行不变，没有站内信或通知记录；B 打标后申请提现照常建单（PENDING_REVIEW）',
  async () => {
    await requireMarksTable(kit.db);
    const appId = await newApp(kit);
    const f = writeoffFixture(kit, redis.url, appId);
    const d1 = await registerDevice(kit, appId);
    const a = await enrol(kit, appId, d1);
    const b = await enrol(kit, appId, d1);
    const { row } = await owing(f, a);
    const rulesBefore = await rules(kit, b.first);
    expect(rulesBefore.statusCode).toBe(200);
    const userBefore = await userRowOf(kit.db, b);
    const noticesBefore = await noticesOf(kit.db, b);

    await withWriteoffAdmin(f, async (h) => {
      await answer(await h.approve(row.id), 0);
    });
    await expectMarks(
      kit.db,
      appId,
      { userId: a.userId, row },
      [{ user: b, dimension: 'device' }],
      f.clock.now(),
    );

    expect(await userRowOf(kit.db, b), 'users 行不变').toEqual(userBefore);
    expect(await noticesOf(kit.db, b), '不发通知').toEqual(noticesBefore);
    const rulesAfter = await rules(kit, b.first);
    expect(rulesAfter.statusCode).toBe(200);
    expect(rulesAfter.json<{ data: unknown }>().data, '提现规则应答不变').toEqual(
      rulesBefore.json<{ data: unknown }>().data,
    );
    const id = await apply(kit, b.first);
    expect(await withdrawalRow(kit, appId, id)).toMatchObject({ status: 'PENDING_REVIEW' });
  },
  CHAIN_TIMEOUT,
);
