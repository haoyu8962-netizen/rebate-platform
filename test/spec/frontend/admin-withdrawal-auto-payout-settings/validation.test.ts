// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { choose } from '../admin-withdrawals/helpers.ts';
import { KEY, LABEL, SUPER, VERSION, serverFor } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  assertBatch,
  invalidMarks,
  markedInvalid,
  openSettings,
  pick,
  save,
  saveRefused,
  settle,
  typeInto,
} from './helpers.ts';

// F1-08ap (BR-WDR-30 细则): checks before anything is sent — window_end later than window_start;
// ② in 0–10000 yuan with at most two decimals; counts whole numbers ≥ 0. A refused save sends
// nothing, asks for no dynamic code and marks what is wrong. The two cross-key checks against
// withdraw.max_amount_fen and payout.daily_cap_fen are not tested here (out of scope).

it(
  '[AC-F1-08ap-VAL#1] 开始时间选 22:00:00（结束时间仍为 20:59:59）后保存：不发请求、不要动态码并标出错误；开始时间改为 20:00:00 后保存：只送 window_start=20:00:00',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    await pick(panel, LABEL.windowStart, '22:00:00');
    await saveRefused(server, panel);
    expect(invalidMarks(panel).length, 'the window is marked wrong').toBeGreaterThan(0);
    await pick(panel, LABEL.windowStart, '20:00:00');
    await save(server, panel);
    assertBatch(
      server,
      [{ key: KEY.windowStart, value: '20:00:00', expected_version: VERSION.windowStart }],
      1,
      1,
    );
  },
);

it(
  '[AC-F1-08ap-VAL#2] 金额上限填 10000.01、1.234、-1、abc，次数填 1.5、-1：每次保存都不发请求并标出该项；金额上限填 0、次数填 0 时可保存（0 / 0）',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    for (const text of ['10000.01', '1.234', '-1', 'abc']) {
      await typeInto(panel, LABEL.maxAmount, text);
      await saveRefused(server, panel);
      expect(markedInvalid(panel, LABEL.maxAmount), `amount ${text} is marked`).toBe(true);
    }
    await typeInto(panel, LABEL.maxAmount, '0');
    for (const text of ['1.5', '-1']) {
      await typeInto(panel, LABEL.payeeDaily, text);
      await saveRefused(server, panel);
      expect(markedInvalid(panel, LABEL.payeeDaily), `count ${text} is marked`).toBe(true);
    }
    await typeInto(panel, LABEL.payeeDaily, '0');
    await save(server, panel);
    assertBatch(
      server,
      [
        { key: KEY.maxAmount, value: 0, expected_version: VERSION.maxAmount },
        { key: KEY.payeeDaily, value: 0, expected_version: 1 },
      ],
      1,
      1,
    );
  },
);

it(
  '[AC-F1-08ap-VAL#3] 开始时间可选恰为 09:00:00 至 22:00:00 的 14 个整点、结束时间恰为 09:59:59 至 22:59:59 的 14 个；选最早开始 09:00:00、最晚结束 22:59:59 后保存：恰送这两个键（版本 1 / 1）',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    const starts = await choose(panel, LABEL.windowStart, /^09:00:00$/);
    await settle();
    expect(starts, 'every start of the window, in order').toEqual([
      '09:00:00',
      '10:00:00',
      '11:00:00',
      '12:00:00',
      '13:00:00',
      '14:00:00',
      '15:00:00',
      '16:00:00',
      '17:00:00',
      '18:00:00',
      '19:00:00',
      '20:00:00',
      '21:00:00',
      '22:00:00',
    ]);
    const ends = await choose(panel, LABEL.windowEnd, /^22:59:59$/);
    await settle();
    expect(ends, 'every end of the window, in order').toEqual([
      '09:59:59',
      '10:59:59',
      '11:59:59',
      '12:59:59',
      '13:59:59',
      '14:59:59',
      '15:59:59',
      '16:59:59',
      '17:59:59',
      '18:59:59',
      '19:59:59',
      '20:59:59',
      '21:59:59',
      '22:59:59',
    ]);
    await save(server, panel);
    assertBatch(
      server,
      [
        { key: KEY.windowStart, value: '09:00:00', expected_version: VERSION.windowStart },
        { key: KEY.windowEnd, value: '22:59:59', expected_version: VERSION.windowEnd },
      ],
      1,
      1,
    );
  },
);

it(
  '[AC-F1-08ap-VAL#4] 同一收款账号每月、同一会员每日、同一会员每月逐项填 -1、1.5，全平台当日上限填 -0.01、-1、abc：每次保存都不发请求、不要动态码并标出该项（每项测完改回合法值）；全平台当日上限填 0 可保存（0 分，版本 0），三项次数同批为 6 / 2 / 3',
  { timeout: 240_000 },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    const counts = [
      { label: LABEL.payeeMonthly, name: 'payee monthly', valid: '6' },
      { label: LABEL.userDaily, name: 'user daily', valid: '2' },
      { label: LABEL.userMonthly, name: 'user monthly', valid: '3' },
    ];
    for (const field of counts) {
      for (const text of ['-1', '1.5']) {
        await typeInto(panel, field.label, text);
        await saveRefused(server, panel);
        expect(markedInvalid(panel, field.label), `${field.name} ${text} is marked`).toBe(true);
      }
      await typeInto(panel, field.label, field.valid);
    }
    for (const text of ['-0.01', '-1', 'abc']) {
      await typeInto(panel, LABEL.platformDaily, text);
      await saveRefused(server, panel);
      expect(markedInvalid(panel, LABEL.platformDaily), `platform daily ${text} is marked`).toBe(
        true,
      );
    }
    await typeInto(panel, LABEL.platformDaily, '0');
    await save(server, panel);
    assertBatch(
      server,
      [
        { key: KEY.payeeMonthly, value: 6, expected_version: 1 },
        { key: KEY.userDaily, value: 2, expected_version: VERSION.userDaily },
        { key: KEY.userMonthly, value: 3, expected_version: 0 },
        { key: KEY.platformDaily, value: 0, expected_version: 0 },
      ],
      1,
      1,
    );
  },
);
