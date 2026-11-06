import {
  createContext,
  useContext,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ACTION_IN_ROW,
  ACTION_ROW,
  FOCUS_RING,
  LAYER,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from './styles.ts';
import type { ModalProps } from './types.ts';

export type ModalVariant = 'dialog' | 'sheet';

/** One per ModalFrame instance; `parent` is the modal whose content renders this one. */
interface ModalNode {
  parent: ModalNode | null;
}

interface ModalEntry {
  node: ModalNode;
  /** Where focus goes back to when this modal closes. */
  previous: HTMLElement | null;
}

/** Open modals, top last: only the top one handles Escape and Tab. */
const openModals: ModalEntry[] = [];

const ParentModal = createContext<ModalNode | null>(null);

function isInside(node: ModalNode, ancestor: ModalNode): boolean {
  for (let current = node.parent; current !== null; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

/**
 * Layout effects run child first, so a nested modal opened in the same commit as its parent is
 * already on the stack. Insert below it, take over the opener it recorded and let it return focus
 * to this modal's title instead. Returns whether this modal is the top one.
 */
function pushModal(entry: ModalEntry, title: HTMLElement | null): boolean {
  const nested = openModals.findIndex((other) => isInside(other.node, entry.node));
  if (nested === -1) {
    openModals.push(entry);
    return true;
  }
  const child = openModals[nested]!;
  entry.previous = child.previous;
  child.previous = title;
  openModals.splice(nested, 0, entry);
  return false;
}

function focusLost(panel: HTMLElement): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || panel.contains(active);
}

/**
 * Give focus back to `previous` while it is still in the closed modal or has dropped to body;
 * focus the caller or another modal moved elsewhere is left alone. The caller usually lifts
 * `inert` from the background in the same render that closes the modal, and the cleanup that
 * calls this can run before that attribute update, when the browser refuses the focus. So retry
 * after the commit (microtask), and once more on the next frame for effect-driven updates.
 */
function restoreFocus(panel: HTMLElement, previous: HTMLElement | null): void {
  if (previous === null) return;
  const attempt = (): boolean => {
    if (!previous.isConnected || !focusLost(panel)) return true;
    previous.focus();
    return document.activeElement === previous;
  };
  if (attempt()) return;
  pendingReturn = previous;
  queueMicrotask(() => {
    if (pendingReturn === previous) pendingReturn = null;
    if (attempt()) return;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(attempt);
    else setTimeout(attempt, 0);
  });
}

/**
 * A focus return still waiting for the commit to finish. A modal opened in the same commit that
 * closed another finds focus on body; it returns focus to that pending control instead.
 */
let pendingReturn: HTMLElement | null = null;

function openerOf(active: Element | null): HTMLElement | null {
  if (active instanceof HTMLElement && active !== document.body) return active;
  return pendingReturn;
}

const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'iframe',
  'summary',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[tabindex]',
].join(',');

function isRendered(element: Element, boundary: Element): boolean {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement && node.hidden) return false;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (node === boundary) break;
  }
  return true;
}

/** Tabbable descendants in DOM order, skipping disabled, inert and hidden ones. */
function tabbables(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(':disabled') &&
      element.closest('[inert]') === null &&
      isRendered(element, panel),
  );
}

