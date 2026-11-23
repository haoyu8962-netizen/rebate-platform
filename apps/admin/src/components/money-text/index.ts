import type { ReactElement } from 'react';

export interface MoneyTextProps {
  readonly fen: bigint | null;
  readonly signed?: boolean;
}

export function MoneyText(props: MoneyTextProps): ReactElement {
  void props;
  throw new Error('NotImplemented: MoneyText');
}
