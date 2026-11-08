// B1-09za (D10-969, 人工对人工以最新为准): unit tests of the rights command's sub-reason choice by
// hand — the pure deciders (manualOnResolve, manualOnEnded) and record() on a terminal PUNISH order
// with the store modules replaced by fakes (no database). Synthetic ids only.
import type { DB } from '@couli/db';
import type { Selectable, Transaction } from 'kysely';
import { beforeEach, expect, it, vi } from 'vitest';
import type { RightsRecordInput } from '../../orders/index.ts';
import type { ClawbackOrder } from '../clawback/index.ts';
import type { RebatePort } from '../rebate/application/rebate.ts';
import {
  REASON_SUB_SET_AUDIT_ACTION,
  REASON_SUB_SOURCE_STORED,
  createRightsCommandPort,
  manualOnEnded,
  manualOnResolve,
  type RightsSystemAudit,
} from './rights-command.ts';
import type { OrderRightsRow } from './rights-store.ts';

const store = vi.hoisted(() => ({
  findRights: vi.fn(),
  insertRights: vi.fn(),
  updateRightsResult: vi.fn(),
  writeRightsManual: vi.fn(),
  casManualReasonSub: vi.fn(),
  readOpenDeductionTotal: vi.fn(),
  readRebateOrder: vi.fn(),
  casReasonSub: vi.fn(),
  computeRightsPending: vi.fn(),
  casRightsPending: vi.fn(),
}));

vi.mock('./rights-store.ts', () => ({
  findRights: store.findRights,
  insertRights: store.insertRights,
  updateRightsResult: store.updateRightsResult,
  writeRightsManual: store.writeRightsManual,
  casManualReasonSub: store.casManualReasonSub,
  readOpenDeductionTotal: store.readOpenDeductionTotal,
}));
vi.mock('../rebate/infra/rebate-store.ts', () => ({
  readRebateOrder: store.readRebateOrder,
  casReasonSub: store.casReasonSub,
}));
vi.mock('../clawback/clawback-store.ts', () => ({
  computeRightsPending: store.computeRightsPending,
  casRightsPending: store.casRightsPending,
}));

const APP = 'app-unit';
const ORDER_ID = '00000000-0000-4000-8000-000000000001';
const ROW_ID = '00000000-0000-4000-8000-0000000000a1';
const NOW = new Date('2026-11-08T00:00:00.000Z');
const trx = {} as Transaction<DB>;

type Order = Selectable<DB['orders']>;

function orderOf(patch: Partial<Order> = {}): Order {
  return {
    app_id: APP,
    order_id: ORDER_ID,
    attr_at: new Date('2026-10-01T00:00:00.000Z'),
    platform: 'taobao',
    platform_status: 'RECEIVED',
    rebate_status: 'VOID',
    reason: 'PUNISH',
    reason_sub: 'FAKE_TRADE',
    reason_sub_manual: false,
    rights_pending: true,
    row_version: 3,
    ...patch,
  } as Order;
}

function storedRow(patch: Partial<OrderRightsRow> = {}): OrderRightsRow {
  return {
    id: ROW_ID,
    app_id: APP,
    order_id: ORDER_ID,
    source: 'IMPORT',
    type: 'PUNISH',
    status: 'PROCESSING',
    reason_sub: 'SHOP_TK',
    reason_sub_manual: true,
    row_version: 1,
    ...patch,
  } as OrderRightsRow;
}

function inputOf(before: Order, patch: Partial<RightsRecordInput> = {}): RightsRecordInput {
  return {
    before,
    order_id: before.order_id,
    source: 'API',
    type: 'PUNISH',
    status: 'SUCCEEDED',
    amount_fen: null,
    deduction_commission_fen: null,
    occurred_at: new Date('2026-10-02T00:00:00.000Z'),
    platform_rights_no: 'TB-UNIT-X',
    now: NOW,
    violation_type: '合成违规',
    ...patch,
  };
}

function portWith(audit: RightsSystemAudit | undefined, manualAppend = vi.fn()) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return createRightsCommandPort({
    clock: { now: () => NOW },
    logger,
    events: { publish: vi.fn() },
    clawback: { apply: vi.fn() } as unknown as ClawbackOrder,
    rebate: { apply: vi.fn() } as unknown as Pick<RebatePort, 'apply'>,
    ...(audit === undefined ? {} : { audit }),
    reasonSubMaps: () => null,
    manualAudit: () => ({ append: manualAppend }),
  });
}

beforeEach(() => {
  for (const fn of Object.values(store)) fn.mockReset();
  store.updateRightsResult.mockResolvedValue(true);
  store.casManualReasonSub.mockResolvedValue(true);
  store.casReasonSub.mockResolvedValue(true);
  store.computeRightsPending.mockResolvedValue(false);
  store.casRightsPending.mockResolvedValue(true);
});

