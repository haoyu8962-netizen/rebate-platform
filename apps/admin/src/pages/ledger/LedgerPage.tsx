// 余额流水（资源 ledger，菜单 资金 / 余额流水；F1-08fa 只读）：按用户 UID 读资金摘要
// （adminGetUserFundSummary）与该用户的余额流水（adminListLedgerEntries，页码分页，筛选：流水类型、
// 子类型、子户、会计日起止、业务单号）。读要 fund.view 或 user.lookup（菜单仍只认 fund.view，只持
// user.lookup 时直达地址可用）；都没有时本页说明无权限、不发请求。只读：整页只发 GET，唯一入口是
// 【导出记录】（跳 /exports），不出【导出当前筛选】（编排 D10-1740）。金额经 @couli/money 显示，
// 不在页面上求和或重算。
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
  Select,
  Table,
  Typography,
  theme,
  type TableColumnsType,
} from 'antd';
import { useEffect, useId, useState, type ReactElement, type ReactNode } from 'react';
import { Link } from 'react-router';
import { PlannedPage, usePlanned } from '../../components/planned/index.ts';
import { delayedLoading, useLoadingClock } from '../../motion.ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { ledgerTexts as t } from '../../texts/ledger.ts';
import {
  EMPTY_DRAFT,
  LEDGER_TYPES,
  LEDGER_URL,
  PAGE_SIZE,
  SUB_ACCOUNTS,
  beijingTime,
  checkDraft,
  failureOf,
  holdKindName,
  ledgerQuery,
  ledgerTypeName,
  money,
  signedMoney,
  subAccountName,
  summaryUrl,
  type Draft,
  type DraftErrors,
  type Filters,
  type FundSummary,
  type LedgerEntry,
  type LedgerEntryPage,
} from './model.ts';

/** fund.view or user.lookup reads both operations (contract). */
export function canReadLedger(access: AccessControl): boolean {
  return access.can('fund.view') || access.can('user.lookup');
}

type SummaryState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly data: FundSummary };

type LedgerState =
  | { readonly status: 'loading'; readonly data?: LedgerEntryPage }
  | { readonly status: 'failed' }
  | { readonly status: 'invalid' }
  | { readonly status: 'ready'; readonly data: LedgerEntryPage };

function LedgerTitle({ extra }: { readonly extra?: ReactNode }): ReactElement {
  return (
    <Flex justify="space-between" align="center" gap={16} wrap>
      <Typography.Title level={4} className="admin-page-title" style={{ margin: 0 }}>
        {t.title}
      </Typography.Title>
      {extra}
    </Flex>
  );
}

function Forbidden(): ReactElement {
  return <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />;
}

export interface LedgerPageProps {
  readonly access: AccessControl;
}

export function LedgerPage({ access }: LedgerPageProps): ReactElement {
  const planned = usePlanned('adminListLedgerEntries');
  if (planned) return <PlannedPage title={t.title} />;
  if (!canReadLedger(access))
    return (
      <Flex vertical gap={16}>
        <LedgerTitle />
        <Card>
          <Forbidden />
        </Card>
      </Flex>
    );
  return <LedgerContent />;
}

const amountStyle = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;
const nowrap = { whiteSpace: 'nowrap' } as const;

function holdText(summary: FundSummary): string {
  const { blocked, hold_kinds: kinds } = summary.withdraw_block;
  if (!blocked) return t.summary.noHold;
  if (kinds.length === 0) return t.dash;
  return kinds.map((kind) => holdKindName(kind)).join(t.summary.holdJoiner);
}

/** The summary as label / value pairs (dt / dd, not a table: the page has one table, the ledger). */
function SummaryList({
  items,
}: {
  readonly items: readonly (readonly [string, string])[];
}): ReactElement {
  const { token } = theme.useToken();
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))',
        gap: token.marginSM,
        margin: 0,
      }}
    >
      {items.map(([label, value]) => (
        <Flex key={label} gap={token.marginXS} align="baseline" wrap>
          <dt style={{ color: token.colorTextSecondary, margin: 0 }}>{label}</dt>
          <dd style={{ margin: 0, ...amountStyle }}>{value}</dd>
        </Flex>
      ))}
    </dl>
  );
}

