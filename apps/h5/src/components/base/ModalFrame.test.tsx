// Focus return with a real caller layout: the background is `inert` while a modal is open, and
// the modal is either unmounted (`{open && <Dialog open />}`) or switched to open=false.
//
// jsdom does not block focus on inert elements, so `focus()` is wrapped to refuse elements inside
// `[inert]`, as browsers do. This models the refusal only; React's commit order and the inert
// attribute updates are the real ones.
import { useState, type ComponentType, type ReactElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog.tsx';
import { Sheet } from './Sheet.tsx';
import type { ModalProps } from './types.ts';

const nativeFocus = HTMLElement.prototype.focus;

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    if (this.closest('[inert]') !== null) return;
    nativeFocus.call(this, options);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

/** Let the post-commit microtask and the next-frame retry run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

type Mode = 'unmount' | 'open=false';

function Harness(props: {
  Component: ComponentType<ModalProps>;
  mode: Mode;
  onCloseFocus?: () => void;
}): ReactElement {
  const { Component, mode, onCloseFocus } = props;
  const [open, setOpen] = useState(false);
  const modal = (
    <Component
      open={open}
      title="Modal title"
      closeLabel="Close modal"
      onClose={() => {
        setOpen(false);
        onCloseFocus?.();
      }}
    />
  );
  return (
    <div>
      <main inert={open}>
        <button type="button" onClick={() => setOpen(true)}>
          Opener
        </button>
      </main>
      <button type="button">Outside</button>
      {mode === 'unmount' ? open && modal : modal}
    </div>
  );
}

const COMPONENTS = [
  ['Dialog', Dialog],
  ['Sheet', Sheet],
] as const;
const MODES: Mode[] = ['unmount', 'open=false'];

describe.each(COMPONENTS)('%s', (_name, Component) => {
  it('refuses focus inside inert (test double sanity check)', () => {
    render(<Harness Component={Component} mode="unmount" />);
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.closest('main')!.setAttribute('inert', '');
    opener.focus();
    expect(document.activeElement).not.toBe(opener);
  });

  it.each(MODES)(
    'returns focus to the opener behind inert (%s, Escape and close)',
    async (mode) => {
      const user = userEvent.setup();
      render(<Harness Component={Component} mode={mode} />);
      const opener = screen.getByRole('button', { name: 'Opener' });

      await user.click(opener);
      expect(opener.closest('main')!.hasAttribute('inert')).toBe(true);
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Modal title' }));
      await user.keyboard('{Escape}');
      await settle();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(opener.closest('main')!.hasAttribute('inert')).toBe(false);
      expect(document.activeElement).toBe(opener);

      await user.click(opener);
      await user.click(screen.getByRole('button', { name: 'Close modal' }));
      await settle();
      expect(document.activeElement).toBe(opener);
    },
  );

  it.each(MODES)('leaves focus the caller moved on close (%s)', async (mode) => {
    const user = userEvent.setup();
    const onCloseFocus = () => screen.getByRole('button', { name: 'Outside' }).focus();
    render(<Harness Component={Component} mode={mode} onCloseFocus={onCloseFocus} />);
    await user.click(screen.getByRole('button', { name: 'Opener' }));
    await user.keyboard('{Escape}');
    await settle();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Outside' }));
  });
});

function Swap(): ReactElement {
  const [step, setStep] = useState<'none' | 'first' | 'second'>('none');
  return (
    <div>
      <main inert={step !== 'none'}>
        <button type="button" onClick={() => setStep('first')}>
          Opener
        </button>
      </main>
      {step === 'first' && (
        <Dialog
          open
          title="First"
          closeLabel="Close first"
          onClose={() => setStep('none')}
          primaryAction={{ label: 'Next', onClick: () => setStep('second') }}
        />
      )}
      {step === 'second' && (
        <Sheet open title="Second" closeLabel="Close second" onClose={() => setStep('none')} />
      )}
    </div>
  );
}

it('does not pull focus out of a modal opened in the same render that closed another', async () => {
  const user = userEvent.setup();
  render(<Swap />);
  await user.click(screen.getByRole('button', { name: 'Opener' }));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await settle();
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Second' }));
  await user.keyboard('{Escape}');
  await settle();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Opener' }));
});

function Nested(props: { onOuterClose: () => void }): ReactElement {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  return (
    <div>
      <main inert={outer}>
        <button
          type="button"
          onClick={() => {
            setOuter(true);
            setInner(true);
          }}
        >
          Opener
        </button>
      </main>
      <Dialog
        open={outer}
        title="Outer"
        closeLabel="Close outer"
        onClose={() => {
          props.onOuterClose();
          setOuter(false);
        }}
      >
        <Sheet
          open={inner}
          title="Inner"
          closeLabel="Close inner"
          onClose={() => setInner(false)}
        />
      </Dialog>
    </div>
  );
}

it('stacks a nested modal opened in the same render above its parent', async () => {
  const user = userEvent.setup();
  const onOuterClose = vi.fn();
  render(<Nested onOuterClose={onOuterClose} />);
  await user.click(screen.getByRole('button', { name: 'Opener' }));
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Inner' }));

  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close inner' }));
  await user.keyboard('{Escape}');
  await settle();
  expect(onOuterClose).not.toHaveBeenCalled();
  expect(screen.queryByRole('heading', { name: 'Inner' })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Outer' }));

  await user.keyboard('{Escape}');
  await settle();
  expect(onOuterClose).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Opener' }));
});

/** Like the earnings page: one piece of state drives both `open` and the content. */
function ClearsOnClose(props: { Component: ComponentType<ModalProps> }): ReactElement {
  const { Component } = props;
  const [note, setNote] = useState<{ title: string; body: string } | null>(null);
  return (
    <div>
      <button type="button" onClick={() => setNote({ title: 'First', body: 'First body' })}>
        Open first
      </button>
      <button type="button" onClick={() => setNote({ title: 'Second', body: 'Second body' })}>
        Open second
      </button>
      <Component
        open={note !== null}
        title={note?.title ?? ''}
        description={note?.body ?? ''}
        closeLabel="Close"
        onClose={() => setNote(null)}
        {...(note === null
          ? {}
          : { primaryAction: { label: `OK ${note.title}`, onClick: () => setNote(null) } })}
      >
        {note === null ? null : <span>{`${note.title} child`}</span>}
      </Component>
    </div>
  );
}

describe.each(COMPONENTS)('%s exit content', (_name, Component) => {
  it('keeps showing the last open content while exiting when the caller clears it', async () => {
    const user = userEvent.setup();
    render(<ClearsOnClose Component={Component} />);
    await user.click(screen.getByRole('button', { name: 'Open first' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));

    const layer = document.body.querySelector('[data-state="closed"]');
    expect(layer).not.toBeNull();
    expect(layer?.getAttribute('aria-hidden')).toBe('true');
    expect(layer?.hasAttribute('inert')).toBe(true);
    expect(layer?.querySelector('h2')?.textContent).toBe('First');
    expect(layer?.textContent).toContain('First body');
    expect(layer?.textContent).toContain('First child');
    expect(layer?.textContent).toContain('OK First');

    await user.click(screen.getByRole('button', { name: 'Open second' }));
    expect(screen.getByRole('heading', { name: 'Second' })).toBeTruthy();
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Second body');
    expect(dialog.textContent).toContain('Second child');
    expect(dialog.textContent).toContain('OK Second');
    expect(dialog.textContent).not.toContain('First');
  });
});

/** The caller mounts the modal only while it is shown: `{show && <Component open />}`. */
function MountsOpen(props: { Component: ComponentType<ModalProps> }): ReactElement {
  const { Component } = props;
  const [show, setShow] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setShow(true)}>
        Show
      </button>
      {show ? (
        <Component open title="Mounted open" closeLabel="Close" onClose={() => setShow(false)} />
      ) : null}
    </div>
  );
}

