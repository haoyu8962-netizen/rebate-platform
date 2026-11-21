// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { KEY, SUPER, registry, serverFor, type ConfigRow } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  assertBatch,
  input,
  markedInvalid,
  openSettings,
  save,
  saveRefused,
  typeInto,
} from './helpers.ts';

// F1-08ap (BR-WDR-30 ⑧ 订单佣金预警): the four warn.*_bp keys are stored in basis points (0–10000)
// and shown / typed as a percentage with at most two decimals (10000 bp = 100%, 1234 bp = 12.34%).
// The config center has no percentage input to follow (it shows *_bp as raw bp, model.ts unitOf),
// so this tab's rule is: a percentage in 0–100 with at most two decimals, submitted as the integer
// bp; anything else is refused before sending and marked. Expected values are integer literals.

/** Field labels of ⑧ (whole label, an optional 「（%）」 and colon; spaces ignored by the regex). */
function percentLabel(words: string): RegExp {
  return new RegExp(`^(?:${words})(?:\\s*[（(][%％][)）])?[:：]?$`);
}
const DAYS_60 = '(?:60\\s*天内?\\s*)?';
const DAYS_30 = '(?:30\\s*天内?\\s*)?';
const RIGHTS = '(?:\\s*[（(]含维权失效[)）])?';
const WARN = {
  rate: percentLabel(`${DAYS_60}(?:订单)?高?佣金比例(?:阈值)?`),
  orders: percentLabel(`${DAYS_60}高佣金?(?:比例)?订单占(?:总订单)?比?(?:例|阈值)?`),
  invalid: percentLabel(`${DAYS_60}失效${RIGHTS}\\s*订单占比(?:阈值)?`),
  received: percentLabel(`${DAYS_30}提现金额占\\s*${DAYS_60}确认收货佣金(?:比例)?`),
} as const;

/** The bp a shown percentage stands for (integer arithmetic on the digits), or null. */
function bpOfShown(text: string): number | null {
  const match = /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(text.replace(/[%％\s,]/g, ''));
  if (match === null) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/** The registry with the four warn keys stored as `stored` (bp). */
function withWarn(stored: Readonly<Record<string, number>>): ConfigRow[] {
  return registry().map((row) => {
    const value = stored[row.key];
    return value === undefined ? row : { ...row, value };
  });
}

it(
  '[AC-F1-08ap-WARN#1] ⑧ 四项预警以百分比显示：存 10000 / 1 / 1234 / 0（bp）分别显示为 100% / 0.01% / 12.34% / 0%（不显示原始 bp 数）',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor({
      items: withWarn({
        [KEY.warnRate]: 10000,
        [KEY.warnOrders]: 1,
        [KEY.warnInvalid]: 1234,
        [KEY.warnReceived]: 0,
      }),
    });
    const panel = await openSettings(server, SUPER);
    expect(bpOfShown(input(panel, WARN.rate).value), 'warn rate').toBe(10000);
    expect(bpOfShown(input(panel, WARN.orders).value), 'warn orders').toBe(1);
    expect(bpOfShown(input(panel, WARN.invalid).value), 'warn invalid').toBe(1234);
    expect(bpOfShown(input(panel, WARN.received).value), 'warn received').toBe(0);
    const rate = input(panel, WARN.rate).value.replace(/[%％\s]/g, '');
    expect(rate, '100%, not the raw 10000').not.toBe('10000');
  },
);

it(
  '[AC-F1-08ap-WARN#2] ⑧ 四项预警填 12.34 / 100 / 0.5 / 0（%）后保存：一次批量只送这四项，值为 1234 / 10000 / 50 / 0（bp），expected_version 为显示时的版本',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    await typeInto(panel, WARN.rate, '12.34');
    await typeInto(panel, WARN.orders, '100');
    await typeInto(panel, WARN.invalid, '0.5');
    await typeInto(panel, WARN.received, '0');
    await save(server, panel);
    assertBatch(
      server,
      [
        { key: KEY.warnRate, value: 1234, expected_version: 1 },
        { key: KEY.warnOrders, value: 10000, expected_version: 1 },
        { key: KEY.warnInvalid, value: 50, expected_version: 1 },
        { key: KEY.warnReceived, value: 0, expected_version: 1 },
      ],
      1,
      1,
    );
  },
);

it(
  '[AC-F1-08ap-WARN#3] ⑧ 预警填 100.01、-1、12.345、abc（%）：每次保存都不发请求、不要动态码并标出该项；改为 0.01 后保存只送 1（bp）',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    for (const text of ['100.01', '-1', '12.345', 'abc']) {
      await typeInto(panel, WARN.invalid, text);
      await saveRefused(server, panel);
      expect(markedInvalid(panel, WARN.invalid), `warn ${text} is marked`).toBe(true);
    }
    await typeInto(panel, WARN.invalid, '0.01');
    await save(server, panel);
    assertBatch(server, [{ key: KEY.warnInvalid, value: 1, expected_version: 1 }], 1, 1);
  },
);
