// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { card } from '../admin-payouts-readonly/helpers.ts';
import {
  BUSINESS_GRANTS,
  ENABLE_CHECK_TITLE,
  ENABLE_CHECK_WORDS,
  EXTRA_NOTE,
  FLAG_NAME,
  GROUP,
  LABEL,
  MASTER_SHOWN,
  NO_AUTO,
  NO_PERMISSION_TO_VIEW,
  SAMPLE,
  SUPER,
  SWITCH_ENTRY,
  UNSET,
  accountOf,
  fenOfShown,
  serverFor,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  MULTI_TIMEOUT,
  buttons,
  disabled,
  flagBox,
  handlersWithoutRole,
  input,
  isShown,
  openSettings,
  settled,
  squash,
  switchReads,
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
