import { expect, it } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import type { ToolCallContext } from '../registry/index.ts';
import { createExplainOrderHandler, type OrderToolsDeps } from './index.ts';

const ORDER = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f6a01';
const CTX: ToolCallContext = {
  appId: 'app_unit',
  userId: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5c01',
  deviceId: 'device_unit',
  phoneBound: true,
  runId: 'run_unit',
  sessionId: 'session_unit',
  signal: new AbortController().signal,
  placeholders: {},
};

function shown(displayStatus: string) {
  return {
    order_id: ORDER,
    platform: 'tb',
    title: 'Synthetic item',
    is_other_product: false,
    display_status: displayStatus,
    reason: null,
    est_rebate_fen: 425,
    expected_credit_period: '2027-12',
  };
}

function detail(displayStatus: string, creditOverdue: boolean) {
  return { ...shown(displayStatus), credit_overdue: creditOverdue };
}

/** explain_order by card: only orders.get and refs are reached on this path. */
async function cardFor(found: ReturnType<typeof detail>) {
  const clock = new FixedClock('2027-12-01T00:00:00.000Z');
  const deps = {
    orders: { get: async () => found },
    refs: { resolve: async () => ({ kind: 'order', orderId: ORDER }) },
    clock,
    claim: { platforms: ['tb'] },
  } as unknown as OrderToolsDeps;
  const outcome = await createExplainOrderHandler(deps).run({ card_id: 'card_1' }, CTX);
  if (outcome.kind !== 'ok') throw new Error(`unexpected outcome ${outcome.kind}`);
  return outcome.cards?.[0]?.data;
}

it('[AC-B1-09q#U1] 按卡片：逾期的详情月份不上卡片，且只换这一个字段（BR-FUND-17 第 12 行）', async () => {
  expect(await cardFor(detail('CREDITING', true))).toEqual({
    ...shown('CREDITING'),
    expected_credit_period: null,
  });
});

it('[AC-B1-09q#U2] 按卡片：未逾期照带详情月份，卡片不多出 credit_overdue', async () => {
  expect(await cardFor(detail('WAITING', false))).toEqual(shown('WAITING'));
});

it('[AC-B1-09q#U3] 按卡片：判的是 credit_overdue 不是 display_status', async () => {
  expect(await cardFor(detail('CREDITING', false))).toMatchObject({
    expected_credit_period: '2027-12',
  });
  expect(await cardFor(detail('NO_REBATE', true))).toMatchObject({
    expected_credit_period: null,
  });
});
