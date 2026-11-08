// 批次明细抽屉（listAdminSettleBatchItems）：子订单 / 补记项、类型、受益人（契约只给 user_id 与
// 角色）、联盟结算佣金 B_settle 与入账金额（分 → 元，保留负号）、结果（未执行显示 pending 的字典名）、
// 跳过原因；明细类型 / 结果筛选，页码分页。批次不存在（20001）显示未找到。只读。
import { ReloadOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Button,
  Drawer,
  Empty,
  Flex,
  Form,
  Result,
  Select,
  Table,
  Typography,
  theme,
  type TableColumnsType,
  type TablePaginationConfig,
} from 'antd';
import { useEffect, useId, useState, type ReactElement } from 'react';
import type { Schema } from '@couli/contracts-ts';
import { settleBillsTexts } from '../../texts/settle-bills.ts';
import { DictName } from './DictName.tsx';
import {
  ITEM_RESULTS,
  ITEM_TYPES,
  PAGE_SIZE,
  codeOf,
  itemResultLabel,
  itemTypeLabel,
  itemsQuery,
  itemsUrl,
  money,
  type ItemFilters,
  type SettleBatch,
  type SettleBatchItem,
  type SettleBatchItemResultFilter,
  type SettleBatchItemType,
} from './model.ts';
import { delayedLoading, useLoadingClock } from '../../motion.ts';

const t = settleBillsTexts.items;

type ItemsStatus = 'loading' | 'ready' | 'failed' | 'missing' | 'forbidden';

/** Draft of the items filter (what the selects show before 【查询】). */
interface ItemDraft {
  readonly itemType: SettleBatchItemType | undefined;
  readonly result: SettleBatchItemResultFilter | undefined;
}
const EMPTY_ITEM_DRAFT: ItemDraft = { itemType: undefined, result: undefined };

interface ItemsData {
  readonly items: readonly SettleBatchItem[];
  readonly total: number;
}

export interface BatchItemsDrawerProps {
  readonly batch: SettleBatch;
  readonly onClose: () => void;
}

