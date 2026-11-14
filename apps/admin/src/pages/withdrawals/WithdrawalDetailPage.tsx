// 提现单详情（资源 withdrawals/{id}；规格 admin-withdrawal-detail.md，F1-08a 第一段只读）：
// GET /admin/v1/withdrawals/{withdrawal_id}（CT-24y getAdminWithdrawal）——单据摘要、金额明细、
// 自动到账判定（结论、未满足条件、预警实际值、执行受阻）、风险标签快照、收款账号（只显示契约给的
// 脱敏值）、批次与批次明细、转账尝试摘要、生效的提现冻结、处理记录（单据上的各时间点）。
// 持 withdraw.review 或 fund.view 可看；20001 显示未找到，10403 显示无权限。标题行的【审核通过】
// 【驳回】见 ReviewActions.tsx（F1-08ah，持 withdraw.review 且状态可审时显示），写后重新拉详情。
// 结果未知转人工的单（PAYING + needs_manual）的【立即查询】【人工处置】见 UnknownPayoutActions.tsx
// （F1-08aj，持 payout.execute 时显示），写后同样重新拉详情。
// TODO(规划/11 §7): 【执行打款】【手动成功】【撤销微信转账】【重新计算】与手机号 / 收款账号的
// 【查看】全量 — blocked on 契约未出
import { ReloadOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Flex,
  Result,
  Table,
  Tag,
  Timeline,
  Typography,
  theme,
  type TableColumnsType,
} from 'antd';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { withdrawalsTexts } from '../../texts/withdrawals.ts';
import {
  beijingTime,
  canRead,
  channelLabel,
  codeOf,
  conditionLabel,
  itemUrl,
  money,
  nameOr,
  percentOf,
  reviewModeLabel,
  riskLabel,
  statusColor,
  statusLabel,
  type WithdrawalDetail,
} from './model.ts';
import { ReviewActions } from './ReviewActions.tsx';
import { UnknownPayoutActions } from './UnknownPayoutActions.tsx';
import { Forbidden, marksOf } from './WithdrawalsPage.tsx';

const t = withdrawalsTexts.detail;
const dash = withdrawalsTexts.dash;

type Attempt = WithdrawalDetail['payout_attempts'][number];
type BatchItem = WithdrawalDetail['batch_items'][number];
type Hold = WithdrawalDetail['holds'][number];

type DetailState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: WithdrawalDetail }
  | { readonly status: 'missing' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'failed' };

export interface WithdrawalDetailPageProps {
  readonly access: AccessControl;
  readonly withdrawalId: string;
}

export function WithdrawalDetailPage({
  access,
  withdrawalId,
}: WithdrawalDetailPageProps): ReactElement {
  if (!canRead(access)) return <Forbidden />;
  return <DetailContent access={access} withdrawalId={withdrawalId} />;
}

function DetailContent({
  access,
  withdrawalId,
}: {
  readonly access: AccessControl;
  readonly withdrawalId: string;
}): ReactElement {
  const getProvider = useDataProvider();
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DetailState>({ status: 'loading' });

  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<WithdrawalDetail>({ url: itemUrl(withdrawalId), method: 'get' }).then(
      (response) => {
        if (current) setState({ status: 'ready', data: response.data });
      },
      (cause: unknown) => {
        if (!current) return;
        const code = codeOf(cause);
        setState({
          status: code === 20001 ? 'missing' : code === 10403 ? 'forbidden' : 'failed',
        });
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, withdrawalId, attempt]);

  const retry = () => {
    setState({ status: 'loading' });
    setAttempt((value) => value + 1);
  };
  /** Read again after a review write, keeping the current content until the answer arrives. */
  const reload = () => setAttempt((value) => value + 1);

  let body: ReactElement;
  if (state.status === 'loading') {
    body = (
      <Typography.Text type="secondary" role="status">
        {t.loading}
      </Typography.Text>
    );
  } else if (state.status === 'missing') {
    body = <Result status="404" title={t.missing} />;
  } else if (state.status === 'forbidden') {
    body = (
      <Result status="403" title={t.forbidden} subTitle={withdrawalsTexts.forbiddenDescription} />
    );
  } else if (state.status === 'failed') {
    body = (
      <Result
        status="error"
        title={t.failed}
        subTitle={t.failedDescription}
        extra={
          <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={retry}>
            {withdrawalsTexts.retry}
          </Button>
        }
      />
    );
  } else {
    body = <DetailBody item={state.data} />;
  }

  return (
    <Flex vertical gap={16}>
      <Flex align="center" gap={12}>
        <Button onClick={() => void navigate('/withdrawals')}>{t.back}</Button>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {state.status === 'ready' ? state.data.out_biz_no : t.crumb}
        </Typography.Title>
        {state.status === 'ready' ? (
          <Flex gap={8} wrap style={{ marginInlineStart: 'auto' }}>
            <ReviewActions item={state.data} access={access} onChanged={reload} />
            <UnknownPayoutActions item={state.data} access={access} onChanged={reload} />
          </Flex>
        ) : null}
      </Flex>
      {body}
    </Flex>
  );
}

