// @vitest-environment jsdom
// DSX-51a (DSX-107, D10-1037): 【改上级】【调等级】 become unmount-style dialogs. The parent renders
// them only while open, so closing unmounts them at once whatever the overlay motion does; focus
// goes back to the trigger in code; state that must survive a close (the 30409 explanation) lives
// in the parent. The shell is mounted exactly as the frozen admin-user-relations tests mount it
// (no reduced motion, antd default motion): nothing here switches motion off.
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  InviterChangeDialog,
  LevelChangeDialog,
} from '../../../../apps/admin/src/pages/users/relations.ts';
import { errorText } from '../admin-user-relations/relations-contract.ts';
import {
  INVITER,
  LEVEL,
  NEW_PARENT,
  PARENT,
  createRelationsServer,
  failure,
} from '../admin-user-relations/relations-fixtures.ts';
import {
  FLOW_TIMEOUT,
  card,
  click,
  close,
  dialog,
  fillChange,
  inviterInput,
  openChange,
  reasonInput,
  settled,
  show,
  startVerification,
  submitChange,
  verify,
} from '../admin-user-relations/relations-helpers.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface FiberNode {
  readonly type: unknown;
  readonly child: FiberNode | null;
  readonly sibling: FiberNode | null;
}
interface HostRootFiber {
  readonly stateNode?: { readonly current?: FiberNode };
}

/** The committed trees of the React roots on the page (FiberRoot.current, never an alternate). */
function liveTrees(): FiberNode[] {
  const trees: FiberNode[] = [];
  for (const element of Array.from(document.body.children)) {
    const slot = Object.keys(element).find((name) => name.startsWith('__reactContainer$'));
    if (slot === undefined) continue;
    const host = (element as unknown as Record<string, HostRootFiber | undefined>)[slot];
    const tree = host?.stateNode?.current;
    if (tree !== undefined) trees.push(tree);
  }
  expect(trees.length, 'React root of the mounted shell').toBeGreaterThan(0);
  return trees;
}
function isComponent(type: unknown, component: unknown): boolean {
  if (type === component) return true;
  if (typeof type !== 'object' || type === null) return false;
  const wrapped = type as { readonly type?: unknown; readonly render?: unknown };
  return wrapped.type === component || wrapped.render === component;
}
/** How many instances of `component` are mounted right now. */
function mounted(component: unknown): number {
  let count = 0;
  const stack: FiberNode[] = liveTrees();
  while (stack.length > 0) {
    const fiber = stack.pop()!;
    if (isComponent(fiber.type, component)) count += 1;
    if (fiber.child !== null) stack.push(fiber.child);
    if (fiber.sibling !== null) stack.push(fiber.sibling);
  }
  return count;
}

it(
  '[AC-DSX-51a-RELATIONS#1] 改上级只在打开时挂载，取消即卸载并由代码把焦点还给触发按钮，再开是新表单',
  async () => {
    const { server } = await show();
    expect(mounted(InviterChangeDialog), 'not mounted before opening').toBe(0);
    const { trigger, modal } = await openChange('inviter');
    expect(mounted(InviterChangeDialog), 'mounted while open').toBe(1);
    await fillChange('inviter', modal);
    await close(modal);
    await waitFor(() => expect(mounted(InviterChangeDialog), 'unmounted on close').toBe(0));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await click(trigger);
    const reopened = await dialog('改上级');
    expect(mounted(InviterChangeDialog)).toBe(1);
    expect(inviterInput(reopened).value).toBe('');
    expect(reasonInput(reopened).value).toBe('');
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-DSX-51a-RELATIONS#2] 调等级只在打开时挂载，取消即卸载并由代码把焦点还给触发按钮，再开是新表单',
  async () => {
    const { server } = await show();
    expect(mounted(LevelChangeDialog), 'not mounted before opening').toBe(0);
    const { trigger, modal } = await openChange('level');
    expect(mounted(LevelChangeDialog), 'mounted while open').toBe(1);
    await fillChange('level', modal);
    await close(modal);
    await waitFor(() => expect(mounted(LevelChangeDialog), 'unmounted on close').toBe(0));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await click(trigger);
    const reopened = await dialog('调等级');
    expect(mounted(LevelChangeDialog)).toBe(1);
    expect(reasonInput(reopened).value).toBe('');
    await settled(server);
    expect(server.requests('POST')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-DSX-51a-RELATIONS#3] 改上级保存成功后对话框卸载，焦点回到触发按钮',
  async () => {
    const { server } = await show();
    const { trigger, modal } = await openChange('inviter');
    await fillChange('inviter', modal);
    await verify(await startVerification(modal), true);
    await waitFor(() => expect(card('上级与直推').textContent).toContain(NEW_PARENT));
    await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0));
    await waitFor(() => expect(mounted(InviterChangeDialog), 'unmounted after saving').toBe(0));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await settled(server);
    expect(server.requests('POST', INVITER)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-DSX-51a-RELATIONS#4] 调等级保存成功后对话框卸载，焦点回到触发按钮',
  async () => {
    const { server } = await show();
    const { trigger, modal } = await openChange('level');
    await fillChange('level', modal);
    await verify(await startVerification(modal), true);
    await waitFor(() => expect(card('基本信息').textContent).toContain('L3'));
    await waitFor(() => expect(screen.queryAllByRole('dialog')).toHaveLength(0));
    await waitFor(() => expect(mounted(LevelChangeDialog), 'unmounted after saving').toBe(0));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await settled(server);
    expect(server.requests('POST', LEVEL)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-DSX-51a-RELATIONS#5] 30409 说明由父组件保存：对话框关闭卸载后再开仍只给说明',
  async () => {
    const server = createRelationsServer();
    server.once('POST', INVITER, () => failure(30409));
    await show(server);
    const { trigger, modal } = await openChange('inviter');
    await fillChange('inviter', modal);
    await submitChange(modal);
    const explanation = await dialog('改上级');
    await waitFor(() => expect(explanation.textContent).toContain(errorText(30409)));
    await close(explanation);
    await waitFor(() => expect(mounted(InviterChangeDialog), 'unmounted on close').toBe(0));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await click(trigger);
    const reopened = await dialog('改上级');
    expect(mounted(InviterChangeDialog)).toBe(1);
    expect(reopened.textContent).toContain(errorText(30409));
    expect(within(reopened).queryAllByRole('textbox')).toEqual([]);
    await settled(server);
    expect(server.requests('POST', INVITER)).toHaveLength(1);
    expect(card('上级与直推').textContent).toContain(PARENT);
  },
  FLOW_TIMEOUT,
);
