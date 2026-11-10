// B3-16a · get_my_earnings behind the real ToolRegistry, over a recording reads port (no database).
// 08 BR-AI-01 细则「收益查询」: 无参数、只下发给已绑手机主体、出 1 张 earnings_summary 卡、返回模型
// {card_id, status: "shown"} 或 {status: "unavailable"}、任一查询失败不出卡; BR-AI-02 工具名与空 schema
// 不命中 denylist; BR-AI-04 数字只来自钱包汇总与提现记录的同一查询、同一次取数; BR-AI-05 模型看不到
// 金额、月份、提现状态; 04 §8.3 earnings_summary (contracts/agent-stream.schema.json).
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it, vi } from 'vitest';
import { createGetMyEarningsHandler } from '../../../../apps/api/src/modules/agent/tools/earnings/index.ts';
import {
  createToolRegistry,
  type ToolSwitches,
} from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import {
  ACTIONS,
  AMOUNTS,
  CARD_REF,
  DENYLIST,
  KEYS,
  SWITCH,
  TOOL,
  WALLET,
  callEarnings,
  caller,
  cardsOf,
  contextOf,
  dataOf,
  earningsCard,
  earningsDeps,
  expectAsOf,
  expectContractCard,
  expectNoAmounts,
  registryWith,
  walletFigures,
  withdrawal,
  type WalletSummary,
} from './kit.ts';

const REJECTED = { kind: 'rejected', modelView: { error: 'invalid_args' } };

it('[AC-B3-16a#1][BR-AI-01][BR-AI-02][BR-AI-03] get_my_earnings 无参数：名称一致、参数为空对象 schema 且 additionalProperties=false、audience 只给已绑手机主体；名称、描述与 schema 不命中 BR-AI-02 ② denylist', () => {
  const { deps, read } = earningsDeps();
  const handler = createGetMyEarningsHandler(deps);
  expect(handler.name).toBe(TOOL);
  expect(handler.definition.name).toBe(TOOL);
  expect(handler.audience).toBe('phone_bound');
  expect(handler.definition.description, 'a description for the model').toBeTypeOf('string');
  const parameters = handler.definition.parameters as Record<string, unknown>;
  expect(parameters['type']).toBe('object');
  expect(parameters['additionalProperties']).toBe(false);
  expect(Object.keys((parameters['properties'] ?? {}) as object)).toEqual([]);
  expect((parameters['required'] ?? []) as unknown[]).toEqual([]);
  // Nothing else in the schema could admit a value (no patternProperties, $defs, oneOf …).
  for (const key of Object.keys(parameters)) {
    expect(['type', 'additionalProperties', 'properties', 'required', 'description']).toContain(
      key,
    );
  }
  expect(JSON.stringify(handler.definition)).not.toMatch(DENYLIST);
  expect(read).not.toHaveBeenCalled();
});

it('[AC-B3-16a#2][BR-AI-01][BR-AI-02] 下发：已绑手机且开关开 → 含 get_my_earnings；游客、已登录未绑手机一律不含；开关为 false、未取到或读取失败时不含；判定不读收益', async () => {
  const { deps, read } = earningsDeps();
  let state: 'on' | 'off' | 'missing' | 'throws' = 'on';
  const get = vi.fn<ToolSwitches['get']>(async () => {
    if (state === 'throws') throw new Error('合成开关读取失败');
    return state === 'on' ? true : state === 'off' ? false : undefined;
  });
  const registry = createToolRegistry({
    handlers: [createGetMyEarningsHandler(deps)],
    switches: { get },
  });
  const names = async (subject = caller()) =>
    (await registry.definitions(subject.appId, subject)).map((definition) => definition.name);

  expect(await names()).toEqual([TOOL]);
  expect(get).toHaveBeenCalledWith(caller().appId, SWITCH);
  expect(await names(caller(null, false)), 'guest').toEqual([]);
  expect(await names(caller('synthetic-unbound', false)), 'logged in, no phone').toEqual([]);
  for (const next of ['off', 'missing', 'throws'] as const) {
    state = next;
    expect(await names(), `switch ${next}`).toEqual([]);
  }
  expect(read).not.toHaveBeenCalled();
});

it.each([
  { args: { x: 1 } },
  { args: { user_id: 'synthetic-other-user' } },
  { args: { app_id: 'synthetic-other-app' } },
  { args: { period: '2026-12' } },
  { args: null },
  { args: [] },
  { args: '{}' },
])(
  '[AC-B3-16a#3][BR-AI-03] 带任何参数（或非对象）一律 invalid_args，不取数、不出卡 %#',
  async ({ args }) => {
    const { deps, read } = earningsDeps();
    const { registry } = registryWith(deps);
    // The empty object is accepted by the same registry (the refusals below are about the args).
    expect((await callEarnings(registry, {})).kind).toBe('ok');
    read.mockClear();
    expect(await callEarnings(registry, args)).toEqual(REJECTED);
    expect(read).not.toHaveBeenCalled();
  },
);

