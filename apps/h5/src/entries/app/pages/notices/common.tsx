import type { ReactElement, ReactNode } from 'react';
import { ApiError } from '../../../../shared/api/index.ts';

/** Unknown, unpublished or taken-down article (contracts/error-codes.yaml). */
const ARTICLE_NOT_FOUND = 30701;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
/** Published articles change rarely; going back and forth reuses what was loaded. */
export const ARTICLE_STALE_MS = 5 * 60 * 1000;

export function isArticleNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.code === ARTICLE_NOT_FOUND;
}

/** Beijing time (UTC+8, no daylight saving) of an RFC 3339 instant as YYYY-MM-DDTHH:mm; null if invalid. */
function beijing(instant: string): string | null {
  const time = Date.parse(instant);
  if (Number.isNaN(time)) return null;
  return new Date(time + BEIJING_OFFSET_MS).toISOString().slice(0, 16);
}

/** Beijing calendar date YYYY-MM-DD; null if the instant is invalid. */
export function beijingDate(instant: string): string | null {
  return beijing(instant)?.slice(0, 10) ?? null;
}

/** Beijing date and minute YYYY-MM-DD HH:mm; null if the instant is invalid. */
export function beijingDateTime(instant: string): string | null {
  return beijing(instant)?.replace('T', ' ') ?? null;
}

export const TITLE =
  'text-couli-title leading-couli-title font-couli-semibold text-couli-text-primary';

/** Page column below the native navigation bar (the H5 never draws its own title bar). */
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
