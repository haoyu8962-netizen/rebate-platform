// B2-12ga (test-change, claude-independent): BR-FUND-12 / B2-12g brief §10「一个用户同时满足多维度 →
// 每个维度一行」. B2-12g spec-test r3 S2 (multi-dimension-rows): no frozen rule test gives one member
// two dimensions, so an implementation collapsing a member to one row (DISTINCT ON (user_id), or a
// dedup by user_id) passed every test. Here member B matches written-off A on both device (a
// reinstall of A's phone: a new devices row with A's device_hash, B logs in there) and
// payout_account (B bound Alipay P first and changed away from it, A then binds P: B's row is an
// is_current=false history row). The fixtures are the frozen ../bad-debt-linked/kit.ts ones, used
// as [AC-B2-12g#10] and [AC-B2-12g#12] use them; nothing there is changed.
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
import { deviceRow, newApp, registerDevice } from '../blocklist-device-scope/kit.ts';
import {
  byHolder,
  enrol,
  expectMarks,
  holdersOf,
  owing,
  rebind,
  requireMarksTable,
  syntheticPayee,
  writeoffFixture,
} from '../bad-debt-linked/kit.ts';

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
  '[AC-B2-12ga#1] 同一成员同时命中两维：A 在 d1（哈希 H）登录；B 在同一手机重装后的 d2（哈希 H、新设备行）登录，且 B 先绑支付宝 P 后换绑、A 再绑 P（B 的 P 是历史行）；U 在别的手机、只绑自己的号 → A 核销批准后 B 恰好两行标记（device、payout_account，source_user_id=A、source_ref=候选单 id），U 与 A 本人没有',
  async () => {
    await requireMarksTable(kit.db);
    const appId = await newApp(kit);
    const f = writeoffFixture(kit, redis.url, appId);
    const d1 = await registerDevice(kit, appId);
    const a = await enrol(kit, appId, d1);
    const d2 = await registerDevice(kit, appId, d1.deviceHash);
    const b = await enrol(kit, appId, d2);
    const p = b.payee;
    await rebind(kit, b, syntheticPayee());
    await rebind(kit, a, p);
    const u = await enrol(kit, appId, await registerDevice(kit, appId));

    expect(d2.deviceId, 'fixture: 重装登记的是新设备行').not.toBe(d1.deviceId);
    expect((await deviceRow(kit, d2)).device_hash, 'fixture: 同一 device_hash').toBe(
      (await deviceRow(kit, d1)).device_hash,
    );
    expect(
      await holdersOf(kit, appId, { alipay: p }),
      'fixture: P 在 B 是历史行，在 A 是当前行',
    ).toEqual(
      byHolder([
        { user_id: a.userId, is_current: true },
        { user_id: b.userId, is_current: false },
      ]),
    );
    expect(await holdersOf(kit, appId, { alipay: u.payee }), 'fixture: U 的号只有 U').toEqual([
      { user_id: u.userId, is_current: true },
    ]);
    const { row } = await owing(f, a);

    await withWriteoffAdmin(f, async (h) => {
      await answer(await h.approve(row.id), 0);
    });
    const rows = await expectMarks(
      kit.db,
      appId,
      { userId: a.userId, row },
      [
        { user: b, dimension: 'device' },
        { user: b, dimension: 'payout_account' },
      ],
      f.clock.now(),
    );
    const ofB = rows.filter((mark) => mark.user_id === b.userId);
    expect(ofB.map((mark) => mark.dimension).sort(), 'B 每个维度一行，恰好两行').toEqual([
      'device',
      'payout_account',
    ]);
    for (const mark of ofB) {
      expect(mark.source_user_id).toBe(a.userId);
      expect(mark.source_ref).toBe(row.id);
    }
    expect(
      rows.filter((mark) => mark.user_id === u.userId || mark.user_id === a.userId),
      'U 与 A 本人没有标记',
    ).toEqual([]);
  },
  CHAIN_TIMEOUT,
);