const columns: TableColumnsType<LedgerEntry> = [
  {
    key: 'booked_at',
    title: t.columns.bookedAt,
    render: (_, row) => <span style={nowrap}>{beijingTime(row.booked_at)}</span>,
  },
  {
    key: 'accounting_date',
    title: t.columns.accountingDate,
    render: (_, row) => <span style={nowrap}>{row.accounting_date}</span>,
  },
  {
    key: 'ledger_type',
    title: t.columns.ledgerType,
    render: (_, row) => ledgerTypeName(row.ledger_type),
  },
  {
    key: 'sub_type',
    title: t.columns.subType,
    render: (_, row) => row.sub_type ?? t.dash,
  },
  {
    key: 'sub_account',
    title: t.columns.subAccount,
    render: (_, row) => subAccountName(row.sub_account),
  },
  {
    key: 'amount',
    title: t.columns.amount,
    align: 'right',
    render: (_, row) => <span style={amountStyle}>{signedMoney(row.amount_fen)}</span>,
  },
  {
    key: 'balance_after',
    title: t.columns.balanceAfter,
    align: 'right',
    render: (_, row) => (
      <span style={amountStyle}>
        {row.balance_after_fen === null ? t.dash : money(row.balance_after_fen)}
      </span>
    ),
  },
  {
    key: 'voucher',
    title: t.columns.voucher,
    render: (_, row) => <span style={nowrap}>{row.voucher.uniq_key}</span>,
  },
  {
    key: 'biz_id',
    title: t.columns.bizId,
    render: (_, row) => <span style={nowrap}>{row.voucher.biz_id}</span>,
  },
];

