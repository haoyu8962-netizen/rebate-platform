import type { ReactElement } from 'react';

// 页内线性图标（表单块、记录块共用）。

export const ICON = {
  'aria-hidden': true,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export function InfoIcon({ className }: { className: string }): ReactElement {
  return (
    <svg {...ICON} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

export function WarningIcon({ className }: { className: string }): ReactElement {
  return (
    <svg {...ICON} className={className}>
      <path d="M12 4.5 3.5 19h17L12 4.5Z" />
      <path d="M12 10v4M12 16.5h.01" />
    </svg>
  );
}

export function ClockIcon({ className }: { className: string }): ReactElement {
  return (
    <svg {...ICON} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}
