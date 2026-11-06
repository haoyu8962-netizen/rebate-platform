import { t } from '../../../shared/texts.ts';

/** Placeholder for an h5 route whose page has not shipped; no H5 title bar (the shell sets the native title). */
export function Component() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6 text-couli-text-secondary">
      <p>{t('h5.shell.page_pending')}</p>
    </main>
  );
}