describe.each(COMPONENTS)('%s enter motion', (_name, Component) => {
  it('plays the enter (data-appear) when mounted already open', () => {
    render(<Component open title="At mount" closeLabel="Close" onClose={() => {}} />);
    const layer = screen.getByRole('dialog').parentElement;
    expect(layer?.getAttribute('data-state')).toBe('open');
    expect(layer?.hasAttribute('data-appear')).toBe(true);
  });

  it('plays the enter when a caller mounts it open later', async () => {
    const user = userEvent.setup();
    render(<MountsOpen Component={Component} />);
    await user.click(screen.getByRole('button', { name: 'Show' }));
    const layer = screen.getByRole('dialog', { name: 'Mounted open' }).parentElement;
    expect(layer?.getAttribute('data-state')).toBe('open');
    expect(layer?.hasAttribute('data-appear')).toBe(true);
  });

  it('still plays the enter when switched from closed to open, and again on reopen', () => {
    const view = render(
      <Component open={false} title="Toggled" closeLabel="Close" onClose={() => {}} />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();

    view.rerender(<Component open title="Toggled" closeLabel="Close" onClose={() => {}} />);
    const first = screen.getByRole('dialog', { name: 'Toggled' }).parentElement;
    expect(first?.getAttribute('data-state')).toBe('open');
    expect(first?.hasAttribute('data-appear')).toBe(true);

    view.rerender(<Component open={false} title="Toggled" closeLabel="Close" onClose={() => {}} />);
    view.rerender(<Component open title="Toggled" closeLabel="Close" onClose={() => {}} />);
    const again = screen.getByRole('dialog', { name: 'Toggled' }).parentElement;
    expect(again?.getAttribute('data-state')).toBe('open');
    expect(again?.hasAttribute('data-appear')).toBe(true);
  });
});
