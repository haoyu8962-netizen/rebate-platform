// @vitest-environment jsdom
// DSX-48d (编排 D10-1032 ⑤): closing a Dialog / Sheet plays an exit motion, and the frame never
// waits for transitionend / animationend to finish closing — jsdom never fires them. Measured
// here on a fake clock:
// - at once, in the same commit that closes: the modal leaves the accessibility tree (no role
//   "dialog" for queries), focus is back on the opener and onClose was called once (as the frozen
//   F1-01f-MODAL tests already require);
// - the closing layer is still in its portal container while its exit motion runs (the visible
//   slide / fade of the browser tests), and it no longer reacts: clicks on its buttons or backdrop
//   and Escape call nothing;
// - once the fake clock passed --motion-duration-emphasized (the enter duration; the exit is
//   shorter), the container is empty — driven by timers only;
// - opening again during the exit gives exactly one live modal with focus on its title, and
//   the old exit never steals focus or removes it; unmounting during the exit removes everything
//   at once without errors.
import { act, cleanup, render, screen } from '@testing-library/react';
import { motionDurationEmphasizedMs } from '@couli/ui-tokens';
import { createElement, Fragment, useState, type ComponentType, type ReactElement } from 'react';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { Dialog, Sheet, type ModalProps } from '../../../../apps/h5/src/components/base/index.ts';
import { BACKDROP } from './contract.ts';

/** Every clock a timer-driven exit could read is fake; microtasks stay real. */
const FAKE_CLOCKS = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'Date',
  'performance',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const;

const OPEN = 'Open fixture';
const TITLE = 'Fixture title';
const CLOSE = 'Fixture close';
const CONFIRM = 'Fixture confirm';

type Modal = ComponentType<ModalProps>;

const MODALS: readonly (readonly [string, Modal])[] = [
  ['Dialog', Dialog],
  ['Sheet', Sheet],
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE_CLOCKS] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

interface Mounted {
  opener: HTMLElement;
  /** The modal's portal container. */
  portal: HTMLElement;
  onClose: Mock<() => void>;
  primary: Mock<() => void>;
  /** The caller sets `open` directly (not through onClose). */
  setOpen: (open: boolean) => void;
  unmount: () => void;
}

function mount(modal: Modal): Mounted {
  const portal = document.createElement('div');
  document.body.append(portal);
  const onClose = vi.fn<() => void>();
  const primary = vi.fn<() => void>();
  const controls = { setOpen: (open: boolean): void => void open };
  function Harness(): ReactElement {
    const [open, setOpen] = useState(false);
    controls.setOpen = setOpen;
    return createElement(
      Fragment,
      null,
      createElement('button', { type: 'button', onClick: () => setOpen(true) }, OPEN),
      createElement(
        modal,
        {
          open,
          title: TITLE,
          closeLabel: CLOSE,
          portalContainer: portal,
          onClose: () => {
            onClose();
            setOpen(false);
          },
          primaryAction: { label: CONFIRM, onClick: primary },
        },
        createElement('p', null, 'Fixture body'),
      ),
    );
  }
  const view = render(createElement(Harness));
  return {
    opener: screen.getByRole('button', { name: OPEN }),
    portal,
    onClose,
    primary,
    setOpen: (open) => {
      act(() => controls.setOpen(open));
    },
    unmount: () => view.unmount(),
  };
}

/** Opens with the opener focused, like a tap on it. */
function open(mounted: Mounted): void {
  act(() => {
    mounted.opener.focus();
    mounted.opener.click();
  });
  expect(screen.getAllByRole('dialog', { name: TITLE })).toHaveLength(1);
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: TITLE }));
}

/** Right after closing: gone for assistive technology, focus returned, layer kept for the exit. */
function expectClosingKept(mounted: Mounted, what: string): void {
  expect(screen.queryByRole('dialog'), `${what}: leaves the accessibility tree at once`).toBeNull();
  expect(document.activeElement, `${what}: focus back on the opener at once`).toBe(mounted.opener);
  expect(
    mounted.portal.childElementCount,
    `${what}: the closing layer stays in its container while the exit motion runs`,
  ).toBeGreaterThan(0);
}

/** The closing layer reacts to nothing: its buttons, its backdrop, Escape. */
function expectClosingInert(mounted: Mounted, what: string): void {
  const calls = mounted.onClose.mock.calls.length;
  for (const element of mounted.portal.querySelectorAll<HTMLElement>(`button, ${BACKDROP}`)) {
    act(() => element.click());
  }
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  expect(mounted.onClose, `${what}: the closing layer does not close again`).toHaveBeenCalledTimes(
    calls,
  );
  expect(mounted.primary, `${what}: the closing layer runs no action`).not.toHaveBeenCalled();
  expect(document.activeElement, `${what}: focus stays on the opener`).toBe(mounted.opener);
}

