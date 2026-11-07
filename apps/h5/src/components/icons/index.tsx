import type { ReactElement, ReactNode } from 'react';

// Line icons shared by the H5 pages (24 grid, currentColor stroke). Each is drawn only here.

function LineIcon({
  className,
  strokeWidth,
  children,
}: {
  className: string | undefined;
  strokeWidth: number;
  children: ReactNode;
}): ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export interface IconProps {
  /** Size and colour classes; each icon has its usual default. */
  className?: string;
}

/** Trailing "go on" arrow of rows, cards and links. */
export function ChevronIcon({
  className = 'size-5 flex-none text-couli-text-secondary',
}: IconProps): ReactElement {
  return (
    <LineIcon className={className} strokeWidth={1.75}>
      <path d="m9.5 6 6 6-6 6" />
    </LineIcon>
  );
}

/** Article / document (rule entries, empty article lists). */
export function DocumentIcon({ className = 'size-5 flex-none' }: IconProps): ReactElement {
  return (
    <LineIcon className={className} strokeWidth={1.6}>
      <path d="M7 3.5h7l4 4v13H7v-17Z" />
      <path d="M14 3.5v4h4M9.5 12h6M9.5 15.5h6" />
    </LineIcon>
  );
}

/** Load-failure illustration of the error states (circle with an exclamation mark). */
export function AlertIcon({ className }: IconProps): ReactElement {
  return (
    <LineIcon className={className} strokeWidth={1.6}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5.5M12 16.2v.3" />
    </LineIcon>
  );
}
