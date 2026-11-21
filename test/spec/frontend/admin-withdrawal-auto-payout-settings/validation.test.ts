// @vitest-environment jsdom
import { expect, it } from 'vitest';
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
