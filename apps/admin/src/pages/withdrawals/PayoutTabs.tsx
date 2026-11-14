// 提现页的「打款队列」「结果待确认」页签（F1-08ba，规格 admin-payouts.md，只读）：
// 「打款队列」——状态卡与通道卡（GET /admin/v1/payout-overview，adminGetPayoutOverview）与队列表
// （listAdminWithdrawals，全部 = status=APPROVED 与 status=PAYING 各读第 1 页、按申请时间倒序合并；
// 打款中 / 待执行各读一个状态并分页），行【详情】进 withdrawals/{id}、【打款记录】开抽屉读该单详情
// 的 payout_attempts；「结果待确认」——GET /admin/v1/unknown-payouts（adminListUnknownPayouts），
// 行【处置】进 withdrawals/{id}（处置在详情页办理）。
// 开关、暂停、水位只用文字与 Tag 展示，不放任何开关控件。持 payout.execute 时「打款队列」的待执行单
// 可勾选，批量栏【执行所选】见 PayoutExecute.tsx（F1-08bb）；执行后重新读队列与概览。
// TODO(规划/11 §7): 【录入企业支付宝余额】、【暂停队列】/【解除暂停】、【解除通道暂停】
// — blocked on F1-08bc–bd
import { ReloadOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Flex,
  Result,
  Row,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  theme,
  type DescriptionsProps,
  type TableColumnsType,
  type TablePaginationConfig,
} from 'antd';
import {
  useCallback,
  useEffect,
  useState,
  type Key,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router';
import { withdrawalsTexts } from '../../texts/withdrawals.ts';
import { delayedLoading, useLoadingClock } from '../../motion.ts';
import { PayoutExecute } from './PayoutExecute.tsx';
import {
  OVERVIEW_URL,
  PAGE_SIZE,
  QUEUE_TABS,
  UNKNOWN_URL,
  beijingTime,
  canExecute,
  channelLabel,
  codeOf,
  detailRoute,
  itemUrl,
  LIST_URL,
  marksOf,
  money,
  nameOr,
  newestFirst,
  oldestFirst,
  percentOf,
  queueQuery,
  queueStatuses,
  statusColor,
  statusLabel,
  waterLevelLabel,
  type PayoutOverview,
  type PayoutOverviewChannel,
  type QueueTab,
  type UnknownPayoutItem,
  type UnknownPayoutPage,
  type WithdrawalDetail,
  type WithdrawalPage,
  type WithdrawalRow,
} from './model.ts';

const t = withdrawalsTexts;
const p = withdrawalsTexts.payouts;

/** Descriptions items (always given). */
type Items = NonNullable<DescriptionsProps['items']>;

type ReadStatus = 'loading' | 'ready' | 'failed' | 'forbidden';

/** The read failed: 10403 is no permission, anything else a failure. */
const failedAs = (cause: unknown): ReadStatus => (codeOf(cause) === 10403 ? 'forbidden' : 'failed');

type GetProvider = ReturnType<typeof useDataProvider>;

function customOf(getProvider: GetProvider) {
  const custom = getProvider().custom;
  if (custom === undefined) throw new Error('Missing custom data provider');
  return custom;
}

function LoadingLine({ text }: { readonly text: string }): ReactElement {
  const { token } = theme.useToken();
  return (
    <Flex
      align="center"
      gap={8}
      style={{
        padding: `${token.paddingSM}px ${token.padding}px`,
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <Typography.Text type="secondary" role="status">
        {text}
      </Typography.Text>
    </Flex>
  );
}

function Failed(props: {
  readonly title: string;
  readonly description: string;
  readonly onRetry: () => void;
}): ReactElement {
  return (
    <Result
      status="error"
      title={props.title}
      subTitle={props.description}
      extra={
        <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={props.onRetry}>
          {t.retry}
        </Button>
      }
    />
  );
}

function EmptyText({ text }: { readonly text: string }): ReactElement {
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={text} />;
}

// ---- 打款队列：状态卡与通道卡 ----------------------------------------------------------------

function OnOff(props: {
  readonly on: boolean;
  readonly onText: string;
  readonly offText: string;
}): ReactElement {
  return (
    <Tag color={props.on ? 'success' : 'default'} style={{ marginInlineEnd: 0 }}>
      {props.on ? props.onText : props.offText}
    </Tag>
  );
}

function Fields({ items }: { readonly items: Items }): ReactElement {
  return <Descriptions bordered size="small" column={1} items={items} />;
}

function OverviewCards({ overview }: { readonly overview: PayoutOverview }): ReactElement {
  const { token } = theme.useToken();
  const amount = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;
  const alipay = overview.channels.find((channel) => channel.channel === 'alipay');
  const watermark = alipay?.watermark ?? null;
  const level = alipay?.water_level ?? null;
  const balance: Items = [
    {
      key: 'available',
      label: p.fields.available,
      children:
        watermark === null ? (
          <Typography.Text type="warning">{p.unentered}</Typography.Text>
        ) : (
          <span style={amount}>{money(watermark.available_fen)}</span>
        ),
    },
    {
      key: 'measuredAt',
      label: p.fields.measuredAt,
      children: beijingTime(watermark?.measured_at ?? null),
    },
    {
      key: 'enteredBy',
      label: p.fields.enteredBy,
      children: watermark === null ? t.dash : (watermark.entered_by_name ?? watermark.entered_by),
    },
  ];
  const water: Items = [
    {
      key: 'forecast',
      label: p.fields.forecast,
      children: <span style={amount}>{money(alipay?.forecast_withdrawal_fen ?? 0)}</span>,
    },
    ...(level === null
      ? []
      : [
          {
            key: 'level',
            label: p.fields.level,
            children: (
              <Tag color={level === 'low' ? 'warning' : 'success'} style={{ marginInlineEnd: 0 }}>
                {waterLevelLabel(level)}
              </Tag>
            ),
          },
        ]),
    {
      key: 'usable',
      label: p.fields.usable,
      children: percentOf(overview.watermark_usable_bp),
    },
  ];
  const daily: Items = [
    {
      key: 'dailySent',
      label: p.fields.dailySent,
      children: <span style={amount}>{money(overview.daily_sent_fen)}</span>,
    },
    {
      key: 'dailyCap',
      label: p.fields.dailyCap,
      children: <span style={amount}>{money(overview.daily_cap_fen)}</span>,
    },
    {
      key: 'singleCap',
      label: p.fields.singleCap,
      children: <span style={amount}>{money(overview.single_cap_fen)}</span>,
    },
  ];
  const queue: Items = [
    {
      key: 'payout',
      label: p.fields.payout,
      children: <OnOff on={overview.payout_enabled} onText={p.payoutOn} offText={p.payoutOff} />,
    },
    {
      key: 'queue',
      label: p.fields.queue,
      children: (
        <Tag color={overview.queue_paused ? 'error' : 'success'} style={{ marginInlineEnd: 0 }}>
          {overview.queue_paused ? p.queuePaused : p.queueRunning}
        </Tag>
      ),
    },
  ];
  const cards: readonly { key: string; title: string; body: ReactNode }[] = [
    { key: 'balance', title: p.cards.balance, body: <Fields items={balance} /> },
    {
      key: 'watermark',
      title: p.cards.watermark,
      body: (
        <Flex vertical gap={8}>
          <Fields items={water} />
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {p.usableHint}
          </Typography.Text>
        </Flex>
      ),
    },
    { key: 'daily', title: p.cards.daily, body: <Fields items={daily} /> },
    { key: 'queue', title: p.cards.queue, body: <Fields items={queue} /> },
  ];
  return (
    <Flex vertical gap={16}>
      <Row gutter={[16, 16]}>
        {cards.map((item) => (
          <Col key={item.key} xs={24} md={12} xl={6}>
            <Card size="small" title={item.title} style={{ height: '100%' }}>
              {item.body}
            </Card>
          </Col>
        ))}
      </Row>
      <Row gutter={[16, 16]}>
        {overview.channels.map((channel) => (
          <Col key={channel.channel} xs={24} md={8}>
            <ChannelCard channel={channel} />
          </Col>
        ))}
      </Row>
      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
        {p.asOf(beijingTime(overview.as_of))}
      </Typography.Text>
    </Flex>
  );
}

function ChannelCard({ channel }: { readonly channel: PayoutOverviewChannel }): ReactElement {
  const items: Items = [
    {
      key: 'enabled',
      label: p.fields.enabled,
      children: <OnOff on={channel.enabled} onText={p.channelOn} offText={p.channelOff} />,
    },
    {
      key: 'paused',
      label: p.fields.paused,
      children: (
        <Tag color={channel.paused ? 'error' : 'default'} style={{ marginInlineEnd: 0 }}>
          {channel.paused ? p.channelPaused : p.channelRunning}
        </Tag>
      ),
    },
  ];
  return (
    <Card size="small" title={nameOr(p.channelTitles, channel.channel)}>
      <Fields items={items} />
    </Card>
  );
}

interface OverviewRead {
  readonly status: ReadStatus;
  readonly overview: PayoutOverview | undefined;
  /** Shows the loading line and reads again (【重试】). */
  readonly retry: () => void;
  /** Reads again while the cards stay (after a batch was executed). */
  readonly refresh: () => void;
}

function useOverview(): OverviewRead {
  const getProvider = useDataProvider();
  const [status, setStatus] = useState<ReadStatus>('loading');
  const [overview, setOverview] = useState<PayoutOverview>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    customOf(getProvider)<PayoutOverview>({ url: OVERVIEW_URL, method: 'get' }).then(
      (response) => {
        if (!current) return;
        setOverview(response.data);
        setStatus('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        setOverview(undefined);
        setStatus(failedAs(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, attempt]);

  const retry = useCallback(() => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  }, []);
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  return { status, overview: status === 'ready' ? overview : undefined, retry, refresh };
}

function OverviewArea({ read }: { readonly read: OverviewRead }): ReactElement {
  const { status, overview, retry } = read;
  if (status === 'forbidden')
    return (
      <Card size="small">
        <Result
          status="403"
          title={p.overviewForbidden}
          subTitle={p.overviewForbiddenDescription}
        />
      </Card>
    );
  if (status === 'failed')
    return (
      <Card size="small">
        <Failed
          title={p.overviewFailed}
          description={p.overviewFailedDescription}
          onRetry={retry}
        />
      </Card>
    );
  if (status === 'loading' || overview === undefined)
    return (
      <Card size="small" styles={{ body: { padding: 0 } }}>
        <LoadingLine text={p.overviewLoading} />
      </Card>
    );
  return <OverviewCards overview={overview} />;
}

// ---- 打款队列：队列表 --------------------------------------------------------------------------

interface QueueData {
  readonly items: readonly WithdrawalRow[];
  readonly total: number;
  /** 全部 shows page 1 of each status; true when either has more rows than that. */
  readonly truncated: boolean;
}

function QueueArea(props: {
  readonly canList: boolean;
  /** payout.execute: the APPROVED rows can be ticked for 【执行所选】. */
  readonly canExecute: boolean;
  readonly overview: PayoutOverview | undefined;
  /** A batch was executed: read the overview again. */
  readonly onExecuted: () => void;
}): ReactElement {
  const { canList, canExecute: executor, overview, onExecuted } = props;
  const getProvider = useDataProvider();
  const navigate = useNavigate();
  const loadingClock = useLoadingClock();
  const { token } = theme.useToken();
  const [tab, setTab] = useState<QueueTab>('all');
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ReadStatus>(canList ? 'loading' : 'forbidden');
  const [data, setData] = useState<QueueData>();
  const [drawerRow, setDrawerRow] = useState<WithdrawalRow | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!canList) return;
    let current = true;
    const statuses = queueStatuses(tab);
    const read = customOf(getProvider);
    void Promise.allSettled(
      statuses.map((item) =>
        read<WithdrawalPage>({
          url: LIST_URL,
          method: 'get',
          query: queueQuery(item, statuses.length > 1 ? 1 : page),
        }),
      ),
    ).then((results) => {
      if (!current) return;
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      );
      if (failures.length > 0) {
        setData(undefined);
        setStatus(
          failures.some((cause) => failedAs(cause) === 'forbidden') ? 'forbidden' : 'failed',
        );
        return;
      }
      const pages = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value.data] : [],
      );
      const items = pages.flatMap((one) => one.items);
      setData({
        items: pages.length > 1 ? newestFirst(items) : items,
        total: pages.reduce((sum, one) => sum + one.total, 0),
        truncated: pages.length > 1 && pages.some((one) => one.total > one.items.length),
      });
      setStatus('ready');
    });
    return () => {
      current = false;
    };
  }, [getProvider, canList, tab, page, attempt]);

  const reload = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  const changeTab = (key: string) => {
    const next = QUEUE_TABS.find((item) => item === key);
    if (next === undefined || next === tab || busy) return;
    setTab(next);
    setPage(1);
    setData(undefined);
    setSelected([]);
    if (canList) setStatus('loading');
  };

  const changePage = (pagination: TablePaginationConfig) => {
    if (pagination.current === undefined || pagination.current === page || busy) return;
    setStatus('loading');
    setSelected([]);
    setPage(pagination.current);
  };

  const executed = useCallback(() => {
    setSelected([]);
    setStatus('loading');
    setAttempt((value) => value + 1);
    onExecuted();
  }, [onExecuted]);

  // 勾选只认当前列表里仍是待执行的单，按列表顺序。
  const tickable = (data?.items ?? []).filter(canExecute);
  const tickedRows = executor ? tickable.filter((row) => selected.includes(row.withdrawal_id)) : [];

  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const secondary = { fontSize: token.fontSizeSM, color: token.colorTextSecondary } as const;
  const amount = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;

  const columns: TableColumnsType<WithdrawalRow> = [
    {
      key: 'number',
      title: p.columns.number,
      render: (_, row) => <span style={code}>{row.out_biz_no}</span>,
    },
    {
      key: 'user',
      title: p.columns.user,
      render: (_, row) => (
        <Flex vertical gap={2}>
          <span style={{ ...code, fontSize: token.fontSizeSM }}>{row.user.user_id}</span>
          {row.user.phone_masked === null ? null : <span>{row.user.phone_masked}</span>}
          <span style={secondary}>{channelLabel(row.payout_channel)}</span>
        </Flex>
      ),
    },
    {
      key: 'amount',
      title: p.columns.amount,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.amount_fen)}</span>,
    },
    {
      key: 'net',
      title: p.columns.net,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.net_fen)}</span>,
    },
    {
      key: 'status',
      title: p.columns.status,
      render: (_, row) => (
        <Tag color={statusColor(row.status)} style={{ marginInlineEnd: 0 }}>
          {statusLabel(row.status)}
        </Tag>
      ),
    },
    {
      key: 'marks',
      title: p.columns.marks,
      render: (_, row) => {
        const marks = marksOf(row);
        if (marks.length === 0) return <span style={secondary}>{t.dash}</span>;
        return (
          <Flex wrap gap={4}>
            {marks.map((mark) => (
              <Tag key={mark} color="warning" style={{ marginInlineEnd: 0 }}>
                {mark}
              </Tag>
            ))}
          </Flex>
        );
      },
    },
    {
      key: 'batch',
      title: p.columns.batch,
      render: (_, row) =>
        row.batch_id === null ? (
          <span style={secondary}>{t.dash}</span>
        ) : (
          <span style={{ ...code, fontSize: token.fontSizeSM }}>{row.batch_id}</span>
        ),
    },
    {
      key: 'createdAt',
      title: p.columns.createdAt,
      render: (_, row) => (
        <span style={{ whiteSpace: 'nowrap' }}>{beijingTime(row.created_at)}</span>
      ),
    },
    {
      key: 'actions',
      title: p.columns.actions,
      render: (_, row) => (
        <Space size={8}>
          <Button size="small" onClick={() => void navigate(detailRoute(row.withdrawal_id))}>
            {t.detailEntry}
          </Button>
          <Button size="small" onClick={() => setDrawerRow(row)}>
            {p.attemptsEntry}
          </Button>
        </Space>
      ),
    },
  ];

  let body: ReactElement;
  if (status === 'forbidden') {
    body = <Result status="403" title={p.queueForbidden} subTitle={p.queueForbiddenDescription} />;
  } else if (status === 'failed') {
    body = <Failed title={p.queueFailed} description={p.queueFailedDescription} onRetry={reload} />;
  } else if (data === undefined) {
    body = <LoadingLine text={p.queueLoading} />;
  } else {
    const all = tab === 'all';
    body = (
      <>
        {status === 'loading' ? <LoadingLine text={p.queueLoading} /> : null}
        {all && data.truncated ? (
          <Alert
            type="info"
            showIcon
            role="note"
            style={{ margin: `0 ${token.padding}px ${token.paddingSM}px` }}
            message={p.allTruncated(PAGE_SIZE)}
          />
        ) : null}
        <Table<WithdrawalRow>
          rowKey="withdrawal_id"
          columns={columns}
          dataSource={data.items as WithdrawalRow[]}
          {...(executor
            ? {
                rowSelection: {
                  hideSelectAll: true,
                  selectedRowKeys: tickedRows.map((row) => row.withdrawal_id),
                  getCheckboxProps: (row: WithdrawalRow) => ({
                    disabled: busy || !canExecute(row),
                  }),
                  onChange: (keys: Key[]) => setSelected(keys.map(String)),
                },
              }
            : {})}
          loading={delayedLoading(status === 'loading', loadingClock)}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: <EmptyText text={p.queueEmpty} /> }}
          pagination={
            all
              ? false
              : {
                  current: page,
                  pageSize: PAGE_SIZE,
                  total: data.total,
                  showSizeChanger: false,
                  showTotal: (total) => t.total(total),
                  style: { paddingInline: token.padding },
                }
          }
          onChange={changePage}
        />
      </>
    );
  }

  return (
    <Card styles={{ body: { padding: 0 } }}>
      <Tabs
        activeKey={tab}
        onChange={changeTab}
        style={{ paddingInline: token.padding }}
        items={QUEUE_TABS.map((key) => ({ key, label: p.queueTabs[key] }))}
      />
      {executor ? (
        <PayoutExecute
          rows={tickedRows}
          overview={overview}
          onFinished={executed}
          onBusyChange={setBusy}
        />
      ) : null}
      {body}
      <AttemptsDrawer row={drawerRow} onClose={() => setDrawerRow(null)} />
    </Card>
  );
}

