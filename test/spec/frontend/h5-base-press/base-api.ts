// DSX-46: the props the new H5 base components must accept (apps/h5/src/components/base).
// The rule tests read the components from base/index.ts at run time, so a missing export fails
// as an assertion instead of a module load error.
import type { ComponentType, MouseEvent, ReactNode } from 'react';
import { expect } from 'vitest';
import * as Base from '../../../../apps/h5/src/components/base/index.ts';

/**
 * `primary` / `secondary` / `text` buttons carry a text label. `icon` is the icon-only button:
 * the icon is the child and `aria-label` gives the accessible name.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'text' | 'icon';

export interface ButtonProps {
  /** Defaults to `primary`. */
  variant?: ButtonVariant;
  /** Native button type; defaults to `button`. */
  type?: 'button' | 'submit' | 'reset';
  /**
   * In-button loading: an indicator marked `data-slot="button-loading"` inside the button,
   * `aria-busy="true"`, the label stays the accessible name, clicks are ignored (no onClick, no
   * form submit) and the button keeps its width.
   */
  loading?: boolean;
  disabled?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  'aria-label'?: string;
  children?: ReactNode;
}

/** One selectable pill: a toggle button whose state is `aria-pressed`. Controlled. */
export interface ChipProps {
  selected: boolean;
  /** Called with the next state when the chip is activated. */
  onSelectedChange?: (selected: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}

export interface SegmentedOption {
  value: string;
  label: ReactNode;
}

/**
 * Single choice from a few options: `role="radiogroup"` named by `aria-label`, each option
 * `role="radio"` with `aria-checked`. Roving tab stop on the checked option; ArrowRight /
 * ArrowLeft check and focus the next / previous option, wrapping at the ends. Controlled.
 */
export interface SegmentedProps {
  options: readonly SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  'aria-label': string;
}

/**
 * Plain container without `onClick`. With `onClick` the whole card is one button (native
 * `<button>` or `role="button"` + `tabIndex=0` + Enter / Space) named by its content or by
 * `aria-label`.
 */
export interface CardProps {
  onClick?: () => void;
  'aria-label'?: string;
  children?: ReactNode;
}

/** Title, optional subtitle and a trailing accessory (e.g. an arrow); clickable like Card. */
export interface ListRowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  'aria-label'?: string;
}

export type BaseComponentName = 'Button' | 'Chip' | 'Segmented' | 'Card' | 'ListRow';

export const BASE_COMPONENT_NAMES: readonly BaseComponentName[] = [
  'Button',
  'Chip',
  'Segmented',
  'Card',
  'ListRow',
];

/** Reads a component export from base/index.ts and asserts it exists before use. */
export function baseExport<P>(name: BaseComponentName): ComponentType<P> {
  const value: unknown = Reflect.get(Base, name);
  const isComponent =
    typeof value === 'function' ||
    (typeof value === 'object' && value !== null && '$$typeof' in value);
  expect(isComponent, `apps/h5/src/components/base/index.ts exports ${name}`).toBe(true);
  return value as ComponentType<P>;
}
