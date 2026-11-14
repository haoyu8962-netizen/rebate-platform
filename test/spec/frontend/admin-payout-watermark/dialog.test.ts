// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  CHANNEL_NAME,
  DASH,
  ENTRY,
  FIELD_TEXT,
  UNENTERED,
  overviewWithW,
  yuan,
  type Overview,
  type WatermarkRequest,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  MULTI_TIMEOUT,
  answerWith,
  assertPost,
  confirm,
  current,
  enter,
  fillIn,
  message,
  messages,
  openEntry,
  openPanel,
  posts,
  refusedLocally,
  serverFor,
  settled,
  verify,
  type Form,
} from './helpers.ts';

// F1-08bc ②: the dialog shows the account (the channel title), the current W of that channel
// from adminGetPayoutOverview channels[].watermark (available_fen through @couli/money, measured_at
// in Beijing time YYYY-MM-DD HH:mm:ss; no row → 未录入 and —), and three inputs: 可用余额 in yuan
// (required, ≥ 0, at most two decimals), 取数时间 in Beijing time YYYY-MM-DD HH:mm:ss (required, a
// real date and time), 备注 (optional; filled, it is not blank after trimming and at most 500
// characters, AdminPayoutWatermarkCreateRequest.note). A form failing a local check opens no
// StepUpModal and sends nothing; each message sits at its own field; once corrected, one request
// whose available_fen is the yuan in integer fen and whose measured_at carries +08:00.

interface Shown {
  readonly name: string;
  readonly answer: Overview;
  readonly expected: readonly string[];
}

it(
  '[AC-F1-08bc-DIALOG#1] 对话框显示账户与该通道当前 W：企业支付宝 ¥30,000.00 / 2026-11-14 09:00:00；微信零钱 无行时「未录入」/「—」；企业支付宝无行时「未录入」/「—」；微信零钱已录入时 ¥1,234.56 / 2026-11-14 08:30:00；打开对话框不发写请求',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const alipayW = overviewWithW('alipay', {
      available_fen: 3000000,
      measured_at: '2026-11-14T09:00:00+08:00',
      entered_by: 'ad000003-0000-4000-8000-0000000000a3',
      entered_by_name: 'ops01',
    });
    const wechatW = overviewWithW('wechat', {
      available_fen: 123456,
      measured_at: '2026-11-14T08:30:00+08:00',
      entered_by: 'ad000004-0000-4000-8000-0000000000a4',
      entered_by_name: null,
    });
    const scenarios: readonly Shown[] = [
      {
        name: ENTRY.alipay,
        answer: alipayW,
        expected: [CHANNEL_NAME.alipay, yuan(3000000), '2026-11-1409:00:00'],
      },
      {
        name: ENTRY.wechat,
        answer: overviewWithW('wechat', null),
        expected: [CHANNEL_NAME.wechat, UNENTERED, DASH],
      },
      {
        name: ENTRY.alipay,
        answer: overviewWithW('alipay', null),
        expected: [CHANNEL_NAME.alipay, UNENTERED, DASH],
      },
      {
        name: ENTRY.wechat,
        answer: wechatW,
        expected: [CHANNEL_NAME.wechat, yuan(123456), '2026-11-1408:30:00'],
      },
    ];
    for (const scenario of scenarios) {
      const server = serverFor({ overview: scenario.answer });
      await openPanel(server);
      const modal = await openEntry(server, scenario.name);
      expect(current(modal), `${scenario.name}: current W`).toEqual(scenario.expected);
      expect(server.writes(), 'nothing sent').toEqual([]);
      cleanup();
    }
  },
);

const VALID: Form = { available: '34567.89', measuredAt: '2026-11-14 09:50:00', note: '' };

interface Refusal {
  readonly form: Form;
  readonly available: readonly string[];
  readonly measuredAt: readonly string[];
  readonly note: readonly string[];
}

