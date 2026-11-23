// F1-07ec: the shared admin list table. Paging is driven by the caller (`total`, `page`,
// `pageSize`); a click on the pager only asks for another page or page size (20 / 50 / 100) and
// shows it once the caller passes it back. Loading, failed (with an optional retry handed to the
// caller) and empty states are distinct. 「列设置」 lets the user hide, show and reorder columns;
// the setting is kept per `storageKey` (./columns.ts) and a change the storage refuses is not
// applied. Row selection is optional and reports the complete set of selected row keys.
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Flex,
  Pagination,
  Table,
  Typography,
  type TableColumnsType,
} from 'antd';
import { useState, type ReactElement, type ReactNode } from 'react';
import { delayedLoading, useLoadingClock } from '../../motion.ts';
import { componentsTexts } from '../../texts/components.ts';
import {
  defaultSettings,
  readSettings,
  reconcile,
  writeSettings,
  type ColumnSettings,
} from './columns.ts';

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

const t = componentsTexts.dataTable;
const PAGE_SIZES: readonly PageSize[] = [20, 50, 100];

function isPageSize(size: number): size is PageSize {
  return (PAGE_SIZES as readonly number[]).includes(size);
}

function isRowKey(key: unknown): key is RowKey {
  return typeof key === 'string' || typeof key === 'number';
}

interface Entry<Row> {
  readonly key: RowKey;
  readonly row: Row;
}

export function DataTable<Row>({
  rows,
  rowKey,
  columns,
  storageKey,
  total,
  page,
  pageSize,
  onPageChange,
  loading = false,
  error = false,
  onRetry,
  selection,
}: DataTableProps<Row>): ReactElement {
  const loadingClock = useLoadingClock();
  const [stored, setStored] = useState<{
    readonly storageKey: string;
    readonly settings: ColumnSettings | undefined;
  }>(() => ({ storageKey, settings: readSettings(storageKey, columns) }));
  // Another table (storageKey) in the same place: read its own setting.
  if (stored.storageKey !== storageKey)
    setStored({ storageKey, settings: readSettings(storageKey, columns) });
  const [settingsOpen, setSettingsOpen] = useState(false);

  const saved = stored.storageKey === storageKey ? stored.settings : undefined;
  const settings = reconcile(saved ?? defaultSettings(columns), columns);
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const visibleCount = settings.filter((setting) => setting.visible).length;

  const apply = (next: ColumnSettings): void => {
    // Only a setting the storage accepted is shown, so the table never differs from what is kept.
    if (writeSettings(storageKey, next)) setStored({ storageKey, settings: next });
  };
  const toggle = (key: string): void =>
    apply(
      settings.map((setting) =>
        setting.key === key ? { key, visible: !setting.visible } : setting,
      ),
    );
  const move = (index: number, offset: -1 | 1): void => {
    const target = index + offset;
    if (target < 0 || target >= settings.length) return;
    const next = [...settings];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(target, 0, moved);
    apply(next);
  };

  const tableColumns: TableColumnsType<Entry<Row>> = settings.flatMap((setting) => {
    const column = byKey.get(setting.key);
    if (column === undefined || !setting.visible) return [];
    return [
      {
        key: column.key,
        title: column.title,
        render: (_value: unknown, entry: Entry<Row>) => column.render(entry.row),
      },
    ];
  });
  const entries: Entry<Row>[] = rows.map((row) => ({ key: rowKey(row), row }));

  const failure = (
    <Flex vertical align="center" gap="small">
      <Typography.Text type="danger">{t.loadFailed}</Typography.Text>
      {onRetry !== undefined ? <Button onClick={onRetry}>{t.retry}</Button> : null}
    </Flex>
  );

  return (
    <Flex vertical gap="small">
      <Flex justify="flex-end">
        <Button aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}>
          {t.columnSettings}
        </Button>
      </Flex>
      {settingsOpen ? (
        <Card size="small">
          <Flex vertical gap="small">
            {settings.map((setting, index) => {
              const column = byKey.get(setting.key);
              if (column === undefined) return null;
              return (
                <Flex key={setting.key} align="center" gap="small">
                  <Checkbox
                    checked={setting.visible}
                    disabled={setting.visible && visibleCount <= 1}
                    onChange={() => toggle(setting.key)}
                  >
                    {column.title}
                  </Checkbox>
                  <Button
                    type="text"
                    size="small"
                    aria-label={t.moveUp(column.title)}
                    icon={<ArrowUpOutlined />}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  />
                  <Button
                    type="text"
                    size="small"
                    aria-label={t.moveDown(column.title)}
                    icon={<ArrowDownOutlined />}
                    disabled={index === settings.length - 1}
                    onClick={() => move(index, 1)}
                  />
                </Flex>
              );
            })}
          </Flex>
        </Card>
      ) : null}
      {error && entries.length > 0 ? (
        <Alert
          type="error"
          showIcon
          message={t.loadFailed}
          action={
            onRetry !== undefined ? (
              <Button size="small" onClick={onRetry}>
                {t.retry}
              </Button>
            ) : undefined
          }
        />
      ) : null}
      <Table<Entry<Row>>
        rowKey="key"
        dataSource={entries}
        columns={tableColumns}
        pagination={false}
        loading={delayedLoading(loading, loadingClock)}
        locale={{ emptyText: error ? failure : t.empty }}
        rowSelection={
          selection === undefined
            ? undefined
            : {
                selectedRowKeys: [...selection.selectedKeys],
                preserveSelectedRowKeys: true,
                onChange: (keys) => selection.onChange(keys.filter(isRowKey)),
              }
        }
      />
      <Flex justify="flex-end">
        <Pagination
          current={page}
          pageSize={pageSize}
          total={total}
          showSizeChanger
          pageSizeOptions={[...PAGE_SIZES]}
          showTotal={t.total}
          onChange={(nextPage, nextSize) => {
            if (isPageSize(nextSize)) onPageChange(nextPage, nextSize);
          }}
        />
      </Flex>
    </Flex>
  );
}
