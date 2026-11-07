import { call, has, isInApp } from '@couli/bridge-sdk';
import { useMemo, type ReactElement, type ReactNode } from 'react';
import type { AppApiBridge } from '../../../../shared/api/app-api.ts';

/** SDK facade the help page uses; injectable for tests, production uses @couli/bridge-sdk. */
export type HelpBridge = Pick<AppApiBridge, 'isInApp' | 'has' | 'call'>;

export const DEFAULT_BRIDGE: HelpBridge = { isInApp, has, call };

/** Fixed support entry of the help centre (cs.open params carry nothing else). */
const SUPPORT_ENTRY = 'help';

/**
 * Opens native support (cs.open) once per tap, or null when the page is not inside the App or
 * native lacks the capability (the entry is then hidden). The result (opened or not) is native's
 * business: nothing is resent and no hint is shown here.
 */
export function useSupport(bridge: HelpBridge): (() => void) | null {
  return useMemo(() => {
    if (!bridge.isInApp()) return null;
    const handle = bridge.has('cs.open');
    if (handle === null) return null;
    return () => {
      bridge.call(handle, { entry: SUPPORT_ENTRY }).catch(() => undefined);
    };
  }, [bridge]);
}

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Calendar date in Beijing (UTC+8, no daylight saving) of an RFC 3339 instant; null if invalid. */
export function beijingDate(instant: string): string | null {
  const time = Date.parse(instant);
  if (Number.isNaN(time)) return null;
  return new Date(time + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

export function Page({ children }: { children: ReactNode }): ReactElement {
  return (
    <main className="flex min-h-dvh flex-col gap-couli-3 bg-couli-background-canvas px-couli-4 pt-couli-2 pb-couli-6 font-couli-system text-couli-text-primary">
      {children}
    </main>
  );
}

export function CenteredState({ children }: { children: ReactNode }): ReactElement {
  return <div className="flex flex-1 items-center justify-center py-couli-16">{children}</div>;
}

function Icon({ className, children }: { className: string; children: ReactNode }): ReactElement {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function ChatIcon({ className }: { className: string }): ReactElement {
  return (
    <Icon className={className}>
      <path d="M5 6.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-6l-4 3v-3H5A1.5 1.5 0 0 1 3.5 16V8A1.5 1.5 0 0 1 5 6.5Z" />
    </Icon>
  );
}
