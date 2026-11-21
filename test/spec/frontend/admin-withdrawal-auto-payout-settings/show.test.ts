// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { card } from '../admin-payouts-readonly/helpers.ts';
import {
  BUSINESS_GRANTS,
  ENABLE_CHECK_ITEMS,
  ENABLE_CHECK_TITLE,
  ENABLE_CHECK_WORDS,
  EXTRA_NOTE,
  FLAG_CODES,
  FLAG_NAME,
  GROUP,
  KEY,
  LABEL,
  MASTER_SHOWN,
  NO_AUTO,
  NO_PERMISSION_TO_VIEW,
  SAMPLE,
  SUPER,
  SWITCHES,
  SWITCH_ENTRY,
  SWITCH_PAGE_TITLE,
  TAB,
  UNSET,
  VERSION,
  WARN_LABEL,
  accountOf,
  fenOfShown,
  registry,
  serverFor,
  type BatchEntry,
  type ConfigRow,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  MULTI_TIMEOUT,
  batches,
  buttons,
  click,
  disabled,
  flagBox,
  handlersWithoutRole,
  input,
  isShown,
  main,
  openSettings,
  save,
  settled,
  squash,
  stepDialogs,
  switchReads,
  tabsIn,
  textOf,
  values,
} from './helpers.ts';

// F1-08ap (BR-WDR-30 细则「后台配置页」): the tab shows ①–⑧ in the group 「自动到账设置」 and ⑨ ⑫ in a
// group 「本系统附加」 noting 花卷云无此项. Values come from the config-items read: the amounts in
// yuan (only through @couli/money), the counts as integers; a key never written (value null) is
// shown as unset with an empty input — no default number is written in by the page. ⑤ ⑥ read
// 「不自动到账」 with no control. ① is a read-only state with an entry to the emergency switch page,
// no control of its own. risk_block_flags is one checkbox per BR-WDR-29 label, blacklist_hit ticked
// and fixed. No element handles clicks or keys without an interactive role, and no entry fills an
// amount or the current time into an input (D10-2050).

it(
  '[AC-F1-08ap-SHOW#1] 超管进「自动到账设置」：金额上限显示 250.50 元、三项次数 2 / 4 / 3、开始 / 结束时间 10:00:00 / 20:59:59；从未写过的「同一会员每月」「全平台当日自动到账」输入框为空并标未设置；冻结金额、当日提现只读显示「不自动到账」',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    await waitFor(() => expect(fenOfShown(input(panel, LABEL.maxAmount).value)).toBe(25050));
    expect(input(panel, LABEL.payeeDaily).value).toBe(String(SAMPLE.payeeDaily));
    expect(input(panel, LABEL.payeeMonthly).value).toBe(String(SAMPLE.payeeMonthly));
    expect(input(panel, LABEL.userDaily).value).toBe(String(SAMPLE.userDaily));
    expect(input(panel, LABEL.userMonthly).value, 'never written: empty').toBe('');
    expect(input(panel, LABEL.platformDaily).value, 'never written: empty').toBe('');
    const text = squash(textOf(panel));
    expect(text).toContain(SAMPLE.windowStart);
    expect(text).toContain(SAMPLE.windowEnd);
    expect(text, 'unset keys are marked').toMatch(UNSET);
    expect(text, 'no default amount written in for ⑨').not.toContain('2000.00');
    for (const label of [LABEL.frozen, LABEL.sameDay]) {
      expect(values(panel, label), String(label)).toEqual([NO_AUTO]);
      expect(within(panel).queryAllByLabelText(label), `${String(label)} has no control`).toEqual(
        [],
      );
    }
  },
);

