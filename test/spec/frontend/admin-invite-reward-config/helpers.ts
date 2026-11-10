// Shared fixtures and flows for the invite reward items (BR-INV-24) in the configuration center
// and the emergency switches page. Rows are contract-shaped and built here; the page under test
// is mounted through the frozen helpers of admin-config-center / admin-kill-switches.
import { waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';
import {
  LIST,
  TARGET,
  createServer,
  item,
  type ConfigRow,
  type Server,
} from '../admin-config-center/fixtures.ts';
import {
  button,
  click,
  column,
  drawer,
  editButton,
  mainElement,
  numberValue,
  reason,
  settled,
} from '../admin-config-center/helpers.ts';
import { squash } from '../admin-platform-icons/helpers.ts';

export const AMOUNT = 'growth.invite_reward.amount_fen';
export const DAILY = 'growth.invite_reward.daily_budget_fen';
export const TOTAL = 'growth.invite_reward.total_budget_fen';
export const MIN_PAID = 'growth.invite_reward.min_paid_fen';
export const IP_WINDOW = 'growth.invite_reward.ip_window_hours';
export const ELIGIBILITY = 'growth.invite_reward.eligibility_days';
export const MONEY_ITEMS = [AMOUNT, DAILY, TOTAL, MIN_PAID] as const;
export const REWARD_ITEMS = [AMOUNT, DAILY, TOTAL, MIN_PAID, IP_WINDOW, ELIGIBILITY] as const;
/** An existing invite.* item (config-registry) that already sits in the invite group. */
export const INVITE_NEIGHBOUR = 'invite.bind_phone_guide';
export const REWARD_SWITCH = 'growth.invite_reward.enabled';
export const BIND_SWITCH = 'growth.invite_bind.enabled';

/** Values follow the BR-INV-24 example; permissions follow the backend registry. */
export const VALUES: Readonly<Record<(typeof REWARD_ITEMS)[number], number>> = {
  [AMOUNT]: 1000,
  [DAILY]: 20000,
  [TOTAL]: 100000,
  [MIN_PAID]: 0,
  [IP_WINDOW]: 24,
  [ELIGIBILITY]: 30,
};

/** What each item's business name must speak of (BR-INV-24 wording), not an exact text. */
export const NAME_PATTERNS: Readonly<Record<(typeof REWARD_ITEMS)[number], RegExp>> = {
  [AMOUNT]: /金额|每方|各得/,
  [DAILY]: /日.*预算|预算.*日/,
  [TOTAL]: /总.*预算|预算.*总/,
  [MIN_PAID]: /实付/,
  [IP_WINDOW]: /IP/i,
  [ELIGIBILITY]: /有效期|资格/,
};

export const POSITIVE_INTEGER_MESSAGE =
  /正整数|整数|大于\s*0|至少\s*1|不能小于\s*1|不得小于\s*1|≥\s*1/;

export function rewardRows(): ConfigRow[] {
  return [
    item(TARGET),
    item(INVITE_NEIGHBOUR, { value: true, value_type: 'boolean', permission: 'config.general' }),
    item(AMOUNT, { value: VALUES[AMOUNT] }),
    item(DAILY, { value: VALUES[DAILY] }),
    item(TOTAL, { value: VALUES[TOTAL] }),
    item(MIN_PAID, { value: VALUES[MIN_PAID] }),
    item(IP_WINDOW, { value: VALUES[IP_WINDOW], permission: 'config.risk' }),
    item(ELIGIBILITY, { value: VALUES[ELIGIBILITY] }),
  ];
}

export function rewardServer(): Server {
  return createServer(rewardRows());
}

export function shown(code: string): boolean {
  return within(mainElement()).queryByText(code, { exact: true }) !== null;
}

/** Group navigation entries (menu items or tabs) whose text matches. */
export function groupEntries(pattern: RegExp): HTMLElement[] {
  return ['menuitem', 'tab']
    .flatMap((role) => within(mainElement()).queryAllByRole(role))
    .filter((node) => pattern.test(node.textContent ?? ''));
}

/** Selects the group named with 「邀请」 that lists all six invite reward items together. */
export async function openInviteGroup(server: Server): Promise<void> {
  await waitFor(() => expect(server.requests('GET', LIST).length).toBeGreaterThan(0));
  await settled(server);
  await waitFor(() => expect(groupEntries(/邀请/).length).toBeGreaterThan(0));
  const count = groupEntries(/邀请/).length;
  for (let index = 0; index < count; index += 1) {
    const entry = groupEntries(/邀请/)[index];
    if (entry === undefined) break;
    await click(entry);
    await settled(server);
    if (REWARD_ITEMS.every(shown)) return;
  }
  expect(
    REWARD_ITEMS.filter((code) => !shown(code)),
    'all six invite reward items listed together under one group named with 邀请',
  ).toEqual([]);
}

/** The business name shown in the row's item cell (the cell text without the raw code). */
export function nameText(code: string): string {
  return squash(column(code, /配置项/).textContent).replace(code, '');
}

export function expectName(code: (typeof REWARD_ITEMS)[number]): string {
  const name = nameText(code);
  expect(name, `business name of ${code}`).toMatch(/[一-鿿]/u);
  expect(name, `name of ${code} is not the raw code`).not.toMatch(/growth\.|invite_reward/);
  expect(name, `name of ${code}`).toMatch(NAME_PATTERNS[code]);
  return name;
}

export async function openRewardEditor(server: Server, code: string): Promise<HTMLElement> {
  await openInviteGroup(server);
  await click(editButton(code));
  return drawer();
}

/** Types the new value and a reason in the drawer, then presses 保存 / 验证并保存. */
export async function fill(edit: HTMLElement, typed: string): Promise<void> {
  await numberValue(edit, typed);
  await reason(edit);
  await click(button(edit, /保存/));
}

/** Waits for a form error (antd role=alert) inside the drawer that matches the pattern. */
export async function refused(edit: HTMLElement, pattern: RegExp): Promise<void> {
  await waitFor(() =>
    expect(
      within(edit)
        .queryAllByRole('alert')
        .map((node) => node.textContent ?? '')
        .join(' '),
    ).toMatch(pattern),
  );
}
