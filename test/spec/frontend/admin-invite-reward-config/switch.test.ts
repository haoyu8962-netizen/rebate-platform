// @vitest-environment jsdom
// F1-15a: growth.invite_reward.enabled on the emergency switches page — business name and the
// 「暂停后：……」 line. BR-INV-24: turning it off only stops new qualifications; qualifications
// already taken are not revoked and are still paid (stopping payouts is payout_paused).
import { cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createServer, item, rows } from '../admin-kill-switches/fixtures.ts';
import {
  button,
  click,
  confirm,
  expectText,
  loaded,
  mount,
  row,
  settled,
} from '../admin-kill-switches/helpers.ts';
import { squash } from '../admin-platform-icons/helpers.ts';
import { BIND_SWITCH, REWARD_SWITCH } from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function switchServer() {
  return createServer([
    ...rows(),
    item(BIND_SWITCH),
    item(REWARD_SWITCH, { value: false, default: false }),
  ]);
}

function cell(code: string, title: RegExp): HTMLElement {
  const current = row(code);
  const table = current.closest('table, [role="table"]');
  expect(table, 'switch table').not.toBeNull();
  const index = within(table as HTMLElement)
    .getAllByRole('columnheader')
    .findIndex((heading) => title.test(heading.textContent?.trim() ?? ''));
  expect(index, String(title)).toBeGreaterThanOrEqual(0);
  const cells = Array.from(current.querySelectorAll<HTMLElement>('td, [role="cell"]'));
  expect(cells[index]).toBeDefined();
  return cells[index]!;
}

function switchName(code: string): string {
  return squash(cell(code, /^功能/).textContent).replace(code, '');
}

const IMPACT = /^(?:暂停或开启后的)?影响$/;

function expectRewardLines(): string {
  const name = switchName(REWARD_SWITCH);
  expect(name, 'business name').toMatch(/邀请奖励/);
  expect(name).not.toMatch(/growth\.|invite_reward/);
  const impact = squash(cell(REWARD_SWITCH, IMPACT).textContent);
  expect(impact).toMatch(/^暂停后：/);
  // Stops new qualifications …
  expect(impact).toMatch(/(?:新增|新的|不再).{0,12}资格|资格.{0,6}(?:不再新增|停止新增)/);
  // … while qualifications already taken stay and are still paid.
  expect(impact).toMatch(/已(?:取得|有|锁定)(?:的)?(?:邀请奖励)?资格/);
  expect(impact).toMatch(/不撤销|不受影响|照常|照发|仍(?:会|可|按|然)/);
  return name;
}

it('[AC-F1-15a-SWITCH#1] 邀请奖励开关显示中文名称与「暂停后：」说明（只停新增资格，已有资格不撤销）', async () => {
  const { server } = await mount(switchServer());
  await loaded(REWARD_SWITCH);
  expectRewardLines();
  // The invite binding switch keeps its own name and line.
  expectText(row(BIND_SWITCH), '邀请绑定');
  expect(squash(cell(BIND_SWITCH, IMPACT).textContent)).toBe(
    '暂停后：新的邀请关系不再绑定；后台改上级不受影响',
  );
  await settled(server);
  expect(server.requests('PUT')).toEqual([]);
  expect(server.requests('POST')).toEqual([]);
});

it(
  '[AC-F1-15a-SWITCH#2] 打开邀请奖励开关的确认框用中文名称并带说明，取消不写入',
  { timeout: 40_000 },
  async () => {
    const { server } = await mount(switchServer());
    await loaded(REWARD_SWITCH);
    const name = expectRewardLines();
    const modal = await confirm(REWARD_SWITCH);
    expectText(modal, name);
    expect(squash(modal.textContent)).toMatch(/资格/);
    await click(button(modal, '取消'));
    await settled(server);
    await waitFor(() => expect(server.requests('PUT')).toEqual([]));
    expect(server.requests('POST')).toEqual([]);
  },
);