it(
  '[AC-F1-08ap-SHOW#2] 分组与总开关：「本系统附加」分组注明「花卷云无此项」并含全平台当日上限、不含金额上限；总开关只读显示「已关闭」并有【去紧急开关页】、无开关控件；列出开启前置检查条目但不显示满足与否；无无交互角色的点击元素、无预填金额或时间的入口',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor({ master: false });
    const panel = await openSettings(server, SUPER);
    const extra = card(panel, GROUP.extra);
    expect(squash(textOf(extra))).toContain(EXTRA_NOTE);
    expect(within(extra).queryAllByLabelText(LABEL.platformDaily).length).toBeGreaterThan(0);
    expect(within(extra).queryAllByLabelText(LABEL.maxAmount), '② is not 本系统附加').toEqual([]);
    await waitFor(() => expect(values(panel, LABEL.master)).toEqual([MASTER_SHOWN.off]));
    const entries = buttons(panel, SWITCH_ENTRY).filter(isShown);
    expect(entries, `one entry ${SWITCH_ENTRY}`).toHaveLength(1);
    expect(disabled(entries[0]!)).toBe(false);
    const controls = [
      ...within(panel).queryAllByRole('switch', { name: LABEL.master }),
      ...within(panel).queryAllByRole('checkbox', { name: LABEL.master }),
    ];
    expect(controls, 'the master switch has no control here').toEqual([]);
    for (const word of ['开启自动到账', '关闭自动到账', '立即关闭', '关闭总开关'])
      expect(buttons(panel, word), `no ${word}`).toEqual([]);
    const text = squash(textOf(panel));
    expect(text).toMatch(ENABLE_CHECK_TITLE);
    for (const word of ENABLE_CHECK_WORDS) expect(text).toMatch(word);
    expect(text, 'the checks are listed, not judged').not.toMatch(/未满足|已满足|未通过|已通过/);
    expect(handlersWithoutRole(panel), 'no handler without a role').toEqual([]);
    const fills = Array.from(panel.querySelectorAll<HTMLElement>('button, a, [role="button"]'))
      .map((node) => squash(node.textContent) || squash(node.getAttribute('aria-label')))
      .filter((name) => /默认|填入|带入|当前时间|现在/.test(name));
    expect(fills, 'no entry filling a default, an amount or the time').toEqual([]);
  },
);

it(
  '[AC-F1-08ap-SHOW#3] 阻断风险标签：每个 BR-WDR-29 标签一个勾选框，已存的「同设备多账号」「曾负余额」「有对账差错」已勾、「首次提现」未勾；「命中黑名单」固定勾选且不可取消',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    const extra = card(panel, GROUP.extra);
    await waitFor(() =>
      expect(flagBox(extra, FLAG_NAME.same_device_multi_account).checked).toBe(true),
    );
    expect(flagBox(extra, FLAG_NAME.had_negative).checked).toBe(true);
    expect(flagBox(extra, FLAG_NAME.recon_diff).checked).toBe(true);
    expect(flagBox(extra, FLAG_NAME.first_withdrawal).checked).toBe(false);
    expect(flagBox(extra, FLAG_NAME.payee_prev_other_user).checked).toBe(false);
    expect(disabled(flagBox(extra, FLAG_NAME.first_withdrawal)), 'others can be ticked').toBe(
      false,
    );
    const blacklist = flagBox(extra, FLAG_NAME.blacklist_hit);
    expect(blacklist.checked, 'blacklist_hit is always checked').toBe(true);
    expect(disabled(blacklist), 'blacklist_hit cannot be removed').toBe(true);
  },
);

it(
  '[AC-F1-08ap-SHOW#4] 总开关已开时显示「已开启」；只持 config.business（无 switch.*）的账号总开关显示无权限查看、不请求 kill-switches，其余设置照常显示',
  { timeout: MULTI_TIMEOUT },
  async () => {
    const on = serverFor({ master: true });
    const panel = await openSettings(on, SUPER);
    await waitFor(() => expect(values(panel, LABEL.master)).toEqual([MASTER_SHOWN.on]));
    cleanup();

    const business = serverFor({ permissions: BUSINESS_GRANTS });
    const shown = await openSettings(business, accountOf(BUSINESS_GRANTS));
    await settled(business);
    const master = values(shown, LABEL.master);
    expect(master).toHaveLength(1);
    expect(master[0]).toMatch(NO_PERMISSION_TO_VIEW);
    expect(switchReads(business), 'no kill-switch read without a switch point').toEqual([]);
    expect(fenOfShown(input(shown, LABEL.maxAmount).value)).toBe(25050);
  },
);