/** Runs the fake clock through the enter duration (the exit is shorter); no end event is fired. */
async function passExit(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(motionDurationEmphasizedMs);
  });
}

function expectRemoved(mounted: Mounted, what: string): void {
  expect(
    mounted.portal.childElementCount,
    `${what}: removed by timers alone, without transitionend / animationend`,
  ).toBe(0);
  expect(document.activeElement, `${what}: focus still on the opener`).toBe(mounted.opener);
}

it('[AC-DSX-48d-CLOSE#1] Dialog 点关闭按钮：立即退出无障碍树、焦点回到打开者、onClose 一次；退出层留在容器里播退出且不再响应点击与 Esc；不靠 transitionend，假时钟走过 --motion-duration-emphasized 后移除', async () => {
  const mounted = mount(Dialog);
  open(mounted);
  act(() => screen.getByRole('button', { name: CLOSE }).click());
  expect(mounted.onClose).toHaveBeenCalledTimes(1);
  expectClosingKept(mounted, 'Dialog close button');
  expectClosingInert(mounted, 'Dialog close button');
  await passExit();
  expectRemoved(mounted, 'Dialog close button');
  expect(mounted.onClose).toHaveBeenCalledTimes(1);
});

it('[AC-DSX-48d-CLOSE#2] Sheet 点遮罩：立即退出无障碍树、焦点回到打开者、onClose 一次；退出层留在容器里播退出且不再响应点击与 Esc；不靠 transitionend，假时钟走过 --motion-duration-emphasized 后移除', async () => {
  const mounted = mount(Sheet);
  open(mounted);
  const backdrop = mounted.portal.querySelector<HTMLElement>(BACKDROP);
  expect(backdrop, BACKDROP).not.toBeNull();
  act(() => backdrop!.click());
  expect(mounted.onClose).toHaveBeenCalledTimes(1);
  expectClosingKept(mounted, 'Sheet backdrop');
  expectClosingInert(mounted, 'Sheet backdrop');
  await passExit();
  expectRemoved(mounted, 'Sheet backdrop');
  expect(mounted.onClose).toHaveBeenCalledTimes(1);
});

it('[AC-DSX-48d-CLOSE#3] Dialog 与 Sheet 由调用方直接置 open=false：同样立即退出无障碍树并还焦点，退出层留到假时钟走过 --motion-duration-emphasized 后移除，onClose 不被调用', async () => {
  for (const [name, modal] of MODALS) {
    const mounted = mount(modal);
    open(mounted);
    mounted.setOpen(false);
    expectClosingKept(mounted, `${name} open=false`);
    await passExit();
    expectRemoved(mounted, `${name} open=false`);
    expect(mounted.onClose, `${name}: closed by the caller`).not.toHaveBeenCalled();
    cleanup();
    document.body.replaceChildren();
  }
});

it('[AC-DSX-48d-CLOSE#4] Dialog 与 Sheet 退出中再次打开：只有一个可用弹层且焦点在其标题；旧的退出走完后不抢焦点、不移除新弹层', async () => {
  for (const [name, modal] of MODALS) {
    const mounted = mount(modal);
    open(mounted);
    act(() => screen.getByRole('button', { name: CLOSE }).click());
    expectClosingKept(mounted, `${name} before reopening`);
    open(mounted);
    await passExit();
    expect(
      screen.getAllByRole('dialog', { name: TITLE }),
      `${name}: one live modal after the old exit`,
    ).toHaveLength(1);
    expect(
      mounted.portal.querySelectorAll(BACKDROP),
      `${name}: one backdrop after the old exit`,
    ).toHaveLength(1);
    expect(document.activeElement, `${name}: focus stays on the reopened title`).toBe(
      screen.getByRole('heading', { name: TITLE }),
    );
    expect(mounted.onClose).toHaveBeenCalledTimes(1);
    cleanup();
    document.body.replaceChildren();
  }
});

it('[AC-DSX-48d-CLOSE#5] Dialog 与 Sheet 退出中卸载：退出层立即清掉，之后计时器到点也不报错', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const [name, modal] of MODALS) {
    const mounted = mount(modal);
    open(mounted);
    act(() => screen.getByRole('button', { name: CLOSE }).click());
    expectClosingKept(mounted, `${name} before unmounting`);
    mounted.unmount();
    expect(mounted.portal.childElementCount, `${name}: nothing left after unmounting`).toBe(0);
    await passExit();
    expect(mounted.portal.childElementCount, `${name}: still nothing after the timers`).toBe(0);
    cleanup();
    document.body.replaceChildren();
  }
  expect(errors).not.toHaveBeenCalled();
});
