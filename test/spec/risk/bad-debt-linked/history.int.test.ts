// B2-12g (claude-independent), brief §11 (money r1): the reachable payout_account and device hits.
// - payout_account: payout_accounts keeps one current row per (app, alipay_hmac) and (app,
//   bank_card_hmac), so two members never hold one value at the same time; the match is between
//   every row of the written-off user and every row of the others (is_current=false ones too),
//   alipay_hmac or bank_card_hmac. Alipay changes go through identity's real save (./kit.ts rebind).
// - device: a reinstall of one phone registers a new devices row with the same device_hash; the
//   written-off user's session devices are taken by device_hash, and a session (revoked ones too)
//   of another member on any devices row of the app with that hash is a hit; never devices.user_id.
// Real approval on the admin entry, real logins and device registrations on the api entry.
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
  pastCard,
  rebind,
  requireMarksTable,
  syntheticCard,
  syntheticPayee,
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
  '[AC-B2-12g#10] 同收款账号含历史行：B 先绑支付宝 P、后换绑 Q；A 再绑 P（BR-WDR-02 允许）；U 只绑自己的号 → A 核销批准后 B 一行 payout_account 标记（source_user_id=A、source_ref=候选单 id），U 与 A 本人没有',
  async () => {
    await requireMarksTable(kit.db);
    const appId = await newApp(kit);
    const f = writeoffFixture(kit, redis.url, appId);
    const b = await enrol(kit, appId, await registerDevice(kit, appId));
    const p = b.payee;
    await rebind(kit, b, syntheticPayee());
    const a = await enrol(kit, appId, await registerDevice(kit, appId));
    await rebind(kit, a, p);
    await enrol(kit, appId, await registerDevice(kit, appId));
    expect(
      await holdersOf(kit, appId, { alipay: p }),
      'fixture: P 在 B 是历史行，在 A 是当前行',
    ).toEqual(
      byHolder([
        { user_id: a.userId, is_current: true },
        { user_id: b.userId, is_current: false },
      ]),
    );
    const { row } = await owing(f, a);

    await withWriteoffAdmin(f, async (h) => {
      await answer(await h.approve(row.id), 0);
    });
    await expectMarks(
      kit.db,
      appId,
      { userId: a.userId, row },
      [{ user: b, dimension: 'payout_account' }],
      f.clock.now(),
    );
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B2-12g#11] 同收款账号的其余组合：A 先绑支付宝 X 后换绑 Z、G 随后绑 X（A 历史行对 G 当前行）；A 与 C 都绑过又换掉银行卡 K（两边都是历史行，按 bank_card_hmac）→ G、C 各一行 payout_account 标记；只绑过别的卡 K2 的 D 不打标',
  async () => {
    await requireMarksTable(kit.db);
    const appId = await newApp(kit);
    const f = writeoffFixture(kit, redis.url, appId);
    const k = syntheticCard();
    const a = await enrol(kit, appId, await registerDevice(kit, appId));
    const x = a.payee;
    await rebind(kit, a, syntheticPayee());
    await pastCard(kit, a, k);
    const g = await enrol(kit, appId, await registerDevice(kit, appId), { payee: x });
    const c = await enrol(kit, appId, await registerDevice(kit, appId));
    await pastCard(kit, c, k);
    const d = await enrol(kit, appId, await registerDevice(kit, appId));
    await pastCard(kit, d, syntheticCard());
    expect(
      await holdersOf(kit, appId, { alipay: x }),
      'fixture: X 在 A 是历史行，在 G 是当前行',
    ).toEqual(
      byHolder([
        { user_id: a.userId, is_current: false },
        { user_id: g.userId, is_current: true },
      ]),
    );
    expect(await holdersOf(kit, appId, { card: k }), 'fixture: K 在 A、C 都是历史行').toEqual(
      byHolder([
        { user_id: a.userId, is_current: false },
        { user_id: c.userId, is_current: false },
      ]),
    );
    const { row } = await owing(f, a);

    await withWriteoffAdmin(f, async (h) => {
      await answer(await h.approve(row.id), 0);
    });
    await expectMarks(
      kit.db,
      appId,
      { userId: a.userId, row },
      [
        { user: g, dimension: 'payout_account' },
        { user: c, dimension: 'payout_account' },
      ],
      f.clock.now(),
    );
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B2-12g#12] 同设备按 device_hash：A 在 d1（哈希 H）登录，同一手机重装后登记 d2（哈希 H、新设备行），B 只在 d2 登录；C 只在 e1（哈希 H2）登录，A 在 e1 重装后的 e2 登录；U 在别的手机 → B、C 各一行 device 标记，U 与 A 本人没有',
  async () => {
    await requireMarksTable(kit.db);
    const appId = await newApp(kit);
    const f = writeoffFixture(kit, redis.url, appId);
    const d1 = await registerDevice(kit, appId);
    const a = await enrol(kit, appId, d1);
    const d2 = await registerDevice(kit, appId, d1.deviceHash);
    const b = await enrol(kit, appId, d2);
    const e1 = await registerDevice(kit, appId);
    const c = await enrol(kit, appId, e1);
    const e2 = await registerDevice(kit, appId, e1.deviceHash);
    await a.login(e2);
    await enrol(kit, appId, await registerDevice(kit, appId));
    for (const [first, again] of [
      [d1, d2],
      [e1, e2],
    ] as const) {
      expect(again.deviceId, 'fixture: 重装登记的是新设备行').not.toBe(first.deviceId);
      expect((await deviceRow(kit, again)).device_hash, 'fixture: 同一 device_hash').toBe(
        (await deviceRow(kit, first)).device_hash,
      );
    }
    const { row } = await owing(f, a);

    await withWriteoffAdmin(f, async (h) => {
      await answer(await h.approve(row.id), 0);
    });
    await expectMarks(
      kit.db,
      appId,
      { userId: a.userId, row },
      [
        { user: b, dimension: 'device' },
        { user: c, dimension: 'device' },
      ],
      f.clock.now(),
    );
  },
  CHAIN_TIMEOUT,
);