/** The first shown element of `root` whose own text is the label `label`. */
function labelNode(root: HTMLElement, label: RegExp): HTMLElement {
  const found = within(root)
    .queryAllByText(label)
    .filter((node) => isShown(node));
  expect(found.length, `a label ${String(label)} in the group`).toBeGreaterThan(0);
  return found[0]!;
}
function before(a: Node, b: Node): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}
/** ①–⑧ in rule order (inside one step the order is free). */
const MAIN_STEPS: readonly (readonly [string, readonly RegExp[]])[] = [
  ['①', [LABEL.master]],
  ['②', [LABEL.maxAmount]],
  ['③', [LABEL.windowLimit, LABEL.windowStart, LABEL.windowEnd]],
  ['④', [LABEL.firstLimit]],
  ['⑤', [LABEL.frozen]],
  ['⑥', [LABEL.sameDay]],
  ['⑦', [LABEL.payeeDaily, LABEL.payeeMonthly, LABEL.userDaily, LABEL.userMonthly]],
  ['⑧', [WARN_LABEL.rate, WARN_LABEL.orders, WARN_LABEL.invalid, WARN_LABEL.received]],
];

it(
  '[AC-F1-08ap-SHOW#5] 「自动到账设置」分组内按 ①–⑧ 顺序含总开关、金额上限、时段三项、首提限制（有开关控件）、冻结金额、当日提现、四项次数、四项预警；可编辑的全平台当日上限与阻断标签在「本系统附加」分组、不在主分组；附加分组不含 ①–⑧',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    const group = card(panel, GROUP.main);
    const extra = card(panel, GROUP.extra);
    expect(group.contains(extra), 'the 本系统附加 group is a group of its own').toBe(false);
    const steps = MAIN_STEPS.map(([name, labels]) => ({
      name,
      nodes: labels.map((label) => labelNode(group, label)),
    }));
    for (let index = 1; index < steps.length; index += 1) {
      const earlier = steps[index - 1]!;
      const later = steps[index]!;
      for (const a of earlier.nodes)
        for (const b of later.nodes)
          expect(before(a, b), `${earlier.name} comes before ${later.name}`).toBe(true);
    }
    const firstLimit = [
      ...within(group).queryAllByRole('switch', { name: LABEL.firstLimit }),
      ...within(group).queryAllByRole('checkbox', { name: LABEL.firstLimit }),
      ...within(group).queryAllByRole('radiogroup', { name: LABEL.firstLimit }),
      ...within(group).queryAllByRole('combobox', { name: LABEL.firstLimit }),
    ].filter((node) => isShown(node));
    expect(firstLimit, '④ has one control').toHaveLength(1);
    expect(disabled(firstLimit[0]!), '④ can be changed').toBe(false);
    for (const [name, labels] of MAIN_STEPS)
      for (const label of labels)
        expect(within(extra).queryAllByText(label), `${name} is not 本系统附加`).toEqual([]);
    expect(within(extra).queryAllByLabelText(LABEL.platformDaily).length).toBeGreaterThan(0);
    expect(within(group).queryAllByLabelText(LABEL.platformDaily), '⑨ not in ①–⑧').toEqual([]);
    expect(disabled(flagBox(extra, FLAG_NAME.recon_diff))).toBe(false);
    expect(within(group).queryAllByRole('checkbox', { name: FLAG_NAME.recon_diff })).toEqual([]);
  },
);

