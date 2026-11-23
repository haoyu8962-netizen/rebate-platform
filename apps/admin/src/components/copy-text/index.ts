import type { ReactElement } from 'react';

export interface CopyTextProps {
  readonly text: string;
  readonly maxLength?: number;
}

export function CopyText(props: CopyTextProps): ReactElement {
  void props;
  throw new Error('NotImplemented: CopyText');
}
