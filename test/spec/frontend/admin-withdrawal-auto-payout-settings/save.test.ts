// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { card } from '../admin-payouts-readonly/helpers.ts';
import {
  BUSINESS_GRANTS,
  FLAG_NAME,
  GROUP,
  KEY,
  LABEL,
  NOTICE,
  SAMPLE,
  SUPER,
  VERSION,
  accountOf,
  fenOfShown,
  passOf,
  registry,
  rowOf,
  serverFor,
  type BatchEntry,
  type ConfigRow,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  assertBatch,
  batches,
  click,
  editable,
  flagBox,
  input,
  openSettings,
  passUntilSent,
  pick,
  save,
  saveRefused,
  setFlag,
  shows,
  stepDialogs,
  typeInto,
  verifications,
} from './helpers.ts';

// F1-08ap: 【保存】 sends one POST /admin/v1/config-items/batch with exactly the keys changed on the
// tab, each {key, value, expected_version} with the version the tab showed (0 for a key never
// written), after the totp dynamic code; amounts typed in yuan go out as integer fen. Without a
// change nothing can be saved. After success the tab shows the answered items and their new
// versions, so the next save carries them.

it(
  '[AC-F1-08ap-SAVE#1] 未改动时【保存】不可用或按下不发请求、不要动态码',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    await saveRefused(server, panel);
    expect(batches(server)).toEqual([]);
  },
);

it(
  '[AC-F1-08ap-SAVE#2] 改金额上限为 300 元、同一会员每日为 1、关时段限制后【保存】：动态码后一次 batch，恰含这三个键（30000 分 / 1 / false，expected_version 为显示时版本）；成功后以新版本刷新，再改金额为 280 元保存带新版本',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    await typeInto(panel, LABEL.maxAmount, '300');
    await typeInto(panel, LABEL.userDaily, '1');
    await setFlag(panel, LABEL.windowLimit, false);
    await save(server, panel);
    const first: BatchEntry[] = [
      { key: KEY.maxAmount, value: 30000, expected_version: VERSION.maxAmount },
      { key: KEY.userDaily, value: 1, expected_version: VERSION.userDaily },
      { key: KEY.windowLimit, value: false, expected_version: 2 },
    ];
    assertBatch(server, first, 1, 1);
    await shows(panel, NOTICE.saved);
    expect(rowOf(server, KEY.maxAmount).version).toBe(VERSION.maxAmount + 1);
    await waitFor(() => expect(fenOfShown(input(panel, LABEL.maxAmount).value)).toBe(30000));
    expect(input(panel, LABEL.userDaily).value).toBe('1');

    await typeInto(panel, LABEL.maxAmount, '280');
    await save(server, panel);
    const second: BatchEntry[] = [
      { key: KEY.maxAmount, value: 28000, expected_version: VERSION.maxAmount + 1 },
    ];
    assertBatch(server, second, 2, verifications(server).length);
  },
);

it(
  '[AC-F1-08ap-SAVE#3] 从未写过的键：同一会员每月填 5、全平台当日填 1500 元，结束时间选 21:59:59 后保存：两未写过的键 expected_version 为 0（5 / 150000 分），结束时间带版本 1',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    await typeInto(panel, LABEL.userMonthly, '5');
    await typeInto(panel, LABEL.platformDaily, '1500');
    await pick(panel, LABEL.windowEnd, '21:59:59');
    await save(server, panel);
    assertBatch(
      server,
      [
        { key: KEY.userMonthly, value: 5, expected_version: 0 },
        { key: KEY.platformDaily, value: 150000, expected_version: 0 },
        { key: KEY.windowEnd, value: '21:59:59', expected_version: VERSION.windowEnd },
      ],
      1,
      1,
    );
    await shows(panel, NOTICE.saved);
  },
);

it(
  '[AC-F1-08ap-SAVE#4] 勾选「首次提现」、取消「有对账差错」后保存：risk_block_flags 为原集合加 first_withdrawal 去 recon_diff（固定的 blacklist_hit 是否随值发送不限），带版本 4；金额上限填 10000 元（上限边界）同批送 1000000 分',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    const extra = card(panel, GROUP.extra);
    await click(flagBox(extra, FLAG_NAME.first_withdrawal));
    await click(flagBox(extra, FLAG_NAME.recon_diff));
    await typeInto(panel, LABEL.maxAmount, '10000');
    expect(stepDialogs()).toEqual([]);
    await save(server, panel);
    const sent = batches(server);
    expect(sent).toHaveLength(1);
    const items = (sent[0]!.body as { items: BatchEntry[] }).items;
    const flags = items.find((entry) => entry.key === KEY.riskFlags);
    expect(flags, 'risk_block_flags is sent').toBeDefined();
    expect(flags!.expected_version).toBe(VERSION.flags);
    const codes = (flags!.value as string[]).filter((code) => code !== 'blacklist_hit').sort();
    const expected = [...SAMPLE.riskFlags, 'first_withdrawal']
      .filter((code) => code !== 'recon_diff')
      .sort();
    expect(codes).toEqual(expected);
    const amount = items.find((entry) => entry.key === KEY.maxAmount);
    expect(amount).toEqual({
      key: KEY.maxAmount,
      value: 1000000,
      expected_version: VERSION.maxAmount,
    });
    expect(items.map((entry) => entry.key).sort()).toEqual([KEY.maxAmount, KEY.riskFlags].sort());
    await shows(panel, NOTICE.saved);
  },
);

