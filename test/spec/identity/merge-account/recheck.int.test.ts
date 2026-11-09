// B1-20c: the merge judges the conditions again, on the locked rows, when it is confirmed
// (规划/08 BR-ID-06「任一条件不满足时只返回 30411」; 02 §18「并号」; D10-1099 Q-3: any admin_adjustments
// row of the source makes it non-empty; Q-4: a blocked(admin_disable) binding of the source is not
// merged). A condition that stopped holding after the ticket was issued → 30411 without reason,
// nothing written (users, user_oauth, bindings, sessions, registrations, login records, push
// tokens) and the ticket not consumed: once the condition holds again the same ticket merges.
// The judgement is on the rows as they are after the lock, not on what was read before it: #49
// changes the target's number, #53 gives the source a number, each in a transaction that holds
// that users row while the merge is seen waiting on it (queued() fails the test otherwise).
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PHONE_CONTEXT, bound, closeKit, openKit, type Kit } from '../bind-phone/http-kit.ts';
import { balanceAccount, entry } from '../bind-phone-merge-conditions/kit.ts';
import { phone } from '../sms-codes/kit.ts';
import { BIND_PATH, merged, refused, scene, usable, type Scene, type Snapshot } from './kit.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await openKit();
}, 180_000);
afterAll(async () => {
  await closeKit(kit);
}, 120_000);

interface Change {
  readonly label: string;
  change(s: Scene): Promise<unknown>;
}

const SOURCE: readonly Change[] = [
  { label: '源有了一笔已归因订单', change: (s) => s.order(s.source) },
  { label: '源有了一条找回申请', change: (s) => s.claim(s.source) },
  {
    label: '源余额有了一条分录',
    change: async (s) =>
      entry(kit, s.db, s.appId, await balanceAccount(s.db, s.appId, s.source), {
        ledgerType: 'REWARD',
        amountFen: -1,
      }),
  },
  {
    // Any entry counts, not the net amount: -100 and +100 leave a zero balance.
    label: '源余额有了两条相反分录（-100 分、+100 分，净额为零）',
    change: async (s) => {
      const account = await balanceAccount(s.db, s.appId, s.source);
      await entry(kit, s.db, s.appId, account, { ledgerType: 'REBATE_CREDIT', amountFen: -100 });
      await entry(kit, s.db, s.appId, account, { ledgerType: 'CLAWBACK', amountFen: 100 });
    },
  },
  { label: '源绑定了上级', change: async (s) => s.setParent(s.source, await s.bystander()) },
  { label: '源有了下级', change: async (s) => s.setParent(await s.bystander(), s.source) },
  { label: '源有了一条待审核调账单（Q-3）', change: (s) => s.adjustment(s.source, 'PENDING') },
  { label: '源有了一条已取消的调账单（Q-3）', change: (s) => s.adjustment(s.source, 'CANCELLED') },
  { label: '源有了一条已驳回的调账单（Q-3）', change: (s) => s.adjustment(s.source, 'REJECTED') },
  {
    label: '源有了 blocked(admin_disable) 的联盟绑定（Q-4）',
    change: (s) =>
      s.binding(s.source, {
        platform: 'taobao',
        status: 'blocked',
        blocked_reason: 'admin_disable',
      }),
  },
];

const TARGET: readonly Change[] = [
  { label: '目标被封禁', change: (s) => s.setRisk(s.target, 'banned') },
  {
    label: '目标封禁后申诉中（appealing，申诉前 banned）',
    change: async (s) => {
      await s.setRisk(s.target, 'banned');
      await s.appeal(s.target, 'banned');
      await s.setRisk(s.target, 'appealing');
    },
  },
  { label: '目标进入注销冷静期', change: (s) => s.deletion(s.target, 'cooling') },
  {
    label: '目标注销处理中（deletion_requests processing）',
    change: (s) => s.deletion(s.target, 'processing'),
  },
  {
    label: '目标注销处理中（users.status=deleting）',
    change: (s) => s.setStatus(s.target, 'deleting'),
  },
  { label: '目标已注销（users.status=deleted）', change: (s) => s.setStatus(s.target, 'deleted') },
  { label: '目标手机号已改走', change: (s) => s.setPhone(s.target, phone('137')) },
  { label: '目标已有同 provider 的第三方身份', change: (s) => s.oauth(s.target, s.provider) },
];

for (const { label, change } of [...SOURCE, ...TARGET]) {
  it(`[AC-B1-20c#15] 签票后${label} → 只返回 30411，什么都不写，ticket 不核销`, async () => {
    const s = await scene(kit);
    const ticket = await s.offer();
    await change(s);
    const before = await s.snapshot();

    refused(kit, await s.merge(ticket));

    expect(await s.snapshot()).toEqual(before);
    await s.ticketKept(ticket);
    expect((await s.user(s.source)).status).toBe('normal');
  });
}

