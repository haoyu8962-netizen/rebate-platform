// B2-12g (claude-independent): BR-FUND-12「核销时给同实名、同设备、同收款账号的关联账户打风控标记」through
// the real approval (POST /admin/v1/bad-debt-writeoffs/{id}/approve on the admin entry) with members
// of real SMS logins on the api entry (./kit.ts). Brief §10: same app, the written-off user excluded;
// device = every device of the written-off user's sessions (revoked ones too) and every other user
// with a session (revoked ones too) on one of them, never devices.user_id (brief §11 widens it to the
// same device_hash: ./history.int.test.ts); one row per (user, dimension); only when the
// BAD_DEBT_WRITEOFF voucher is written (not on CANCELLED, not when the frozen check refuses);
// replays write nothing new; the marks are written on the approving transaction. The id_no hit is
// not built (realname_verified_id_no_hmac_key keeps one verified identity per value and app); its
// cross-app and non-verified counterparts are here. The payout_account hits, reachable only through
// history rows, are in ./history.int.test.ts. Every test first asserts the table exists.
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createBadDebtLinkedMarker } from '../../../../apps/api/src/modules/risk/index.ts';
import { close, open, type Kit } from '../../identity/payout-account/kit.ts';
import {
  answer,
  balanceCache,
  conflict,
  credit,
  everything,
  expectCancelled,
  expectWrittenOff,
  frozenPending,
  newKey,
  returnFrozen,
  withWriteoffAdmin,
} from '../../ledger/bad-debt-writeoffs/kit.ts';
import { CHAIN_TIMEOUT, T } from '../../payout/risk-rule-toggle/chain-kit.ts';
import { logout, newApp, registerDevice, withdrawPrivacy } from '../blocklist-device-scope/kit.ts';
import {
  enrol,
  expectMarks,
  marks,
  owing,
  requireMarksTable,
  writeoffFixture,
  type MarkRow,
  type MarksFault,
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
  '[AC-B2-12g#1] 同设备：被核销用户 A 真实登录过 D1、D2；B 在 D1 登录两次、C 在 D2 登录、U 只在自己的 D3 → 批准核销后 B、C 各一行 device 标记（source_user_id=A、source_ref=候选单 id、created_at=批准时刻），U 与 A 本人没有；核销本身照旧（凭证、余额、应答不变）',
  async () => {
    await requireMarksTable(kit.db);
    const appId = await newApp(kit);
    const f = writeoffFixture(kit, redis.url, appId);
    const d1 = await registerDevice(kit, appId);
    const d2 = await registerDevice(kit, appId);
    const d3 = await registerDevice(kit, appId);
    const a = await enrol(kit, appId, d1);
    await a.login(d2);
    const b = await enrol(kit, appId, d1);
    await b.login(d1);
    const c = await enrol(kit, appId, d2);
    await enrol(kit, appId, d3);
    const { m, row } = await owing(f, a);
    const cache = await balanceCache(f);

    await withWriteoffAdmin(f, async (h) => {
      await expectWrittenOff(f, await h.approve(row.id), {
        row,
        m,
        adminId: h.writer.id,
        amount: 800n,
        frozen: 0n,
        cache,
      });
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

it(
  '[AC-B2-12g#2] 已吊销的会话与设备也算（D10-571）：A 在 D1 的会话已退出登录、B 在 D1 的会话也已退出；A 在 D2 撤回隐私同意（设备与会话吊销），C 先前在 D2 登录过 → B、C 各一行 device 标记',
  async () => {
    await requireMarksTable(kit.db);
    const appId = await newApp(kit);
    const f = writeoffFixture(kit, redis.url, appId);
    const d1 = await registerDevice(kit, appId);
    const d2 = await registerDevice(kit, appId);
    const a = await enrol(kit, appId, d1);
    const b = await enrol(kit, appId, d1);
    await logout(kit, b.first);
    await logout(kit, a.first);
    const c = await enrol(kit, appId, d2);
    const onD2 = await a.login(d2);
    await withdrawPrivacy(kit, onD2);
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

it(
  '[AC-B2-12g#3] 不牵连：别的 app 里设备哈希、身份证号、收款账号都与 A 相同的 X 不打标；本 app 里身份证 HMAC 与 A 相同但实名不是 verified（注销后保留的 tax_retained）的 R 不打标；不相关的 U 与 A 本人不打标；与 A 同设备的 B 打标（对照）',
  async () => {
    await requireMarksTable(kit.db);
    const appId = await newApp(kit);
    const otherApp = await newApp(kit);
    const f = writeoffFixture(kit, redis.url, appId);
    const d1 = await registerDevice(kit, appId);
    const a = await enrol(kit, appId, d1);
    const b = await enrol(kit, appId, d1);
    await enrol(kit, appId, await registerDevice(kit, appId), {
      idNo: a.idNo,
      realname: 'retained',
    });
    await enrol(kit, appId, await registerDevice(kit, appId));
    const twin = await registerDevice(kit, otherApp, d1.deviceHash);
    await enrol(kit, otherApp, twin, { idNo: a.idNo, payee: a.payee });
    const { row } = await owing(f, a);

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
    expect(await marks(kit.db, otherApp), '别的 app 不打标').toEqual([]);
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B2-12g#4] 批准时余额已回正 → 候选单 CANCELLED、不写凭证，也不打标；同一 app 另一笔照常核销的只给它自己的关联账户打标（对照）',
  async () => {
    await requireMarksTable(kit.db);
    const appId = await newApp(kit);
    const f = writeoffFixture(kit, redis.url, appId);
    const d1 = await registerDevice(kit, appId);
    const d2 = await registerDevice(kit, appId);
    const a = await enrol(kit, appId, d1);
    await enrol(kit, appId, d1);
    const a2 = await enrol(kit, appId, d2);
    const b2 = await enrol(kit, appId, d2);
    const cancelled = await owing(f, a);
    await credit(f, cancelled.m, 800n);
    const written = await owing(f, a2);

    await withWriteoffAdmin(f, async (h) => {
      await expectCancelled(f, await h.approve(cancelled.row.id), {
        row: cancelled.row,
        m: cancelled.m,
        money: { available: 0n, frozen: 0n, negativeSince: null },
      });
      expect(await marks(kit.db, appId), 'CANCELLED 不打标').toEqual([]);
      await answer(await h.approve(written.row.id), 0);
    });
    await expectMarks(
      kit.db,
      appId,
      { userId: a2.userId, row: written.row },
      [{ user: b2, dimension: 'device' }],
      f.clock.now(),
    );
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B2-12g#5] frozen > 0 拒绝批准（writeoff_frozen_pending）时不打标；提现单退回后 available 0 再批准 → CANCELLED，仍不打标（BR-FUND-12 E-35 例）；另一笔照常核销的打标（对照）',
  async () => {
    await requireMarksTable(kit.db);
    const appId = await newApp(kit);
    const f = writeoffFixture(kit, redis.url, appId);
    const d1 = await registerDevice(kit, appId);
    const d2 = await registerDevice(kit, appId);
    const a = await enrol(kit, appId, d1);
    await enrol(kit, appId, d1);
    const a2 = await enrol(kit, appId, d2);
    const b2 = await enrol(kit, appId, d2);
    const held = await owing(f, a, { available: -1000n, frozen: 1000n });
    const written = await owing(f, a2);

    await withWriteoffAdmin(f, async (h) => {
      await frozenPending(await h.approve(held.row.id));
      expect(await marks(kit.db, appId), 'frozen 拒绝不打标').toEqual([]);
      await answer(await h.approve(written.row.id), 0);
      await returnFrozen(f, held.m, 1000n);
      await expectCancelled(f, await h.approve(held.row.id), {
        row: held.row,
        m: held.m,
        money: { available: 0n, frozen: 0n, negativeSince: null },
      });
    });
    await expectMarks(
      kit.db,
      appId,
      { userId: a2.userId, row: written.row },
      [{ user: b2, dimension: 'device' }],
      f.clock.now(),
    );
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B2-12g#6] 不重复：同一幂等键重放、换新键再批（20902）都不新增或改动标记行；risk 的标记端口对同一候选单再调一次（时钟已后移）也不新增、不改动（ON CONFLICT DO NOTHING）',
  async () => {
    await requireMarksTable(kit.db);
    const appId = await newApp(kit);
    const f = writeoffFixture(kit, redis.url, appId);
    const d1 = await registerDevice(kit, appId);
    const a = await enrol(kit, appId, d1);
    const b = await enrol(kit, appId, d1);
    const { row } = await owing(f, a);

    let first: MarkRow[] = [];
    await withWriteoffAdmin(f, async (h) => {
      const key = newKey();
      await answer(await h.approve(row.id, {}, { key }), 0);
      first = await expectMarks(
        kit.db,
        appId,
        { userId: a.userId, row },
        [{ user: b, dimension: 'device' }],
        f.clock.now(),
      );
      f.clock.advanceMs(60_000);
      await answer(await h.approve(row.id, {}, { key }), 0);
      expect(await marks(kit.db, appId), '同键重放').toEqual(first);
      await conflict(await h.approve(row.id, {}, { key: newKey() }));
      expect(await marks(kit.db, appId), '新键再批').toEqual(first);
    });

    const marker = createBadDebtLinkedMarker({ clock: f.clock });
    await kit.db
      .transaction()
      .execute((trx) => marker.mark(trx, { appId, sourceUserId: a.userId, sourceRef: row.id }));
    expect(await marks(kit.db, appId), '端口再调一次').toEqual(first);
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B2-12g#7] 同一事务：写标记失败时批准整笔回滚（50001；候选单仍 PENDING、无凭证、余额不变、无审计、无标记）；写审计失败时标记也随之回滚；换新幂等键重试后核销生效并打标',
  async () => {
    await requireMarksTable(kit.db);
    const appId = await newApp(kit);
    const fault: MarksFault = { armed: false, tripped: 0 };
    const f = writeoffFixture(kit, redis.url, appId, fault);
    const d1 = await registerDevice(kit, appId);
    const a = await enrol(kit, appId, d1);
    const b = await enrol(kit, appId, d1);
    const { m, row } = await owing(f, a);
    const before = await everything(f);
    const cache = await balanceCache(f);

    await withWriteoffAdmin(f, async (h) => {
      fault.armed = true;
      const failed = await h.approve(row.id, {}, { key: newKey() });
      expect(fault.tripped, '批准事务里应写 risk_linked_marks').toBe(1);
      await answer(failed, 50001);
      expect(await everything(f), '写标记失败整笔回滚').toEqual(before);
      expect(await marks(kit.db, appId)).toEqual([]);

      h.fault.point = 'audit';
      const tripped = h.fault.tripped;
      await answer(await h.approve(row.id, {}, { key: newKey() }), 50001);
      expect(h.fault.tripped, 'audit 故障应被触发').toBe(tripped + 1);
      expect(await everything(f), '写审计失败整笔回滚').toEqual(before);
      expect(await marks(kit.db, appId), '标记随批准回滚').toEqual([]);

      await expectWrittenOff(f, await h.approve(row.id, {}, { key: newKey() }), {
        row,
        m,
        adminId: h.writer.id,
        amount: 800n,
        frozen: 0n,
        cache,
      });
    });
    await expectMarks(
      kit.db,
      appId,
      { userId: a.userId, row },
      [{ user: b, dimension: 'device' }],
      f.clock.now(),
    );
  },
  CHAIN_TIMEOUT,
);
