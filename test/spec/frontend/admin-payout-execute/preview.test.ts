// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  CANCEL,
  CHECK,
  CID,
  CNO,
  PREVIEW_HEADERS,
  QID,
  QNO,
  SUBMIT,
  alipayOverview,
  dailyLeft,
  executeSamples,
  netSum,
  overview,
  recheckNote,
  yuan,
  type Overview,
  type Withdrawal,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  MULTI_TIMEOUT,
  button,
  checkItems,
  checkbox,
  click,
  dialogs,
  disabled,
  open,
  openQueue,
  select,
  serverFor,
  squash,
} from './helpers.ts';

// F1-08bb ②: 【执行所选】 opens the 执行确认 dialog — nothing is sent. It lists what will be executed
// (提现单号, 用户, 实付金额 through @couli/money; list order, whatever the tick order) and the
// 「执行前检查」 list, every item taken from the payout overview (no threshold of its own): the
// payout switch, the queue, for each channel of the ticked rows (overview order) its W with t_W
// (fresh while the overview gives a water level) and W against P with the overview's conclusion,
// then the daily cap left (daily_cap_fen − daily_sent_fen) against the ticked net sum. Each item ends
// with （满足） or （未满足）; an unmet W item does not block the submit (the server checks again, which
// the note under the list says). 【取消】 sends nothing, keeps the ticks and gives the focus back.

const sample = executeSamples();
const rowOf = (id: string): Withdrawal => sample.find((row) => row.withdrawal_id === id)!;
const A = rowOf(QID.approvedA);
const B = rowOf(QID.approvedB);
const C = rowOf(CID);

/** The preview rows of `modal` for `items`: whole cells, list order. */
function assertPreview(modal: HTMLElement, items: readonly Withdrawal[]): void {
  const headers = within(modal)
    .queryAllByRole('columnheader')
    .map((node) => squash(node.textContent));
  expect(headers, 'execution list headers').toEqual([...PREVIEW_HEADERS]);
  const found = items.map((item) => {
    const rows = within(modal)
      .queryAllByRole('row')
      .filter((row) => within(row).queryAllByText(item.out_biz_no, { exact: true }).length === 1);
    expect(rows, `one preview row ${item.out_biz_no}`).toHaveLength(1);
    const row = rows[0]!;
    const cells = within(row).queryAllByRole('cell');
    expect(cells).toHaveLength(3);
    expect(cells[0]!.textContent).toBe(item.out_biz_no);
    expect(within(cells[1]!).queryAllByText(item.user.user_id, { exact: true })).toHaveLength(1);
    expect(within(cells[1]!).queryAllByText(item.user.phone_masked!, { exact: true })).toHaveLength(
      1,
    );
    expect(cells[2]!.textContent).toBe(yuan(item.net_fen));
    return row;
  });
  const bodyRows = within(modal)
    .queryAllByRole('row')
    .filter((row) => within(row).queryAllByRole('cell').length > 0);
  expect(bodyRows, 'only the ticked rows').toHaveLength(items.length);
  for (let index = 1; index < found.length; index += 1)
    expect(
      found[index - 1]!.compareDocumentPosition(found[index]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      'list order',
    ).not.toBe(0);
}

it(
  '[AC-F1-08bb-PREVIEW#1] 倒序勾 C、A 后点【执行所选】：执行确认对话框按列表顺序列 A、C 的单号、用户、实付金额；执行前检查逐项全文（开关已开启、队列运行中、企业支付宝 W 与取数时间、W 对 P 与水位结论、单日限额余量对本次合计，均满足）与服务端再查的说明；不发请求；【取消】后焦点回【执行所选】、勾选保留',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openQueue(server);
    await select(panel, [CNO, QNO.approvedA]);
    const entry = button(panel, '执行所选');
    const modal = await open(server, panel);
    assertPreview(modal, [A, C]);
    const view = overview();
    expect(checkItems(modal)).toEqual(
      [
        CHECK.payoutOn,
        CHECK.queueRunning,
        CHECK.fresh('alipay', yuan(3000000), '2026-11-14 09:00:00'),
        CHECK.level('alipay', yuan(3000000), yuan(2100000), '水位低', true),
        CHECK.daily(dailyLeft(view), netSum([A, C]), true),
      ].map(squash),
    );
    expect(
      within(modal).queryAllByText(recheckNote('2026-11-14 10:00:00'), { exact: true }),
    ).toHaveLength(1);
    expect(disabled(button(modal, SUBMIT))).toBe(false);
    expect(server.writes()).toEqual([]);
    await click(button(modal, CANCEL));
    await waitFor(() => expect(dialogs()).toEqual([]));
    await waitFor(() => expect(document.activeElement).toBe(entry));
    expect(checkbox(panel, QNO.approvedA).checked).toBe(true);
    expect(checkbox(panel, CNO).checked).toBe(true);
    expect(server.writes()).toEqual([]);
  },
);

