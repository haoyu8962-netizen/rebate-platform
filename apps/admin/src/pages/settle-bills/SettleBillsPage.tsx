// 月结账单（资源 settle-bills，菜单 资金 / 月结账单；规格 admin-settle-bills.md，F1-08d 第一段只读）：
// 账单列表 GET /admin/v1/settle-bills（账单月区间 / 账单状态筛选，页码分页），【查看】进
// settle-bills/{bill_id} 详情。持 settle.bill 或 fund.view 可看；两者都没有时本页说明无权限、不发请求。
// 合计只作展示（契约 D10-280 ③），按平台照契约原样显示、不在页面上求和。
// TODO(规划/11 §7): 下一期卡（结算数据来源、【上传结算明细】）、导出 — blocked on 契约未出
import { ReloadOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Flex,
  Form,
  Input,
  Result,
  Select,
  Table,
  Tag,
  Typography,
  theme,
  type TableColumnsType,
  type TablePaginationConfig,
} from 'antd';
import { useEffect, useId, useState, type ReactElement } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { Schema } from '@couli/contracts-ts';
import { PlannedPage, usePlanned } from '../../components/planned/index.ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { settleBillsTexts as t } from '../../texts/settle-bills.ts';
import {
  BILL_STATUSES,
  EMPTY_DRAFT,
  LIST_URL,
  PAGE_SIZE,
  awaitingInSearch,
  beijingTime,
  billStatusLabel,
  checkDraft,
  codeOf,
  count,
  listQuery,
  money,
  platformEntries,
  searchWithAwaiting,
  type Draft,
  type DraftErrors,
  type Filters,
  type SettleBill,
  type SettleBillStatus,
} from './model.ts';
import { PlatformValues } from './PlatformValues.tsx';
import { DictName } from './DictName.tsx';
import { delayedLoading, useLoadingClock } from '../../motion.ts';

type ListStatus = 'loading' | 'ready' | 'failed' | 'forbidden';

interface ListData {
  readonly items: readonly SettleBill[];
  readonly total: number;
}

/** Either point reads bills (contract listAdminSettleBills). */
export function canReadSettleBills(access: AccessControl): boolean {
  return access.can('settle.bill') || access.can('fund.view');
}

export function SettleTitle(): ReactElement {
  return (
    <Typography.Title level={4} className="admin-page-title" style={{ margin: 0 }}>
      {t.title}
    </Typography.Title>
  );
}

export function SettleForbidden(): ReactElement {
  return (
    <Flex vertical gap={16}>
      <SettleTitle />
      <Card>
        <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
      </Card>
    </Flex>
  );
}

export interface SettleBillsPageProps {
  readonly access: AccessControl;
}

export function SettleBillsPage({ access }: SettleBillsPageProps): ReactElement {
  const planned = usePlanned('listAdminSettleBills');
  if (planned) return <PlannedPage title={t.title} />;
  if (!canReadSettleBills(access)) return <SettleForbidden />;
  return <SettleBillsContent />;
}