it('[AC-B3-16a#4][BR-AI-01] 游客与已登录未绑手机主体直接调用也被拒（invalid_args），不取数；身份只取服务端主体', async () => {
  const { deps, read } = earningsDeps();
  const { registry } = registryWith(deps);
  for (const subject of [caller(null, false), caller('synthetic-unbound', false)]) {
    expect(await callEarnings(registry, {}, contextOf(subject))).toEqual(REJECTED);
  }
  expect(read).not.toHaveBeenCalled();
  const outcome = await callEarnings(registry, {}, contextOf(caller('synthetic-user-b')));
  expect(outcome.kind).toBe('ok');
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith({ appId: caller().appId, userId: 'synthetic-user-b' });
});

it('[AC-B3-16a#5][BR-AI-04][BR-FUND-18][BR-TEXT-22] 出 1 张 earnings_summary（schema_version 1）：四个数字与钱包汇总同名字段逐一相等，as_of 为取数时刻（+08:00），无提现时 latest_withdrawal 为 null，按钮固定两个，fallback_text 为 agent.earnings.fallback，整帧符合契约', async () => {
  const { deps, read, texts } = earningsDeps();
  const { registry } = registryWith(deps);
  const card = earningsCard(await callEarnings(registry, {}));
  expect(card.schema_version).toBe(1);
  const data = dataOf(card);
  expect(Object.keys(data).sort()).toEqual(
    [
      'actions',
      'as_of',
      'credit_overdue',
      'estimated_total_fen',
      'latest_withdrawal',
      'next_credit_period',
      'withdrawable_fen',
    ].sort(),
  );
  expect({
    withdrawable_fen: data['withdrawable_fen'],
    estimated_total_fen: data['estimated_total_fen'],
    next_credit_period: data['next_credit_period'],
    credit_overdue: data['credit_overdue'],
  }).toEqual(walletFigures(WALLET));
  expectAsOf(data['as_of']);
  expect(data['latest_withdrawal']).toBeNull();
  expect(data['actions']).toEqual(ACTIONS);
  expect(card.fallback_text).toBe(`固定文案:${KEYS.fallback}`);
  expect(texts).toHaveBeenCalledWith(caller().appId, KEYS.fallback);
  expectNoAmounts(card.fallback_text, 'fallback_text');
  expectContractCard(card);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith({ appId: caller().appId, userId: 'synthetic-user' });
});

it('[AC-B3-16a#6][BR-AI-04][BR-AI-05] 任意钱包数字（含 0、负余额时可提现为 0、超 2^31、无预计月份、入账核对中）原样上卡；返回模型恰为 {card_id, status: "shown"}，不含任何金额与月份', async () => {
  const fen = fc.oneof(
    fc.constantFrom(0, 1, 2 ** 31 + 1, Number.MAX_SAFE_INTEGER),
    fc.integer({ min: 100_000_000, max: 2 ** 40 }),
  );
  const month = fc
    .tuple(fc.integer({ min: 2026, max: 2099 }), fc.integer({ min: 1, max: 12 }))
    .map(([y, m]) => `${String(y)}-${String(m).padStart(2, '0')}`);
  const wallet: fc.Arbitrary<WalletSummary> = fc
    .record({
      available: fc.oneof(
        fen,
        fen.filter((n) => n > 0).map((n) => -n),
      ),
      estimated: fen,
      pending: fen,
      period: fc.option(month, { nil: null }),
      overdue: fc.boolean(),
    })
    .filter(({ estimated, pending }) => Number.isSafeInteger(estimated + pending))
    .map(({ available, estimated, pending, period, overdue }) => ({
      ...WALLET,
      available_fen: available,
      withdrawable_fen: Math.max(available, 0),
      negative_fen: Math.max(-available, 0),
      estimated_total_fen: estimated + pending,
      estimated_fen: estimated,
      pending_credit_fen: pending,
      next_credit_period: period,
      credit_overdue: overdue,
    }));
  let current: WalletSummary = WALLET;
  const { deps, read } = earningsDeps(async () => ({ wallet: current, latestWithdrawal: null }));
  const { registry } = registryWith(deps);
  await fc.assert(
    fc.asyncProperty(wallet, async (generated) => {
      current = generated;
      read.mockClear();
      const outcome = await callEarnings(registry, {});
      const data = dataOf(earningsCard(outcome));
      expect({
        withdrawable_fen: data['withdrawable_fen'],
        estimated_total_fen: data['estimated_total_fen'],
        next_credit_period: data['next_credit_period'],
        credit_overdue: data['credit_overdue'],
      }).toEqual(walletFigures(generated));
      expect(outcome.modelView).toEqual({ card_id: CARD_REF, status: 'shown' });
      expect(read).toHaveBeenCalledTimes(1);
      return true;
    }),
    propParams(),
  );
}, 900_000);

