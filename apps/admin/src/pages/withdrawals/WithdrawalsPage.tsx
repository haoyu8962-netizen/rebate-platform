// 提现审核（资源 withdrawals，菜单 资金 / 提现审核；规格 admin-withdrawals.md，F1-08a 第一段只读）：
// 「审核列表」——状态页签（全部 / 待审 / 驳回 / 手动 / 自动）、筛选（提现状态、审核方式、收款方式、
// 风险标签、提现单号、用户 ID、申请日期区间；改了未点【查询】不发请求）、页码分页，
// GET /admin/v1/withdrawals（CT-24y listAdminWithdrawals）；行【详情】进 withdrawals/{id}。
// 持 withdraw.review 或 fund.view 可看；两者都没有时本页说明无权限、不发请求。
// TODO(规划/11 §7): 【批量通过】【批量手动打款】【批量自动打款】与一键组批、【导出】、「打款队列」
// 「结果待确认」「自动到账设置」页签与各页签计数 — blocked on 契约未出
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
  Tabs,
  Tag,
  Typography,
  theme,
  type TableColumnsType,
  type TablePaginationConfig,
} from 'antd';
import { useEffect, useId, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { withdrawalsTexts as t } from '../../texts/withdrawals.ts';
import {
  CHANNELS,
  EMPTY_DRAFT,
  LIST_URL,
  PAGE_SIZE,
  REVIEW_MODES,
  RISK_FLAGS,
  STATUSES,
  STATUS_TABS,
  beijingTime,
  canRead,
  channelLabel,
  checkDraft,
  codeOf,
  conditionLabel,
  detailRoute,
  listQuery,
  money,
  reviewModeLabel,
  riskLabel,
  sameDraft,
  statusColor,
  statusLabel,
  type Draft,
  type DraftErrors,
  type Filters,
  type PayoutChannel,
  type ReviewMode,
  type RiskFlagCode,
  type StatusTab,
  type WithdrawalPage,
  type WithdrawalRow,
  type WithdrawalStatus,
} from './model.ts';
import { delayedLoading, useLoadingClock } from '../../motion.ts';

type ListStatus = 'loading' | 'ready' | 'failed' | 'forbidden';

interface ListData {
  readonly items: readonly WithdrawalRow[];
  readonly total: number;
}

export interface WithdrawalsPageProps {
  readonly access: AccessControl;
}

export function Forbidden(): ReactElement {
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

export function WithdrawalsPage({ access }: WithdrawalsPageProps): ReactElement {
  if (!canRead(access)) return <Forbidden />;
  return <WithdrawalsList />;
}

/** The marks shown under a row's status (「暂停」, 执行受阻, needs_manual, hold_reason). */
export function marksOf(row: WithdrawalRow): string[] {
  const marks: string[] = [];
  if (row.blocked_reason !== null) marks.push(t.paused(row.blocked_reason));
  const blocked = row.auto_decision?.execute_blocked ?? null;
  if (blocked !== null) marks.push(t.executeBlocked(blocked));
  if (row.needs_manual) marks.push(t.needsManual);
  if (row.hold_reason !== null) marks.push(t.holdReason(row.hold_reason));
  return marks;
}

function WithdrawalsList(): ReactElement {
  const loadingClock = useLoadingClock();
  const getProvider = useDataProvider();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const ids = {
    status: useId(),
    reviewMode: useId(),
    channel: useId(),
    riskFlag: useId(),
    outBizNo: useId(),
    userId: useId(),
    from: useId(),
    to: useId(),
  };
  const [tab, setTab] = useState<StatusTab>('all');
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [applied, setApplied] = useState<Draft>(EMPTY_DRAFT);
  const [draftErrors, setDraftErrors] = useState<DraftErrors>({});
  const [filters, setFilters] = useState<Filters>({});
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [data, setData] = useState<ListData>();

  // The list: page `page` of the status tab under the applied `filters`; `attempt` reads again.
  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<WithdrawalPage>({
      url: LIST_URL,
      method: 'get',
      query: listQuery(tab, filters, page),
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
  }, [getProvider, tab, filters, page, attempt]);

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
    setApplied(draft);
    setFilters(checked.filters);
    setPage(1);
    reload();
  };

  const reset = () => {
    setDraft(EMPTY_DRAFT);
    setApplied(EMPTY_DRAFT);
    setDraftErrors({});
    setFilters({});
    setPage(1);
    reload();
  };

  const changeTab = (key: string) => {
    const next = STATUS_TABS.find((item) => item === key);
    if (next === undefined || next === tab) return;
    setTab(next);
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

  const columns: TableColumnsType<WithdrawalRow> = [
    {
      key: 'number',
      title: t.columns.number,
      render: (_, row) => <span style={code}>{row.out_biz_no}</span>,
    },
    {
      key: 'user',
      title: t.columns.user,
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
      title: t.columns.amount,
      align: 'right',
      render: (_, row) => (
        <Flex vertical gap={2} align="flex-end">
          <span style={amount}>{money(row.amount_fen)}</span>
          {row.fee_fen === 0 ? null : (
            <span style={{ ...secondary, ...amount }}>
              {t.fee} {money(row.fee_fen)}
            </span>
          )}
          {row.tax_fen === 0 ? null : (
            <span style={{ ...secondary, ...amount }}>
              {t.tax} {money(row.tax_fen)}
            </span>
          )}
        </Flex>
      ),
    },
    {
      key: 'net',
      title: t.columns.net,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.net_fen)}</span>,
    },
    {
      key: 'status',
      title: t.columns.status,
      render: (_, row) => (
        <Flex vertical gap={4} align="flex-start">
          <Tag color={statusColor(row.status)} style={{ marginInlineEnd: 0 }}>
            {statusLabel(row.status)}
          </Tag>
          {row.review_mode === null ? null : (
            <span style={secondary}>{reviewModeLabel(row.review_mode)}</span>
          )}
          {marksOf(row).map((mark) => (
            <Tag key={mark} color="warning" style={{ marginInlineEnd: 0 }}>
              {mark}
            </Tag>
          ))}
        </Flex>
      ),
    },
    {
      key: 'risk',
      title: t.columns.risk,
      render: (_, row) =>
        row.risk_flags.length === 0 ? (
          <span style={secondary}>{t.noRisk}</span>
        ) : (
          <Flex wrap gap={4}>
            {row.risk_flags.map((flag) => (
              <Tag key={flag.code} color="error" style={{ marginInlineEnd: 0 }}>
                {riskLabel(flag.code)}
              </Tag>
            ))}
          </Flex>
        ),
    },
    {
      key: 'reason',
      title: t.columns.reason,
      render: (_, row) => {
        const conditions = row.auto_decision?.failed_conditions ?? [];
        return (
          <Flex vertical gap={2}>
            {conditions.length === 0 ? null : (
              <span>
                <span style={secondary}>{t.colon(t.manualReasons)}</span>
                {t.joinList(conditions.map(conditionLabel))}
              </span>
            )}
            {row.reviewer_id === null ? null : (
              <span>
                <span style={secondary}>{t.colon(t.reviewer)}</span>
                <span style={code}>{row.reviewer_id}</span>
                {row.reviewed_at === null ? null : ` ${beijingTime(row.reviewed_at)}`}
              </span>
            )}
            {row.reject_reason_code === null ? null : (
              <span>
                <span style={secondary}>{t.colon(t.rejectReason)}</span>
                <span style={code}>{row.reject_reason_code}</span>
              </span>
            )}
            {row.batch_id === null ? null : (
              <span>
                <span style={secondary}>{t.colon(t.batch)}</span>
                <span style={code}>{row.batch_id}</span>
              </span>
            )}
          </Flex>
        );
      },
    },
    {
      key: 'createdAt',
      title: t.columns.createdAt,
      render: (_, row) => (
        <span style={{ whiteSpace: 'nowrap' }}>{beijingTime(row.created_at)}</span>
      ),
    },
    {
      key: 'actions',
      title: t.columns.actions,
      width: 80,
      render: (_, row) => (
        <Button size="small" onClick={() => void navigate(detailRoute(row.withdrawal_id))}>
          {t.detailEntry}
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
    body = <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />;
  } else if (status === 'failed') {
    body = (
      <Result
        status="error"
        title={t.loadFailedTitle}
        subTitle={t.loadFailedDescription}
        extra={
          <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={reload}>
            {t.retry}
          </Button>
        }
      />
    );
  } else if (data === undefined) {
    body = loadingLine ?? <span />;
  } else {
    body = (
      <>
        {loadingLine}
        <Table<WithdrawalRow>
          rowKey="withdrawal_id"
          columns={columns}
          dataSource={data.items as WithdrawalRow[]}
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
      </>
    );
  }

  const textItem = (
    field: 'outBizNo' | 'userId' | 'dateFrom' | 'dateTo',
    id: string,
    label: string,
    placeholder: string,
    width: number,
  ) => {
    const error = draftErrors[field];
    return (
      <Form.Item
        label={label}
        htmlFor={id}
        validateStatus={error === undefined ? '' : 'error'}
        help={error}
        style={{ marginBottom: 0 }}
      >
        <Input
          id={id}
          value={draft[field]}
          placeholder={placeholder}
          aria-invalid={error === undefined ? undefined : true}
          style={{ width }}
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
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t.title}
      </Typography.Title>
      <Alert type="info" showIcon role="note" message={t.readOnlyNotice} />
      <Card>
        <Form layout="vertical" component="div">
          <Flex wrap gap={16} align="flex-end">
            <Form.Item label={t.filter.status} htmlFor={ids.status} style={{ marginBottom: 0 }}>
              <Select<WithdrawalStatus>
                id={ids.status}
                value={draft.status ?? null}
                allowClear
                virtual={false}
                placeholder={t.filter.all}
                style={{ width: 160 }}
                options={STATUSES.map((item) => ({ value: item, label: statusLabel(item) }))}
                onChange={(value: WithdrawalStatus | undefined) =>
                  setDraft((previous) => ({ ...previous, status: value ?? undefined }))
                }
              />
            </Form.Item>
            <Form.Item
              label={t.filter.reviewMode}
              htmlFor={ids.reviewMode}
              style={{ marginBottom: 0 }}
            >
              <Select<ReviewMode>
                id={ids.reviewMode}
                value={draft.reviewMode ?? null}
                allowClear
                virtual={false}
                placeholder={t.filter.all}
                style={{ width: 140 }}
                options={REVIEW_MODES.map((item) => ({
                  value: item,
                  label: reviewModeLabel(item),
                }))}
                onChange={(value: ReviewMode | undefined) =>
                  setDraft((previous) => ({ ...previous, reviewMode: value ?? undefined }))
                }
              />
            </Form.Item>
            <Form.Item label={t.filter.channel} htmlFor={ids.channel} style={{ marginBottom: 0 }}>
              <Select<PayoutChannel>
                id={ids.channel}
                value={draft.channel ?? null}
                allowClear
                virtual={false}
                placeholder={t.filter.all}
                style={{ width: 140 }}
                options={CHANNELS.map((item) => ({ value: item, label: channelLabel(item) }))}
                onChange={(value: PayoutChannel | undefined) =>
                  setDraft((previous) => ({ ...previous, channel: value ?? undefined }))
                }
              />
            </Form.Item>
            <Form.Item label={t.filter.riskFlag} htmlFor={ids.riskFlag} style={{ marginBottom: 0 }}>
              <Select<RiskFlagCode>
                id={ids.riskFlag}
                value={draft.riskFlag ?? null}
                allowClear
                virtual={false}
                placeholder={t.filter.all}
                style={{ width: 200 }}
                options={RISK_FLAGS.map((item) => ({ value: item, label: riskLabel(item) }))}
                onChange={(value: RiskFlagCode | undefined) =>
                  setDraft((previous) => ({ ...previous, riskFlag: value ?? undefined }))
                }
              />
            </Form.Item>
            {textItem(
              'outBizNo',
              ids.outBizNo,
              t.filter.outBizNo,
              t.filter.outBizNoPlaceholder,
              200,
            )}
            {textItem('userId', ids.userId, t.filter.userId, t.filter.userIdPlaceholder, 200)}
            {textItem('dateFrom', ids.from, t.filter.createdFrom, t.filter.datePlaceholder, 150)}
            {textItem('dateTo', ids.to, t.filter.createdTo, t.filter.datePlaceholder, 150)}
            <Flex gap={8}>
              <Button onClick={reset}>{t.filter.reset}</Button>
              <Button type="primary" onClick={runQuery}>
                {t.filter.query}
              </Button>
            </Flex>
          </Flex>
        </Form>
        {sameDraft(draft, applied) ? null : (
          <Alert
            type="warning"
            showIcon
            role="status"
            style={{ marginTop: 16 }}
            message={t.filter.draftNotice}
          />
        )}
      </Card>
      <Card styles={{ body: { padding: 0 } }}>
        <Tabs
          activeKey={tab}
          onChange={changeTab}
          style={{ paddingInline: 16 }}
          items={STATUS_TABS.map((key) => ({ key, label: t.statusTabs[key] }))}
        />
        {body}
      </Card>
    </Flex>
  );
}
