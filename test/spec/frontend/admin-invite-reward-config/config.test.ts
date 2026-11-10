// @vitest-environment jsdom
// F1-15a: the six growth.invite_reward.* items (BR-INV-24, seeds 0001) in the configuration
// center: business names, the invite group, amounts in yuan (integer fen sent), hours and days.
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { formatYuanAdmin } from '../../../../packages/money/src/index.ts';
import { LIST, REASON } from '../admin-config-center/fixtures.ts';
import {
  approve,
  click,
  column,
  confirmation,
  dialog,
  expectText,
  mainElement,
  mount,
  settled,
  verify,
} from '../admin-config-center/helpers.ts';
import {
  AMOUNT,
  DAILY,
  ELIGIBILITY,
  IP_WINDOW,
  MIN_PAID,
  MONEY_ITEMS,
  POSITIVE_INTEGER_MESSAGE,
  REWARD_ITEMS,
  TOTAL,
  VALUES,
  expectName,
  fill,
  groupEntries,
  openInviteGroup,
  openRewardEditor,
  refused,
  rewardServer,
  shown,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function savedValue(
  code: (typeof REWARD_ITEMS)[number],
  typed: string,
  expected: number,
): Promise<void> {
  const server = rewardServer();
  await mount(server);
  const edit = await openRewardEditor(server, code);
  // The drawer is titled with the business name, not the raw code.
  expectText(edit, expectName(code));
  await fill(edit, typed);
  const confirm = await confirmation();
  expect(server.requests('PUT')).toEqual([]);
  await approve(confirm);
  await verify(await dialog('二次验证 · 动态码'));
  await waitFor(() => expect(server.requests('PUT')).toHaveLength(1));
  const request = server.requests('PUT')[0]!;
  expect(request.path).toBe(`${LIST}/${code}`);
  expect(request.body).toEqual({ value: expected, expected_version: 3, reason: REASON });
  expect(Number.isSafeInteger((request.body as { value: unknown }).value)).toBe(true);
  await settled(server);
  expect(server.requests('PUT')).toHaveLength(1);
}

async function refusesNonPositive(code: typeof IP_WINDOW | typeof ELIGIBILITY): Promise<void> {
  const server = rewardServer();
  await mount(server);
  const edit = await openRewardEditor(server, code);
  expectText(edit, expectName(code));
  for (const typed of ['0', '-1', '1.5']) {
    await fill(edit, typed);
    await settled(server);
    await refused(edit, POSITIVE_INTEGER_MESSAGE);
    // Only the drawer is open: no confirmation and no step-up for a refused value.
    expect(screen.queryAllByRole('dialog'), typed).toHaveLength(1);
    expect(server.requests('PUT'), typed).toEqual([]);
    expect(server.requests('POST'), typed).toEqual([]);
  }
  expect(column(code, /当前值/).textContent).toMatch(new RegExp(`${VALUES[code]}`));
}

it('[AC-F1-15a-CONFIG#1] 六项邀请奖励配置都有各自的中文名称，不以原始键作名称', async () => {
  const { server } = await mount(rewardServer());
  await openInviteGroup(server);
  const names = REWARD_ITEMS.map((code) => expectName(code));
  expect(new Set(names).size).toBe(REWARD_ITEMS.length);
  for (const code of REWARD_ITEMS) expect(shown(code), code).toBe(true);
  await settled(server);
  expect(server.requests('PUT')).toEqual([]);
  expect(server.requests('POST')).toEqual([]);
});

it('[AC-F1-15a-CONFIG#2] 六项同在名称含「邀请」的分组，不落入「其他」，IP 时长也不归风控阈值', async () => {
  const { server } = await mount(rewardServer());
  await openInviteGroup(server);
  expect(
    within(mainElement())
      .queryAllByRole('heading')
      .some((node) => /邀请/.test(node.textContent ?? '')),
    'selected group heading names 邀请',
  ).toBe(true);
  expect(groupEntries(/其他/), 'no 其他 group for these rows').toEqual([]);
  const risk = groupEntries(/风控阈值/);
  expect(risk).toHaveLength(1);
  await click(risk[0]!);
  await settled(server);
  expect(shown(IP_WINDOW)).toBe(false);
  for (const code of REWARD_ITEMS) expect(shown(code), code).toBe(false);
});

it('[AC-F1-15a-CONFIG#3] 四个金额项按后台金额格式显示（整数分→元），预算 0 不写成不限', async () => {
  const { server } = await mount(rewardServer());
  await openInviteGroup(server);
  for (const code of MONEY_ITEMS) {
    expectName(code);
    const current = column(code, /当前值/);
    expectText(current, formatYuanAdmin(BigInt(VALUES[code])));
    expect(column(code, /类型/).textContent, code).toMatch(/金额/);
  }
  for (const code of [DAILY, TOTAL])
    expect(column(code, /当前值/).textContent, code).not.toMatch(/不限|无上限|无限/);
});

it('[AC-F1-15a-CONFIG#4] IP 时长按小时、资格有效期按天显示', async () => {
  const { server } = await mount(rewardServer());
  await openInviteGroup(server);
  expectName(IP_WINDOW);
  expectName(ELIGIBILITY);
  expect(column(IP_WINDOW, /当前值/).textContent).toMatch(/24\s*小时/);
  expect(column(ELIGIBILITY, /当前值/).textContent).toMatch(/30\s*天/);
  for (const code of [IP_WINDOW, ELIGIBILITY])
    expect(column(code, /类型/).textContent, code).not.toMatch(/金额/);
});

it(
  '[AC-F1-15a-CONFIG#5] 每方奖励金额以元输入 12.34，提交整数分 1234',
  { timeout: 40_000 },
  async () => {
    await savedValue(AMOUNT, '12.34', 1234);
  },
);

it(
  '[AC-F1-15a-CONFIG#6] 每日预算以元输入 0，提交整数分 0（0 即未填，前端不拒）',
  { timeout: 40_000 },
  async () => {
    await savedValue(DAILY, '0', 0);
  },
);

it(
  '[AC-F1-15a-CONFIG#7] 总预算以元输入 5000.5，提交整数分 500050',
  { timeout: 40_000 },
  async () => {
    await savedValue(TOTAL, '5000.5', 500050);
  },
);

it(
  '[AC-F1-15a-CONFIG#8] 首单实付下限以元输入 0.01，提交整数分 1',
  { timeout: 40_000 },
  async () => {
    await savedValue(MIN_PAID, '0.01', 1);
  },
);

it(
  '[AC-F1-15a-CONFIG#9] 金额项三位小数或负数被拒，不取整、不确认、不写入',
  { timeout: 40_000 },
  async () => {
    const server = rewardServer();
    await mount(server);
    const edit = await openRewardEditor(server, AMOUNT);
    expectText(edit, expectName(AMOUNT));
    for (const typed of ['12.345', '-1']) {
      await fill(edit, typed);
      await settled(server);
      await refused(edit, /小数|精确到分|负数|有效金额/);
      expect(screen.queryAllByRole('dialog'), typed).toHaveLength(1);
      expect(server.requests('PUT'), typed).toEqual([]);
      expect(server.requests('POST'), typed).toEqual([]);
    }
    expectText(column(AMOUNT, /当前值/), formatYuanAdmin(1000n));
  },
);

it(
  '[AC-F1-15a-CONFIG#10] IP 时长按小时编辑，输入 48 提交整数 48',
  { timeout: 40_000 },
  async () => {
    await savedValue(IP_WINDOW, '48', 48);
  },
);

it(
  '[AC-F1-15a-CONFIG#11] 资格有效期按天编辑，输入 45 提交整数 45',
  { timeout: 40_000 },
  async () => {
    await savedValue(ELIGIBILITY, '45', 45);
  },
);

it(
  '[AC-F1-15a-CONFIG#12] IP 时长输入 0、-1、1.5 被拒（须正整数），不确认、不写入',
  { timeout: 60_000 },
  async () => {
    await refusesNonPositive(IP_WINDOW);
  },
);

it(
  '[AC-F1-15a-CONFIG#13] 资格有效期输入 0、-1、1.5 被拒（须正整数），不确认、不写入',
  { timeout: 60_000 },
  async () => {
    await refusesNonPositive(ELIGIBILITY);
  },
);
