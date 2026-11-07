import { useId, type ReactElement, type ReactNode } from 'react';
import {
  LIST_ROW,
  LIST_ROW_CLICKABLE,
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
  onClick?: () => void;
  'aria-label'?: string;
}

/**
 * One list row. With `onClick` the whole row is a native `<button>` named by the title (or by
 * `aria-label`) and described by the subtitle.
 */
export function ListRow({
  title,
  subtitle,
  trailing,
  onClick,
  'aria-label': ariaLabel,
}: ListRowProps): ReactElement {
  const id = useId();
  const titleId = `${id}-title`;
  const subtitleId = `${id}-subtitle`;
  const content = (
    <>
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
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel === undefined ? titleId : undefined}
      aria-describedby={subtitle === undefined ? undefined : subtitleId}
      className={LIST_ROW_CLICKABLE}
      onClick={onClick}
    >
      {content}
    </button>
  );
}
