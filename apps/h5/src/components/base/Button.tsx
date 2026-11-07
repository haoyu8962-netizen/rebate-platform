import type { MouseEvent, ReactElement, ReactNode } from 'react';
import { BUTTON_LABEL, BUTTON_LOADING, BUTTON_SPINNER, BUTTON_VARIANT } from './styles.ts';

/** `icon` is the icon-only button: the icon is the child and `aria-label` names it. */
export type ButtonVariant = keyof typeof BUTTON_VARIANT;

export interface ButtonProps {
  /** Defaults to `primary`. */
  variant?: ButtonVariant;
  /** Native button type; defaults to `button` so a button inside a form does not submit. */
  type?: 'button' | 'submit' | 'reset';
  /**
   * In-button loading (ui-rules §3.6): a spinner over the kept label, `aria-busy`, clicks and
   * form submits ignored, width unchanged.
   */
  loading?: boolean;
  disabled?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  'aria-label'?: string;
  children?: ReactNode;
}

/** Native `<button>` with a pressed look and the shared focus ring. */
export function Button({
  variant = 'primary',
  type = 'button',
  loading = false,
  disabled = false,
  onClick,
  'aria-label': ariaLabel,
  children,
}: ButtonProps): ReactElement {
  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (loading) {
      // Guards repeat taps: no callback and no form submit while busy.
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <button
      type={type}
      className={BUTTON_VARIANT[variant]}
      disabled={disabled}
      aria-busy={loading ? true : undefined}
      aria-label={ariaLabel}
      onClick={handleClick}
    >
      {/* The label stays laid out (and named) while loading, so the width does not jump. */}
      <span className={loading ? `${BUTTON_LABEL} opacity-0` : BUTTON_LABEL}>{children}</span>
      {loading ? (
        <span data-slot="button-loading" aria-hidden="true" className={BUTTON_LOADING}>
          <span className={BUTTON_SPINNER} />
        </span>
      ) : null}
    </button>
  );
}
