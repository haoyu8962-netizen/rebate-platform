import { useLayoutEffect } from 'react';
import { TOAST_LAYER } from './styles.ts';

export interface ToastProps {
  message: string;
  /** Milliseconds until the status disappears; omitted means 2000. */
  durationMs?: number;
  /** Where the persistent announcement region lives; omitted means `document.body`. */
  container?: HTMLElement;
}

const DEFAULT_DURATION_MS = 2000;
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

const STATUS_CLASS = `${TOAST_LAYER} pointer-events-none inset-x-couli-4 mx-auto w-fit max-w-full rounded-couli-button border border-couli-border-subtle bg-couli-background-surface px-couli-4 py-couli-2 text-center text-couli-footnote leading-couli-footnote text-couli-text-primary [box-shadow:var(--shadow-floating)]`;
const STATUS_BOTTOM = 'calc(env(safe-area-inset-bottom, 0px) + var(--space-16))';

/**
 * Light notice at the bottom centre. It renders nothing where it is used: the notice goes into a
 * persistent polite live region in `container` (default `document.body`), so sheets, dialogs and
 * inert application containers never silence it; its layer (`TOAST_LAYER`) sits above sheets and
 * dialogs, so they never cover it either. It never takes focus and removes its
 * text after `durationMs`; the region itself stays, empty.
 *
 * A new `message` replaces the text and restarts the timer. To announce the same text again,
 * mount a new Toast (for example with a new `key`, even in the same commit): every notice clears
 * the previous text and writes its own into a fresh element, so screen readers announce it again.
 */
export function Toast({ message, durationMs = DEFAULT_DURATION_MS, container }: ToastProps): null {
  useLayoutEffect(() => {
    // From the second notice on, the region is already in the page, empty, before any text is
    // written. The very first notice creates the region in this same task, because its text must
    // be visible as soon as render returns; that first announcement may be missed.
    const region = acquireRegion(container ?? document.body);
    const status = region.ownerDocument.createElement('div');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.className = STATUS_CLASS;
    status.style.setProperty('bottom', STATUS_BOTTOM);
    region.append(status);
    status.textContent = message;
    const timer = setTimeout(() => status.remove(), durationMs);
    return () => {
      clearTimeout(timer);
      status.remove();
    };
  }, [container, message, durationMs]);

  return null;
}
