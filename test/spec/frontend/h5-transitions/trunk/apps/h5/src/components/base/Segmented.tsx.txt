import { useRef, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { SEGMENT, SEGMENTED_GROUP } from './styles.ts';

export interface SegmentedOption {
  value: string;
  label: ReactNode;
}

/** Single choice from a few options. Controlled: the parent owns `value`. */
export interface SegmentedProps {
  options: readonly SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  'aria-label': string;
}

const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown']);
const PREVIOUS_KEYS = new Set(['ArrowLeft', 'ArrowUp']);

/**
 * `radiogroup` of `radio` options with `aria-checked`. One tab stop on the checked option;
 * arrow keys check and focus the next / previous option, wrapping at the ends.
 */
export function Segmented({
  options,
  value,
  onChange,
  'aria-label': ariaLabel,
}: SegmentedProps): ReactElement {
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const checkedIndex = options.findIndex((option) => option.value === value);
  const tabStop = checkedIndex === -1 ? 0 : checkedIndex;

  const select = (index: number): void => {
    const option = options[index];
    if (option === undefined) return;
    optionRefs.current[index]?.focus();
    if (option.value !== value) onChange(option.value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const step = NEXT_KEYS.has(event.key) ? 1 : PREVIOUS_KEYS.has(event.key) ? -1 : 0;
    if (step === 0 || options.length === 0) return;
    event.preventDefault();
    select((index + step + options.length) % options.length);
  };

  return (
    <div role="radiogroup" aria-label={ariaLabel} className={SEGMENTED_GROUP}>
      {options.map((option, index) => {
        const checked = index === checkedIndex;
        return (
          <button
            key={option.value}
            ref={(element) => {
              optionRefs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={index === tabStop ? 0 : -1}
            className={checked ? SEGMENT.checked : SEGMENT.unchecked}
            onClick={() => select(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
