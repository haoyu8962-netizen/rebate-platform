// B2-04zn · 钉生产组合根（不连库）：扣回与结算 worker 拿到的账本，确实是 createLedger 带入口的 EVENT_BUS 和
// payout 的回正钩子造出来的，防止之后漏装配静默失效。createLedger 的两个选项都可省，少传一个不报错也不写日志，
// 这个缺口就是这样来的。这里只监听不替换（spy 透传），账本、钩子、总线都取自真实的 AppModule 装配。
import { afterEach, expect, it, vi } from 'vitest';
import * as recovered from '../../../../apps/api/src/modules/ledger/application/recovered-ledger.ts';
import * as payout from '../../../../apps/api/src/modules/payout/application/balance-recovered.ts';
import * as clawback from '../../../../apps/api/src/modules/settlement/clawback/clawback-order.ts';
import * as beneficiary from '../../../../apps/api/src/modules/settlement/credit/beneficiary/beneficiary-credit.ts';
import * as credit from '../../../../apps/api/src/modules/settlement/credit/credit-order.ts';
import { keyedWorker } from '../../orders/rebate-wiring/kit.ts';
import { runtime } from '../../orders/wiring/context-kit.ts';
import { built } from '../../orders/wiring/db-kit.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

function factories() {
  return {
    ledgers: vi.spyOn(recovered, 'createLedger'),
    hooks: vi.spyOn(payout, 'createBalanceRecoveredHook'),
  };
}

/** `given` came out of a createLedger call that was handed `bus` and a hook of payout's. */
function expectHooked(
  made: ReturnType<typeof factories>,
  given: unknown,
  bus: unknown,
  who: string,
): void {
  const index = made.ledgers.mock.results.findIndex((result) => result.value === given);
  expect(index, `${who}: the ledger came from createLedger`).toBeGreaterThanOrEqual(0);
  const options = made.ledgers.mock.calls[index]![0];
  expect(options.eventBus, `${who}: the entry's EVENT_BUS`).toBe(bus);
  expect(
    made.hooks.mock.results.map((result) => result.value as unknown),
    `${who}: payout's recovery port`,
  ).toContain(options.balanceRecoveredHook);
}

it('[AC-B2-04zn#13] 生产组合根：扣回用的账本带入口的 EVENT_BUS 和 payout 的回正钩子（同步与维权导入共用这一份）', async () => {
  const made = factories();
  const clawbacks = vi.spyOn(clawback, 'createClawbackOrder');
  const f = await built(() => keyedWorker());
  try {
    await runtime(f.context);
    expect(clawbacks).toHaveBeenCalledTimes(1);
    const bus = f.context.get(f.platform.EVENT_BUS, { strict: false });
    expectHooked(made, clawbacks.mock.calls[0]![0].ledger, bus, 'clawback');
  } finally {
    await f.close();
  }
});

it('[AC-B2-04zn#14] 生产组合根：结算 worker 的 R5 与 R5a 用的账本带入口的 EVENT_BUS 和 payout 的回正钩子', async () => {
  const made = factories();
  const credits = vi.spyOn(credit, 'createCreditOrder');
  const supplements = vi.spyOn(beneficiary, 'createBeneficiaryCredit');
  const f = await built(() => keyedWorker());
  try {
    expect(credits).toHaveBeenCalledTimes(1);
    expect(supplements).toHaveBeenCalledTimes(1);
    const bus = f.context.get(f.platform.EVENT_BUS, { strict: false });
    expectHooked(made, credits.mock.calls[0]![0].ledger, bus, 'R5');
    expectHooked(made, supplements.mock.calls[0]![0].ledger, bus, 'R5a');
  } finally {
    await f.close();
  }
});
