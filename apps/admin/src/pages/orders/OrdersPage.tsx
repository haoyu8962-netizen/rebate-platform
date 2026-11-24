// Order list (design-hifi AdmOrders, AdmOrdersStates; design/specs/admin-orders.md; 01 F-ADM-05,
// F1-07e): filters (platform, platform_status, rebate_status, flag, order number, user, paid
// days in Beijing time) applied with 【查询】, the contract's columns in the server's order
// (paid_at descending) and server-side pages. Everything is read through the data provider
// (GET /admin/v1/orders). The title row has 【同步记录】 and 【手动同步】 (F1-07eb, CT-24n; their
// reads start only when pressed); rights import and export come with a later contract and are not
// rendered. F1-07ed: platform and rebate-status tabs (no counts) mirror those two filters; the
// applied conditions, page and page size (20 / 50 / 100) are written to the address under the
// request parameter names, so a reload, a remount or 【返回】 from the detail restores them (invalid
// values in the address are ignored). 「列设置」 hides / shows columns, kept per page in
// localStorage (components/data-table/columns.ts); platform extra columns (./platforms.ts) start
// hidden. Order numbers and UIDs have copy buttons; the product cell is ProductCell.
// F1-07edb (BR-ID-46): eight columns and 「操作」 show by default (「平台状态」「标记」 start hidden and can
// be shown in 「列设置」); a row's 【查看】 opens the detail drawer (./OrderDrawer.tsx) and writes
// detail=<order_id> to the address, so the full address opens it directly; closing it drops the
// parameter and gives the focus back to that 【查看】, with the conditions, page and rows kept.
// 【详情】 still goes to the full page. The sync status bar (./SyncStatusBar.tsx) stays above.
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  HistoryOutlined,
  InboxOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  ConfigProvider,
  DatePicker,
  Empty,
  Flex,
  Form,
  Input,
  Pagination,
  Result,
  Select,
  Skeleton,
  Table,
  Tag,
  Typography,
  theme,
  type TableColumnsType,
  type ThemeConfig,
} from 'antd';
import dayjs from 'dayjs';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
} from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { PlannedPage, plannedButtonProps, usePlanned } from '../../components/planned/index.ts';
import { CopyText } from '../../components/copy-text/index.ts';
import { ProductCell } from '../../components/product-cell/index.ts';
import {
  defaultSettings,
  readSettings,
  reconcile,
  writeSettings,
  type ColumnSettings,
} from '../../components/data-table/columns.ts';
import { ordersTexts as t } from '../../texts/orders.ts';
import { platformExtraColumns } from './platforms.ts';
import { OrderDrawer } from './OrderDrawer.tsx';
import { FlagTags, StatusTag } from './parts.tsx';
import { SyncDialog } from './SyncDialog.tsx';
import { SyncRecords } from './SyncRecords.tsx';
import { SyncStatusBar } from './SyncStatusBar.tsx';
import { refreshesSyncBar } from './sync-bar.ts';
import { nextNoticeId, noticeOf, type SyncNotice } from './sync.ts';
import {
  FIRST_PAGE,
  FLAGS,
  ORDERS_URL,
  PAGE_SIZE,
  PAGE_SIZES,
  PLATFORMS,
  PLATFORM_STATUSES,
  QUERY_MAX,
  REBATE_STATUSES,
  backQueryOf,
  beijingClock,
  beijingDate,
  cleanQ,
  codeLabel,
  detailOf,
  failureOf,
  hasConditions,
  money,
  platformLabel,
  queryFromSearch,
  requestQuery,
  searchOf,
  showsPager,
  withoutBackState,
  type OrderFlag,
  type OrderPage,
  type OrderQuery,
  type OrderRow,
  type OrdersBackState,
  type SyncOutcome,
} from './model.ts';

export interface OrdersPageProps {
  readonly access: AccessControl;
}

type ListStatus = 'loading' | 'ready' | 'failed' | 'invalid' | 'forbidden';

interface Draft {
  readonly platform: string | undefined;
  readonly platformStatus: string | undefined;
  readonly rebateStatus: string | undefined;
  readonly flag: string | undefined;
  readonly q: string;
  readonly userId: string;
  readonly paidFrom: string | undefined;
  readonly paidTo: string | undefined;
}

