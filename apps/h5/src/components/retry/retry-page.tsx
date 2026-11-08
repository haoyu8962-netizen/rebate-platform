import type { ReactElement } from 'react';
import { t } from '../../shared/texts.ts';
import { Button } from '../base/Button.tsx';

export interface RetryPageProps {
  onRetry: () => void;
}

/**
 * H5-side load failure page (design StateLoadFailed): illustration slot, title, description and
 * the primary 【重试】 button (the base Button). Covers only failures H5 itself sees (lazy route
 * chunk, render error); the native container's retry and maintenance pages are separate (规划/03
 * §8.3, TECH-20). Error details are never shown. Colours come from token utilities only.
 */
export function RetryPage({ onRetry }: RetryPageProps): ReactElement {
  const message = t('h5.load_failed');
  return (
    <div
      role="alert"
      className="flex min-h-dvh flex-col items-center justify-center gap-couli-4 bg-couli-background-canvas p-couli-6 text-center"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 96 96"
        className="size-24 text-couli-text-secondary"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="18" y="14" width="60" height="68" rx="8" />
        <path d="M32 34h32M32 46h20" />
        <path d="M40 66l16-12M56 66L40 54" />
      </svg>
      <h1 className="text-couli-heading font-couli-semibold text-couli-text-primary">{message}</h1>
      <p className="text-couli-body text-couli-text-secondary">{message}</p>
      <Button onClick={() => onRetry()}>{t('h5.retry')}</Button>
    </div>
  );
}
