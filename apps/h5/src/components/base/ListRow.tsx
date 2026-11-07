import { useId, type ReactElement, type ReactNode } from 'react';
import {
  LIST_ROW,
  LIST_ROW_CLICKABLE,
  LIST_ROW_LEADING,
  LIST_ROW_SUBTITLE,
  LIST_ROW_TEXT,
  LIST_ROW_TITLE,
  LIST_ROW_TRAILING,
} from './styles.ts';

/** Title, optional subtitle and a trailing accessory (e.g. an arrow); clickable like Card. */
export interface ListRowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  /** Decoration before the title (an icon); never part of the name. */
  leading?: ReactNode;
  /**
   * What names a clickable row: the title (default; the subtitle describes it) or the whole row
   * content, for rows whose figures belong in the name (amount, date …).
   */
  labelFrom?: 'title' | 'content';
  onClick?: () => void;
  'aria-label'?: string;
}

/**
 * One list row. With `onClick` the whole row is a native `<button>` named by the title (or by
 * `aria-label`) and described by the subtitle; with `labelFrom="content"` named by all its text.
 */
export function ListRow({
  title,
  subtitle,
  trailing,
  leading,
  labelFrom = 'title',
  onClick,
  'aria-label': ariaLabel,
}: ListRowProps): ReactElement {
  const id = useId();
  const titleId = `${id}-title`;
  const subtitleId = `${id}-subtitle`;
  const content = (
    <>
      {leading === undefined ? null : (
        <span aria-hidden="true" className={LIST_ROW_LEADING}>
          {leading}
        </span>
      )}
      <span className={LIST_ROW_TEXT}>
        <span id={titleId} className={LIST_ROW_TITLE}>
          {title}
        </span>
        {subtitle === undefined ? null : (
          <span id={subtitleId} className={LIST_ROW_SUBTITLE}>
            {subtitle}
          </span>
        )}
      </span>
      {trailing === undefined ? null : <span className={LIST_ROW_TRAILING}>{trailing}</span>}
    </>
  );
  if (onClick === undefined) {
    return <div className={LIST_ROW}>{content}</div>;
  }
  const byTitle = labelFrom === 'title';
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel === undefined && byTitle ? titleId : undefined}
      aria-describedby={subtitle === undefined || !byTitle ? undefined : subtitleId}
      className={LIST_ROW_CLICKABLE}
      onClick={onClick}
    >
      {content}
    </button>
  );
}
