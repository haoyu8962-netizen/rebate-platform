import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createWithdrawalReviewHits } from '../../../../apps/api/src/modules/risk/index.ts';
import { setup } from '../auto-payout/kit.ts';
import { close, hits, open, rule, type Harness } from './db-kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, 60_000);

it.each(['phone', 'id_no', 'device', 'alipay', 'bank_card', 'wechat_openid'] as const)(
  '[AC-B2-05q#30][BR-ID-36] %s 新规则先登记，命中引用提现、动作 manual_review，请求专属字段全部空',
  async (dimension) => {
    const f = await setup(h);
    const id = await f.start(100n);
    const input = {
      app_id: f.appId,
      user_id: f.actor.userId,
      withdrawal_id: id,
      dimension,
      value_hmac: '4'.repeat(64),
      rule_id: `BLACKLIST_${dimension.toUpperCase()}`,
    };
    const writer = createWithdrawalReviewHits({ clock: f.clock });
    await h.db.transaction().execute((trx) => writer.record(trx, input));
    expect(await hits(h, f.appId)).toEqual([
      expect.objectContaining({
        app_id: f.appId,
        user_id: f.actor.userId,
        dimension,
        value_hmac: input.value_hmac,
        rule_id: input.rule_id,
        risk_action: 'manual_review',
        ref_type: 'withdrawal',
        ref_id: id,
        request_type: null,
        amount_fen: null,
        related_phone_hmac: null,
        related_phone_masked: null,
        created_at: f.clock.now(),
      }),
    ]);
    expect(
      await h.db
        .withSchema('app')
        .selectFrom('risk_rules')
        .select(['rule_id', 'created_at'])
        .where('app_id', '=', f.appId)
        .execute(),
    ).toEqual([{ rule_id: input.rule_id, created_at: f.clock.now() }]);
  },
);

it('[AC-B2-05q#31][BR-ID-36] 判定已生效的规则现已停用：仍写命中，ON CONFLICT 不改规则原状', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  await rule({ db: h.db, clock: f.clock }, f.appId, 'phone', 'disabled');
  const rules = () =>
    h.db
      .withSchema('app')
      .selectFrom('risk_rules')
      .selectAll()
      .where('app_id', '=', f.appId)
      .execute();
  const before = await rules();
  const writer = createWithdrawalReviewHits({ clock: f.clock });
  await h.db.transaction().execute((trx) =>
    writer.record(trx, {
      app_id: f.appId,
      user_id: f.actor.userId,
      withdrawal_id: id,
      dimension: 'phone',
      value_hmac: '5'.repeat(64),
      rule_id: 'BLACKLIST_PHONE',
    }),
  );
  expect(await hits(h, f.appId)).toEqual([
    expect.objectContaining({ ref_id: id, risk_action: 'manual_review' }),
  ]);
  expect(await rules()).toEqual(before);
});

it('[AC-B2-05q#32][BR-ID-36] 写口只能使用调用方事务：未提交时外部不可见，回滚撤回命中和懒登记', async () => {
  const f = await setup(h);
  const id = await f.start(100n);
  const writer = createWithdrawalReviewHits({ clock: f.clock });
  const abort = new Error('synthetic rollback');
  await expect(
    h.db.transaction().execute(async (trx) => {
      await writer.record(trx, {
        app_id: f.appId,
        user_id: f.actor.userId,
        withdrawal_id: id,
        dimension: 'device',
        value_hmac: '6'.repeat(64),
        rule_id: 'BLACKLIST_DEVICE',
      });
      expect(await hits({ db: trx }, f.appId)).toHaveLength(1);
      expect(await hits({ db: h.observer }, f.appId)).toEqual([]);
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await hits(h, f.appId)).toEqual([]);
  expect(
    await h.db
      .withSchema('app')
      .selectFrom('risk_rules')
      .selectAll()
      .where('app_id', '=', f.appId)
      .execute(),
  ).toEqual([]);
});

it('[AC-B2-05q#33][BR-ID-36] 同规则首次并发命中不同提现：登记一次，两笔命中都保留且 app 隔离', async () => {
  const f = await setup(h);
  const other = await setup(h);
  const first = await f.start(100n);
  const second = await f.start(100n);
  const third = await other.start(100n);
  const writer = createWithdrawalReviewHits({ clock: f.clock });
  await Promise.all(
    [
      { f, id: first },
      { f, id: second },
      { f: other, id: third },
    ].map(({ f: owner, id }) =>
      h.db.transaction().execute((trx) =>
        writer.record(trx, {
          app_id: owner.appId,
          user_id: owner.actor.userId,
          withdrawal_id: id,
          dimension: 'phone',
          value_hmac: '7'.repeat(64),
          rule_id: 'BLACKLIST_PHONE',
        }),
      ),
    ),
  );
  expect((await hits(h, f.appId)).map((row) => row.ref_id).sort()).toEqual([first, second].sort());
  expect((await hits(h, other.appId)).map((row) => row.ref_id)).toEqual([third]);
  expect(
    await h.db
      .withSchema('app')
      .selectFrom('risk_rules')
      .select('rule_id')
      .where('app_id', '=', f.appId)
      .execute(),
  ).toEqual([{ rule_id: 'BLACKLIST_PHONE' }]);
});
