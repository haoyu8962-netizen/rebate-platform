// 平台资金台账（资源 fund-ledger，菜单 资金 / 平台资金台账；规格 admin-fund-dashboard.md，F1-08ga
// 只读段）：按日台账 = 资产快照列表 GET /admin/v1/asset-snapshots（快照日期区间筛选，页码分页）。
// 读要 fund.view（菜单仍只认 fund.cash_entry，只持 fund.view 时直达地址可看）；没有时本页说明无权限、
// 不发请求。金额照快照原样显示、不在页面上求和；没写快照的日子没有行。
// TODO(规划/11 §7): 台账概览卡、垫资水位（W / P / 状态）、联盟回款记录、【录入企业支付宝余额】【录入联盟回款】、导出 — blocked on 契约未出
import { ReloadOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Empty,
  Flex,
  Form,
  Input,
  Result,
  Table,
  Tag,
  Typography,
  theme,
  type TableColumnsType,
  type TablePaginationConfig,
} from 'antd';
import { useEffect, useId, useState, type ReactElement } from 'react';
import { PlannedPage, usePlanned } from '../../components/planned/index.ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { fundLedgerTexts as t } from '../../texts/fund-ledger.ts';
import {
  EMPTY_DRAFT,
  LIST_URL,
  PAGE_SIZE,
  checkDraft,
  codeOf,
  listQuery,
  money,
  platformLabel,
  rejectedFields,
  type AssetSnapshot,
  type AssetSnapshotPage,
  type AssetSnapshotReceivable,
  type Draft,
  type DraftErrors,
  type Filters,
} from './model.ts';
import { delayedLoading, useLoadingClock } from '../../motion.ts';

type ListStatus = 'loading' | 'ready' | 'failed' | 'invalid' | 'forbidden';

interface ListData {
  readonly items: readonly AssetSnapshot[];
  readonly total: number;
}

/** fund.view reads the snapshots (contract listAdminAssetSnapshots). */
export function canReadFundLedger(access: AccessControl): boolean {
  return access.can('fund.view');
}

function LedgerTitle(): ReactElement {
  return (
    <Typography.Title level={4} className="admin-page-title" style={{ margin: 0 }}>
      {t.title}
    </Typography.Title>
  );
}

function ReadOnlyNotice(): ReactElement {
  return <Alert type="info" showIcon role="note" message={t.readOnlyNotice} />;
}

function LedgerForbidden(): ReactElement {
  return (
    <Flex vertical gap={16}>
      <LedgerTitle />
      <ReadOnlyNotice />
      <Card>
        <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
      </Card>
    </Flex>
  );
}

export interface FundLedgerPageProps {
  readonly access: AccessControl;
}

export function FundLedgerPage({ access }: FundLedgerPageProps): ReactElement {
  const planned = usePlanned('listAdminAssetSnapshots');
  if (planned) return <PlannedPage title={t.title} />;
  if (!canReadFundLedger(access)) return <LedgerForbidden />;
  return <FundLedgerContent />;
}

const amountStyle = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;

/** Each platform's receivable as the snapshot wrote it (contract order); none shows the dash. */
function Receivables({
  items,
}: {
  readonly items: readonly AssetSnapshotReceivable[];
}): ReactElement {
  if (items.length === 0) return <span>{t.dash}</span>;
  return (
    <Flex vertical gap={2}>
      {items.map((item) => (
        <span key={item.platform} style={amountStyle}>
          <Typography.Text type="secondary">{platformLabel(item.platform)}</Typography.Text>{' '}
          <span>{money(item.union_receivable_fen)}</span>
        </span>
      ))}
    </Flex>
  );
}

