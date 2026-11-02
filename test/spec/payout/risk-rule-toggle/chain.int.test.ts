// B2-11f: 规则启停落到提现判定点的真实链路 (BR-ID-36 细则「规则清单的启停」, BR-WDR-03 ③a, BR-WDR-29 ③ ⑨,
// BR-WDR-30 ⑫; D10-536 (b), D10-537 ②, D10-566), through the real AppModule: POST /v1/withdrawals on the
// api entry and the evt.payout-auto-payout handler on the worker entry. Each entry has its own read
// port and its own cache, so these tests also pin that both call sites of
// createBlocklistMatchReader pass it (`rules` is optional, leaving it out fails silently). Every test
// starts with a disabled rule that must not refuse, which is where it is red before the
// implementation; what already holds (③ alone, an enabled rule) follows in the same test.
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { LOGIN, NAME } from '../../identity/payout-account/kit.ts';
import {
  CHAIN_DIMENSIONS,
  CHAIN_TIMEOUT,
  PHONE,
  T,
  close,
  flagCodes,
  member,
  open,
  withWorker,
  type Kit,
} from './chain-kit.ts';
import { RULE_OF, SAME_DEVICE_RULE, TTL_MS, hitRows, judgementRows } from './kit.ts';

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

/** The refusal of a blocklist hit on POST /v1/withdrawals. */
function refused(violation: string) {
  return { code: 44001, data: { risk_msg_code: `blocklist.${violation}` } };
}