it(
  '[AC-F1-08bc-DIALOG#2] 本地校验：可用余额为空、负数、超过两位小数、非数字，取数时间为空、格式不对、日期不存在，备注全空白、超过 500 字时不弹动态码、不发请求，提示落在对应字段；改正后提示消失，只发一次请求',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    answerWith(server);
    await openPanel(server);
    const modal = await openEntry(server, ENTRY.alipay);
    const amount = message(FIELD_TEXT.amountInvalid);
    const time = message(FIELD_TEXT.timeInvalid);
    const refusals: readonly Refusal[] = [
      {
        form: { available: '', measuredAt: '', note: '' },
        available: message(FIELD_TEXT.amountRequired),
        measuredAt: message(FIELD_TEXT.timeRequired),
        note: [],
      },
      { form: { ...VALID, available: '-1' }, available: amount, measuredAt: [], note: [] },
      { form: { ...VALID, available: '12.345' }, available: amount, measuredAt: [], note: [] },
      { form: { ...VALID, available: 'abc' }, available: amount, measuredAt: [], note: [] },
      { form: { ...VALID, available: '1e3' }, available: amount, measuredAt: [], note: [] },
      {
        form: { ...VALID, measuredAt: '2026/11/14 09:50:00' },
        available: [],
        measuredAt: time,
        note: [],
      },
      {
        form: { ...VALID, measuredAt: '2026-11-31 09:50:00' },
        available: [],
        measuredAt: time,
        note: [],
      },
      {
        form: { ...VALID, note: '   ' },
        available: [],
        measuredAt: [],
        note: message(FIELD_TEXT.noteBlank),
      },
      {
        form: { ...VALID, note: '额'.repeat(501) },
        available: [],
        measuredAt: [],
        note: message(FIELD_TEXT.noteLong),
      },
    ];
    for (const refusal of refusals) {
      const { form, ...expected } = refusal;
      await fillIn(modal, form);
      await refusedLocally(server, modal);
      expect(messages(modal), JSON.stringify(form).slice(0, 80)).toEqual(expected);
    }
    await fillIn(modal, VALID);
    await confirm(server, modal);
    expect(messages(modal), 'no message once corrected').toEqual({
      available: [],
      measuredAt: [],
      note: [],
    });
    await verify();
    await waitFor(() => expect(posts(server)).toHaveLength(1));
    await settled(server);
    const body: WatermarkRequest = {
      channel: 'alipay',
      available_fen: 3456789,
      measured_at: '2026-11-14T09:50:00+08:00',
    };
    assertPost(server, body, 1, 1);
  },
);

interface Conversion {
  readonly form: Form;
  readonly fen: number;
  readonly at: string;
}

const LONG_NOTE = '额'.repeat(500);

it(
  '[AC-F1-08bc-DIALOG#3] 金额只按 @couli/money 换成整数分、时间按北京时间带 +08:00 发送：0 → 0 分、0.5 → 50 分、100 → 10000 分、1234567.8 → 123456780 分；00:10 不换成 UTC；备注正好 500 字照发',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const cases: readonly Conversion[] = [
      {
        form: { available: '0', measuredAt: '2026-11-15 00:10:00', note: '' },
        fen: 0,
        at: '2026-11-15T00:10:00+08:00',
      },
      {
        form: { available: '0.5', measuredAt: '2026-11-14 23:59:59', note: '' },
        fen: 50,
        at: '2026-11-14T23:59:59+08:00',
      },
      {
        form: { available: '100', measuredAt: '2026-11-14 09:50:00', note: '' },
        fen: 10000,
        at: '2026-11-14T09:50:00+08:00',
      },
      {
        form: { available: '1234567.8', measuredAt: '2026-11-14 09:50:00', note: LONG_NOTE },
        fen: 123456780,
        at: '2026-11-14T09:50:00+08:00',
      },
    ];
    for (const item of cases) {
      const server = serverFor();
      answerWith(server);
      await openPanel(server);
      const modal = await openEntry(server, ENTRY.alipay);
      await enter(server, modal, item.form);
      const body: WatermarkRequest = {
        channel: 'alipay',
        available_fen: item.fen,
        measured_at: item.at,
        ...(item.form.note === '' ? {} : { note: item.form.note }),
      };
      assertPost(server, body, 1, 1);
      cleanup();
    }
  },
);