function SettleBillsContent(): ReactElement {
  const loadingClock = useLoadingClock();
  const getProvider = useDataProvider();
  const navigate = useNavigate();
  const location = useLocation();
  const { token } = theme.useToken();
  const ids = { from: useId(), to: useId(), status: useId() };
  // /settle-bills?awaiting_confirm=true (workbench card settle_bill_pending) starts with 「待确认」
  // on, so the very first read carries it. Which bills wait is the server's call (CT-24zzj).
  const [initialAwaiting] = useState(() => awaitingInSearch(location.search));
  const [draft, setDraft] = useState<Draft>(() => ({
    ...EMPTY_DRAFT,
    awaitingConfirm: initialAwaiting,
  }));
  const [draftErrors, setDraftErrors] = useState<DraftErrors>({});
  const [filters, setFilters] = useState<Filters>(() =>
    initialAwaiting ? { awaitingConfirm: true } : {},
  );
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [data, setData] = useState<ListData>();

  // The list: page `page` under the applied `filters`; `attempt` reads the same again.
  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<Schema<'AdminSettleBillPage'>>({
      url: LIST_URL,
      method: 'get',
      query: listQuery(filters, page),
    }).then(
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
  }, [getProvider, filters, page, attempt]);

  const reload = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  // The address follows the applied 「待确认」 (other parameters kept).
  const syncAddress = (awaiting: boolean) => {
    if (awaitingInSearch(location.search) === awaiting) return;
    void navigate(
      { pathname: location.pathname, search: searchWithAwaiting(location.search, awaiting) },
      { replace: true },
    );
  };

  const runQuery = () => {
    const checked = checkDraft(draft);
    if ('errors' in checked) {
      setDraftErrors(checked.errors);
      return;
    }
    setDraftErrors({});
    setFilters(checked.filters);
    setPage(1);
    syncAddress(checked.filters.awaitingConfirm === true);
    reload();
  };

  const reset = () => {
    setDraft(EMPTY_DRAFT);
    setDraftErrors({});
    setFilters({});
    setPage(1);
    syncAddress(false);
    reload();
  };

  const changePage = (pagination: TablePaginationConfig) => {
    if (pagination.current === undefined || pagination.current === page) return;
    setStatus('loading');
    setPage(pagination.current);
  };

  const amount = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;

  const columns: TableColumnsType<SettleBill> = [
    {
      key: 'month',
      title: t.columns.month,
      render: (_, row) => <span style={{ whiteSpace: 'nowrap' }}>{row.bill_id}</span>,
    },
    {
      key: 'status',
      title: t.columns.status,
      render: (_, row) => (
        <Tag style={{ marginInlineEnd: 0 }}>
          <DictName>{billStatusLabel(row.status)}</DictName>
        </Tag>
      ),
    },
    {
      key: 'generated',
      title: t.columns.generated,
      render: (_, row) => (
        <span style={{ whiteSpace: 'nowrap' }}>{beijingTime(row.generated_at)}</span>
      ),
    },
    {
      key: 'orders',
      title: t.columns.orders,
      align: 'right',
      render: (_, row) => (
        <PlatformValues
          entries={platformEntries(row.platform_order_counts)}
          format={(value) => count(value)}
        />
      ),
    },
    {
      key: 'commission',
      title: t.columns.commission,
      align: 'right',
      render: (_, row) => (
        <PlatformValues
          entries={platformEntries(row.platform_settle_commission_totals)}
          format={(value) => money(value)}
        />
      ),
    },
    {
      key: 'beneficiary',
      title: t.columns.beneficiary,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.beneficiary_total_fen)}</span>,
    },
    {
      key: 'retained',
      title: t.columns.retained,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.platform_retained_fen)}</span>,
    },
    {
      key: 'errors',
      title: t.columns.errors,
      align: 'right',
      render: (_, row) => count(row.error_count),
    },
    {
      key: 'held',
      title: t.columns.held,
      align: 'right',
      render: (_, row) => count(row.held_count),
    },
    {
      key: 'actions',
      title: t.columns.actions,
      width: 80,
      render: (_, row) => (
        <Button
          size="small"
          onClick={() => void navigate(`/settle-bills/${encodeURIComponent(row.bill_id)}`)}
        >
          {t.viewEntry}
        </Button>
      ),
    },
  ];

  const loadingLine =
    status === 'loading' ? (
      <Flex
        align="center"
        gap={8}
        style={{ padding: '12px 16px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}
      >
        <Typography.Text type="secondary" role="status">
          {t.loading}
        </Typography.Text>
      </Flex>
    ) : null;

  let body: ReactElement;
  if (status === 'forbidden') {
    body = (
      <Card title={t.listTitle}>
        <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
      </Card>
    );
  } else if (status === 'failed') {
    body = (
      <Card title={t.listTitle}>
        <Result
          status="error"
          title={t.loadFailedTitle}
          subTitle={t.loadFailedDescription}
          extra={
            <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={reload}>
              {t.retryLoad}
            </Button>
          }
        />
      </Card>
    );
  } else if (data === undefined) {
    body = (
      <Card title={t.listTitle} styles={{ body: { padding: 0 } }}>
        {loadingLine}
      </Card>
    );
  } else {
    body = (
      <Card title={t.listTitle} styles={{ body: { padding: 0 } }}>
        {loadingLine}
        <Table<SettleBill>
          rowKey="bill_id"
          columns={columns}
          dataSource={data.items as SettleBill[]}
          loading={delayedLoading(status === 'loading', loadingClock)}
          scroll={{ x: 'max-content' }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <Flex vertical align="center" gap={4}>
                    <Typography.Text strong>{t.empty}</Typography.Text>
                    <Typography.Text type="secondary">{t.emptyHint}</Typography.Text>
                  </Flex>
                }
              />
            ),
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

  const monthItem = (which: 'from' | 'to') => {
    const field = which === 'from' ? 'billFrom' : 'billTo';
    const error = draftErrors[field];
    const id = which === 'from' ? ids.from : ids.to;
    return (
      <Form.Item
        label={which === 'from' ? t.filter.billFrom : t.filter.billTo}
        htmlFor={id}
        validateStatus={error === undefined ? '' : 'error'}
        help={error}
        style={{ marginBottom: 0 }}
      >
        <Input
          id={id}
          value={draft[field]}
          placeholder={t.filter.monthPlaceholder}
          aria-invalid={error === undefined ? undefined : true}
          style={{ width: 140 }}
          onChange={(event) => {
            const value = event.target.value;
            setDraft((previous) => ({ ...previous, [field]: value }));
          }}
        />
      </Form.Item>
    );
  };

  return (
    <Flex vertical gap={16}>
      <SettleTitle />
      <Alert type="info" showIcon role="note" message={t.readOnlyNotice} />
      <Card>
        <Form layout="vertical" component="div">
          <Flex wrap gap={16} align="flex-end">
            {monthItem('from')}
            {monthItem('to')}
            <Form.Item label={t.filter.status} htmlFor={ids.status} style={{ marginBottom: 0 }}>
              <Select<SettleBillStatus>
                id={ids.status}
                value={draft.status ?? null}
                allowClear
                virtual={false}
                placeholder={t.filter.all}
                style={{ width: 160 }}
                options={BILL_STATUSES.map((item) => ({
                  value: item,
                  label: billStatusLabel(item),
                }))}
                onChange={(value: SettleBillStatus | undefined) =>
                  setDraft((previous) => ({ ...previous, status: value ?? undefined }))
                }
              />
            </Form.Item>
            <Form.Item style={{ marginBottom: 0 }}>
              <Checkbox
                checked={draft.awaitingConfirm}
                onChange={(event) => {
                  const on = event.target.checked;
                  setDraft((previous) => ({ ...previous, awaitingConfirm: on }));
                }}
              >
                {t.filter.awaitingConfirm}
              </Checkbox>
            </Form.Item>
            <Flex gap={8}>
              <Button onClick={reset}>{t.filter.reset}</Button>
              <Button type="primary" onClick={runQuery}>
                {t.filter.query}
              </Button>
            </Flex>
          </Flex>
        </Form>
      </Card>
      <Alert type="info" role="note" message={t.totalsNotice} />
      {body}
    </Flex>
  );
}
