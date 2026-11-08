// Sync records of the order list (design-hifi AdmOrderSyncRecords; design/specs/admin-orders.md
// §1, §2; CT-24n adminListOrderSyncs): read only when 【同步记录】 is pressed, server pages
// (page / page_size only), newest first as the server gives them. Each row shows the status (the
// console dictionary name, else the code), the platform, the time window in Beijing time or the
// order numbers, the counts, who asked and when (Beijing time). Loading, empty and a failed read
// with 【重试】.
import { InboxOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Button,
  Empty,
  Flex,
  Modal,
  Result,
  Table,
  Tag,
  Typography,
  theme,
  type TableColumnsType,
  type TablePaginationConfig,
} from 'antd';
import { useEffect, useState, type ReactElement } from 'react';
import { ordersTexts } from '../../texts/orders.ts';
import {
  SYNCS_URL,
  SYNC_PAGE_SIZE,
  beijingMinute,
  beijingTime,
  failureOf,
  platformLabel,
  syncModeName,
  syncStatusName,
  syncTone,
  type SyncItem,
  type SyncPage,
} from './model.ts';

const t = ordersTexts.sync;
const dash = ordersTexts.dash;

type Status = 'loading' | 'ready' | 'failed' | 'forbidden';

export function SyncRecords({ onClose }: { readonly onClose: () => void }): ReactElement {
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<Status>('loading');
  const [data, setData] = useState<SyncPage>();

  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<SyncPage>({
      url: SYNCS_URL,
      method: 'get',
      query: { page, page_size: SYNC_PAGE_SIZE },
    }).then(
      (response) => {
        if (!current) return;
        setData(response.data);
        setStatus('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        setData(undefined);
        setStatus(failureOf(cause) === 'forbidden' ? 'forbidden' : 'failed');
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, page, attempt]);

  const retry = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  const changePage = (pagination: TablePaginationConfig) => {
    if (pagination.current === undefined || pagination.current === page) return;
    setStatus('loading');
    setPage(pagination.current);
  };

  const code = { fontFamily: token.fontFamilyCode, fontSize: token.fontSizeSM } as const;
  const nowrap = { whiteSpace: 'nowrap' } as const;

  const columns: TableColumnsType<SyncItem> = [
    {
      key: 'status',
      title: t.columns.status,
      render: (_, row) => (
        <Tag color={syncTone(row.status)} style={{ marginInlineEnd: 0 }}>
          {syncStatusName(row.status)}
        </Tag>
      ),
    },
    {
      key: 'platform',
      title: t.columns.platform,
      render: (_, row) => <span style={nowrap}>{platformLabel(row.platform)}</span>,
    },
    {
      key: 'mode',
      title: t.columns.mode,
      render: (_, row) => <span style={nowrap}>{syncModeName(row.mode)}</span>,
    },
    {
      key: 'target',
      title: t.columns.target,
      render: (_, row) =>
        row.mode !== 'order_nos' || row.order_nos === null ? (
          <Flex vertical gap={2}>
            <span style={nowrap}>{t.window(beijingMinute(row.from), beijingMinute(row.to))}</span>
            {row.status_filter === null ? null : <span style={code}>{row.status_filter}</span>}
          </Flex>
        ) : (
          <Flex vertical gap={2}>
            {row.order_nos.map((one) => (
              <span key={one} style={{ ...code, wordBreak: 'break-all' }}>
                {one}
              </span>
            ))}
          </Flex>
        ),
    },
    {
      key: 'counts',
      title: t.columns.counts,
      align: 'right',
      render: (_, row) => (
        <span style={nowrap}>{t.counts(row.fetched_count, row.stored_count)}</span>
      ),
    },
    {
      key: 'requestedBy',
      title: t.columns.requestedBy,
      render: (_, row) => row.requested_by_name ?? dash,
    },
    {
      key: 'createdAt',
      title: t.columns.createdAt,
      render: (_, row) => <span style={nowrap}>{beijingTime(row.created_at)}</span>,
    },
    {
      key: 'finishedAt',
      title: t.columns.finishedAt,
      render: (_, row) => <span style={nowrap}>{beijingTime(row.finished_at)}</span>,
    },
  ];

  let body: ReactElement;
  if (status === 'loading') {
    body = (
      <Typography.Text type="secondary" role="status">
        {t.recordsLoading}
      </Typography.Text>
    );
  } else if (status === 'forbidden') {
    body = <Result status="403" title={t.recordsForbidden} />;
  } else if (status === 'failed' || data === undefined) {
    body = (
      <Result
        status="warning"
        icon={<WarningOutlined aria-hidden style={{ color: token.colorError }} />}
        title={
          <Typography.Text type="danger" strong>
            {t.recordsFailed}
          </Typography.Text>
        }
        extra={
          <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={retry}>
            {ordersTexts.retry}
          </Button>
        }
      />
    );
  } else if (data.items.length === 0) {
    body = (
      <Empty
        image={
          <InboxOutlined aria-hidden style={{ fontSize: 28, color: token.colorTextTertiary }} />
        }
        description={t.recordsEmpty}
      />
    );
  } else {
    body = (
      <Table<SyncItem>
        rowKey="sync_id"
        size="middle"
        columns={columns}
        dataSource={data.items}
        scroll={{ x: 'max-content' }}
        pagination={{
          current: page,
          pageSize: SYNC_PAGE_SIZE,
          total: data.total,
          showSizeChanger: false,
          showTotal: (total) => ordersTexts.total(total),
        }}
        onChange={changePage}
      />
    );
  }

  return (
    <Modal
      open
      centered
      width={1040}
      title={t.recordsTitle}
      destroyOnHidden
      onCancel={onClose}
      footer={[
        <Button key="close" onClick={onClose}>
          {t.close}
        </Button>,
      ]}
    >
      {body}
    </Modal>
  );
}