it.each(CHAIN_DIMENSIONS)(
  '[AC-B2-11f#20] 真实 AppModule api 入口：%s 规则停用 → POST 不再 44001，照常建单；其他维度命中仍 44001',
  async (dimension) => {
    const off = await member(kit);
    await off.block(dimension);
    await off.setRule(RULE_OF[dimension], 'disabled');
    const id = await off.apply();
    expect(await off.withdrawal(id)).toMatchObject({ status: 'PENDING_REVIEW' });

    const other = dimension === 'phone' ? 'device' : 'phone';
    const next = await member(kit);
    await next.block(dimension, 'malicious_rights');
    await next.block(other, 'fraud_invite');
    await next.setRule(RULE_OF[dimension], 'disabled');
    const answer = await next.post();
    expect(answer.statusCode).toBe(403);
    expect(answer.json()).toMatchObject(refused('fraud_invite'));
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B2-11f#21] api 入口：启用→停用，配置项周期内仍 44001（不追溯），满周期才放行',
  async () => {
    const m = await member(kit);
    await m.block('phone');
    expect((await m.post()).json()).toMatchObject(refused('other'));

    await m.setRule(RULE_OF.phone, 'disabled');
    kit.clock.advanceMs(TTL_MS - 1);
    expect((await m.post()).json()).toMatchObject(refused('other'));
    kit.clock.advanceMs(1);
    expect((await m.post()).json()).toMatchObject({ code: 0 });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B2-11f#22] api 入口：停用→启用，配置项周期内仍放行，满周期才恢复 44001',
  async () => {
    const m = await member(kit);
    await m.block('phone');
    await m.setRule(RULE_OF.phone, 'disabled');
    expect((await m.post()).json()).toMatchObject({ code: 0 });

    await m.setRule(RULE_OF.phone, 'enabled');
    kit.clock.advanceMs(TTL_MS - 1);
    expect((await m.post()).json()).toMatchObject({ code: 0 });
    kit.clock.advanceMs(1);
    expect((await m.post()).json()).toMatchObject(refused('other'));
  },
  CHAIN_TIMEOUT,
);

it.each(CHAIN_DIMENSIONS)(
  '[AC-B2-11f#23] 真实 AppModule worker 入口：%s 规则停用 → ⑨ blacklist_hit 未命中，不因 ⑨ 转人工；启用时仍转人工',
  async (dimension) => {
    await withWorker(kit, async (worker) => {
      const off = await member(kit);
      const id = await off.apply();
      await off.block(dimension);
      await off.setRule(RULE_OF[dimension], 'disabled');
      expect(await worker.decide(off, id)).toMatchObject({ result: 'auto', failed_conditions: [] });
      expect(await off.withdrawal(id)).toMatchObject({ review_mode: 'auto' });

      const on = await member(kit);
      const second = await on.apply();
      await on.block(dimension);
      await on.setRule(RULE_OF[dimension], 'enabled');
      expect(await worker.decide(on, second)).toMatchObject({
        result: 'manual',
        failed_conditions: ['risk_flag:blacklist_hit'],
      });
      expect(await on.withdrawal(second)).toMatchObject({
        status: 'PENDING_REVIEW',
        review_mode: 'manual',
      });
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B2-11f#24] worker 入口：failed_conditions 顺序不变，停用只去掉 ⑨ 这一项；其他维度命中仍记 ⑨',
  async () => {
    const before = [
      'max_amount',
      'channel_disabled',
      'risk_flag:same_device_multi_account',
      'risk_flag:recon_diff',
    ];
    await withWorker(kit, async (worker) => {
      async function prepared() {
        const m = await member(kit, { thirdOnDevice: true, reconDiff: true });
        const id = await m.apply();
        await m.setConfig('withdraw.auto_payout.max_amount_fen', 500);
        await m.setConfig('payout.channel_enabled.alipay', false);
        await m.block('phone');
        return { m, id };
      }

      const off = await prepared();
      await off.m.setRule(RULE_OF.phone, 'disabled');
      expect(await worker.decide(off.m, off.id)).toMatchObject({
        result: 'manual',
        failed_conditions: before,
      });

      const on = await prepared();
      await on.m.setRule(RULE_OF.phone, 'enabled');
      expect(await worker.decide(on.m, on.id)).toMatchObject({
        result: 'manual',
        failed_conditions: [...before, 'risk_flag:blacklist_hit'],
      });

      const next = await member(kit);
      const id = await next.apply();
      await next.block('phone');
      await next.block('id_no');
      await next.setRule(RULE_OF.phone, 'disabled');
      expect(await worker.decide(next, id)).toMatchObject({
        result: 'manual',
        failed_conditions: ['risk_flag:blacklist_hit'],
      });
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B2-11f#25] worker 入口：启用→停用，配置项周期内的判定仍记 ⑨，满周期才放行；已写的判定不追溯',
  async () => {
    await withWorker(kit, async (worker) => {
      const first = await member(kit);
      const second = await member(kit, { appId: first.appId, login: 'second@example.test' });
      const third = await member(kit, { appId: first.appId, login: 'third@example.test' });
      const ids = [await first.apply(), await second.apply(), await third.apply()] as const;
      await first.block('phone');
      await second.block('phone');
      await third.block('phone');

      const manual = { result: 'manual', failed_conditions: ['risk_flag:blacklist_hit'] };
      const decided = await worker.decide(first, ids[0]);
      expect(decided).toMatchObject(manual);

      await first.setRule(RULE_OF.phone, 'disabled');
      kit.clock.advanceMs(TTL_MS - 1);
      expect(await worker.decide(second, ids[1])).toMatchObject(manual);
      kit.clock.advanceMs(1);
      expect(await worker.decide(third, ids[2])).toMatchObject({
        result: 'auto',
        failed_conditions: [],
      });
      expect((await first.withdrawal(ids[0])).auto_decision).toEqual(decided);
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B2-11f#26] worker 入口：停用→启用，配置项周期内仍不记 ⑨，满周期才恢复',
  async () => {
    await withWorker(kit, async (worker) => {
      const first = await member(kit);
      const second = await member(kit, { appId: first.appId, login: 'second@example.test' });
      const third = await member(kit, { appId: first.appId, login: 'third@example.test' });
      const ids = [await first.apply(), await second.apply(), await third.apply()] as const;
      await first.block('phone');
      await second.block('phone');
      await third.block('phone');
      await first.setRule(RULE_OF.phone, 'disabled');

      const auto = { result: 'auto', failed_conditions: [] };
      expect(await worker.decide(first, ids[0])).toMatchObject(auto);

      await first.setRule(RULE_OF.phone, 'enabled');
      kit.clock.advanceMs(TTL_MS - 1);
      expect(await worker.decide(second, ids[1])).toMatchObject(auto);
      kit.clock.advanceMs(1);
      expect(await worker.decide(third, ids[2])).toMatchObject({
        result: 'manual',
        failed_conditions: ['risk_flag:blacklist_hit'],
      });
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B2-11f#27] ③ 停用：真实判定函数下 W1 标签不含 ③、不写 risk_hits 与判定行，auto-decision 按未命中；启用照旧出标签；已写入的标签不因之后停用而追溯',
  async () => {
    await withWorker(kit, async (worker) => {
      const off = await member(kit, { thirdOnDevice: true });
      await off.block('phone');
      await off.setRule(RULE_OF.phone, 'disabled');
      await off.setRule(SAME_DEVICE_RULE, 'disabled');
      const id = await off.apply();
      expect(flagCodes((await off.withdrawal(id)).risk_flags)).not.toContain(
        'same_device_multi_account',
      );
      expect(await hitRows(kit.db, off.appId)).toEqual([]);
      expect(await judgementRows(kit.db, off.appId)).toEqual([]);
      expect(await worker.decide(off, id)).toMatchObject({ result: 'auto', failed_conditions: [] });

      const on = await member(kit, { thirdOnDevice: true });
      await on.setRule(SAME_DEVICE_RULE, 'enabled');
      const second = await on.apply();
      expect(flagCodes((await on.withdrawal(second)).risk_flags)).toContain(
        'same_device_multi_account',
      );
      expect(await hitRows(kit.db, on.appId)).toEqual([
        { rule_id: SAME_DEVICE_RULE, ref_type: 'withdrawal', ref_id: second },
      ]);

      // Disabled after W1: the snapshot of the completed judgement still blocks (不追溯).
      await on.setRule(SAME_DEVICE_RULE, 'disabled');
      expect(await worker.decide(on, second)).toMatchObject({
        result: 'manual',
        failed_conditions: ['risk_flag:same_device_multi_account'],
      });
    });
  },
  CHAIN_TIMEOUT,
);

it(
  '[AC-B2-11f#28] 日志与错误响应不含手机号、收款账号、姓名明文（BR-ID-33）',
  async () => {
    await withWorker(kit, async (worker) => {
      const off = await member(kit);
      await off.block('phone');
      await off.setRule(RULE_OF.phone, 'disabled');
      const from = kit.lines.length;
      const id = await off.apply();
      await worker.decide(off, id);

      const next = await member(kit);
      await next.block('alipay');
      const answer = await next.post();
      expect(answer.json()).toMatchObject(refused('other'));

      const text = [...kit.lines.slice(from), ...worker.lines, answer.body].join('\n');
      for (const plain of [PHONE, LOGIN, NAME]) {
        expect(text.includes(plain)).toBe(false);
      }
    });
  },
  CHAIN_TIMEOUT,
);
