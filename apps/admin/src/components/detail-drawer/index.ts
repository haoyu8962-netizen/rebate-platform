import type { ReactElement, ReactNode } from 'react';

export interface DetailDrawerProps {
  readonly open: boolean;
  readonly title: string;
  readonly groups: readonly {
    readonly key: string;
    readonly title: string;
    readonly fields: readonly {
      readonly key: string;
      readonly label: string;
      readonly value: ReactNode;
    }[];
  }[];
  readonly onClose: () => void;
}

export function DetailDrawer(props: DetailDrawerProps): ReactElement | null {
  void props;
  throw new Error('NotImplemented: DetailDrawer');
}
