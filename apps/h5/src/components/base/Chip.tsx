import type { ReactElement, ReactNode } from 'react';
import { CHIP } from './styles.ts';

/** One selectable pill. Controlled: the parent owns `selected`. */
export interface ChipProps {
  selected: boolean;
  /** Called with the next state when the chip is activated. */
  onSelectedChange?: (selected: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}

/** Toggle button: the state is read out through `aria-pressed`. */
export function Chip({
  selected,
  onSelectedChange,
  disabled = false,
  children,
}: ChipProps): ReactElement {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      className={selected ? CHIP.selected : CHIP.unselected}
      onClick={() => onSelectedChange?.(!selected)}
    >
      {children}
    </button>
  );
}
