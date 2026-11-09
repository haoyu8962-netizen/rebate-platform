import { useLayoutEffect } from 'react';
import { isInApp } from '@couli/bridge-sdk';
import { TOAST_DISPLAY_MS, TOAST_EXIT_MS } from './motion.ts';
import { TOAST_LAYER } from './styles.ts';

export interface ToastProps {
  message: string;
  /** Milliseconds until the status disappears; omitted means motion.toast.display. */
  durationMs?: number;
  /** Where the persistent announcement region lives; omitted means `document.body`. */
  container?: HTMLElement;
}

const REGION_SLOT = 'toast-region';

/** One persistent region per mount point, created empty the first time a Toast mounts there. */
const regions = new WeakMap<HTMLElement, HTMLElement>();

function acquireRegion(container: HTMLElement): HTMLElement {
  const known = regions.get(container);
  // A region removed from its container (for example by replaceChildren) is rebuilt.
  if (known !== undefined && known.parentNode === container) return known;
  const region = container.ownerDocument.createElement('div');
  region.setAttribute('data-slot', REGION_SLOT);
  region.setAttribute('aria-live', 'polite');
  container.append(region);
  regions.set(container, region);
  return region;
}

const STATUS_CLASS = `h5-toast ${TOAST_LAYER} pointer-events-none inset-x-couli-4 mx-auto w-fit max-w-full rounded-couli-button border border-couli-border-subtle bg-couli-background-surface px-couli-4 py-couli-2 text-center text-couli-footnote leading-couli-footnote text-couli-text-primary [box-shadow:var(--shadow-floating)]`;
/** Outside the App: bottom centre, clear of the home indicator. */
const STATUS_BOTTOM = 'calc(env(safe-area-inset-bottom, 0px) + var(--space-16))';
/** Inside the App: top centre, below the status bar; the navigation bar is native, above the page. */
const STATUS_TOP = 'calc(env(safe-area-inset-top, 0px) + var(--space-4))';

/**
 * Light notice, centred: at the top of the page inside the App (bridge present when it mounts,
 * 03 §8.3) and at the bottom outside it (DSX-48). It renders nothing where it is used: the
 * notice goes into a persistent polite live region in `container` (default `document.body`), so
 * sheets, dialogs and inert application containers never silence it; its layer (`TOAST_LAYER`) sits above sheets and
 * dialogs, so they never cover it either. It never takes focus and removes its
 * text after `durationMs`; the region itself stays, empty.
 *
 * A new `message` replaces the text and restarts the timer. To announce the same text again,
 * mount a new Toast (for example with a new `key`, even in the same commit): every notice clears
 * the previous text and writes its own into a fresh element, so screen readers announce it again.
 *
 * Motion (DSX-48d, shared/styles/index.css `h5-toast`): the notice fades in, and fades out over
 * the last TOAST_EXIT_MS before it is removed; it never moves. Timers only, no transitionend.
 */
export function Toast({ message, durationMs = TOAST_DISPLAY_MS, container }: ToastProps): null {
  useLayoutEffect(() => {
    // From the second notice on, the region is already in the page, empty, before any text is
    // written. The very first notice creates the region in this same task, because its text must
    // be visible as soon as render returns; that first announcement may be missed.
    const region = acquireRegion(container ?? document.body);
    const status = region.ownerDocument.createElement('div');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.className = STATUS_CLASS;
    if (isInApp()) status.style.setProperty('top', STATUS_TOP);
    else status.style.setProperty('bottom', STATUS_BOTTOM);
    region.append(status);
    status.textContent = message;
    const fade = setTimeout(
      () => status.setAttribute('data-state', 'closed'),
      Math.max(0, durationMs - TOAST_EXIT_MS),
    );
    const timer = setTimeout(() => status.remove(), durationMs);
    return () => {
      clearTimeout(fade);
      clearTimeout(timer);
      status.remove();
    };
  }, [container, message, durationMs]);

  return null;
}
