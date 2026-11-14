// @vitest-environment jsdom
import { cleanup } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  CHECK,
  CID,
  CNO,
  QID,
  QNO,
  SUBMIT,
  alipayOverview,
  executeSamples,
  netSum,
  yuan,
  type Withdrawal,
} from './fixtures.ts';
import {
  MULTI_TIMEOUT,
  button,
  checkItems,
  disabled,
  open,
  openQueue,
  select,
  serverFor,
  squash,
} from './helpers.ts';

// F1-08bb ② boundary of 单日限额余量: the ticked net sum fits while it is not above
// daily_cap_fen − daily_sent_fen (BR-WDR-13 ③ daily_cap holds only when sent + net > cap), so a sum
// exactly equal to what is left is 满足, and one fen more than what is left is 未满足.

const sample = executeSamples();
const rowOf = (id: string): Withdrawal => sample.find((row) => row.withdrawal_id === id)!;
const A = rowOf(QID.approvedA);
const C = rowOf(CID);

it(
  '[AC-F1-08bb-PREVIEW#4] 单日限额余量取等：daily_cap_fen − daily_sent_fen 恰等于所勾 A+C 实付合计（¥599.88）→ 该项满足；余量少 1 分（¥599.87）→ 未满足；其余各项不变，【确认执行】都可用',
  { timeout: MULTI_TIMEOUT },
  async () => {
    expect(netSum([A, C]), 'A + C').toBe(yuan(59988));
    const scenarios: readonly { sent: number; left: number; met: boolean }[] = [
      { sent: 4940012, left: 59988, met: true },
      { sent: 4940013, left: 59987, met: false },
    ];
    for (const scenario of scenarios) {
      const view = alipayOverview({}, { daily_cap_fen: 5000000, daily_sent_fen: scenario.sent });
      const server = serverFor({ overview: view });
      const panel = await openQueue(server);
      await select(panel, [QNO.approvedA, CNO]);
      const modal = await open(server, panel);
      expect(checkItems(modal)).toEqual(
        [
          CHECK.payoutOn,
          CHECK.queueRunning,
          CHECK.fresh('alipay', yuan(3000000), '2026-11-14 09:00:00'),
          CHECK.level('alipay', yuan(3000000), yuan(2100000), '水位低', true),
          CHECK.daily(yuan(scenario.left), netSum([A, C]), scenario.met),
        ].map(squash),
      );
      expect(disabled(button(modal, SUBMIT))).toBe(false);
      expect(server.writes()).toEqual([]);
      cleanup();
    }
  },
);