function nextTabbable(panel: HTMLElement, backwards: boolean): HTMLElement | undefined {
  const items = tabbables(panel);
  const active = document.activeElement;
  if (active === null || !panel.contains(active)) return backwards ? items.at(-1) : items[0];
  if (backwards) {
    const before = items.filter(
      (item) => item.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    return before.at(-1) ?? items.at(-1);
  }
  const after = items.find(
    (item) => active.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  return after ?? items[0];
}

// Dialog: centred card, at most viewport − 2 × (safe area + 24) tall (a11y spec §4).
const DIALOG_HEIGHT: CSSProperties = {
  maxHeight:
    'calc(100dvh - 2 * (max(env(safe-area-inset-top, 0px), env(safe-area-inset-bottom, 0px)) + var(--space-6)))',
};
// Sheet: bottom panel, at most viewport − top safe area − 24; 34 bottom inset or the safe area.
const SHEET_FRAME: CSSProperties = {
  maxHeight: 'calc(100dvh - env(safe-area-inset-top, 0px) - var(--space-6))',
  paddingBottom: 'max(34px, env(safe-area-inset-bottom, 0px))',
};

const VARIANT = {
  dialog: {
    root: 'flex items-center justify-center px-couli-6',
    panel: 'w-full rounded-couli-card p-couli-5',
    panelStyle: DIALOG_HEIGHT,
    title: 'px-couli-8 text-center text-couli-body leading-couli-body',
    close: 'top-couli-2 right-couli-2',
    actions: '',
    // A full-width divider above the buttons while the body scrolls (a11y spec §4).
    divider:
      'data-scrollable:-mx-couli-5 data-scrollable:border-t data-scrollable:border-couli-border-subtle data-scrollable:px-couli-5 data-scrollable:pt-couli-3',
  },
  sheet: {
    root: 'flex flex-col justify-end',
    panel: 'w-full rounded-t-couli-panel px-couli-4 pt-couli-5',
    panelStyle: SHEET_FRAME,
    // Sheet titles use the title size, 22/28.6 (ProductAuthSheet, AdaptShortAuthSheet).
    title: 'pr-couli-8 text-couli-title leading-couli-title',
    close: 'top-couli-2 right-couli-1',
    actions: 'pt-couli-2',
    divider:
      'data-scrollable:-mx-couli-4 data-scrollable:border-t data-scrollable:border-couli-border-subtle data-scrollable:px-couli-4 data-scrollable:pt-couli-3',
  },
} as const;

function CloseIcon(): ReactElement {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

interface ModalFrameProps extends ModalProps {
  variant: ModalVariant;
}

/**
 * Shared modal behaviour for Dialog and Sheet: portal into `portalContainer` (default
 * document.body), focus the title on open, keep Tab inside, close on Escape / backdrop as allowed,
 * and return focus to the previously focused control when closed or unmounted.
 */
export function ModalFrame(props: ModalFrameProps): ReactElement | null {
  const {
    variant,
    open,
    title,
    description,
    closeLabel,
    onClose,
    children,
    primaryAction,
    secondaryAction,
    dismissible = true,
    closeOnBackdrop = true,
    portalContainer,
  } = props;
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  const parent = useContext(ParentModal);
  const [node] = useState<ModalNode>(() => ({ parent }));

  const onKeyDown = useEffectEvent((event: KeyboardEvent, panel: HTMLElement) => {
    if (event.key === 'Escape') {
      if (!dismissible || event.isComposing) return;
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = nextTabbable(panel, event.shiftKey);
    event.preventDefault();
    target?.focus();
  });

  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel === null) return;
    const previous = openerOf(document.activeElement);
    const entry: ModalEntry = { node, previous };
    if (pushModal(entry, titleRef.current)) titleRef.current?.focus();
    const listener = (event: KeyboardEvent) => {
      if (openModals.at(-1) === entry) onKeyDown(event, panel);
    };
    document.addEventListener('keydown', listener);
    return () => {
      document.removeEventListener('keydown', listener);
      openModals.splice(openModals.indexOf(entry), 1);
      restoreFocus(panel, entry.previous);
    };
  }, [open, node]);

  // Track whether the body overflows: the body box follows the viewport, the content box follows
  // the caller's content. Environments without ResizeObserver simply show no divider.
  useLayoutEffect(() => {
    if (!open) return;
    const body = bodyRef.current;
    const content = contentRef.current;
    if (body === null || content === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setScrollable(body.scrollHeight > body.clientHeight);
    });
    observer.observe(body);
    observer.observe(content);
    return () => observer.disconnect();
  }, [open]);

  if (!open) return null;
  const style = VARIANT[variant];
  const hasActions = primaryAction !== undefined || secondaryAction !== undefined;
  const allowBackdrop = dismissible && closeOnBackdrop;

  return createPortal(
    <ParentModal value={node}>
      <div className={`${LAYER} inset-0 ${style.root}`}>
        <div
          data-slot="modal-backdrop"
          aria-hidden="true"
          className="absolute inset-0 bg-couli-overlay-scrim"
          onClick={allowBackdrop ? onClose : undefined}
        />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description === undefined ? undefined : descriptionId}
          className={`relative flex flex-col gap-couli-4 bg-couli-background-surface text-couli-text-primary [box-shadow:var(--shadow-floating)] ${style.panel}`}
          style={style.panelStyle}
        >
          {variant === 'sheet' ? (
            <div
              data-slot="sheet-handle"
              aria-hidden="true"
              className="absolute top-couli-2 left-1/2 h-couli-1 w-9 -translate-x-1/2 rounded-couli-pill bg-couli-border-subtle"
            />
          ) : null}
          <h2
            ref={titleRef}
            id={titleId}
            tabIndex={-1}
            className={`flex-none font-couli-semibold outline-none ${style.title}`}
          >
            {title}
          </h2>
          <button
            type="button"
            aria-label={closeLabel}
            className={`absolute flex size-couli-interaction-target-minimum cursor-pointer items-center justify-center rounded-couli-button text-couli-text-secondary ${FOCUS_RING} ${style.close}`}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
          <div
            ref={bodyRef}
            data-slot="modal-body"
            className="-m-couli-1 min-h-0 overflow-y-auto p-couli-1 text-couli-footnote leading-couli-footnote"
          >
            <div ref={contentRef}>
              {description === undefined ? null : (
                <p id={descriptionId} className="mb-couli-3 last:mb-0">
                  {description}
                </p>
              )}
              {children}
            </div>
          </div>
          {hasActions ? (
            <div
              data-slot="modal-actions"
              data-scrollable={scrollable ? '' : undefined}
              className={`${ACTION_ROW} ${style.actions} ${style.divider}`}
            >
              {secondaryAction === undefined ? null : (
                <button
                  type="button"
                  className={`${ACTION_IN_ROW} ${SECONDARY_BUTTON}`}
                  onClick={secondaryAction.onClick}
                >
                  {secondaryAction.label}
                </button>
              )}
              {primaryAction === undefined ? null : (
                <button
                  type="button"
                  className={`${ACTION_IN_ROW} ${PRIMARY_BUTTON}`}
                  onClick={primaryAction.onClick}
                >
                  {primaryAction.label}
                </button>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </ParentModal>,
    portalContainer ?? document.body,
  );
}
