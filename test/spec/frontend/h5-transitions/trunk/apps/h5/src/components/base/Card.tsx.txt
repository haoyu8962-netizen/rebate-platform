import {
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { CARD_PADDING, CARD_PRESSABLE, CARD_SURFACE } from './styles.ts';

/**
 * Plain container without `onClick`. With `onClick` the whole card is one button named by its
 * first line of content or by `aria-label`; a plain card takes `aria-label` only as a landmark or
 * region (`as` other than `div`).
 */
export interface CardProps {
  onClick?: () => void;
  /** A clickable card that stays a named button but is unavailable (aria-disabled, presses ignored). */
  disabled?: boolean;
  'aria-label'?: string;
  /** Inner padding; defaults to 16 all round. */
  padding?: CardPadding;
  /** Layout classes added to the card (display, gap, overflow …); surface and shape stay the card's. */
  className?: string;
  /** Element of a plain card (a clickable card is always one `role="button"` element). */
  as?: CardElement;
  /** Names a plain card that is a landmark or region (`as="nav"` / `"section"`). */
  'aria-labelledby'?: string;
  children?: ReactNode;
}

export type CardPadding = keyof typeof CARD_PADDING;
export type CardElement = 'div' | 'section' | 'article' | 'nav' | 'ul';

function cardClass(
  padding: CardPadding,
  className: string | undefined,
  pressable: boolean,
): string {
  return [CARD_SURFACE, CARD_PADDING[padding], pressable ? CARD_PRESSABLE : '', className ?? '']
    .filter((part) => part !== '')
    .join(' ');
}

/** Enter on keydown and Space on keyup, as a native button does. */
function pressKeys(onClick: () => void): {
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onKeyUp: (event: KeyboardEvent<HTMLElement>) => void;
} {
  return {
    onKeyDown: (event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        onClick();
      } else if (event.key === ' ') {
        // Keeps the page from scrolling; the press fires on keyup.
        event.preventDefault();
      }
    },
    onKeyUp: (event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === ' ') {
        event.preventDefault();
        onClick();
      }
    },
  };
}

/** The element holding the first non-blank text inside `root`, or `root` when there is none. */
function firstTextElement(root: HTMLElement): HTMLElement {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if ((node.textContent ?? '').trim() !== '' && node.parentElement !== null) {
      return node.parentElement;
    }
  }
  return root;
}

/**
 * Clickable card: `role="button"` on the card itself (not a native `<button>`) so any block
 * content stays valid inside it. Without `aria-label` the button is named by the first line of
 * its content (like a card title) and described by the whole content, because a button's
 * children are not read out on their own.
 */
function ClickableCard({
  onClick,
  disabled,
  ariaLabel,
  className,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  ariaLabel: string | undefined;
  className: string;
  children?: ReactNode;
}): ReactElement {
  const cardRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const contentId = `${baseId}-content`;
  const press = disabled ? () => undefined : onClick;

  // Runs after every render: the content (and so its first line) may change with any render.
  useLayoutEffect(() => {
    const card = cardRef.current;
    const content = contentRef.current;
    if (card === null || content === null) return;
    if (ariaLabel !== undefined) {
      card.removeAttribute('aria-labelledby');
      return;
    }
    const label = firstTextElement(content);
    if (label.id === '') label.id = `${baseId}-label`;
    card.setAttribute('aria-labelledby', label.id);
  });

  return (
    <div
      ref={cardRef}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-describedby={contentId}
      aria-disabled={disabled ? true : undefined}
      className={className}
      onClick={press}
      {...pressKeys(press)}
    >
      <div id={contentId} ref={contentRef}>
        {children}
      </div>
    </div>
  );
}

/** Surface card: a plain container, or one button over the whole card when `onClick` is set. */
export function Card({
  onClick,
  disabled = false,
  'aria-label': ariaLabel,
  padding = 'default',
  className,
  as: Element = 'div',
  'aria-labelledby': labelledBy,
  children,
}: CardProps): ReactElement {
  if (onClick === undefined) {
    return (
      <Element
        className={cardClass(padding, className, false)}
        aria-label={Element === 'div' ? undefined : ariaLabel}
        aria-labelledby={labelledBy}
      >
        {children}
      </Element>
    );
  }
  return (
    <ClickableCard
      onClick={onClick}
      disabled={disabled}
      ariaLabel={ariaLabel}
      className={cardClass(padding, className, true)}
    >
      {children}
    </ClickableCard>
  );
}