function DetailBody({ item }: { readonly item: WithdrawalDetail }): ReactElement {
  const { token } = theme.useToken();
  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const secondary = { fontSize: token.fontSizeSM, color: token.colorTextSecondary } as const;
  const amount = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;
  const id = (value: string | null): ReactNode =>
    value === null ? dash : <span style={code}>{value}</span>;
  const marks = marksOf(item);
  const decision = item.auto_decision;

  const basic = [
    { key: 'number', label: t.number, children: id(item.out_biz_no) },
    {
      key: 'status',
      label: t.status,
      children: (
        <Tag color={statusColor(item.status)} style={{ marginInlineEnd: 0 }}>
          {statusLabel(item.status)}
        </Tag>
      ),
    },
    { key: 'display', label: t.displayStatus, children: id(item.display_status) },
    {
      key: 'marks',
      label: t.marks,
      children:
        marks.length === 0 ? (
          dash
        ) : (
          <Flex wrap gap={4}>
            {marks.map((mark) => (
              <Tag key={mark} color="warning" style={{ marginInlineEnd: 0 }}>
                {mark}
              </Tag>
            ))}
          </Flex>
        ),
    },
    {
      key: 'mode',
      label: t.reviewMode,
      children: item.review_mode === null ? dash : reviewModeLabel(item.review_mode),
    },
    { key: 'created', label: t.createdAt, children: beijingTime(item.created_at) },
    ...(item.review_mode === 'manual'
      ? [{ key: 'deadline', label: t.reviewDeadline, children: beijingTime(item.review_deadline) }]
      : []),
    { key: 'reviewer', label: t.reviewer, children: id(item.reviewer_id) },
    { key: 'reviewed', label: t.reviewedAt, children: beijingTime(item.reviewed_at) },
    ...(item.reject_reason_code === null
      ? []
      : [{ key: 'reject', label: t.rejectReason, children: id(item.reject_reason_code) }]),
    ...(item.reject_note === null
      ? []
      : [{ key: 'note', label: t.rejectNote, children: item.reject_note }]),
    { key: 'executor', label: t.executor, children: id(item.executor_id) },
    ...(item.fail_code === null
      ? []
      : [{ key: 'fail', label: t.failCode, children: id(item.fail_code) }]),
    ...(item.channel_order_id === null
      ? []
      : [{ key: 'serial', label: t.channelOrderId, children: id(item.channel_order_id) }]),
    ...(item.manual_resolution === null
      ? []
      : [{ key: 'resolution', label: t.manualResolution, children: id(item.manual_resolution) }]),
    ...(item.manual_entry_by === null
      ? []
      : [{ key: 'entry', label: t.manualEntryBy, children: id(item.manual_entry_by) }]),
    ...(item.manual_confirm_by === null
      ? []
      : [{ key: 'confirm', label: t.manualConfirmBy, children: id(item.manual_confirm_by) }]),
    { key: 'user', label: t.user, children: id(item.user.user_id) },
    { key: 'phone', label: t.phone, children: item.user.phone_masked ?? dash },
  ];

  const amounts = [
    { key: 'amount', label: t.amount, value: item.amount_fen },
    { key: 'fee', label: t.fee, value: item.fee_fen },
    { key: 'tax', label: t.tax, value: item.tax_fen },
    { key: 'net', label: t.net, value: item.net_fen },
  ].map(({ key, label, value }) => ({
    key,
    label,
    children: <span style={amount}>{money(value)}</span>,
  }));

  const payee = [
    { key: 'method', label: t.payoutMethod, children: channelLabel(item.payout_method) },
    { key: 'account', label: t.maskedAccount, children: item.payee.masked_account || dash },
    { key: 'name', label: t.maskedName, children: item.payee.masked_name || dash },
    ...(item.payee.bank_name === null
      ? []
      : [{ key: 'bank', label: t.bankName, children: item.payee.bank_name }]),
    ...(item.channel_state === null
      ? []
      : [
          {
            key: 'channelState',
            label: t.channelState,
            children: withdrawalsTexts.withCode(
              nameOr(withdrawalsTexts.channelStates, item.channel_state),
              item.channel_state,
            ),
          },
        ]),
    ...(item.confirm_deadline === null
      ? []
      : [
          {
            key: 'confirmDeadline',
            label: t.confirmDeadline,
            children: beijingTime(item.confirm_deadline),
          },
        ]),
  ];

  const itemColumns: TableColumnsType<BatchItem> = [
    { key: 'batch', title: t.itemBatch, render: (_, row) => id(row.batch_id) },
    {
      key: 'result',
      title: t.itemResult,
      render: (_, row) =>
        withdrawalsTexts.withCode(nameOr(withdrawalsTexts.itemResults, row.result), row.result),
    },
    { key: 'reason', title: t.itemReason, render: (_, row) => id(row.reason) },
    { key: 'moved', title: t.itemMovedTo, render: (_, row) => id(row.moved_to_batch_id) },
    { key: 'at', title: t.itemAt, render: (_, row) => beijingTime(row.at) },
  ];

  const attemptColumns: TableColumnsType<Attempt> = [
    {
      key: 'kind',
      title: t.attemptKind,
      render: (_, row) => nameOr(withdrawalsTexts.attemptKinds, row.kind),
    },
    {
      key: 'result',
      title: t.attemptResult,
      render: (_, row) => nameOr(withdrawalsTexts.attemptResults, row.result),
    },
    { key: 'code', title: t.attemptCode, render: (_, row) => id(row.resp_code) },
    { key: 'sub', title: t.attemptSubCode, render: (_, row) => id(row.resp_sub_code) },
    { key: 'at', title: t.attemptAt, render: (_, row) => beijingTime(row.at) },
  ];

  const holdColumns: TableColumnsType<Hold> = [
    { key: 'reason', title: t.holdReason, render: (_, row) => id(row.reason) },
    { key: 'source', title: t.holdSource, render: (_, row) => id(row.source_ref) },
    { key: 'created', title: t.holdCreatedAt, render: (_, row) => beijingTime(row.created_at) },
    {
      key: 'until',
      title: t.holdUntil,
      render: (_, row) =>
        row.hold_until === null ? t.holdUntilReleased : beijingTime(row.hold_until),
    },
  ];

  const history = [
    { label: t.historyCreated, at: item.created_at },
    { label: t.historyRisk, at: item.risk_flags_at },
    { label: t.historyDecided, at: decision?.decided_at ?? null },
    { label: t.historyReviewed, at: item.reviewed_at },
    { label: t.historyExecuted, at: item.executed_at },
    { label: t.historyHold, at: item.hold_at },
    { label: t.historyPaid, at: item.paid_at },
    { label: t.historyUpdated, at: item.updated_at },
  ].flatMap((entry) => (entry.at === null ? [] : [{ label: entry.label, at: entry.at }]));

  const table = <Row extends object>(
    rows: readonly Row[],
    columns: TableColumnsType<Row>,
    rowKey: (row: Row) => string,
    empty: string,
  ) => (
    <Table<Row>
      size="small"
      rowKey={rowKey}
      columns={columns}
      dataSource={rows as Row[]}
      pagination={false}
      scroll={{ x: 'max-content' }}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} /> }}
    />
  );

  return (
    <Flex vertical gap={16}>
      <Card title={t.basic}>
        <Descriptions bordered size="small" column={{ xs: 1, md: 2 }} items={basic} />
      </Card>
      <Card title={t.amounts}>
        <Descriptions bordered size="small" column={{ xs: 1, md: 4 }} items={amounts} />
      </Card>
      <Card title={t.decision}>
        {decision === null ? (
          <Typography.Text type="secondary">{t.decisionNone}</Typography.Text>
        ) : (
          <Descriptions
            bordered
            size="small"
            column={1}
            items={[
              {
                key: 'result',
                label: t.decisionResult,
                children: reviewModeLabel(decision.result),
              },
              {
                key: 'conditions',
                label: t.failedConditions,
                children:
                  decision.failed_conditions.length === 0 ? (
                    t.noFailedConditions
                  ) : (
                    <Flex wrap gap={4}>
                      {decision.failed_conditions.map((condition) => (
                        <Tag key={condition} color="warning" style={{ marginInlineEnd: 0 }}>
                          {conditionLabel(condition)}
                        </Tag>
                      ))}
                    </Flex>
                  ),
              },
              ...(decision.execute_blocked === null
                ? []
                : [
                    {
                      key: 'blocked',
                      label: t.executeBlocked,
                      children: id(decision.execute_blocked),
                    },
                  ]),
              {
                key: 'warn',
                label: t.warnValues,
                children:
                  decision.warn_values === null ? (
                    dash
                  ) : (
                    <Flex vertical gap={2}>
                      <span>
                        {t.warnHighCommission}{' '}
                        {percentOf(decision.warn_values.high_commission_order_ratio_bp)}
                      </span>
                      <span>
                        {t.warnInvalid} {percentOf(decision.warn_values.invalid_ratio_bp)}
                      </span>
                      <span>
                        {t.warnWithdrawReceived}{' '}
                        {percentOf(decision.warn_values.withdraw_received_ratio_bp)}
                      </span>
                    </Flex>
                  ),
              },
              {
                key: 'version',
                label: t.ruleVersion,
                children: decision.rule_version === null ? dash : String(decision.rule_version),
              },
              { key: 'decided', label: t.decidedAt, children: beijingTime(decision.decided_at) },
            ]}
          />
        )}
      </Card>
      <Card title={t.risk}>
        {item.risk_flags.length === 0 ? (
          <Typography.Text type="secondary">{t.riskNone}</Typography.Text>
        ) : (
          <Flex wrap gap={4}>
            {item.risk_flags.map((flag) => (
              <Tag key={flag.code} color="error" style={{ marginInlineEnd: 0 }}>
                {riskLabel(flag.code)}
              </Tag>
            ))}
          </Flex>
        )}
        {item.risk_flags_at === null ? null : (
          <div style={{ ...secondary, marginTop: 8 }}>
            {t.riskAt(beijingTime(item.risk_flags_at))}
          </div>
        )}
      </Card>
      <Card title={t.payee}>
        {item.channel_state === null ? null : (
          <Alert
            type="info"
            showIcon
            role="note"
            style={{ marginBottom: 12 }}
            message={`${withdrawalsTexts.colon(t.channelState)}${nameOr(withdrawalsTexts.channelStates, item.channel_state)}`}
          />
        )}
        <Descriptions bordered size="small" column={{ xs: 1, md: 2 }} items={payee} />
      </Card>
      <Card title={t.batch}>
        {item.batch === null ? (
          <Typography.Text type="secondary">{t.batchNone}</Typography.Text>
        ) : (
          <Descriptions
            bordered
            size="small"
            column={{ xs: 1, md: 3 }}
            items={[
              { key: 'id', label: t.batchId, children: id(item.batch.batch_id) },
              {
                key: 'kind',
                label: t.batchKind,
                children: nameOr(withdrawalsTexts.batchKinds, item.batch.kind),
              },
              {
                key: 'created',
                label: t.batchCreatedAt,
                children: beijingTime(item.batch.created_at),
              },
            ]}
          />
        )}
        {item.batch_items.length === 0 ? null : (
          <Flex vertical gap={8} style={{ marginTop: 12 }}>
            <Typography.Text strong>{t.batchItems}</Typography.Text>
            {table(
              item.batch_items,
              itemColumns,
              (row) => `${row.batch_id}:${row.at}:${row.result}`,
              dash,
            )}
          </Flex>
        )}
      </Card>
      <Card title={t.attempts}>
        {table(item.payout_attempts, attemptColumns, (row) => row.attempt_id, t.attemptsNone)}
      </Card>
      <Card title={t.holds}>
        {item.holds.length === 0 ? (
          <Typography.Text type="secondary">{t.holdsNone}</Typography.Text>
        ) : (
          table(item.holds, holdColumns, (row) => row.hold_id, t.holdsNone)
        )}
      </Card>
      <Card title={t.history}>
        <Typography.Paragraph type="secondary" style={{ ...secondary, marginTop: 0 }}>
          {t.historyNote}
        </Typography.Paragraph>
        <Timeline
          items={history.map((entry) => ({
            key: entry.label,
            children: (
              <span>
                {entry.label} {beijingTime(entry.at)}
              </span>
            ),
          }))}
        />
      </Card>
    </Flex>
  );
}