it(
  '[AC-F1-08ap-SHOW#6] 超管在总开关已开时按【去紧急开关页】：真正到达紧急开关页（标题「紧急开关」、提现审核页签不再显示、读了开关列表），按下本身不发任何写请求',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor({ master: true });
    const panel = await openSettings(server, SUPER);
    await waitFor(() => expect(values(panel, LABEL.master)).toEqual([MASTER_SHOWN.on]));
    const since = server.log.length;
    const entries = buttons(panel, SWITCH_ENTRY).filter(isShown);
    expect(entries, `one entry ${SWITCH_ENTRY}`).toHaveLength(1);
    await click(entries[0]!);
    await waitFor(() =>
      expect(
        within(main()).queryAllByRole('heading', { name: SWITCH_PAGE_TITLE }).length,
        'the emergency switch page',
      ).toBeGreaterThan(0),
    );
    await settled(server);
    expect(tabsIn(main(), TAB.review), 'left the withdrawals page').toEqual([]);
    const after = server.log.slice(since);
    expect(
      after.some((request) => request.method === 'GET' && request.path === SWITCHES),
      'the switch page read its list',
    ).toBe(true);
    expect(
      server.log
        .slice(since)
        .filter((request) => request.method !== 'GET')
        .map((request) => `${request.method} ${request.path}`),
      'pressing the entry writes nothing',
    ).toEqual([]);
    expect(stepDialogs(), 'nothing asked for').toEqual([]);
  },
);

it(
  '[AC-F1-08ap-SHOW#7] 开启前置检查逐条列全且各为独立列表项：单笔与单日限额、失败码与查询状态、按日账单含 out_biz_no、每日通道对账连续跑通（每项的必备词都在同一条目内，末项须写明「每日」）；只列条目不显示满足与否',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor({ master: false });
    const panel = await openSettings(server, SUPER);
    const text = squash(textOf(panel));
    expect(text).toMatch(ENABLE_CHECK_TITLE);
    const listItems = Array.from(
      panel.querySelectorAll<HTMLElement>('li, [role="listitem"]'),
    ).filter((node) => isShown(node));
    // Only the innermost list items: an item holding other items is not one check.
    const leaves = listItems.filter(
      (node) => !listItems.some((other) => other !== node && node.contains(other)),
    );
    const matched = ENABLE_CHECK_ITEMS.map((words) => {
      const found = leaves.filter((node) => {
        const own = squash(textOf(node));
        return words.every((word) => word.test(own));
      });
      expect(found, `one list item carrying ${words.map(String).join(' ')} together`).toHaveLength(
        1,
      );
      return found[0]!;
    });
    expect(new Set(matched).size, 'four separate list items, not one paragraph').toBe(4);
    for (const [index, node] of matched.entries()) {
      const own = squash(textOf(node));
      for (const [other, words] of ENABLE_CHECK_ITEMS.entries())
        if (other !== index)
          expect(
            words.every((word) => word.test(own)),
            `item ${index + 1} does not also hold item ${other + 1}`,
          ).toBe(false);
    }
    for (const words of ENABLE_CHECK_ITEMS)
      for (const word of words)
        expect(text, `the check item carries ${String(word)}`).toMatch(word);
    expect(text, 'the checks are listed, not judged').not.toMatch(
      /未满足|已满足|未通过|已通过|不满足|满足要求|✓|✗|✔|✘/,
    );
  },
);