// ---- 打款记录抽屉 -------------------------------------------------------------------------------

function AttemptsDrawer(props: {
  readonly row: WithdrawalRow | null;
  readonly onClose: () => void;
}): ReactElement {
  const { row, onClose } = props;
  return (
    <Drawer
      open={row !== null}
      onClose={onClose}
      width={720}
      destroyOnHidden
      title={row === null ? p.attemptsEntry : p.drawerTitle(row.out_biz_no)}
    >
      {row === null ? null : <AttemptsBody key={row.withdrawal_id} id={row.withdrawal_id} />}
    </Drawer>
  );
}

type DetailStatus = ReadStatus | 'missing';

function AttemptsBody({ id }: { readonly id: string }): ReactElement {
  const getProvider = useDataProvider();
  const loadingClock = useLoadingClock();
  const { token } = theme.useToken();
  const [status, setStatus] = useState<DetailStatus>('loading');
  const [detail, setDetail] = useState<WithdrawalDetail>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    customOf(getProvider)<WithdrawalDetail>({ url: itemUrl(id), method: 'get' }).then(
      (response) => {
        if (!current) return;
        setDetail(response.data);
        setStatus('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        setDetail(undefined);
        const code = codeOf(cause);
        setStatus(code === 20001 ? 'missing' : failedAs(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, id, attempt]);

  if (status === 'forbidden') return <Result status="403" title={p.drawerForbidden} />;
  if (status === 'missing') return <Result status="404" title={p.drawerMissing} />;
  if (status === 'failed')
    return (
      <Failed
        title={p.drawerFailed}
        description={p.overviewFailedDescription}
        onRetry={() => {
          setStatus('loading');
          setAttempt((value) => value + 1);
        }}
      />
    );
  if (detail === undefined) return <LoadingLine text={p.drawerLoading} />;

  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const summary: Items = [
    {
      key: 'number',
      label: p.summary.number,
      children: <span style={code}>{detail.out_biz_no}</span>,
    },
    { key: 'net', label: p.summary.net, children: money(detail.net_fen) },
    {
      key: 'status',
      label: p.summary.status,
      children: (
        <Tag color={statusColor(detail.status)} style={{ marginInlineEnd: 0 }}>
          {statusLabel(detail.status)}
        </Tag>
      ),
    },
    { key: 'channel', label: p.summary.channel, children: channelLabel(detail.payout_channel) },
    {
      key: 'executeSeq',
      label: p.summary.executeSeq,
      children: detail.execute_seq === null ? t.dash : String(detail.execute_seq),
    },
  ];
  type Attempt = WithdrawalDetail['payout_attempts'][number];
  const columns: TableColumnsType<Attempt> = [
    {
      key: 'at',
      title: p.attemptColumns.at,
      render: (_, item) => <span style={{ whiteSpace: 'nowrap' }}>{beijingTime(item.at)}</span>,
    },
    {
      key: 'kind',
      title: p.attemptColumns.kind,
      render: (_, item) => nameOr(t.attemptKinds, item.kind),
    },
    {
      key: 'result',
      title: p.attemptColumns.result,
      render: (_, item) => nameOr(t.attemptResults, item.result),
    },
    {
      key: 'code',
      title: p.attemptColumns.code,
      render: (_, item) => <span style={code}>{item.resp_code ?? t.dash}</span>,
    },
    {
      key: 'subCode',
      title: p.attemptColumns.subCode,
      render: (_, item) => <span style={code}>{item.resp_sub_code ?? t.dash}</span>,
    },
  ];
  return (
    <Flex vertical gap={16}>
      <Descriptions bordered size="small" column={1} items={summary} />
      <Alert type="info" showIcon role="note" message={p.drawerNotice} />
      <Table<Attempt>
        rowKey="attempt_id"
        columns={columns}
        dataSource={oldestFirst(detail.payout_attempts)}
        loading={delayedLoading(false, loadingClock)}
        pagination={false}
        size="small"
        scroll={{ x: 'max-content' }}
        locale={{ emptyText: <EmptyText text={p.attemptsEmpty} /> }}
      />
    </Flex>
  );
}

/**
 * 「打款队列」：状态卡、通道卡与队列表（两者各自加载、互不遮挡）；持 payout.execute 时待执行单可勾选
 * 【执行所选】，执行前检查取同一份概览，执行后队列与概览都重新读取。
 */
export function PayoutQueuePanel(props: {
  readonly canList: boolean;
  readonly canExecute: boolean;
}): ReactElement {
  const read = useOverview();
  return (
    <Flex vertical gap={16}>
      <Alert type="info" showIcon role="note" message={p.readOnlyNotice} />
      <OverviewArea read={read} />
      <QueueArea
        canList={props.canList}
        canExecute={props.canExecute}
        overview={read.overview}
        onExecuted={read.refresh}
      />
    </Flex>
  );
}

// ---- 结果待确认 ----------------------------------------------------------------------------------

/** 「结果待确认」：持 payout.execute 时读 unknown-payouts，否则说明无权限、不发请求。 */
export function UnknownPayoutsPanel({ canList }: { readonly canList: boolean }): ReactElement {
  const getProvider = useDataProvider();
  const navigate = useNavigate();
  const loadingClock = useLoadingClock();
  const { token } = theme.useToken();
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ReadStatus>(canList ? 'loading' : 'forbidden');
  const [data, setData] = useState<UnknownPayoutPage>();

  useEffect(() => {
    if (!canList) return;
    let current = true;
    customOf(getProvider)<UnknownPayoutPage>({
      url: UNKNOWN_URL,
      method: 'get',
      query: { page, page_size: PAGE_SIZE },
    }).then(
      (response) => {
        if (!current) return;
        setData(response.data);
        setStatus('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        setData(undefined);
        setStatus(failedAs(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, canList, page, attempt]);

  const reload = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  const changePage = (pagination: TablePaginationConfig) => {
    if (pagination.current === undefined || pagination.current === page) return;
    setStatus('loading');
    setPage(pagination.current);
  };

  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const secondary = { fontSize: token.fontSizeSM, color: token.colorTextSecondary } as const;
  const amount = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;
  const u = p.unknownColumns;

  const columns: TableColumnsType<UnknownPayoutItem> = [
    {
      key: 'number',
      title: u.number,
      render: (_, row) => <span style={code}>{row.out_biz_no}</span>,
    },
    {
      key: 'user',
      title: u.user,
      render: (_, row) => (
        <Flex vertical gap={2}>
          <span style={{ ...code, fontSize: token.fontSizeSM }}>{row.user.user_id}</span>
          {row.user.phone_masked === null ? null : <span>{row.user.phone_masked}</span>}
          <span style={secondary}>{channelLabel(row.payout_channel)}</span>
        </Flex>
      ),
    },
    {
      key: 'net',
      title: u.net,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.net_fen)}</span>,
    },
    {
      key: 'firstTransfer',
      title: u.firstTransfer,
      render: (_, row) => (
        <span style={{ whiteSpace: 'nowrap' }}>{beijingTime(row.first_transfer_at)}</span>
      ),
    },
    {
      key: 'latestQuery',
      title: u.latestQuery,
      render: (_, row) => {
        const query = row.latest_query;
        if (query === null) return t.dash;
        return (
          <Flex vertical gap={2}>
            <span>
              {nameOr(t.attemptResults, query.result)}{' '}
              <span style={{ whiteSpace: 'nowrap' }}>{beijingTime(query.at)}</span>
            </span>
            {query.resp_code === null ? null : (
              <span style={{ ...code, ...secondary }}>
                {query.resp_sub_code === null
                  ? query.resp_code
                  : `${query.resp_code} / ${query.resp_sub_code}`}
              </span>
            )}
          </Flex>
        );
      },
    },
    {
      key: 'blockers',
      title: u.blockers,
      render: (_, row) =>
        row.fail_blockers.length === 0 ? (
          <span style={secondary}>{p.noBlocker}</span>
        ) : (
          <Flex vertical gap={2}>
            {row.fail_blockers.map((blocker) => (
              <span key={blocker} style={secondary}>
                {nameOr(p.failBlockers, blocker)}
              </span>
            ))}
          </Flex>
        ),
    },
    {
      key: 'actions',
      title: u.actions,
      render: (_, row) => (
        <Button size="small" onClick={() => void navigate(detailRoute(row.withdrawal_id))}>
          {p.handleEntry}
        </Button>
      ),
    },
  ];

  let body: ReactElement;
  if (status === 'forbidden') {
    body = (
      <Result status="403" title={p.unknownForbidden} subTitle={p.unknownForbiddenDescription} />
    );
  } else if (status === 'failed') {
    body = (
      <Failed title={p.unknownFailed} description={p.queueFailedDescription} onRetry={reload} />
    );
  } else if (data === undefined) {
    body = <LoadingLine text={p.unknownLoading} />;
  } else {
    body = (
      <>
        {status === 'loading' ? <LoadingLine text={p.unknownLoading} /> : null}
        <Table<UnknownPayoutItem>
          rowKey="withdrawal_id"
          columns={columns}
          dataSource={data.items}
          loading={delayedLoading(status === 'loading', loadingClock)}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: <EmptyText text={p.unknownEmpty} /> }}
          pagination={{
            current: page,
            pageSize: PAGE_SIZE,
            total: data.total,
            showSizeChanger: false,
            showTotal: (total) => t.total(total),
            style: { paddingInline: token.padding },
          }}
          onChange={changePage}
        />
      </>
    );
  }

  return (
    <Flex vertical gap={16}>
      <Alert type="info" showIcon role="note" message={p.unknownNotice} />
      <Card styles={{ body: { padding: 0 } }}>{body}</Card>
    </Flex>
  );
}
