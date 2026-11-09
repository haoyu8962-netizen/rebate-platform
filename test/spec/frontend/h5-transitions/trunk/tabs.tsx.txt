import type { ReactElement, ReactNode } from 'react';
import { TAB, TAB_LIST } from './styles.ts';

export interface TabItem {
  value: string;
  label: ReactNode;
  /** Id of the tab itself (its panel is labelled by it). */
  id: string;
  /** Id of the panel the tab controls. */
  panelId: string;
}

/** Page tabs. Controlled: the parent owns `value` and renders the panels. */
export interface TabsProps {
  items: readonly TabItem[];
  value: string;
  /** Called with the tab's value on every activation, the selected tab included. */
  onChange: (value: string) => void;
  'aria-label': string;
}

/** `tablist` of native buttons with `role="tab"`, `aria-selected` and `aria-controls`. */
export function Tabs({ items, value, onChange, 'aria-label': ariaLabel }: TabsProps): ReactElement {
  return (
    <div role="tablist" aria-label={ariaLabel} className={TAB_LIST}>
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            id={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={item.panelId}
            className={selected ? TAB.selected : TAB.unselected}
            onClick={() => onChange(item.value)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
