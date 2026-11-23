import type { ReactElement } from 'react';

type StatusStyle = { readonly label: string; readonly color: string };

export interface StatusTagProps {
  readonly value: string;
  readonly mapping: Readonly<Partial<Record<string, StatusStyle>>>;
}

export function StatusTag(props: StatusTagProps): ReactElement {
  void props;
  throw new Error('NotImplemented: StatusTag');
}
