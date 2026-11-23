import type { ReactElement, ReactNode } from 'react';

type RowKey = string | number;
type PageSize = 20 | 50 | 100;

export interface DataTableProps<Row> {
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => RowKey;
  readonly columns: readonly {
    readonly key: string;
    readonly title: string;
    readonly render: (row: Row) => ReactNode;
    readonly defaultVisible?: boolean;
  }[];
  readonly storageKey: string;
  readonly total: number;
  readonly page: number;
  readonly pageSize: PageSize;
  readonly onPageChange: (page: number, pageSize: PageSize) => void;
  readonly loading?: boolean;
  readonly error?: boolean;
  readonly onRetry?: () => void;
  readonly selection?: {
    readonly selectedKeys: readonly RowKey[];
    readonly onChange: (selectedKeys: RowKey[]) => void;
  };
}

export function DataTable<Row>(props: DataTableProps<Row>): ReactElement {
  void props;
  throw new Error('NotImplemented: DataTable');
}
