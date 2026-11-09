import type { ReactElement, ReactNode } from 'react';
import { CHIP, CHIP_HIT } from './styles.ts';

/** One selectable pill. Controlled: the parent owns `selected`. */
export interface ChipProps {
  selected: boolean;
  /** Called with the next state when the chip is activated. */
  onSelectedChange?: (selected: boolean) => void;
  disabled?: boolean;
  /**
   * `toggle` (default): a toggle button, the state read out through `aria-pressed`. `radio`: one
   * option of a single choice (`role="radio"` with `aria-checked`), for a `radiogroup` the parent
   * draws around the chips.
   */
  kind?: 'toggle' | 'radio';
  children?: ReactNode;
}

/** Native `<button>` with a 44 px hit area around the visual pill. */
export function Chip({
  selected,
  onSelectedChange,
  disabled = false,
  kind = 'toggle',
  children,
}: ChipProps): ReactElement {
  const state =
    kind === 'radio'
      ? ({ role: 'radio', 'aria-checked': selected } as const)
      : ({ 'aria-pressed': selected } as const);
  return (
    <button
      type="button"
      {...state}
      disabled={disabled}
      className={CHIP_HIT}
      onClick={() => onSelectedChange?.(!selected)}
    >
      <span className={selected ? CHIP.selected : CHIP.unselected}>{children}</span>
    </button>
  );
}
