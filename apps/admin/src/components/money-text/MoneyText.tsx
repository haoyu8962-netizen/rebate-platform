// F1-07ec: an amount in integer fen shown with formatYuanAdmin (@couli/money); null shows the
// placeholder, even when `signed` is set. The prop type stays `bigint | null`: never a number.
import { formatYuanAdmin } from '@couli/money';
import type { ReactElement } from 'react';
import { componentsTexts } from '../../texts/components.ts';

export interface MoneyTextProps {
  readonly fen: bigint | null;
  readonly signed?: boolean;
}

export function MoneyText({ fen, signed = false }: MoneyTextProps): ReactElement {
  return (
    <span className="tabular-nums">
      {fen === null ? componentsTexts.placeholder : formatYuanAdmin(fen, { signed })}
    </span>
  );
}