it('[AC-B3-16a#7][BR-AI-05][BR-AI-19] 返回模型与工具 trace 都不含余额、收益、提现金额、预计月份与提现状态；卡片引用取 outcome.cards[0]', async () => {
  const latest = withdrawal({ status: 'FAILED', fail_code: 'PAYEE_NOT_EXIST' });
  const { deps, cardReference } = earningsDeps(async () => ({
    wallet: WALLET,
    latestWithdrawal: latest,
  }));
  const { registry } = registryWith(deps);
  const outcome = await callEarnings(registry, {});
  earningsCard(outcome);
  expect(outcome.modelView).toEqual({ card_id: CARD_REF, status: 'shown' });
  expect(cardReference).toHaveBeenCalledWith(expect.anything(), 0);
  const trace = outcome.kind === 'ok' ? (outcome.trace ?? {}) : {};
  for (const [what, value] of [
    ['modelView', outcome.modelView],
    ['trace', trace],
  ] as const) {
    expectNoAmounts(value, what, AMOUNTS, [WALLET.next_credit_period ?? '']);
    const text = JSON.stringify(value);
    for (const leak of ['FAILED', 'PAYEE_NOT_EXIST', latest.masked_account, 'withdrawal_status']) {
      expect(text, `${what}: no ${leak}`).not.toContain(leak);
    }
  }
});

it.each(['error', 'non-error'] as const)(
  '[AC-B3-16a#8][BR-AI-04] 取数失败（reject %s）：不出卡、不拼半张卡，返回模型恰为 {status: "unavailable"}，不用 0 或旧值补位',
  async (kind) => {
    // The port is one read of both queries; a failure of either rejects that one read.
    const message = `合成${kind}查询失败`;
    const { deps, read } = earningsDeps(() =>
      Promise.reject(kind === 'error' ? new Error(message) : { message }),
    );
    const { registry } = registryWith(deps);
    const outcome = await callEarnings(registry, {});
    expect(read).toHaveBeenCalledTimes(1);
    expect(cardsOf(outcome).map((card) => card.type)).not.toContain('earnings_summary');
    expect(outcome.modelView).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(outcome)).not.toContain(message);

    // A later call that reads fine shows the card again (nothing remembered from the failure).
    read.mockImplementationOnce(async () => ({ wallet: WALLET, latestWithdrawal: null }));
    const next = await callEarnings(registry, {});
    expect(dataOf(earningsCard(next))['withdrawable_fen']).toBe(WALLET.withdrawable_fen);
  },
);

it('[AC-B3-16a#24][BR-AI-04][BR-AI-01] 同一 handler 与取数口：先成功出卡，之后本次读取拒绝 → 不出卡、返回模型 {status: "unavailable"}，不拿上次的旧值出卡；再成功时卡上数字只来自本次读取', async () => {
  const first: WalletSummary = WALLET;
  const second: WalletSummary = {
    ...WALLET,
    available_fen: 314_159_265,
    withdrawable_fen: 314_159_265,
    estimated_total_fen: 271_828_182,
    estimated_fen: 200_000_000,
    pending_credit_fen: 71_828_182,
    next_credit_period: '2032-03',
    credit_overdue: true,
  };
  const latest = withdrawal({ status: 'PENDING_REVIEW' });
  const { deps, read } = earningsDeps();
  const { registry } = registryWith(deps);

  read.mockImplementationOnce(async () => ({ wallet: first, latestWithdrawal: latest }));
  const shown = dataOf(earningsCard(await callEarnings(registry, {})));
  expect(shown['withdrawable_fen']).toBe(first.withdrawable_fen);
  expect((shown['latest_withdrawal'] as Record<string, unknown>)['amount_fen']).toBe(
    latest.amount_fen,
  );

  const message = '合成本次查询失败';
  read.mockImplementationOnce(() => Promise.reject(new Error(message)));
  const failed = await callEarnings(registry, {});
  expect(read).toHaveBeenCalledTimes(2);
  expect(
    cardsOf(failed).map((card) => card.type),
    'no card from the earlier read',
  ).not.toContain('earnings_summary');
  expect(failed.modelView).toEqual({ status: 'unavailable' });
  expectNoAmounts(failed, 'the failed outcome', AMOUNTS, [WALLET.next_credit_period ?? '']);
  expect(JSON.stringify(failed)).not.toContain(message);

  read.mockImplementationOnce(async () => ({ wallet: second, latestWithdrawal: null }));
  const again = dataOf(earningsCard(await callEarnings(registry, {})));
  expect(read).toHaveBeenCalledTimes(3);
  expect({
    withdrawable_fen: again['withdrawable_fen'],
    estimated_total_fen: again['estimated_total_fen'],
    next_credit_period: again['next_credit_period'],
    credit_overdue: again['credit_overdue'],
  }).toEqual(walletFigures(second));
  expect(again['latest_withdrawal'], 'no withdrawal in this read').toBeNull();
});