it('[AC-B1-09za-UNIT#1] manualOnResolve：输入不带人工值、行上有人工值时，只有订单 reason_sub_manual=false 才用行上的值（fromRow）；订单已人工（含「无」）则不用', () => {
  const stored = storedRow();
  const input = { type: 'PUNISH' as const, manual_reason_sub: undefined };
  expect(manualOnResolve(stored, input, { reason_sub_manual: false })).toEqual({
    manual: { value: 'SHOP_TK' },
    writeRow: false,
    fromRow: true,
  });
  expect(manualOnResolve(stored, input, { reason_sub_manual: true })).toEqual({
    manual: undefined,
    writeRow: false,
    fromRow: false,
  });
  expect(
    manualOnResolve(storedRow({ reason_sub: null }), input, { reason_sub_manual: false }),
  ).toEqual({ manual: { value: null }, writeRow: false, fromRow: true });
});

it('[AC-B1-09za-UNIT#2] manualOnResolve：输入自带人工值时照旧以输入为准（不论订单是否已人工），行上已是同值则不回写；非 PUNISH 或行无人工值时无选择', () => {
  const incoming = { value: 'RISK_ORDER' as const, origin: { import_id: 'i', admin_id: 'a' } };
  expect(
    manualOnResolve(
      storedRow(),
      { type: 'PUNISH', manual_reason_sub: incoming },
      {
        reason_sub_manual: true,
      },
    ),
  ).toEqual({ manual: incoming, writeRow: true, fromRow: false });
  expect(
    manualOnResolve(
      storedRow({ reason_sub: 'RISK_ORDER' }),
      { type: 'PUNISH', manual_reason_sub: incoming },
      { reason_sub_manual: false },
    ),
  ).toEqual({ manual: incoming, writeRow: false, fromRow: false });
  expect(
    manualOnResolve(storedRow({ type: 'RIGHTS' }), { type: 'RIGHTS' }, { reason_sub_manual: false })
      .manual,
  ).toBeUndefined();
  expect(
    manualOnResolve(
      storedRow({ reason_sub: null, reason_sub_manual: false }),
      { type: 'PUNISH' },
      { reason_sub_manual: false },
    ).fromRow,
  ).toBe(false);
});

it('[AC-B1-09za-UNIT#3] manualOnResolve：行上的人工值不属于 PUNISH 子原因时抛错；订单已人工时不读它、不抛', () => {
  const broken = storedRow({ reason_sub: 'AFTER_SALE' });
  expect(() => manualOnResolve(broken, { type: 'PUNISH' }, { reason_sub_manual: false })).toThrow(
    TypeError,
  );
  expect(manualOnResolve(broken, { type: 'PUNISH' }, { reason_sub_manual: true }).manual).toBe(
    undefined,
  );
});

it('[AC-B1-09za-UNIT#4] manualOnEnded：older（已存行的旧人工值）只替换 reason_sub_manual=false 的 PUNISH 订单；非 older 照旧（人工对人工以最新为准，同值不写）', () => {
  const auto = { reason: 'PUNISH', reason_sub: 'FAKE_TRADE', reason_sub_manual: false };
  const byHand = { reason: 'PUNISH', reason_sub: 'MARKET_DISRUPT', reason_sub_manual: true };
  const none = { reason: 'PUNISH', reason_sub: null, reason_sub_manual: true };
  const refund = { reason: 'REFUND', reason_sub: 'IN_SALE', reason_sub_manual: false };
  const shop = { value: 'SHOP_TK' as const };
  expect(manualOnEnded(auto, undefined, shop, true).order).toBe(true);
  expect(manualOnEnded(byHand, undefined, shop, true).order).toBe(false);
  expect(manualOnEnded(none, undefined, shop, true).order).toBe(false);
  expect(manualOnEnded(refund, undefined, shop, true).order).toBe(false);
  expect(manualOnEnded(byHand, undefined, shop).order).toBe(true);
  expect(manualOnEnded({ ...byHand, reason_sub: 'SHOP_TK' }, undefined, shop).order).toBe(false);
  expect(manualOnEnded(auto, storedRow(), shop).row).toBe(false);
  expect(manualOnEnded(auto, storedRow({ reason_sub: 'RISK_ORDER' }), shop).row).toBe(true);
});

it('[AC-B1-09za-UNIT#5] record：VOID PUNISH 订单已人工改为 MARKET_DISRUPT，同步结案带 SHOP_TK 的已存「处理中」行：行原地结案、不写订单子原因、不写任何审计', async () => {
  const before = orderOf({ reason_sub: 'MARKET_DISRUPT', reason_sub_manual: true });
  store.findRights.mockResolvedValue(storedRow());
  store.readRebateOrder.mockResolvedValue(before);
  const audit = { appendAction: vi.fn() };
  const manualAppend = vi.fn();

  const result = await portWith(audit, manualAppend).record(trx, inputOf(before));

  expect(result).toEqual({ kind: 'applied' });
  expect(store.updateRightsResult).toHaveBeenCalledTimes(1);
  expect(store.updateRightsResult.mock.calls[0]?.[2]).not.toHaveProperty('manualReasonSub');
  expect(store.casManualReasonSub).not.toHaveBeenCalled();
  expect(store.casReasonSub).not.toHaveBeenCalled();
  expect(audit.appendAction).not.toHaveBeenCalled();
  expect(manualAppend).not.toHaveBeenCalled();
});

