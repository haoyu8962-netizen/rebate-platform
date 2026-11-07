import {
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { CARD, CARD_CLICKABLE } from './styles.ts';

/**
 * Plain container without `onClick`. With `onClick` the whole card is one button named by its
 * first line of content or by `aria-label` (used only when clickable).
 */
export interface CardProps {
  onClick?: () => void;
  'aria-label'?: string;
  children?: ReactNode;
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
  ariaLabel,
  children,
}: {
  onClick: () => void;
  ariaLabel: string | undefined;
  children?: ReactNode;
}): ReactElement {
  const cardRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const contentId = `${baseId}-content`;

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
      className={CARD_CLICKABLE}
      onClick={onClick}
      {...pressKeys(onClick)}
    >
      <div id={contentId} ref={contentRef}>
        {children}
      </div>
    </div>
  );
}

/** Surface card: a plain container, or one button over the whole card when `onClick` is set. */
export function Card({ onClick, 'aria-label': ariaLabel, children }: CardProps): ReactElement {
  if (onClick === undefined) {
    return <div className={CARD}>{children}</div>;
  }
  return (
    <ClickableCard onClick={onClick} ariaLabel={ariaLabel}>
      {children}
    </ClickableCard>
  );
}