it('[AC-B1-20c#16] 目标被封禁时只返回 30411；解封后同一 ticket 照常并号（未被核销）', async () => {
  const s = await scene(kit);
  const ticket = await s.offer();
  await s.setRisk(s.target, 'banned');
  refused(kit, await s.merge(ticket));
  await s.ticketKept(ticket);

  await s.setRisk(s.target, 'normal');
  merged(kit, await s.merge(ticket), s.target);
  expect(await s.user(s.source)).toMatchObject({ status: 'deleted', deleted_reason: 'merged' });
});

it('[AC-B1-20c#17] 只看源与目标：同 App 其他用户的订单、调账单、admin_disable 绑定不影响并号', async () => {
  const s = await scene(kit);
  const other = await s.bystander();
  await s.order(other);
  await s.adjustment(other, 'PENDING');
  await s.binding(other, {
    platform: 'taobao',
    status: 'blocked',
    blocked_reason: 'admin_disable',
  });
  const ticket = await s.offer();

  merged(kit, await s.merge(ticket), s.target);
});

it('[AC-B1-20c#48] 签票后源在另一台设备正常完成首次绑定手机号 → 再交原 ticket 只返回 30411，什么都不写，源不置墓碑、身份不迁', async () => {
  const s = await scene(kit);
  const ticket = await s.offer();
  const other = await s.newDevice();
  const there = await s.login(s.source, other);
  const own = phone('136');
  const code = await s.send(own, other);
  bound(kit, await s.post(BIND_PATH, { phone: own, code }, { token: there.access_token }, other));
  expect((await s.user(s.source)).phone_hmac).toBe(s.hmac(own));
  const before = await s.snapshot();

  refused(kit, await s.merge(ticket));

  expect(await s.snapshot()).toEqual(before);
  expect(await s.user(s.source)).toMatchObject({
    status: 'normal',
    deleted_reason: null,
    phone_hmac: s.hmac(own),
  });
  expect((await s.rows.oauth(s.source)).map((row) => row.id)).toEqual([s.sourceOauth]);
  expect(await s.rows.oauth(s.target)).toEqual([]);
});

it('[AC-B1-20c#49] 并号在锁外读到目标旧号码、随后等目标行锁；持锁的另一事务把目标号码改走并提交 → 只返回 30411，不迁移，ticket 不核销', async () => {
  const s = await scene(kit);
  const ticket = await s.offer();
  const moved = s.hmac(phone('137'));
  const before = await s.snapshot();
  const gate = await s.hold(s.target);

  const pending = s.merge(ticket);
  await s.queued(gate, [pending]);
  await gate.release((trx) =>
    sql`UPDATE app.users SET phone_hmac = ${moved}
      WHERE app_id = ${s.appId} AND id = ${s.target}`.execute(trx),
  );

  refused(kit, await pending);

  expect(await s.snapshot()).toEqual({
    ...before,
    users: before.users.map((row) => (row.id === s.target ? { ...row, phone_hmac: moved } : row)),
  });
  expect(await s.rows.oauth(s.target)).toEqual([]);
  expect((await s.user(s.source)).status).toBe('normal');
  await s.ticketKept(ticket);
});

it('[AC-B1-20c#53] 并号在锁外读到源未绑手机、随后等源行锁；持锁的另一事务给源写上手机号（别处完成首次绑定）并提交 → 只返回 30411，不迁移、不置墓碑、会话不变，ticket 不核销', async () => {
  const s = await scene(kit);
  const ticket = await s.offer();
  const own = phone('136');
  const ownHmac = s.hmac(own);
  const ownCipher = Buffer.from(kit.crypto.encrypt(own, PHONE_CONTEXT), 'utf8');
  const before = await s.snapshot();
  expect((await s.user(s.source)).phone_hmac).toBeNull();
  const gate = await s.hold(s.source);

  const pending = s.merge(ticket);
  await s.queued(gate, [pending]);
  await gate.release((trx) =>
    sql`UPDATE app.users SET phone_hmac = ${ownHmac}, phone_cipher = ${ownCipher}
      WHERE app_id = ${s.appId} AND id = ${s.source}`.execute(trx),
  );

  refused(kit, await pending);

  const phoneless = (snapshot: Snapshot) => ({
    ...snapshot,
    users: snapshot.users.map((row) =>
      row.id === s.source ? { ...row, phone_hmac: null, phone_cipher: null } : row,
    ),
  });
  expect(phoneless(await s.snapshot())).toEqual(phoneless(before));
  expect(await s.user(s.source)).toMatchObject({
    status: 'normal',
    deleted_reason: null,
    phone_hmac: ownHmac,
  });
  expect((await s.rows.oauth(s.source)).map((row) => row.id)).toEqual([s.sourceOauth]);
  expect(await s.rows.oauth(s.target)).toEqual([]);
  expect(await s.rows.sessions(s.target)).toEqual([]);
  await usable(s, s.session.access_token);
  await s.ticketKept(ticket);
});