const ALL = 'all';
const DAY_FORMAT = 'YYYY-MM-DD';
/** localStorage key of this list's column settings. */
const COLUMNS_KEY = 'admin.orders.list.columns';
/** Order numbers and UIDs are shown whole (an order number is at most QUERY_MAX characters). */
const WHOLE = QUERY_MAX;

/** A list column: the antd column plus whether it starts visible (platform extras do not). */
type ListColumn = TableColumnsType<OrderRow>[number] & {
  readonly key: string;
  readonly title: string;
  readonly defaultVisible?: boolean;
};

/** Columns that 「列设置」 offers but that start hidden (BR-ID-46). */
const HIDDEN_BY_DEFAULT: readonly string[] = ['platformStatus', 'flags'];

/** The columns 「列设置」 offers, in display order; 「操作」 is not among them. */
const configurable: readonly { readonly key: string; readonly defaultVisible?: boolean }[] = [
  ...[
    'orderNo',
    'platform',
    'product',
    'user',
    'paidAt',
    'payAmount',
    'commission',
    'platformStatus',
    'rebateStatus',
    'flags',
  ].map((key) => (HIDDEN_BY_DEFAULT.includes(key) ? { key, defaultVisible: false } : { key })),
  ...platformExtraColumns().map((field) => ({ key: `extra:${field}`, defaultVisible: false })),
];

/**
 * The first conditions: the address; with an empty search, the router state an arrival carries
 * (e.g. a ledger link), which writeAddress then moves into the address and drops; else page 1.
 */
function initialQuery(search: string, state: unknown): OrderQuery {
  if (search !== '' && search !== '?') return queryFromSearch(search);
  return backQueryOf(state) ?? FIRST_PAGE;
}

/**
 * Writes the conditions (and the open drawer's detail=<order_id>) to the address in place (no
 * navigation, so the page is not remounted) and drops the router state of an older 【返回】: from
 * here on the address is the only source.
 */
function writeAddress(query: OrderQuery, detailId: string | undefined): void {
  const params = new URLSearchParams(searchOf(query));
  if (detailId !== undefined) params.set('detail', detailId);
  const text = params.toString();
  const search = text === '' ? '' : `?${text}`;
  const state: unknown = window.history.state;
  const next = withoutBackState(state);
  if (window.location.search === search && next === state) return;
  const { pathname, hash } = window.location;
  window.history.replaceState(next, '', `${pathname}${search}${hash}`);
}

// Filter card (AdmOrders): 36 high controls, small labels above them, four per line.
const FILTER_THEME: ThemeConfig = {
  components: {
    Input: { controlHeight: 36 },
    Select: { controlHeight: 36 },
    DatePicker: { controlHeight: 36 },
    Button: { controlHeight: 36 },
    Form: { labelFontSize: 12, verticalLabelPadding: '0 0 4px' },
  },
};

// Visually hidden label of each date input (the group label stays visible above them).
const HIDDEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
};

const FLAG_LABELS: Readonly<Record<OrderFlag, string>> = {
  locked: t.flags.locked,
  status_locked: t.flags.statusLocked,
  rights_pending: t.flags.rightsPending,
  hold: t.flags.hold,
};

function draftOf(query: OrderQuery): Draft {
  return {
    platform: query.platform,
    platformStatus: query.platformStatus,
    rebateStatus: query.rebateStatus,
    flag: query.flag,
    q: query.q ?? '',
    userId: query.userId ?? '',
    paidFrom: query.paidFrom,
    paidTo: query.paidTo,
  };
}

/** A form day YYYY-MM-DD as a picker value, with the year as written (also years 1–99). */
function pickerDay(day: string): dayjs.Dayjs {
  const [year, month, date] = day.split('-').map(Number);
  const value = new Date(2000, 0, 1);
  value.setFullYear(year ?? 2000, (month ?? 1) - 1, date ?? 1);
  return dayjs(value);
}

/**
 * The pager item a click landed on (its page number, from the item's title), else undefined. Used
 * only for the item the pager ignores: on a page past the last one the pager clamps its current
 * page to the last page, so pressing that page reports no change.
 */
function pressedPage(event: MouseEvent<HTMLElement>): number | undefined {
  const target = event.target instanceof Element ? event.target : null;
  const title = target?.closest('[title]')?.getAttribute('title') ?? '';
  return /^[1-9]\d*$/.test(title) ? Number(title) : undefined;
}