it(
  '[AC-F1-08bb-PREVIEW#2] 勾企业支付宝单 A 与银行卡单 B：执行前检查按概览的通道顺序列两个通道（银行卡没有 W：未录入、无结论，均未满足），单日限额余量对 A+B 合计；未满足的余额项不阻止【确认执行】',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openQueue(server);
    await select(panel, [QNO.approvedB, QNO.approvedA]);
    const modal = await open(server, panel);
    assertPreview(modal, [A, B]);
    expect(checkItems(modal)).toEqual(
      [
        CHECK.payoutOn,
        CHECK.queueRunning,
        CHECK.fresh('alipay', yuan(3000000), '2026-11-14 09:00:00'),
        CHECK.level('alipay', yuan(3000000), yuan(2100000), '水位低', true),
        CHECK.unentered('bank_card'),
        CHECK.noLevel('bank_card'),
        CHECK.daily(dailyLeft(overview()), netSum([A, B]), true),
      ].map(squash),
    );
    expect(disabled(button(modal, SUBMIT))).toBe(false);
    expect(server.writes()).toEqual([]);
  },
);

/** The alipay W of the sample with another amount and t_W. */
function watermark(availableFen: number, measuredAt: string) {
  return {
    ...overview().channels[0]!.watermark!,
    available_fen: availableFen,
    measured_at: measuredAt,
  };
}

it(
  '[AC-F1-08bb-PREVIEW#3] 执行前检查随概览字段变化、不写死阈值：W 已过期（概览无水位结论）→ W 项「已过期」、水位「无结论」均未满足，单日余量 ¥100.00 不够本次合计也未满足；W 低于 P → 水位项未满足；W 充足、结论正常 → 满足；说明里的数据时间取 as_of；各情形【确认执行】都可用',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const scenarios: readonly { overview: Overview; items: string[]; time: string }[] = [
      {
        overview: alipayOverview(
          { watermark: watermark(3000000, '2026-11-14T06:00:00+08:00'), water_level: null },
          { daily_sent_fen: 4990000 },
        ),
        items: [
          CHECK.stale('alipay', yuan(3000000), '2026-11-14 06:00:00'),
          CHECK.noLevel('alipay'),
          CHECK.daily(yuan(10000), netSum([A, C]), false),
        ],
        time: '2026-11-14 10:00:00',
      },
      {
        overview: alipayOverview(
          { watermark: watermark(1500000, '2026-11-14T09:30:00+08:00'), water_level: 'low' },
          { daily_cap_fen: 3000000, daily_sent_fen: 0, as_of: '2026-11-14T10:30:00+08:00' },
        ),
        items: [
          CHECK.fresh('alipay', yuan(1500000), '2026-11-14 09:30:00'),
          CHECK.level('alipay', yuan(1500000), yuan(2100000), '水位低', false),
          CHECK.daily(yuan(3000000), netSum([A, C]), true),
        ],
        time: '2026-11-14 10:30:00',
      },
      {
        overview: alipayOverview(
          {
            watermark: watermark(4000000, '2026-11-14T09:45:00+08:00'),
            forecast_withdrawal_fen: 1200000,
            water_level: 'normal',
          },
          { daily_cap_fen: 2000000, daily_sent_fen: 1990012 },
        ),
        items: [
          CHECK.fresh('alipay', yuan(4000000), '2026-11-14 09:45:00'),
          CHECK.level('alipay', yuan(4000000), yuan(1200000), '正常', true),
          CHECK.daily(yuan(9988), netSum([A, C]), false),
        ],
        time: '2026-11-14 10:00:00',
      },
    ];
    for (const scenario of scenarios) {
      const server = serverFor({ overview: scenario.overview });
      const panel = await openQueue(server);
      await select(panel, [QNO.approvedA, CNO]);
      const modal = await open(server, panel);
      expect(checkItems(modal)).toEqual(
        [CHECK.payoutOn, CHECK.queueRunning, ...scenario.items].map(squash),
      );
      expect(
        within(modal).queryAllByText(recheckNote(scenario.time), { exact: true }),
      ).toHaveLength(1);
      expect(disabled(button(modal, SUBMIT))).toBe(false);
      expect(server.writes()).toEqual([]);
      cleanup();
    }
  },
);
