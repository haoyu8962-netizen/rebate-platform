import { useEffect, useRef, type ReactElement } from 'react';
import { PRIMARY_BUTTON } from './styles.ts';
import type { StateProps } from './types.ts';

interface StateLayoutProps extends StateProps {
  /** ErrorState announces its title and helper text (`role="alert"`); EmptyState does not. */
  alert: boolean;
}

/**
 * Empty / error state (GUIDE §3): centred column — 96×96 muted placeholder holding a 32px icon,
 * a 17/600 title, a 14 helper line in the secondary text colour, then an optional main button.
 */
export function StateLayout({
  title,
  description,
  icon,
  action,
  alert,
  autoFocusAction = false,
}: StateLayoutProps): ReactElement {
  const actionRef = useRef<HTMLButtonElement>(null);
  const focusAction = alert && autoFocusAction && action !== undefined;

  // Runs on mount and when the switch turns on; parent re-renders leave focus where it is.
  useEffect(() => {
    if (focusAction) actionRef.current?.focus();
  }, [focusAction]);

  return (
    <div className="flex w-full flex-col items-center gap-couli-4 px-couli-8 text-center">
      <div
        data-slot="state-illustration"
        aria-hidden="true"
        className="flex size-24 flex-none items-center justify-center rounded-couli-card bg-couli-background-muted text-couli-text-secondary [&>svg]:size-8 [&>svg]:flex-none"
      >
        {icon}
      </div>
      <div role={alert ? 'alert' : undefined} className="flex flex-col gap-couli-1">
        <h2 className="text-couli-body leading-couli-body font-couli-semibold text-couli-text-primary">
          {title}
        </h2>
        <p className="text-couli-footnote leading-couli-footnote text-couli-text-secondary">
          {description}
        </p>
      </div>
      {action === undefined ? null : (
        <div className="flex w-full max-w-60 flex-col">
          <button
            ref={actionRef}
            type="button"
            className={`w-full ${PRIMARY_BUTTON}`}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        </div>
      )}
    </div>
  );
}
