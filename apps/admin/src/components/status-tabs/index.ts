import type { ReactElement } from 'react';

export interface StatusTabsProps {
  readonly items: readonly {
    readonly key: string;
    readonly label: string;
    readonly count?: number;
  }[];
  readonly activeKey: string;
  readonly onChange: (key: string) => void;
}

export function StatusTabs(props: StatusTabsProps): ReactElement {
  void props;
  throw new Error('NotImplemented: StatusTabs');
}
