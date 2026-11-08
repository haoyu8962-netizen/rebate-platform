// 三个只读列表共用的读取与三态（加载中 / 出错可重试 / 空列表 / 无权限）。每次读取只发一个 GET；
// 读取失败时不保留上一次的行（再查失败不显示旧数据）。
import { ReloadOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Button,
  Card,
  Empty,
  Flex,
  Result,
  Table,
  Typography,
  theme,
  type TableColumnsType,
  type TablePaginationConfig,
} from 'antd';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { payOrdersTexts as t } from '../../texts/pay-orders.ts';
import { PAGE_SIZE, codeOf } from './model.ts';
import { delayedLoading, useLoadingClock } from '../../motion.ts';

type ListStatus = 'loading' | 'ready' | 'failed' | 'forbidden';

interface Page<Row> {
  readonly items: readonly Row[];
  readonly total: number;
}

export interface PagedRead<Row> {
  readonly status: ListStatus;
  readonly data: Page<Row> | undefined;
  readonly page: number;
  /** Reads the same page again (【重试】, or after new filters were applied). */
  readonly reload: () => void;
  /** Goes to page 1 (and reads it). */
  readonly restart: () => void;
  readonly goTo: (page: number) => void;
}

/** Reads `url` page by page under the filter parameters `filters` (page and page_size added). */
export function usePagedRead<Row>(
  url: string,
  filters: Readonly<Record<string, string>>,
): PagedRead<Row> {
  const filterKey = JSON.stringify(filters);
  const getProvider = useDataProvider();
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [data, setData] = useState<Page<Row>>();

  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    const query = {
      page,
      page_size: PAGE_SIZE,
      ...(JSON.parse(filterKey) as Record<string, string>),
    };
    custom<Page<Row>>({ url, method: 'get', query }).then(
      (response) => {
        if (!current) return;
        setData({ items: response.data.items, total: response.data.total });
        setStatus('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        // A failed read never keeps the rows of an earlier answer on screen.
        setData(undefined);
        setStatus(codeOf(cause) === 10403 ? 'forbidden' : 'failed');
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, url, filterKey, page, attempt]);

  const reload = useCallback(() => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  }, []);
  const restart = useCallback(() => {
    setStatus('loading');
    setPage(1);
    setAttempt((value) => value + 1);
  }, []);
  const goTo = useCallback((next: number) => {
    setStatus('loading');
    setPage(next);
  }, []);
  return { status, data, page, reload, restart, goTo };
}

export interface PagedTableProps<Row> {
  readonly read: PagedRead<Row>;
  readonly title: string;
  readonly rowKey: keyof Row & string;
  readonly columns: TableColumnsType<Row>;
  readonly loadingText: string;
  readonly failedText: string;
  readonly emptyText: string;
}

/** The list card of a read: forbidden, failed with 【重试】, loading, or the table with paging. */
export function PagedTable<Row extends object>({
  read,
  title,
  rowKey,
  columns,
  loadingText,
  failedText,
  emptyText,
}: PagedTableProps<Row>): ReactElement {
  const loadingClock = useLoadingClock();
  const { token } = theme.useToken();
  const { status, data, page } = read;

  if (status === 'forbidden') {
    return (
      <Card title={title}>
        <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
      </Card>
    );
  }
  if (status === 'failed') {
    return (
      <Card title={title}>
        <Result
          status="error"
          title={failedText}
          subTitle={t.orders.failedHint}
          extra={
            <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={read.reload}>
              {t.retry}
            </Button>
          }
        />
      </Card>
    );
  }
  const loadingLine =
    status === 'loading' ? (
      <Flex
        align="center"
        gap={8}
        style={{ padding: '12px 16px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}
      >
        <Typography.Text type="secondary" role="status">
          {loadingText}
        </Typography.Text>
      </Flex>
    ) : null;
  if (data === undefined) {
    return (
      <Card title={title} styles={{ body: { padding: 0 } }}>
        {loadingLine}
      </Card>
    );
  }
  const changePage = (pagination: TablePaginationConfig) => {
    if (pagination.current === undefined || pagination.current === page) return;
    read.goTo(pagination.current);
  };
  return (
    <Card title={title} styles={{ body: { padding: 0 } }}>
      {loadingLine}
      <Table<Row>
        rowKey={rowKey}
        columns={columns}
        dataSource={data.items as Row[]}
        loading={delayedLoading(status === 'loading', loadingClock)}
        scroll={{ x: 'max-content' }}
        locale={{
          emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyText} />,
        }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: data.total,
          showSizeChanger: false,
          showTotal: (total) => t.total(total),
          style: { paddingInline: 16 },
        }}
        onChange={changePage}
      />
    </Card>
  );
}