export function BatchItemsDrawer({ batch, onClose }: BatchItemsDrawerProps): ReactElement {
  const loadingClock = useLoadingClock();
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const ids = { type: useId(), result: useId() };
  const [draft, setDraft] = useState<ItemDraft>(EMPTY_ITEM_DRAFT);
  const [filters, setFilters] = useState<ItemFilters>({});
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ItemsStatus>('loading');
  const [data, setData] = useState<ItemsData>();
  const batchId = batch.batch_id;

  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<Schema<'AdminSettleBatchItemPage'>>({
      url: itemsUrl(batchId),
      method: 'get',
      query: itemsQuery(filters, page),
    }).then(
      (response) => {
        if (!current) return;
        setData({ items: response.data.items, total: response.data.total });
        setStatus('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        setData(undefined);
        const code = codeOf(cause);
        setStatus(code === 20001 ? 'missing' : code === 10403 ? 'forbidden' : 'failed');
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, batchId, filters, page, attempt]);

  const reload = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };
  const runQuery = () => {
    setFilters({
      ...(draft.itemType === undefined ? {} : { itemType: draft.itemType }),
      ...(draft.result === undefined ? {} : { result: draft.result }),
    });
    setPage(1);
    reload();
  };
  const reset = () => {
    setDraft(EMPTY_ITEM_DRAFT);
    setFilters({});
    setPage(1);
    reload();
  };
  const changePage = (pagination: TablePaginationConfig) => {
    if (pagination.current === undefined || pagination.current === page) return;
    setStatus('loading');
    setPage(pagination.current);
  };

  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const secondary = { fontSize: token.fontSizeSM, color: token.colorTextSecondary } as const;
  const amount = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;

  const columns: TableColumnsType<SettleBatchItem> = [
    {
      key: 'order',
      title: t.columns.order,
      render: (_, row) => (
        <span style={{ ...code, fontSize: token.fontSizeSM }}>{row.order_id}</span>
      ),
    },
    {
      key: 'type',
      title: t.columns.type,
      render: (_, row) => <DictName>{itemTypeLabel(row.item_type)}</DictName>,
    },
    {
      key: 'beneficiary',
      title: t.columns.beneficiary,
      render: (_, row) =>
        row.user_id === null ? (
          t.noBeneficiary
        ) : (
          <Flex vertical gap={2}>
            <span style={{ ...code, fontSize: token.fontSizeSM }}>{row.user_id}</span>
            {row.role === null ? null : <span style={secondary}>{row.role}</span>}
          </Flex>
        ),
    },
    {
      key: 'settle',
      title: t.columns.settle,
      align: 'right',
      render: (_, row) => (
        <span style={amount}>
          {row.b_settle_fen === null ? t.noSettle : money(row.b_settle_fen)}
        </span>
      ),
    },
    {
      key: 'amount',
      title: t.columns.amount,
      align: 'right',
      render: (_, row) => (
        <span style={amount}>{row.amount_fen === null ? t.noAmount : money(row.amount_fen)}</span>
      ),
    },
    {
      key: 'result',
      title: t.columns.result,
      render: (_, row) => <DictName>{itemResultLabel(row.result ?? 'pending')}</DictName>,
    },
    {
      key: 'reason',
      title: t.columns.reason,
      render: (_, row) => row.skip_reason ?? settleBillsTexts.dash,
    },
  ];

  let body: ReactElement;
  if (status === 'missing' || status === 'failed' || status === 'forbidden') {
    body = (
      <Result
        status={status === 'forbidden' ? '403' : status === 'missing' ? 'warning' : 'error'}
        title={
          status === 'forbidden'
            ? settleBillsTexts.forbiddenTitle
            : status === 'missing'
              ? t.missing
              : t.failed
        }
        extra={
          status === 'failed' ? (
            <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={reload}>
              {t.retry}
            </Button>
          ) : undefined
        }
      />
    );
  } else if (data === undefined) {
    body = (
      <Typography.Text type="secondary" role="status">
        {t.loading}
      </Typography.Text>
    );
  } else {
    body = (
      <Table<SettleBatchItem>
        rowKey="id"
        columns={columns}
        dataSource={data.items as SettleBatchItem[]}
        loading={delayedLoading(status === 'loading', loadingClock)}
        scroll={{ x: 'max-content' }}
        locale={{
          emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t.empty} />,
        }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: data.total,
          showSizeChanger: false,
          showTotal: (total) => t.total(total),
        }}
        onChange={changePage}
      />
    );
  }

  return (
    <Drawer open width={960} title={t.title(batchId)} onClose={onClose}>
      <Flex vertical gap={16}>
        <Form layout="vertical" component="div">
          <Flex wrap gap={16} align="flex-end">
            <Form.Item label={t.filter.type} htmlFor={ids.type} style={{ marginBottom: 0 }}>
              <Select<SettleBatchItemType>
                id={ids.type}
                value={draft.itemType ?? null}
                allowClear
                virtual={false}
                placeholder={t.filter.all}
                style={{ width: 160 }}
                options={ITEM_TYPES.map((item) => ({ value: item, label: itemTypeLabel(item) }))}
                onChange={(value: SettleBatchItemType | undefined) =>
                  setDraft((previous) => ({ ...previous, itemType: value ?? undefined }))
                }
              />
            </Form.Item>
            <Form.Item label={t.filter.result} htmlFor={ids.result} style={{ marginBottom: 0 }}>
              <Select<SettleBatchItemResultFilter>
                id={ids.result}
                value={draft.result ?? null}
                allowClear
                virtual={false}
                placeholder={t.filter.all}
                style={{ width: 160 }}
                options={ITEM_RESULTS.map((item) => ({
                  value: item,
                  label: itemResultLabel(item),
                }))}
                onChange={(value: SettleBatchItemResultFilter | undefined) =>
                  setDraft((previous) => ({ ...previous, result: value ?? undefined }))
                }
              />
            </Form.Item>
            <Flex gap={8}>
              <Button onClick={reset}>{t.filter.reset}</Button>
              <Button type="primary" onClick={runQuery}>
                {t.filter.query}
              </Button>
            </Flex>
          </Flex>
        </Form>
        {body}
      </Flex>
    </Drawer>
  );
}
