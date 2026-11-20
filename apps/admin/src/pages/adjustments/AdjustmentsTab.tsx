// 「调账单」页签（adminListAdjustments）：状态 / 原因 / 用户 ID 筛选（契约只有这三项，AND），页码分页，
// 行【详情】打开调账单详情抽屉（adminGetAdjustment）。持 fund.adjust 时已生效、非红冲单、未被红冲的行与
// 详情另有【红冲】（F1-08cb，ReverseDialog）；成功或 20902 后列表与打开着的详情重新读取，提示交给页面。
// 页面的 `version` 变了（新建调账生效）也重新读取；每次列表读有了回答都告诉页面（`onListRead`）。
// 红冲结果未知时【去列表核对】关对话框并重新读取。持 fund.adjust 时待批准（系统预填）的行与详情另有
// 【批准】（F1-08cc，ApproveDialog：批准并短信验证 / 驳回）；成功、20902、结果未定后读回已不是待批准，或结果
// 未知时【去列表核对】，都关对话框并重新读取列表与打开着的详情。
import { ReloadOutlined } from '@ant-design/icons';
import {
  Button,
  Card,
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
import { plannedButtonProps, usePlanned } from '../../components/planned/index.ts';
import type { MarkerClock } from '../../components/unknown-marker/index.ts';
import { delayedLoading, useLoadingClock } from '../../motion.ts';
import { adjustmentsTexts } from '../../texts/adjustments.ts';
import { ApproveDialog } from './ApproveDialog.tsx';
import { DetailDrawer, type DetailState } from './DetailDrawer.tsx';
import { voucherOf } from './links.ts';
import { ReverseDialog } from './ReverseDialog.tsx';
import {
  ADJUSTMENTS_URL,
  EMPTY_DRAFT,
  PAGE_SIZE,
  REASONS,
  STATUSES,
  adjustmentUrl,
  adjustmentsQuery,
  beijingTime,
  codeOf,
  directionLabel,
  fieldsOf,
  filtersOf,
  money,
  reasonLabel,
  statusLabel,
  type Adjustment,
  type AdjustmentDetail,
  type AdjustmentPage,
  type AdjustmentStatus,
  type Draft,
  type Filters,
  type ReasonCode,
} from './model.ts';
import { useRead } from './useRead.ts';
import { reversible, type Executed, type Rejection } from './write.ts';
import type { LedgerPrefill } from '../ledger/prefill.ts';

const t = adjustmentsTexts.adjustments;

/** A prompt of the page after a write (success, or the original reversed meanwhile). */
export interface Notice {
  readonly type: 'success' | 'warning';
  /** One element per line (the new form id, then the available balance before / after). */
  readonly lines: readonly string[];
  /**
   * The voucher a success wrote (F1-08fe): 【查看凭证】 opens 余额流水 for its user and biz_id.
   * Left out when nothing was written (warnings, a cancelled write-off).
   */
  readonly voucher?: LedgerPrefill;
}

export interface AdjustmentsTabProps {
  /** fund.adjust: 【红冲】 and 【批准】 entries. */
  readonly canAdjust: boolean;
  /** adminCreateAdjustment is still planned: the entries are greyed out. */
  readonly planned: boolean;
  /** Bumped by the page after a write: the list (and an open detail) is read again. */
  readonly version: number;
  /** The page's injected clock: the moment of the result-unknown marker (F1-08at). */
  readonly clock: MarkerClock;
  readonly onNotice: (notice: Notice) => void;
  /** The list read for `version` has answered (ready or failed). */
  readonly onListRead?: (version: number) => void;
  /** adjust_id whose detail opens with the tab (F1-08fe: 余额流水「关联单据」). */
  readonly initialDetail?: string;
}

interface Reversal {
  readonly item: Adjustment;
  /** The 【红冲】 that opened the dialog (focus goes back to it on cancel). */
  readonly trigger: HTMLElement;
}

interface Approval {
  readonly item: Adjustment;
  /** The 【批准】 that opened the dialog (focus goes back to it on cancel). */
  readonly trigger: HTMLElement;
}

export function AdjustmentsTab({
  canAdjust,
  planned,
  version,
  onNotice,
  onListRead,
  initialDetail,
  clock,
}: AdjustmentsTabProps): ReactElement {
  const loadingClock = useLoadingClock();
  const { token } = theme.useToken();
  const ids = { status: useId(), reason: useId(), user: useId() };
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [filters, setFilters] = useState<Filters>({});
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  /** The form shown in the detail drawer (undefined: closed). */
  const [target, setTarget] = useState<string | undefined>(initialDetail);
  /** Bumped on every open and retry of the drawer: each one is a new read. */
  const [detailAttempt, setDetailAttempt] = useState(0);
  /** The open reversal dialog (undefined: closed). */
  const [reversal, setReversal] = useState<Reversal>();
  /** The open approval dialog (undefined: closed). */
  const [approval, setApproval] = useState<Approval>();
  const approvePlanned = usePlanned('adminApproveAdjustment');
  const rejectPlanned = usePlanned('adminRejectAdjustment');
  const entryPlanned = approvePlanned && rejectPlanned;

  // Both reads are also repeated whenever the page bumps `version` (attempt + version grows).
  const list = useRead<AdjustmentPage>(
    ADJUSTMENTS_URL,
    adjustmentsQuery(filters, page),
    attempt + version,
  );
  const detail = useRead<AdjustmentDetail>(
    target === undefined ? undefined : adjustmentUrl(target),
    undefined,
    detailAttempt + version,
  );

  const answered = list.status === 'ready' || list.status === 'failed';
  useEffect(() => {
    if (answered) onListRead?.(version);
  }, [answered, version, onListRead]);

  const reload = () => setAttempt((value) => value + 1);
  /** After a reversal (or a 20902): the list and the open detail are read again. */
  const refresh = () => {
    reload();
    setDetailAttempt((value) => value + 1);
  };
  const openReverse = (item: Adjustment, trigger: HTMLElement) => setReversal({ item, trigger });
  const cancelReverse = () => {
    const trigger = reversal?.trigger;
    setReversal(undefined);
    if (trigger?.isConnected === true) trigger.focus();
  };
  const reversed = (executed: Executed) => {
    setReversal(undefined);
    const w = adjustmentsTexts.write;
    onNotice({
      type: 'success',
      lines: [
        w.reversed(executed.adjustment.adjust_id),
        w.reversedBefore(money(executed.available_before_fen)),
        w.reversedAfter(money(executed.available_after_fen)),
      ],
      voucher: voucherOf(executed),
    });
    refresh();
  };
  const stale = () => {
    setReversal(undefined);
    onNotice({ type: 'warning', lines: [adjustmentsTexts.write.errors.alreadyReversed] });
    refresh();
  };
  /** 【去列表核对】 of a reversal whose result is unknown. */
  const checkReverse = () => {
    cancelReverse();
    refresh();
  };
  const openApprove = (item: Adjustment, trigger: HTMLElement) => setApproval({ item, trigger });
  const cancelApprove = (uncertain: boolean) => {
    const trigger = approval?.trigger;
    setApproval(undefined);
    if (uncertain) refresh();
    if (trigger?.isConnected === true) trigger.focus();
  };
  const approved = (executed: Executed) => {
    setApproval(undefined);
    const w = adjustmentsTexts.write;
    onNotice({
      type: 'success',
      lines: [
        adjustmentsTexts.approve.approved(
          executed.adjustment.adjust_id,
          money(executed.adjustment.amount_fen),
        ),
        w.createdBefore(money(executed.available_before_fen)),
        w.createdAfter(money(executed.available_after_fen)),
      ],
    });
    refresh();
  };
  const rejected = (rejection: Rejection) => {
    setApproval(undefined);
    onNotice({
      type: 'success',
      lines: [adjustmentsTexts.approve.rejected(rejection.adjustment.adjust_id)],
    });
    refresh();
  };
  const approvalStale = () => {
    setApproval(undefined);
    onNotice({ type: 'warning', lines: [adjustmentsTexts.approve.errors.stale] });
    refresh();
  };
  /** 【去列表核对】 of a decision whose result is unknown. */
  const checkApprove = () => {
    cancelApprove(false);
    refresh();
  };
  const openForm = (adjustId: string) => {
    setTarget(adjustId);
    setDetailAttempt((value) => value + 1);
  };

  const runQuery = () => {
    setFilters(filtersOf(draft));
    setPage(1);
    reload();
  };
  const reset = () => {
    setDraft(EMPTY_DRAFT);
    setFilters({});
    setPage(1);
    reload();
  };
  const changePage = (pagination: TablePaginationConfig) => {
    if (pagination.current === undefined || pagination.current === page) return;
    setPage(pagination.current);
  };

  let detailState: DetailState = { status: 'loading' };
  if (detail.status === 'ready') detailState = { status: 'ready', data: detail.data.adjustment };
  else if (detail.status === 'failed') {
    const errorCode = codeOf(detail.cause);
    if (errorCode === 20001 && fieldsOf(detail.cause).includes('adjust_id'))
      detailState = { status: 'missing' };
    else if (errorCode === 10403) detailState = { status: 'forbidden' };
    else detailState = { status: 'failed' };
  }

  const nowrap = { whiteSpace: 'nowrap' } as const;
  const code = { fontFamily: token.fontFamilyCode, whiteSpace: 'nowrap' } as const;
  const amount = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;
  const c = t.columns;

  const columns: TableColumnsType<Adjustment> = [
    { key: 'id', title: c.id, render: (_, row) => <span style={code}>{row.adjust_id}</span> },
    { key: 'user', title: c.user, render: (_, row) => <span style={code}>{row.user_id}</span> },
    {
      key: 'direction',
      title: c.direction,
      render: (_, row) => <span style={nowrap}>{directionLabel(row.direction)}</span>,
    },
    {
      key: 'amount',
      title: c.amount,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.amount_fen)}</span>,
    },
    {
      key: 'reason',
      title: c.reason,
      render: (_, row) => <span style={nowrap}>{reasonLabel(row.reason_code)}</span>,
    },
    {
      key: 'status',
      title: c.status,
      render: (_, row) => <Tag style={{ marginInlineEnd: 0 }}>{statusLabel(row.status)}</Tag>,
    },
    {
      key: 'reversal',
      title: c.reversal,
      render: (_, row) =>
        row.reversed_by_adjust_id === null ? (
          adjustmentsTexts.dash
        ) : (
          <Tag color="warning" style={{ marginInlineEnd: 0 }}>
            {t.reversed}
          </Tag>
        ),
    },
    {
      key: 'creator',
      title: c.creator,
      render: (_, row) =>
        row.created_by === null ? (
          adjustmentsTexts.system
        ) : (
          <span style={code}>{row.created_by}</span>
        ),
    },
    {
      key: 'created',
      title: c.created,
      render: (_, row) => <span style={nowrap}>{beijingTime(row.created_at)}</span>,
    },
    {
      key: 'actions',
      title: c.actions,
      fixed: 'right',
      render: (_, row) => (
        <Flex gap={4} wrap={false}>
          <Button
            type="link"
            size="small"
            autoInsertSpace={false}
            onClick={() => openForm(row.adjust_id)}
          >
            {t.detailEntry}
          </Button>
          {canAdjust && reversible(row) ? (
            <Button
              type="link"
              size="small"
              danger
              autoInsertSpace={false}
              {...plannedButtonProps(planned)}
              onClick={(event) => openReverse(row, event.currentTarget)}
            >
              {t.reverseEntry}
            </Button>
          ) : null}
          {canAdjust && row.status === 'PENDING' ? (
            <Button
              type="link"
              size="small"
              autoInsertSpace={false}
              {...plannedButtonProps(entryPlanned)}
              onClick={(event) => openApprove(row, event.currentTarget)}
            >
              {t.approveEntry}
            </Button>
          ) : null}
        </Flex>
      ),
    },
  ];

  const loading = list.status === 'loading' || list.status === 'idle';
  const rows = list.status === 'ready' || list.status === 'loading' ? list.data : undefined;

  let body: ReactElement;
  if (list.status === 'failed' && codeOf(list.cause) === 10403) {
    body = (
      <Result
        status="403"
        title={adjustmentsTexts.forbidden}
        subTitle={adjustmentsTexts.forbiddenDescription}
      />
    );
  } else if (list.status === 'failed') {
    body = (
      <Result
        status="error"
        title={t.failed}
        subTitle={t.failedDescription}
        extra={
          <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={reload}>
            {adjustmentsTexts.retry}
          </Button>
        }
      />
    );
  } else if (rows === undefined) {
    body = (
      <Flex
        align="center"
        gap={8}
        style={{
          padding: `${token.paddingSM}px ${token.padding}px`,
          borderBottom: `${token.lineWidth}px ${token.lineType} ${token.colorBorderSecondary}`,
        }}
      >
        <Typography.Text type="secondary" role="status">
          {t.loading}
        </Typography.Text>
      </Flex>
    );
  } else {
    body = (
      <Table<Adjustment>
        rowKey="adjust_id"
        columns={columns}
        dataSource={rows.items}
        loading={delayedLoading(loading, loadingClock)}
        scroll={{ x: 'max-content' }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={<Typography.Text>{t.empty}</Typography.Text>}
            />
          ),
        }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: rows.total,
          showSizeChanger: false,
          showTotal: (total) => adjustmentsTexts.total(total),
          style: { paddingInline: token.padding },
        }}
        onChange={changePage}
      />
    );
  }

  return (
    <Flex vertical gap={16}>
      <Card>
        <Form layout="vertical" component="div">
          <Flex wrap gap={16} align="flex-end">
            <Form.Item label={t.filter.status} htmlFor={ids.status} style={{ marginBottom: 0 }}>
              <Select<AdjustmentStatus>
                id={ids.status}
                value={draft.status ?? null}
                allowClear
                virtual={false}
                placeholder={adjustmentsTexts.all}
                style={{ width: 160 }}
                options={STATUSES.map((value) => ({ value, label: statusLabel(value) }))}
                onChange={(value: AdjustmentStatus | undefined) =>
                  setDraft((previous) => ({ ...previous, status: value ?? undefined }))
                }
              />
            </Form.Item>
            <Form.Item label={t.filter.reason} htmlFor={ids.reason} style={{ marginBottom: 0 }}>
              <Select<ReasonCode>
                id={ids.reason}
                value={draft.reasonCode ?? null}
                allowClear
                virtual={false}
                placeholder={adjustmentsTexts.all}
                style={{ width: 200 }}
                options={REASONS.map((value) => ({ value, label: reasonLabel(value) }))}
                onChange={(value: ReasonCode | undefined) =>
                  setDraft((previous) => ({ ...previous, reasonCode: value ?? undefined }))
                }
              />
            </Form.Item>
            <Form.Item label={t.filter.user} htmlFor={ids.user} style={{ marginBottom: 0 }}>
              <Input
                id={ids.user}
                value={draft.userId}
                allowClear
                style={{ width: 320 }}
                onChange={(event) => {
                  const value = event.target.value;
                  setDraft((previous) => ({ ...previous, userId: value }));
                }}
                onPressEnter={runQuery}
              />
            </Form.Item>
            <Flex gap={8}>
              <Button onClick={reset}>{adjustmentsTexts.reset}</Button>
              <Button type="primary" onClick={runQuery}>
                {adjustmentsTexts.query}
              </Button>
            </Flex>
          </Flex>
        </Form>
      </Card>
      <Card styles={{ body: { padding: 0 } }}>
        <div aria-busy={loading}>{body}</div>
      </Card>
      <DetailDrawer
        open={target !== undefined}
        state={detailState}
        onClose={() => setTarget(undefined)}
        onRetry={() => setDetailAttempt((value) => value + 1)}
        onOpenForm={openForm}
        {...(canAdjust ? { onReverse: openReverse, onApprove: openApprove } : {})}
        planned={planned}
        approvePlanned={entryPlanned}
      />
      {reversal === undefined ? null : (
        <ReverseDialog
          key={reversal.item.adjust_id}
          item={reversal.item}
          clock={clock}
          planned={planned}
          onClose={cancelReverse}
          onReversed={reversed}
          onStale={stale}
          onCheck={checkReverse}
        />
      )}
      {approval === undefined ? null : (
        <ApproveDialog
          key={approval.item.adjust_id}
          item={approval.item}
          clock={clock}
          approvePlanned={approvePlanned}
          rejectPlanned={rejectPlanned}
          onClose={cancelApprove}
          onApproved={approved}
          onRejected={rejected}
          onStale={approvalStale}
          onCheck={checkApprove}
        />
      )}
    </Flex>
  );
}