it('[AC-B1-09za-UNIT#6] record：VOID PUNISH 订单为自动 FAKE_TRADE，同步结案带 SHOP_TK 的已存行：订单写 SHOP_TK（人工），写一条 system:settlement 的 order_reason_sub_set（FAKE_TRADE → SHOP_TK，带 order_rights id）', async () => {
  const before = orderOf();
  store.findRights.mockResolvedValue(storedRow());
  store.readRebateOrder.mockResolvedValue(before);
  const audit = { appendAction: vi.fn() };
  const manualAppend = vi.fn();

  await portWith(audit, manualAppend).record(trx, inputOf(before));

  expect(store.casManualReasonSub).toHaveBeenCalledTimes(1);
  expect(store.casManualReasonSub.mock.calls[0]?.[2]).toBe('SHOP_TK');
  expect(manualAppend).not.toHaveBeenCalled();
  expect(audit.appendAction).toHaveBeenCalledTimes(1);
  expect(audit.appendAction.mock.calls[0]?.[1]).toEqual({
    appId: APP,
    actor: 'system:settlement',
    action: REASON_SUB_SET_AUDIT_ACTION,
    target: `orders:${ORDER_ID}`,
    before: {
      reason: 'PUNISH',
      source: REASON_SUB_SOURCE_STORED,
      order_rights_id: ROW_ID,
      reason_sub: 'FAKE_TRADE',
      reason_sub_manual: false,
    },
    after: {
      reason: 'PUNISH',
      source: REASON_SUB_SOURCE_STORED,
      order_rights_id: ROW_ID,
      reason_sub: 'SHOP_TK',
      reason_sub_manual: true,
    },
  });
});

it('[AC-B1-09za-UNIT#7] record：已存行的旧人工值要替换终态订单的自动值而没有审计端口时，在任何写入前抛错', async () => {
  const before = orderOf();
  store.findRights.mockResolvedValue(storedRow());
  store.readRebateOrder.mockResolvedValue(before);

  await expect(portWith(undefined).record(trx, inputOf(before))).rejects.toThrow(/audit port/);
  expect(store.updateRightsResult).not.toHaveBeenCalled();
  expect(store.casManualReasonSub).not.toHaveBeenCalled();
});

it('[AC-B1-09za-UNIT#8] record：D10-699 重开（API FAILED → SUCCEEDED）的行带人工值、订单已人工：只写重开审计，不写子原因、不写 order_reason_sub_set', async () => {
  const before = orderOf({ reason_sub: 'MARKET_DISRUPT', reason_sub_manual: true });
  store.findRights.mockResolvedValue(storedRow({ source: 'API', status: 'FAILED' }));
  store.readRebateOrder.mockResolvedValue(before);
  const audit = { appendAction: vi.fn() };

  await portWith(audit).record(trx, inputOf(before));

  expect(store.casManualReasonSub).not.toHaveBeenCalled();
  expect(audit.appendAction).toHaveBeenCalledTimes(1);
  expect(audit.appendAction.mock.calls[0]?.[1]).toMatchObject({
    action: 'order_rights_success_after_closed',
  });
});

it('[AC-B1-09za-UNIT#9] record：结案输入自带人工值（导入 origin）时照 D10-957 以输入为准，写导入审计（rights_import），不写 system 审计', async () => {
  const before = orderOf({ reason_sub: 'MARKET_DISRUPT', reason_sub_manual: true });
  store.findRights.mockResolvedValue(storedRow());
  store.readRebateOrder.mockResolvedValue(before);
  const audit = { appendAction: vi.fn() };
  const manualAppend = vi.fn();
  const input = inputOf(before, {
    source: 'IMPORT',
    manual_reason_sub: { value: 'RISK_ORDER', origin: { import_id: 'imp-1', admin_id: 'adm-1' } },
  });

  await portWith(audit, manualAppend).record(trx, input);

  expect(store.casManualReasonSub.mock.calls[0]?.[2]).toBe('RISK_ORDER');
  expect(audit.appendAction).not.toHaveBeenCalled();
  expect(manualAppend).toHaveBeenCalledTimes(1);
  expect(manualAppend.mock.calls[0]?.[0]).toMatchObject({
    actor: 'adm-1',
    action: REASON_SUB_SET_AUDIT_ACTION,
    after: { source: 'rights_import', import_id: 'imp-1', reason_sub: 'RISK_ORDER' },
  });
});