function blank(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function OrdersPage({ access }: OrdersPageProps): ReactElement {
  // GET /admin/v1/orders not live yet (planned): the placeholder, no read (D10-284).
  const planned = usePlanned('adminListOrders');
  if (planned) return <PlannedPage title={t.title} />;
  if (!access.can('order.view')) {
    return (
      <Flex vertical gap={16}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t.title}
        </Typography.Title>
        <Card>
          <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
        </Card>
      </Flex>
    );
  }
  return <OrdersList />;
}

function OrdersList(): ReactElement {
  const getProvider = useDataProvider();
  const navigate = useNavigate();
  const location = useLocation();
  const { token } = theme.useToken();
  const ids = {
    platform: useId(),
    platformStatus: useId(),
    rebateStatus: useId(),
    flag: useId(),
    q: useId(),
    user: useId(),
    from: useId(),
    to: useId(),
  };
  // The browser address is this page's only when the router shows it (not a memory router).
  const [addressed] = useState(() => window.location.pathname === location.pathname);
  const [query, setQuery] = useState<OrderQuery>(() =>
    initialQuery(addressed ? window.location.search : location.search, location.state),
  );
  const [draft, setDraft] = useState<Draft>(() => draftOf(query));
  const [rangeError, setRangeError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [data, setData] = useState<OrderPage>();
  // Manual sync (F1-07eb): nothing is read until a dialog opens.
  const [syncOpen, setSyncOpen] = useState(false);
  // Manual syncs accepted on this page: each one refreshes the sync status bar once.
  const [syncsAccepted, setSyncsAccepted] = useState(0);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [notice, setNotice] = useState<SyncNotice>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saved, setSaved] = useState<ColumnSettings | undefined>(() =>
    readSettings(COLUMNS_KEY, configurable),
  );
  // The detail drawer (F1-07edb): the order shown, from detail=<order_id> in the address at first.
  const detailPlanned = usePlanned('adminGetOrder');
  const [detailId, setDetailId] = useState<string | undefined>(() =>
    detailPlanned ? undefined : detailOf(addressed ? window.location.search : location.search),
  );
  // The 【查看】 that opened the drawer: the focus goes back to it on closing.
  const viewTrigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (addressed) writeAddress(query, detailId);
  }, [addressed, query, detailId]);

  useEffect(() => {
    if (detailId !== undefined) return;
    const trigger = viewTrigger.current;
    viewTrigger.current = null;
    if (trigger?.isConnected === true) trigger.focus({ preventScroll: true });
  }, [detailId]);

  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<OrderPage>({ url: ORDERS_URL, method: 'get', query: requestQuery(query) }).then(
      (response) => {
        if (!current) return;
        setData(response.data);
        setStatus('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        // A failed read never leaves the previous rows, amounts or detail entries on screen.
        setData(undefined);
        const kind = failureOf(cause);
        setStatus(kind);
      },
    );
    return () => {
      // A newer query (or leaving the page) drops this answer.
      current = false;
    };
  }, [getProvider, query, attempt]);

  const load = (next: OrderQuery) => {
    setStatus('loading');
    setData(undefined);
    setQuery(next);
  };

  const retry = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  const submit = () => {
    if (
      draft.paidFrom !== undefined &&
      draft.paidTo !== undefined &&
      draft.paidFrom > draft.paidTo
    ) {
      setRangeError(true);
      return;
    }
    setRangeError(false);
    // A fresh query object: 【查询】 reads again even when nothing changed.
    load({
      page: 1,
      pageSize: query.pageSize,
      platform: PLATFORMS.find((code) => code === draft.platform),
      platformStatus: PLATFORM_STATUSES.find((code) => code === draft.platformStatus),
      rebateStatus: REBATE_STATUSES.find((code) => code === draft.rebateStatus),
      flag: FLAGS.find((code) => code === draft.flag),
      q: cleanQ(draft.q),
      userId: blank(draft.userId),
      paidFrom: draft.paidFrom,
      paidTo: draft.paidTo,
    });
  };

  const reset = () => {
    setDraft(draftOf(FIRST_PAGE));
    setRangeError(false);
    load({ page: 1, pageSize: query.pageSize });
  };

  const changePage = (page: number, size: number) => {
    const pageSize = PAGE_SIZES.find((value) => value === size);
    if (pageSize === undefined) return;
    // A new page size starts again from the first page.
    if (pageSize !== (query.pageSize ?? PAGE_SIZE)) {
      load({ ...query, page: 1, pageSize });
      return;
    }
    if (page === query.page) return;
    load({ ...query, page });
  };

  // The pager of the list, also shown under the empty state of a page past the last one.
  const pagination = (total: number) => ({
    current: query.page,
    pageSize: query.pageSize ?? PAGE_SIZE,
    total,
    showSizeChanger: true,
    pageSizeOptions: [...PAGE_SIZES],
    showTotal: (count: number) => t.total(count),
    onChange: changePage,
  });

  // A tab applies that one filter at once (page 1) and keeps the filter form in step with it.
  const choosePlatform = (key: string) => {
    const platform = PLATFORMS.find((code) => code === key);
    setDraft({ ...draft, platform });
    load({ ...query, page: 1, platform });
  };
  const chooseRebate = (key: string) => {
    const rebateStatus = REBATE_STATUSES.find((code) => code === key);
    setDraft({ ...draft, rebateStatus });
    load({ ...query, page: 1, rebateStatus });
  };

  const open = (orderId: string) => {
    const state: OrdersBackState = { ordersQuery: query };
    void navigate(`/orders/${encodeURIComponent(orderId)}`, { state });
  };

  // 【查看】: the drawer over the list; the list is not read again.
  const view = (orderId: string, trigger: HTMLElement) => {
    viewTrigger.current = trigger;
    setDetailId(orderId);
  };

  const code = { fontFamily: token.fontFamilyCode } as const;
  const secondary = { color: token.colorTextSecondary, fontSize: token.fontSizeSM } as const;
  const nowrap = { whiteSpace: 'nowrap' } as const;

  const columns: ListColumn[] = [
    {
      key: 'orderNo',
      title: t.columns.orderNo,
      render: (_, row) => (
        <span style={{ ...code, ...nowrap, color: token.colorPrimary }}>
          <CopyText text={row.sub_order_id} maxLength={WHOLE} />
        </span>
      ),
    },
    {
      key: 'platform',
      title: t.columns.platform,
      render: (_, row) => (
        <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
          {platformLabel(row.platform)}
        </Tag>
      ),
    },
    {
      key: 'product',
      title: t.columns.product,
      width: 220,
      render: (_, row) =>
        row.title === null && row.image_url === null ? (
          t.dash
        ) : (
          <div style={{ maxWidth: 220 }}>
            <ProductCell title={row.title} imageUrl={row.image_url} />
          </div>
        ),
    },
    {
      key: 'user',
      title: t.columns.user,
      width: 180,
      render: (_, row) =>
        row.user === null ? (
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {t.noUser}
          </Typography.Text>
        ) : (
          <Flex vertical gap={2}>
            <span style={{ ...code, fontSize: token.fontSizeSM, wordBreak: 'break-all' }}>
              <CopyText text={row.user.user_id} maxLength={WHOLE} />
            </span>
            <span style={{ ...code, ...secondary }}>{row.user.phone_masked ?? t.dash}</span>
          </Flex>
        ),
    },
    {
      key: 'paidAt',
      title: t.columns.paidAt,
      render: (_, row) =>
        row.paid_at === null ? (
          t.dash
        ) : (
          <Flex vertical style={nowrap}>
            <span>{beijingDate(row.paid_at)}</span>
            <span>{beijingClock(row.paid_at)}</span>
          </Flex>
        ),
    },
    {
      key: 'payAmount',
      title: t.columns.payAmount,
      align: 'right',
      render: (_, row) => <span style={nowrap}>{money(row.pay_amount_fen)}</span>,
    },
    {
      key: 'commission',
      title: t.columns.commission,
      align: 'right',
      render: (_, row) => (
        <Flex vertical align="flex-end" style={nowrap}>
          <span>{money(row.est_commission_fen)}</span>
          {row.settle_commission_fen === null ? null : (
            <span style={secondary}>{t.settledCommission(money(row.settle_commission_fen))}</span>
          )}
        </Flex>
      ),
    },
    {
      key: 'platformStatus',
      title: t.columns.platformStatus,
      render: (_, row) => <StatusTag kind="platform_status" code={row.platform_status} stacked />,
    },
    {
      key: 'rebateStatus',
      title: t.columns.rebateStatus,
      render: (_, row) => <StatusTag kind="rebate_status" code={row.rebate_status} stacked />,
    },
    {
      key: 'flags',
      title: t.columns.flags,
      render: (_, row) => <FlagTags flags={row.flags} holdReason={row.hold_reason} />,
    },
    ...platformExtraColumns().map((field): ListColumn => ({
      key: `extra:${field}`,
      title: field,
      defaultVisible: false,
      render: (_, row) => {
        const value: unknown = row[field];
        return typeof value === 'string' || typeof value === 'number' ? String(value) : t.dash;
      },
    })),
    {
      key: 'actions',
      title: t.columns.actions,
      fixed: 'right',
      render: (_, row) => (
        <Flex gap={12} style={nowrap}>
          <Button
            type="link"
            size="small"
            aria-label={t.viewActionName(row.sub_order_id)}
            style={{ paddingInline: 0 }}
            {...plannedButtonProps(detailPlanned)}
            onClick={(event) => view(row.order_id, event.currentTarget)}
          >
            {t.viewAction}
          </Button>
          <Button
            type="link"
            size="small"
            aria-label={t.detailActionName(row.sub_order_id)}
            style={{ paddingInline: 0 }}
            onClick={() => open(row.order_id)}
          >
            {t.detailAction}
          </Button>
        </Flex>
      ),
    },
  ];

  // 「操作」 always shows (fixed at the right); every other column can be hidden.
  const settings = reconcile(saved ?? defaultSettings(configurable), configurable);
  const shownKeys = new Set(settings.filter((one) => one.visible).map((one) => one.key));
  const visibleColumns = columns.filter(
    (column) => !configurable.some((one) => one.key === column.key) || shownKeys.has(column.key),
  );
  const toggleColumn = (key: string) => {
    const next = settings.map((one) => (one.key === key ? { key, visible: !one.visible } : one));
    // Only a setting the storage accepted is shown, so the table never differs from what is kept.
    if (writeSettings(COLUMNS_KEY, next)) setSaved(next);
  };

  // 「列设置」 belongs to the table: shown with rows only.
  const columnSettings =
    status === 'ready' && data !== undefined && data.items.length > 0 ? (
      <Flex vertical gap={8}>
        <Flex justify="flex-end">
          <Button aria-expanded={settingsOpen} onClick={() => setSettingsOpen((open) => !open)}>
            {t.columnSettings}
          </Button>
        </Flex>
        {settingsOpen ? (
          <Card size="small">
            <Flex wrap gap={16}>
              {settings.map((one) => {
                const column = columns.find((candidate) => candidate.key === one.key);
                if (column === undefined) return null;
                return (
                  <Checkbox
                    key={one.key}
                    checked={one.visible}
                    disabled={one.visible && shownKeys.size <= 1}
                    onChange={() => toggleColumn(one.key)}
                  >
                    {column.title}
                  </Checkbox>
                );
              })}
            </Flex>
          </Card>
        ) : null}
      </Flex>
    ) : null;

  const labels = t.conditionLabels;
  const paidText =
    query.paidFrom === undefined && query.paidTo === undefined
      ? undefined
      : t.range(query.paidFrom ?? t.dash, query.paidTo ?? t.dash);
  const conditions = [
    query.platform === undefined
      ? undefined
      : t.condition(labels.platform, platformLabel(query.platform)),
    query.platformStatus === undefined
      ? undefined
      : t.condition(labels.platformStatus, codeLabel('platform_status', query.platformStatus)),
    query.rebateStatus === undefined
      ? undefined
      : t.condition(labels.rebateStatus, codeLabel('rebate_status', query.rebateStatus)),
    query.flag === undefined ? undefined : t.condition(labels.flag, FLAG_LABELS[query.flag]),
    query.q === undefined ? undefined : t.condition(labels.query, query.q),
    query.userId === undefined ? undefined : t.condition(labels.user, query.userId),
    paidText === undefined ? undefined : t.condition(labels.paidAt, paidText),
  ].filter((value): value is string => value !== undefined);
  const conditionText = conditions.join(t.conditionSeparator);

  const inner = {
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: token.borderRadiusLG,
    overflow: 'hidden',
  } as const;

  const iconCircle = (background: string) =>
    ({
      width: 56,
      height: 56,
      marginInline: 'auto',
      borderRadius: '50%',
      background,
    }) as const;

  let body: ReactElement;
  if (status === 'failed' || status === 'invalid') {
    body = (
      <div style={inner}>
        <Result
          status="warning"
          icon={
            <Flex align="center" justify="center" style={iconCircle(token.colorErrorBg)}>
              <WarningOutlined aria-hidden style={{ fontSize: 24, color: token.colorError }} />
            </Flex>
          }
          title={
            <Typography.Text type="danger" strong style={{ fontSize: token.fontSize }}>
              {t.loadFailedTitle}
            </Typography.Text>
          }
          subTitle={status === 'invalid' ? t.invalidQueryDescription : t.loadFailedDescription}
          extra={
            <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={retry}>
              {t.retry}
            </Button>
          }
        />
      </div>
    );
  } else if (status === 'loading' || data === undefined) {
    body = (
      <div style={inner}>
        <Flex
          align="center"
          gap={8}
          style={{ padding: '12px 16px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}
        >
          <ClockCircleOutlined aria-hidden style={{ color: token.colorTextTertiary }} />
          <Typography.Text type="secondary" role="status">
            {t.loading}
          </Typography.Text>
        </Flex>
        <div style={{ padding: 16 }}>
          <Skeleton active title={false} paragraph={{ rows: 4 }} />
        </div>
      </div>
    );
  } else if (data.items.length === 0) {
    body = (
      <div style={{ ...inner, padding: '40px 24px' }}>
        <Empty
          image={
            <InboxOutlined aria-hidden style={{ fontSize: 28, color: token.colorTextTertiary }} />
          }
          styles={{
            image: {
              height: 56,
              width: 56,
              marginInline: 'auto',
              marginBottom: 16,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: token.colorFillTertiary,
            },
          }}
          description={
            <Flex vertical align="center" gap={8}>
              <Typography.Text strong>{t.empty}</Typography.Text>
              {conditions.length === 0 ? null : (
                <Typography.Text type="secondary">
                  {t.emptyConditions(conditionText)}
                </Typography.Text>
              )}
            </Flex>
          }
        >
          {hasConditions(query) ? <Button onClick={reset}>{t.resetConditions}</Button> : null}
        </Empty>
        {/* A page past the last one (total > 0): the pager stays, to go back or change the size.
            The pager shows the last page as current there and ignores a press on it, so that one
            press is taken here (F1-07edb). */}
        {showsPager(data) ? (
          <Flex
            justify="flex-end"
            style={{ marginTop: token.marginLG }}
            onClick={(event) => {
              const pressed = pressedPage(event);
              const size = query.pageSize ?? PAGE_SIZE;
              const last = Math.max(1, Math.ceil(data.total / size));
              if (pressed !== undefined && query.page > last && pressed === last)
                changePage(pressed, size);
            }}
          >
            <Pagination {...pagination(data.total)} />
          </Flex>
        ) : null}
      </div>
    );
  } else {
    body = (
      <Table<OrderRow>
        rowKey="order_id"
        size="middle"
        columns={visibleColumns}
        dataSource={data.items}
        scroll={{ x: 'max-content' }}
        pagination={pagination(data.total)}
      />
    );
  }

  // Shown with a settled answer for applied conditions; names them and the server's total.
  const applied =
    status === 'ready' && data !== undefined && conditions.length > 0 ? (
      <Flex align="center" gap={12} wrap aria-live="polite">
        <Tag icon={<CheckCircleOutlined aria-hidden />} style={{ marginInlineEnd: 0 }}>
          {t.applied}
        </Tag>
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          {conditionText}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          {t.total(data.total)}
        </Typography.Text>
      </Flex>
    ) : null;

  const statusOptions = (kind: 'platform_status' | 'rebate_status', codes: readonly string[]) => [
    { value: ALL, label: t.filters.all },
    ...codes.map((value) => ({ value, label: codeLabel(kind, value) })),
  ];
  const pick = (value: string | undefined) => (value === ALL ? undefined : value);
  const cell = { marginBottom: 0, flex: '1 1 220px', minWidth: 200 } as const;

  const syncDone = (outcome: SyncOutcome) => {
    setSyncOpen(false);
    if (refreshesSyncBar(outcome)) setSyncsAccepted((count) => count + 1);
    const shown = noticeOf(outcome);
    setNotice(shown === undefined ? undefined : { id: nextNoticeId(), ...shown });
  };

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center" wrap gap={8}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t.title}
        </Typography.Title>
        <Flex gap={8} wrap>
          <Button icon={<HistoryOutlined aria-hidden />} onClick={() => setRecordsOpen(true)}>
            {t.sync.recordsEntry}
          </Button>
          <Button
            type="primary"
            icon={<SyncOutlined aria-hidden />}
            onClick={() => {
              setNotice(undefined);
              setSyncOpen(true);
            }}
          >
            {t.sync.manualEntry}
          </Button>
        </Flex>
      </Flex>
      <SyncStatusBar refresh={syncsAccepted} />
      {notice === undefined ? null : (
        <Alert
          key={notice.id}
          type={notice.type}
          showIcon
          closable
          message={notice.text}
          onClose={() => setNotice(undefined)}
        />
      )}
      {syncOpen ? <SyncDialog onClose={() => setSyncOpen(false)} onDone={syncDone} /> : null}
      {recordsOpen ? <SyncRecords onClose={() => setRecordsOpen(false)} /> : null}
      <OrderDrawer orderId={detailId} onClose={() => setDetailId(undefined)} />
      <Card>
        <ConfigProvider theme={FILTER_THEME}>
          {/* Each Select also carries its label as aria-label: the browser would otherwise read the
              label's generated colon into the accessible name. */}
          <Form layout="vertical" component="div" colon={false}>
            <Flex vertical gap={12}>
              <Flex gap={16} wrap>
                <Form.Item label={t.filters.platform} htmlFor={ids.platform} style={cell}>
                  <Select<string | undefined>
                    id={ids.platform}
                    aria-label={t.filters.platform}
                    value={draft.platform}
                    placeholder={<Typography.Text>{t.filters.platformAll}</Typography.Text>}
                    onChange={(value) => setDraft({ ...draft, platform: pick(value) })}
                    options={[
                      { value: ALL, label: t.filters.platformAll },
                      ...PLATFORMS.map((value) => ({ value, label: platformLabel(value) })),
                    ]}
                  />
                </Form.Item>
                <Form.Item
                  label={t.filters.platformStatus}
                  htmlFor={ids.platformStatus}
                  style={cell}
                >
                  <Select<string | undefined>
                    id={ids.platformStatus}
                    aria-label={t.filters.platformStatus}
                    value={draft.platformStatus}
                    placeholder={<Typography.Text>{t.filters.all}</Typography.Text>}
                    onChange={(value) => setDraft({ ...draft, platformStatus: pick(value) })}
                    options={statusOptions('platform_status', PLATFORM_STATUSES)}
                  />
                </Form.Item>
                <Form.Item label={t.filters.rebateStatus} htmlFor={ids.rebateStatus} style={cell}>
                  <Select<string | undefined>
                    id={ids.rebateStatus}
                    aria-label={t.filters.rebateStatus}
                    value={draft.rebateStatus}
                    placeholder={<Typography.Text>{t.filters.all}</Typography.Text>}
                    onChange={(value) => setDraft({ ...draft, rebateStatus: pick(value) })}
                    options={statusOptions('rebate_status', REBATE_STATUSES)}
                  />
                </Form.Item>
                <Form.Item label={t.filters.query} htmlFor={ids.q} style={cell}>
                  <Input
                    id={ids.q}
                    allowClear
                    maxLength={QUERY_MAX}
                    placeholder={t.filters.queryPlaceholder}
                    value={draft.q}
                    onChange={(event) => setDraft({ ...draft, q: event.target.value })}
                    onPressEnter={submit}
                    style={code}
                  />
                </Form.Item>
              </Flex>
              <Flex gap={16} wrap align="flex-end">
                <Form.Item label={t.filters.user} htmlFor={ids.user} style={cell}>
                  <Input
                    id={ids.user}
                    allowClear
                    placeholder={t.filters.userPlaceholder}
                    value={draft.userId}
                    onChange={(event) => setDraft({ ...draft, userId: event.target.value })}
                    onPressEnter={submit}
                  />
                </Form.Item>
                <Form.Item
                  label={t.filters.paidAt}
                  style={cell}
                  validateStatus={rangeError ? 'error' : ''}
                  {...(rangeError ? { help: t.filters.rangeInvalid } : {})}
                >
                  <Flex gap={8}>
                    <label htmlFor={ids.from} style={HIDDEN}>
                      {t.filters.paidFrom}
                    </label>
                    <DatePicker
                      id={ids.from}
                      format={DAY_FORMAT}
                      placeholder={t.filters.paidFromPlaceholder}
                      value={draft.paidFrom === undefined ? null : pickerDay(draft.paidFrom)}
                      onChange={(value) =>
                        setDraft({ ...draft, paidFrom: value?.format(DAY_FORMAT) ?? undefined })
                      }
                      style={{ flex: 1, minWidth: 0 }}
                    />
                    <label htmlFor={ids.to} style={HIDDEN}>
                      {t.filters.paidTo}
                    </label>
                    <DatePicker
                      id={ids.to}
                      format={DAY_FORMAT}
                      placeholder={t.filters.paidToPlaceholder}
                      value={draft.paidTo === undefined ? null : pickerDay(draft.paidTo)}
                      onChange={(value) =>
                        setDraft({ ...draft, paidTo: value?.format(DAY_FORMAT) ?? undefined })
                      }
                      style={{ flex: 1, minWidth: 0 }}
                    />
                  </Flex>
                </Form.Item>
                <Form.Item label={t.filters.flag} htmlFor={ids.flag} style={cell}>
                  <Select<string | undefined>
                    id={ids.flag}
                    aria-label={t.filters.flag}
                    value={draft.flag}
                    placeholder={<Typography.Text>{t.filters.all}</Typography.Text>}
                    onChange={(value) => setDraft({ ...draft, flag: pick(value) })}
                    options={[
                      { value: ALL, label: t.filters.all },
                      ...FLAGS.map((value) => ({ value, label: FLAG_LABELS[value] })),
                    ]}
                  />
                </Form.Item>
                <Flex gap={12} style={{ flex: '1 1 220px', minWidth: 200 }}>
                  <Button type="primary" icon={<SearchOutlined aria-hidden />} onClick={submit}>
                    {t.filters.submit}
                  </Button>
                  <Button onClick={reset}>{t.filters.reset}</Button>
                </Flex>
              </Flex>
            </Flex>
          </Form>
        </ConfigProvider>
      </Card>
      {status === 'forbidden' ? (
        <Card>
          <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
        </Card>
      ) : (
        <Card>
          <Flex vertical gap={12}>
            <ListTabs
              name={t.tabs.platformName}
              items={PLATFORMS.map((value) => ({ key: value, label: platformLabel(value) }))}
              active={query.platform}
              onChoose={choosePlatform}
            />
            <ListTabs
              name={t.tabs.rebateName}
              items={REBATE_STATUSES.map((value) => ({
                key: value,
                label: codeLabel('rebate_status', value),
              }))}
              active={query.rebateStatus}
              onChoose={chooseRebate}
            />
            {applied}
            {columnSettings}
            {body}
          </Flex>
        </Card>
      )}
    </Flex>
  );
}

/**
 * One row of filter tabs (「全部」 first, no counts). A tab list that wraps onto more lines instead of
 * scrolling its overflow out of view, so every tab stays reachable at narrow widths; each tab is an
 * antd Button with the tab role and its selected state.
 */
function ListTabs(props: {
  readonly name: string;
  readonly items: readonly { readonly key: string; readonly label: string }[];
  readonly active: string | undefined;
  readonly onChoose: (key: string) => void;
}): ReactElement {
  const { name, items, active, onChoose } = props;
  const all = [{ key: ALL, label: t.tabs.all }, ...items];
  const current = active ?? ALL;
  return (
    <Flex role="tablist" aria-label={name} wrap gap={4}>
      {all.map((item) => {
        const selected = item.key === current;
        return (
          <Button
            key={item.key}
            role="tab"
            aria-selected={selected}
            type={selected ? 'primary' : 'text'}
            autoInsertSpace={false}
            onClick={() => {
              if (!selected) onChoose(item.key);
            }}
          >
            {item.label}
          </Button>
        );
      })}
    </Flex>
  );
}