it(
  '[AC-F1-08ap-SHOW#8] 阻断风险标签恰为 BR-WDR-29 全部 11 个标签各一个勾选框，除「命中黑名单」外都可勾；勾上此前未覆盖的「当日有入账」「60 天失效占比高」「60 天高佣占比高」「30 天提现额与 60 天确认收货返利比例异常」「收款账号曾属他人」「风险计算失败」后保存：risk_block_flags 恰为原集合加这六个 code（版本 4）',
  { timeout: FLOW_TIMEOUT },
  async () => {
    const server = serverFor();
    const panel = await openSettings(server, SUPER);
    const extra = card(panel, GROUP.extra);
    const names = Object.values(FLAG_NAME);
    expect(names, 'every BR-WDR-29 label').toHaveLength(11);
    for (const name of names) flagBox(extra, name);
    expect(
      within(extra)
        .queryAllByRole('checkbox')
        .filter((node) => isShown(node)).length,
      'no other checkbox among the flags',
    ).toBe(11);
    for (const name of names.filter((one) => one !== FLAG_NAME.blacklist_hit))
      expect(disabled(flagBox(extra, name)), `${name} can be ticked`).toBe(false);
    const added = [
      'credited_today',
      'invalid_ratio_60d',
      'high_commission_ratio_60d',
      'withdraw_vs_received',
      'payee_prev_other_user',
      'risk_calc_failed',
    ] as const;
    for (const code of added) {
      const box = flagBox(extra, FLAG_NAME[code]);
      expect(box.checked, `${code} not stored yet`).toBe(false);
      await click(box);
      expect(flagBox(extra, FLAG_NAME[code]).checked, `${code} ticked`).toBe(true);
    }
    await save(server, panel);
    const sent = batches(server);
    expect(sent).toHaveLength(1);
    const items = (sent[0]!.body as { items: BatchEntry[] }).items;
    expect(
      items.map((entry) => entry.key),
      'only the flags',
    ).toEqual([KEY.riskFlags]);
    expect(items[0]!.expected_version).toBe(VERSION.flags);
    const codes = (items[0]!.value as string[]).filter((code) => code !== 'blacklist_hit').sort();
    expect(codes).toEqual(
      [
        'credited_today',
        'had_negative',
        'high_commission_ratio_60d',
        'invalid_ratio_60d',
        'payee_prev_other_user',
        'recon_diff',
        'risk_calc_failed',
        'same_device_multi_account',
        'withdraw_vs_received',
      ].sort(),
    );
  },
);

/** Every BR-WDR-29 code a save may add (blacklist_hit is fixed and always checked). */
const OPTIONAL_FLAGS = FLAG_CODES.filter((code) => code !== 'blacklist_hit');

/** The registry with no risk flag stored (risk_block_flags = [], version 4). */
function noFlagsStored(): ConfigRow[] {
  return registry().map((row) => (row.key === KEY.riskFlags ? { ...row, value: [] } : row));
}

it(
  '[AC-F1-08ap-SHOW#9] 阻断风险标签逐个单独勾选（表驱动列全 BR-WDR-29 除「命中黑名单」外的 10 个标签，已存集合为空）：每次只勾一个、其余不勾，保存后 risk_block_flags 恰多出该标签的 code（「60 天失效占比高」→ invalid_ratio_60d、「60 天高佣占比高」→ high_commission_ratio_60d 等，版本 4）',
  { timeout: 900_000 },
  async () => {
    expect(OPTIONAL_FLAGS, 'every BR-WDR-29 label but blacklist_hit').toHaveLength(10);
    const table: readonly (readonly [(typeof OPTIONAL_FLAGS)[number], string])[] =
      OPTIONAL_FLAGS.map((code) => [code, FLAG_NAME[code]] as const);
    for (const [code, name] of table) {
      const server = serverFor({ items: noFlagsStored() });
      const panel = await openSettings(server, SUPER);
      const extra = card(panel, GROUP.extra);
      for (const other of OPTIONAL_FLAGS)
        expect(flagBox(extra, FLAG_NAME[other]).checked, `${other} not stored`).toBe(false);
      await click(flagBox(extra, name));
      for (const other of OPTIONAL_FLAGS)
        expect(flagBox(extra, FLAG_NAME[other]).checked, `only ${name} ticked (${other})`).toBe(
          other === code,
        );
      await save(server, panel);
      const sent = batches(server);
      expect(sent, `one save for ${name}`).toHaveLength(1);
      const items = (sent[0]!.body as { items: BatchEntry[] }).items;
      expect(
        items.map((entry) => entry.key),
        `only the flags for ${name}`,
      ).toEqual([KEY.riskFlags]);
      expect(items[0]!.expected_version).toBe(VERSION.flags);
      const codes = (items[0]!.value as string[]).filter((one) => one !== 'blacklist_hit');
      expect(codes, `ticking ${name} adds exactly ${code}`).toEqual([code]);
      cleanup();
    }
  },
);
