import type { ReactElement } from 'react';

export interface ProductCellProps {
  readonly title?: string | null | undefined;
  readonly imageUrl?: string | null | undefined;
  readonly platformIconUrl?: string | null | undefined;
  readonly tags?: readonly string[] | null | undefined;
  readonly amountFen?: bigint | null | undefined;
  readonly commissionRateBp?: number | null | undefined;
  readonly estimatedCommissionFen?: bigint | null | undefined;
  readonly shopName?: string | null | undefined;
  readonly paidAtText?: string | null | undefined;
}

export function ProductCell(props: ProductCellProps): ReactElement | null {
  void props;
  throw new Error('NotImplemented: ProductCell');
}