function LedgerContent(): ReactElement {
  const loadingClock = useLoadingClock();
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const ids = {
    uid: useId(),
    ledgerType: useId(),
    subType: useId(),
    subAccount: useId(),
    dateFrom: useId(),
    dateTo: useId(),
    ref: useId(),
  };
  const [uidDraft, setUidDraft] = useState('');
  const [uidError, setUidError] = useState<string>();
  const [userId, setUserId] = useState<string>();
  // Bumped by every 【查询】 of the UID form: both reads start afresh, earlier answers are dropped.
  const [generation, setGeneration] = useState(0);
  const [forbidden, setForbidden] = useState(false);
  const [summary, setSummary] = useState<SummaryState>({ status: 'loading' });
  const [summaryAttempt, setSummaryAttempt] = useState(0);
  const [ledger, setLedger] = useState<LedgerState>({ status: 'loading' });
  const [ledgerAttempt, setLedgerAttempt] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [draftErrors, setDraftErrors] = useState<DraftErrors>({});
  const [filters, setFilters] = useState<Filters>({});
  const [page, setPage] = useState(1);

  // The fund summary of the queried user; `summaryAttempt` reads it again (【重试】).
  useEffect(() => {
    if (userId === undefined) return undefined;
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<FundSummary>({ url: summaryUrl(userId), method: 'get' }).then(
      (response) => {
        if (current) setSummary({ status: 'ready', data: response.data });
      },
      (cause: unknown) => {
        if (!current) return;
        const failure = failureOf(cause);
        if (failure === 'uid') {
          // user_id rejected (unknown, malformed, of another app): nothing of it stays on screen.
          setUidError(t.uid.unknown);
          setUserId(undefined);
        } else if (failure === 'forbidden') setForbidden(true);
        else setSummary({ status: 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, userId, generation, summaryAttempt]);

  // The ledger of the queried user: page `page` under the applied `filters`; `ledgerAttempt`
  // reads the same again (filter 【查询】【重置】, 【重试】).
  useEffect(() => {
    if (userId === undefined) return undefined;
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<LedgerEntryPage>({
      url: LEDGER_URL,
      method: 'get',
      query: ledgerQuery(userId, filters, page),
    }).then(
      (response) => {
        if (current) setLedger({ status: 'ready', data: response.data });
      },
      (cause: unknown) => {
        if (!current) return;
        const failure = failureOf(cause);
        // A failed read never keeps the rows of an earlier answer on screen.
        if (failure === 'uid') {
          // user_id rejected (unknown, malformed, of another app): nothing of it stays on screen.
          setUidError(t.uid.unknown);
          setUserId(undefined);
        } else if (failure === 'forbidden') setForbidden(true);
        else setLedger(failure === 'invalid' ? { status: 'invalid' } : { status: 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, userId, generation, filters, page, ledgerAttempt]);

  const queryUser = () => {
    const value = uidDraft.trim();
    if (value === '') {
      setUidError(t.uid.required);
      return;
    }
    setUidError(undefined);
    setForbidden(false);
    setUserId(value);
    setGeneration((count) => count + 1);
    setSummary({ status: 'loading' });
    setLedger({ status: 'loading' });
    setDraft(EMPTY_DRAFT);
    setDraftErrors({});
    setFilters({});
    setPage(1);
  };

  const rereadLedger = () => {
    setLedger((previous) =>
      previous.status === 'ready'
        ? { status: 'loading', data: previous.data }
        : { status: 'loading' },
    );
    setLedgerAttempt((count) => count + 1);
  };

  const applyFilters = () => {
    const checked = checkDraft(draft);
    if ('errors' in checked) {
      setDraftErrors(checked.errors);
      return;
    }
    setDraftErrors({});
    setFilters(checked.filters);
    setPage(1);
    rereadLedger();
  };

  const resetFilters = () => {
    setDraft(EMPTY_DRAFT);
    setDraftErrors({});
    setFilters({});
    setPage(1);
    rereadLedger();
  };

  const retrySummary = () => {
    setSummary({ status: 'loading' });
    setSummaryAttempt((count) => count + 1);
  };

  const changePage = (next: number) => {
    if (next === page) return;
    setLedger((previous) =>
      previous.status === 'ready'
        ? { status: 'loading', data: previous.data }
        : { status: 'loading' },
    );
    setPage(next);
  };

  const uidForm = (
    <Card>
      <Form layout="vertical">
        <Flex wrap gap={16} align="flex-end">
          <Form.Item
            label={t.uid.label}
            htmlFor={ids.uid}
            validateStatus={uidError === undefined ? '' : 'error'}
            help={uidError}
            style={{ marginBottom: 0 }}
          >
            <Input
              id={ids.uid}
              value={uidDraft}
              placeholder={t.uid.placeholder}
              aria-invalid={uidError === undefined ? undefined : true}
              style={{ width: 360 }}
              onChange={(event) => setUidDraft(event.target.value)}
              onPressEnter={(event) => {
                event.preventDefault();
                queryUser();
              }}
            />
          </Form.Item>
          <Button type="primary" onClick={queryUser}>
            {t.query}
          </Button>
        </Flex>
      </Form>
    </Card>
  );

  const header = (
    <>
      <LedgerTitle extra={<Link to="/exports">{t.exportsEntry}</Link>} />
      <Alert type="info" showIcon role="note" message={t.readOnlyNotice} />
      {uidForm}
    </>
  );

  if (userId === undefined)
    return (
      <Flex vertical gap={16}>
        {header}
      </Flex>
    );

  if (forbidden)
    return (
      <Flex vertical gap={16}>
        {header}
        <Card>
          <Forbidden />
        </Card>
      </Flex>
    );

  const loadingLine = (text: string) => (
    <Flex
      align="center"
      gap={8}
      aria-busy
      style={{
        paddingBlock: token.paddingSM,
        paddingInline: token.padding,
        borderBottom: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
      }}
    >
      <Typography.Text type="secondary" role="status">
        {text}
      </Typography.Text>
    </Flex>
  );

  let summaryBody: ReactElement;
  if (summary.status === 'loading') {
    summaryBody = loadingLine(t.summary.loading);
  } else if (summary.status === 'failed') {
    summaryBody = (
      <Result
        status="error"
        title={t.summary.failed}
        subTitle={t.summary.failedHint}
        extra={
          <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={retrySummary}>
            {t.retry}
          </Button>
        }
      />
    );
  } else {
    const data = summary.data;
    summaryBody = (
      <SummaryList
        items={[
          [t.summary.userId, data.user_id],
          [t.summary.available, money(data.available_fen)],
          [t.summary.frozen, money(data.frozen_fen)],
          [t.summary.negativeSince, data.negative_since ?? t.dash],
          [t.summary.withdrawn, money(data.withdrawn_fen)],
          [t.summary.block, holdText(data)],
        ]}
      />
    );
  }

  const dayItem = (field: 'dateFrom' | 'dateTo') => {
    const error = draftErrors[field];
    const id = field === 'dateFrom' ? ids.dateFrom : ids.dateTo;
    return (
      <Form.Item
        label={field === 'dateFrom' ? t.filter.dateFrom : t.filter.dateTo}
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
          style={{ width: 140 }}
          onChange={(event) => {
            const value = event.target.value;
            setDraft((previous) => ({ ...previous, [field]: value }));
          }}
        />
      </Form.Item>
    );
  };

  const filterForm = (
    <Form layout="vertical">
      <Flex wrap gap={16} align="flex-end">
        <Form.Item label={t.filter.ledgerType} htmlFor={ids.ledgerType} style={{ marginBottom: 0 }}>
          <Select
            id={ids.ledgerType}
            value={draft.ledgerType}
            placeholder={t.filter.all}
            allowClear
            virtual={false}
            popupMatchSelectWidth={false}
            style={{ width: 180 }}
            options={LEDGER_TYPES.map((code) => ({ value: code, label: ledgerTypeName(code) }))}
            onChange={(value) => setDraft((previous) => ({ ...previous, ledgerType: value }))}
          />
        </Form.Item>
        <Form.Item label={t.filter.subType} htmlFor={ids.subType} style={{ marginBottom: 0 }}>
          <Input
            id={ids.subType}
            value={draft.subType}
            placeholder={t.filter.subTypePlaceholder}
            style={{ width: 160 }}
            onChange={(event) => {
              const value = event.target.value;
              setDraft((previous) => ({ ...previous, subType: value }));
            }}
          />
        </Form.Item>
        <Form.Item label={t.filter.subAccount} htmlFor={ids.subAccount} style={{ marginBottom: 0 }}>
          <Select
            id={ids.subAccount}
            value={draft.subAccount}
            placeholder={t.filter.all}
            allowClear
            virtual={false}
            style={{ width: 120 }}
            options={SUB_ACCOUNTS.map((code) => ({ value: code, label: subAccountName(code) }))}
            onChange={(value) => setDraft((previous) => ({ ...previous, subAccount: value }))}
          />
        </Form.Item>
        {dayItem('dateFrom')}
        {dayItem('dateTo')}
        <Form.Item label={t.filter.ref} htmlFor={ids.ref} style={{ marginBottom: 0 }}>
          <Input
            id={ids.ref}
            value={draft.ref}
            placeholder={t.filter.refPlaceholder}
            style={{ width: 300 }}
            onChange={(event) => {
              const value = event.target.value;
              setDraft((previous) => ({ ...previous, ref: value }));
            }}
          />
        </Form.Item>
        <Flex gap={8}>
          <Button onClick={resetFilters}>{t.reset}</Button>
          <Button type="primary" onClick={applyFilters}>
            {t.query}
          </Button>
        </Flex>
      </Flex>
    </Form>
  );

  let ledgerBody: ReactElement;
  if (ledger.status === 'failed') {
    ledgerBody = (
      <Result
        status="error"
        title={t.list.failed}
        subTitle={t.list.failedHint}
        extra={
          <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={rereadLedger}>
            {t.retry}
          </Button>
        }
      />
    );
  } else if (ledger.status === 'invalid') {
    ledgerBody = <Result status="warning" title={t.list.invalid} />;
  } else if (ledger.data === undefined) {
    ledgerBody = loadingLine(t.list.loading);
  } else {
    const data = ledger.data;
    ledgerBody = (
      <Table<LedgerEntry>
        rowKey="entry_id"
        columns={columns}
        dataSource={data.items}
        loading={delayedLoading(ledger.status === 'loading', loadingClock)}
        scroll={{ x: 'max-content' }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={<Typography.Text>{t.list.empty}</Typography.Text>}
            />
          ),
        }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: data.total,
          showSizeChanger: false,
          showTotal: (total) => t.list.total(total),
          style: { paddingInline: token.padding },
          onChange: changePage,
        }}
      />
    );
  }

  return (
    <Flex vertical gap={16}>
      {header}
      <Card title={t.summary.title}>{summaryBody}</Card>
      <Card>{filterForm}</Card>
      <Card title={t.list.title} styles={{ body: { padding: 0 } }}>
        {ledgerBody}
      </Card>
    </Flex>
  );
}