function FundLedgerContent(): ReactElement {
  const loadingClock = useLoadingClock();
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const ids = { from: useId(), to: useId() };
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [draftErrors, setDraftErrors] = useState<DraftErrors>({});
  const [filters, setFilters] = useState<Filters>({});
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [data, setData] = useState<ListData>();

  // The list: page `page` under the applied `filters`; `attempt` reads the same again.
  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<AssetSnapshotPage>({
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
        const code = codeOf(cause);
        if (code === 10403) {
          setStatus('forbidden');
        } else if (code === 20001) {
          // 20001 (date format, or date_from after date_to): the notice goes next to the dates.
          const fields = rejectedFields(cause);
          const errors: { dateFrom?: string; dateTo?: string } = {};
          if (fields.length === 0 || fields.includes('date_from'))
            errors.dateFrom = t.filter.serverInvalid;
          if (fields.length === 0 || fields.includes('date_to'))
            errors.dateTo = t.filter.serverInvalid;
          setDraftErrors(errors);
          setStatus('invalid');
        } else {
          setStatus('failed');
        }
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

  const runQuery = () => {
    const checked = checkDraft(draft);
    if ('errors' in checked) {
      setDraftErrors(checked.errors);
      return;
    }
    setDraftErrors({});
    setFilters(checked.filters);
    setPage(1);
    reload();
  };

  const reset = () => {
    setDraft(EMPTY_DRAFT);
    setDraftErrors({});
    setFilters({});
    setPage(1);
    reload();
  };

  const changePage = (pagination: TablePaginationConfig) => {
    if (pagination.current === undefined || pagination.current === page) return;
    setStatus('loading');
    setPage(pagination.current);
  };

  const columns: TableColumnsType<AssetSnapshot> = [
    {
      key: 'date',
      title: t.columns.date,
      render: (_, row) => (
        <Flex gap={8} align="center" wrap={false}>
          <span style={{ whiteSpace: 'nowrap' }}>{row.snapshot_date}</span>
          {row.waiting_comparable ? null : (
            <Tag color="warning" title={t.notComparableHint} style={{ marginInlineEnd: 0 }}>
              {t.notComparable}
            </Tag>
          )}
        </Flex>
      ),
    },
    {
      key: 'available',
      title: t.columns.available,
      align: 'right',
      render: (_, row) => (
        <span style={amountStyle}>{money(row.total_available_positive_fen)}</span>
      ),
    },
    {
      key: 'negative',
      title: t.columns.negative,
      align: 'right',
      render: (_, row) => <span style={amountStyle}>{money(row.total_negative_fen)}</span>,
    },
    {
      key: 'frozen',
      title: t.columns.frozen,
      align: 'right',
      render: (_, row) => <span style={amountStyle}>{money(row.total_frozen_fen)}</span>,
    },
    {
      key: 'waiting',
      title: t.columns.waiting,
      align: 'right',
      render: (_, row) => <span style={amountStyle}>{money(row.total_waiting_fen)}</span>,
    },
    {
      key: 'estimated',
      title: t.columns.estimated,
      align: 'right',
      render: (_, row) => <span style={amountStyle}>{money(row.total_estimated_fen)}</span>,
    },
    // Last: the dash of a day without receivables never runs into an amount after it.
    {
      key: 'receivables',
      title: t.columns.receivables,
      align: 'right',
      render: (_, row) => <Receivables items={row.receivables} />,
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
  } else if (status === 'invalid') {
    body = (
      <Card title={t.listTitle}>
        <Result status="warning" title={t.invalidTitle} subTitle={t.invalidDescription} />
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
        <Table<AssetSnapshot>
          rowKey="snapshot_date"
          columns={columns}
          dataSource={data.items as AssetSnapshot[]}
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

  const dayItem = (which: 'from' | 'to') => {
    const field = which === 'from' ? 'dateFrom' : 'dateTo';
    const error = draftErrors[field];
    const id = which === 'from' ? ids.from : ids.to;
    return (
      <Form.Item
        label={which === 'from' ? t.filter.dateFrom : t.filter.dateTo}
        htmlFor={id}
        validateStatus={error === undefined ? '' : 'error'}
        help={error}
        style={{ marginBottom: 0 }}
      >
        <Input
          id={id}
          value={draft[field]}
          placeholder={t.filter.datePlaceholder}
          aria-invalid={error === undefined ? undefined : true}
          style={{ width: 160 }}
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
      <LedgerTitle />
      <ReadOnlyNotice />
      <Card>
        <Form layout="vertical" component="div">
          <Flex wrap gap={16} align="flex-end">
            {dayItem('from')}
            {dayItem('to')}
            <Flex gap={8}>
              <Button onClick={reset}>{t.filter.reset}</Button>
              <Button type="primary" onClick={runQuery}>
                {t.filter.query}
              </Button>
            </Flex>
          </Flex>
        </Form>
      </Card>
      <Alert type="info" role="note" message={t.snapshotNotice} />
      {body}
    </Flex>
  );
}
