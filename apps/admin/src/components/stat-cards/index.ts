import type { ReactElement } from 'react';

type FilterValue = Readonly<Record<string, string>>;

type StatCard = {
  readonly key: string;
  readonly label: string;
  readonly filterValue?: FilterValue;
} & (
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'money'; readonly fen: bigint | null; readonly signed?: boolean }
);

export interface StatCardsProps {
  readonly cards: readonly StatCard[];
  readonly initialVisibleCount?: number;
  readonly onSelect?: (filterValue: FilterValue) => void;
}

export function StatCards(props: StatCardsProps): ReactElement {
  void props;
  throw new Error('NotImplemented: StatCards');
}
