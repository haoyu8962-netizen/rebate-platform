import type { ReactElement } from 'react';

type FilterField = {
  readonly label: string;
  readonly advanced?: boolean;
} & (
  | { readonly kind: 'exact-text' | 'fuzzy-text'; readonly name: string }
  | {
      readonly kind: 'select';
      readonly name: string;
      readonly options: readonly { readonly value: string; readonly label: string }[];
    }
  | {
      readonly kind: 'date-range';
      readonly start: { readonly name: string; readonly label: string };
      readonly end: { readonly name: string; readonly label: string };
    }
  | {
      readonly kind: 'number-range';
      readonly min: { readonly name: string; readonly label: string };
      readonly max: { readonly name: string; readonly label: string };
    }
);

export interface FilterBarProps {
  readonly fields: readonly FilterField[];
  readonly onSubmit?: (values: Readonly<Record<string, string>>) => void;
}

export function FilterBar(props: FilterBarProps): ReactElement {
  void props;
  throw new Error('NotImplemented: FilterBar');
}