/** The registry with 首提限制 stored on (version 3) instead of the sample's off. */
function withFirstLimitOn(): ConfigRow[] {
  return registry().map((row) =>
    row.key === KEY.firstLimit ? { ...row, value: true, version: 3 } : row,
  );
}

it(
  '[AC-F1-08ap-SAVE#5] 已存首提限制为开（版本 3）、同一收款账号每月为 4（版本 1）：关首提限制、每月改为 7 后保存恰送 first_withdrawal_limit_enabled=false（版本 3）与 payee_monthly_max_count=7（版本 1）、不动每日；再开首提限制保存送 true（版本 4）',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor({ items: withFirstLimitOn() });
    const panel = await openSettings(server, SUPER);
    expect(input(panel, LABEL.payeeMonthly).value).toBe(String(SAMPLE.payeeMonthly));
    expect(input(panel, LABEL.payeeDaily).value).toBe(String(SAMPLE.payeeDaily));
    await setFlag(panel, LABEL.firstLimit, false);
    await typeInto(panel, LABEL.payeeMonthly, '7');
    await save(server, panel);
    assertBatch(
      server,
      [
        { key: KEY.firstLimit, value: false, expected_version: 3 },
        { key: KEY.payeeMonthly, value: 7, expected_version: 1 },
      ],
      1,
      1,
    );
    await shows(panel, NOTICE.saved);
    expect(rowOf(server, KEY.payeeDaily).value, 'the daily count is untouched').toBe(
      SAMPLE.payeeDaily,
    );
    await waitFor(() => expect(input(panel, LABEL.payeeMonthly).value).toBe('7'));
    expect(input(panel, LABEL.payeeDaily).value).toBe(String(SAMPLE.payeeDaily));

    await setFlag(panel, LABEL.firstLimit, true);
    await save(server, panel);
    assertBatch(
      server,
      [{ key: KEY.firstLimit, value: true, expected_version: 4 }],
      2,
      verifications(server).length,
    );
    expect(rowOf(server, KEY.firstLimit)).toMatchObject({ value: true, version: 5 });
  },
);

it(
  '[AC-F1-08ap-SAVE#6] 金额带分：金额上限填 300.01 元、全平台当日上限填 1500.01 元后保存：恰送 30001 分（版本 3）与 150001 分（版本 0），不截掉小数',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    await typeInto(panel, LABEL.maxAmount, '300.01');
    await typeInto(panel, LABEL.platformDaily, '1500.01');
    await save(server, panel);
    assertBatch(
      server,
      [
        { key: KEY.maxAmount, value: 30001, expected_version: 3 },
        { key: KEY.platformDaily, value: 150001, expected_version: 0 },
      ],
      1,
      1,
    );
    await shows(panel, NOTICE.saved);
    await waitFor(() => expect(fenOfShown(input(panel, LABEL.maxAmount).value)).toBe(30001));
    expect(fenOfShown(input(panel, LABEL.platformDaily).value)).toBe(150001);
  },
);

it(
  '[AC-F1-08ap-SAVE#7] 持 config.business 的普通账号（非超管）连续两次保存都成功：第一次金额上限 300 元带凭证 1；凭证用过即失效，第二次同一会员每日改为 1 必须用新动态码凭证 2 送出并成功（若先带旧凭证被拒 10003，须重新要动态码后原样重发），不当作最终失败',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor({ permissions: BUSINESS_GRANTS });
    const panel = await openSettings(server, accountOf(BUSINESS_GRANTS));
    await typeInto(panel, LABEL.maxAmount, '300');
    await save(server, panel);
    assertBatch(
      server,
      [{ key: KEY.maxAmount, value: 30000, expected_version: VERSION.maxAmount }],
      1,
      1,
    );
    await shows(panel, NOTICE.saved);
    expect(rowOf(server, KEY.maxAmount)).toMatchObject({
      value: 30000,
      version: VERSION.maxAmount + 1,
    });

    await typeInto(panel, LABEL.userDaily, '1');
    const before = batches(server).length;
    await save(server, panel);
    const reused = (): boolean => {
      const all = batches(server);
      return all[all.length - 1]!.headers.get('X-Step-Up-Token') === passOf(1);
    };
    if (reused()) await passUntilSent(server, before + 1);
    const sent = batches(server);
    expect(reused(), 'the last save carries a new pass').toBe(false);
    assertBatch(
      server,
      [{ key: KEY.userDaily, value: 1, expected_version: VERSION.userDaily }],
      sent.length,
      2,
    );
    const second = sent[sent.length - 1]!;
    if (sent.length === before + 2)
      expect(sent[before]!.body, 'resent as it was').toStrictEqual(second.body);
    expect(rowOf(server, KEY.userDaily)).toMatchObject({
      value: 1,
      version: VERSION.userDaily + 1,
    });
    await waitFor(() => expect(input(panel, LABEL.userDaily).value).toBe('1'));
    expect(fenOfShown(input(panel, LABEL.maxAmount).value)).toBe(30000);
    expect(editable(panel).length, 'the form stays usable').toBeGreaterThan(0);
  },
);
