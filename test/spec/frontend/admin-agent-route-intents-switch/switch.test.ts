// @vitest-environment jsdom
// F1-10kb (D10-1322 / D10-1329): agent.degraded.route_intents on the emergency switches page —
// business name and the 「暂停后：……」 line. 08 BR-AI-14 细则「无模型降级」: off means no routing
// by the way the question is asked and no condition extraction; everything except links and
// pasted codes goes back to keyword search. The AI assistant stays on and still searches.
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

const ROUTE_SWITCH = 'agent.degraded.route_intents';
const PAGE_GUIDE = 'agent.page_guide.enabled';
const IMPACT = /^(?:暂停或开启后的)?影响$/;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Server rows as registered by B1-22y: default on, boolean, switch.all only, editable. */
function switchServer() {
  return createServer([...rows(), item(PAGE_GUIDE), item(ROUTE_SWITCH)]);
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

function impactText(code: string): string {
  return squash(cell(code, IMPACT).textContent);
}

/** Checks the meaning of the impact line (not its exact wording). */
function expectRouteImpact(impact: string): void {
  expect(impact).toMatch(/^暂停后：/);
  // No more routing by the way the question is asked …
  expect(impact, 'stops routing by question type').toMatch(
    /(?:不再?|停止|取消|不做)[^；;。]{0,8}分流|分流[^；;。]{0,6}(?:停止|关闭|取消)/,
  );
  // … and everything except links and pasted codes goes to keyword search.
  expect(impact, 'keyword search for everything else').toMatch(/关键词搜索/);
  expect(impact, 'links and codes are the exception').toMatch(
    /(?:链接|口令)[^；;。]{0,6}(?:链接|口令)[^；;。]{0,4}(?:以外|之外|外)/,
  );
  expect(impact, 'everything else').toMatch(/(?:一律|都|全部|均|统一)[^；;。]{0,6}关键词搜索/);
  // Must not read as if the AI assistant closes or stops searching.
  expect(impact, 'assistant stays on').not.toMatch(
    /(?:AI|助手)[^；;。]{0,8}(?:关闭|停用|下线|不可用)/,
  );
  expect(impact, 'search keeps running').not.toMatch(
    /(?:停止|不再|暂停|关闭)(?:关键词)?搜索|搜索[^；;。]{0,4}(?:停止|关闭|暂停)/,
  );
}

function expectRouteLines(): string {
  const name = switchName(ROUTE_SWITCH);
  expect(name, 'business name in Chinese').toMatch(/[一-鿿]/u);
  expect(name, 'name is not the raw code').not.toMatch(/agent\.|degraded|route_intents/);
  expect(name, 'name speaks of AI').toMatch(/AI|助手/);
  expect(name, 'name speaks of the no-model degradation').toMatch(/无模型|降级/);
  expect(name, 'name speaks of routing by question type').toMatch(/问法|分流/);
  expectRouteImpact(impactText(ROUTE_SWITCH));
  return name;
}

it('[AC-F1-10kb-SWITCH#1] 无模型降级问法分流开关显示中文名称与「暂停后：」说明（不再分流，链接口令以外一律关键词搜索），其他开关的名称与说明不变', async () => {
  const { server } = await mount(switchServer());
  await loaded(ROUTE_SWITCH);
  expectRouteLines();
  // The neighbouring switches keep their own names and lines.
  expect(switchName('agent.enabled')).toBe('AI助手');
  expect(impactText('agent.enabled')).toBe('暂停后：AI助手对所有用户关闭');
  expect(switchName(PAGE_GUIDE)).toBe('AI页面引导');
  expect(impactText(PAGE_GUIDE)).toBe('暂停后：页面内不再显示AI引导入口');
  expect(switchName('parse.tpwd.enabled')).toBe('口令解析');
  expect(impactText('parse.tpwd.enabled')).toBe('暂停后：粘贴的口令不再解析，降级为按标题搜索');
  await settled(server);
  expect(server.requests('PUT')).toEqual([]);
  expect(server.requests('POST')).toEqual([]);
});

it(
  '[AC-F1-10kb-SWITCH#2] 暂停问法分流开关的确认框用中文名称并带说明，取消不写入',
  { timeout: 40_000 },
  async () => {
    const { server } = await mount(switchServer());
    await loaded(ROUTE_SWITCH);
    const name = expectRouteLines();
    const modal = await confirm(ROUTE_SWITCH);
    expectText(modal, name);
    expect(squash(modal.textContent)).toMatch(/分流/);
    expect(squash(modal.textContent)).toMatch(/关键词搜索/);
    await click(button(modal, '取消'));
    await settled(server);
    await waitFor(() => expect(server.requests('PUT')).toEqual([]));
    expect(server.requests('POST')).toEqual([]);
  },
);
