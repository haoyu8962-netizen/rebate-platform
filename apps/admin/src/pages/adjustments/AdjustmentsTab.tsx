// 「调账单」页签（adminListAdjustments，只读）：状态 / 原因 / 用户 ID 筛选（契约只有这三项，AND），
// 页码分页，行【详情】打开调账单详情抽屉（adminGetAdjustment）。不出现新建、红冲、批准、驳回入口。
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
import { useId, useState, type ReactElement } from 'react';
import { delayedLoading, useLoadingClock } from '../../motion.ts';
import { adjustmentsTexts } from '../../texts/adjustments.ts';
import { DetailDrawer, type DetailState } from './DetailDrawer.tsx';
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

const t = adjustmentsTexts.adjustments;

export function AdjustmentsTab(): ReactElement {
  const loadingClock = useLoadingClock();
  const { token } = theme.useToken();
  const ids = { status: useId(), reason: useId(), user: useId() };
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [filters, setFilters] = useState<Filters>({});
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  /** The form shown in the detail drawer (undefined: closed). */
  const [target, setTarget] = useState<string>();
  /** Bumped on every open and retry of the drawer: each one is a new read. */
  const [detailAttempt, setDetailAttempt] = useState(0);

  const list = useRead<AdjustmentPage>(ADJUSTMENTS_URL, adjustmentsQuery(filters, page), attempt);
  const detail = useRead<AdjustmentDetail>(
    target === undefined ? undefined : adjustmentUrl(target),
    undefined,
    detailAttempt,
  );

  const reload = () => setAttempt((value) => value + 1);
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
        <Button
          type="link"
          size="small"
          autoInsertSpace={false}
          onClick={() => openForm(row.adjust_id)}
        >
          {t.detailEntry}
        </Button>
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
      />
    </Flex>
  );
}
