// 「坏账核销」页签（adminListBadDebtWriteoffs，只读）：候选单逐列显示负余额起始日、天数、生成时金额、
// 当前可用余额（负数保留负号）、冻结、状态（后台字典名）与生成时间，页码分页。持 fund.writeoff（超管含）时
// 待批准的行有【批准核销】（F1-08cd，WriteoffApproveDialog，短信验证）；成功、20902 或结果未定后读回已不是
// 待批准时，提示交给页面、列表重新读取；结果未知时【去列表核对】关对话框、列表重新读取。
import { ReloadOutlined } from '@ant-design/icons';
import {
  Button,
  Card,
  Empty,
  Flex,
  Result,
  Table,
  Tag,
  Typography,
  theme,
  type TableColumnsType,
  type TablePaginationConfig,
} from 'antd';
import { useState, type ReactElement } from 'react';
import { plannedButtonProps, usePlanned } from '../../components/planned/index.ts';
import { delayedLoading, useLoadingClock } from '../../motion.ts';
import { adjustmentsTexts } from '../../texts/adjustments.ts';
import {
  PAGE_SIZE,
  WRITEOFFS_URL,
  beijingTime,
  codeOf,
  money,
  writeoffStatusLabel,
  writeoffsQuery,
  type Writeoff,
  type WriteoffPage,
} from './model.ts';
import type { Notice } from './AdjustmentsTab.tsx';
import { useRead } from './useRead.ts';
import { WriteoffApproveDialog } from './WriteoffApproveDialog.tsx';
import type { WriteoffApproved } from './write.ts';

const t = adjustmentsTexts.writeoffs;
const w = adjustmentsTexts.writeoffApprove;

export interface WriteoffsTabProps {
  /** fund.writeoff: 【批准核销】 on the PENDING rows. */
  readonly canWriteoff: boolean;
  readonly onNotice: (notice: Notice) => void;
}

interface Approval {
  readonly item: Writeoff;
  /** The 【批准核销】 that opened the dialog (focus goes back to it on cancel). */
  readonly trigger: HTMLElement;
}

export function WriteoffsTab({ canWriteoff, onNotice }: WriteoffsTabProps): ReactElement {
  const loadingClock = useLoadingClock();
  const { token } = theme.useToken();
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const list = useRead<WriteoffPage>(WRITEOFFS_URL, writeoffsQuery(page), attempt);
  /** The open approval dialog (undefined: closed). */
  const [approval, setApproval] = useState<Approval>();
  const approvePlanned = usePlanned('adminApproveBadDebtWriteoff');

  const reload = () => setAttempt((value) => value + 1);
  const openApprove = (item: Writeoff, trigger: HTMLElement) => setApproval({ item, trigger });
  const cancelApprove = (uncertain: boolean) => {
    const trigger = approval?.trigger;
    setApproval(undefined);
    if (uncertain) reload();
    if (trigger?.isConnected === true) trigger.focus();
  };
  const approved = (result: WriteoffApproved) => {
    setApproval(undefined);
    const { id, status } = result.writeoff;
    onNotice(
      status === 'APPROVED'
        ? { type: 'success', lines: [w.approved(id, money(result.written_off_fen))] }
        : { type: 'success', lines: [w.cancelled(id)] },
    );
    reload();
  };
  const approvalStale = () => {
    setApproval(undefined);
    onNotice({ type: 'warning', lines: [w.errors.stale] });
    reload();
  };
  /** 【去列表核对】 while the approval's result is unknown: close and read the list again. */
  const checkApprove = () => {
    const trigger = approval?.trigger;
    setApproval(undefined);
    reload();
    if (trigger?.isConnected === true) trigger.focus();
  };
  const changePage = (pagination: TablePaginationConfig) => {
    if (pagination.current === undefined || pagination.current === page) return;
    setPage(pagination.current);
  };

  const nowrap = { whiteSpace: 'nowrap' } as const;
  const code = { fontFamily: token.fontFamilyCode, whiteSpace: 'nowrap' } as const;
  const amount = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;
  const c = t.columns;

  const columns: TableColumnsType<Writeoff> = [
    { key: 'id', title: c.id, render: (_, row) => <span style={code}>{row.id}</span> },
    { key: 'user', title: c.user, render: (_, row) => <span style={code}>{row.user_id}</span> },
    {
      key: 'since',
      title: c.since,
      render: (_, row) => <span style={nowrap}>{row.negative_since}</span>,
    },
    { key: 'days', title: c.days, align: 'right', render: (_, row) => String(row.negative_days) },
    {
      key: 'candidate',
      title: c.candidate,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.candidate_fen)}</span>,
    },
    {
      key: 'available',
      title: c.available,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.available_fen)}</span>,
    },
    {
      key: 'frozen',
      title: c.frozen,
      align: 'right',
      render: (_, row) => <span style={amount}>{money(row.frozen_fen)}</span>,
    },
    {
      key: 'status',
      title: c.status,
      render: (_, row) => (
        <Tag style={{ marginInlineEnd: 0 }}>{writeoffStatusLabel(row.status)}</Tag>
      ),
    },
    {
      key: 'created',
      title: c.created,
      render: (_, row) => <span style={nowrap}>{beijingTime(row.created_at)}</span>,
    },
    ...(canWriteoff
      ? [
          {
            key: 'actions',
            title: c.actions,
            fixed: 'right' as const,
            render: (_: unknown, row: Writeoff) =>
              row.status === 'PENDING' ? (
                <Button
                  type="link"
                  size="small"
                  danger
                  autoInsertSpace={false}
                  {...plannedButtonProps(approvePlanned)}
                  onClick={(event) => openApprove(row, event.currentTarget)}
                >
                  {t.approveEntry}
                </Button>
              ) : (
                adjustmentsTexts.dash
              ),
          },
        ]
      : []),
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
      <Table<Writeoff>
        rowKey="id"
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
    <>
      <Card styles={{ body: { padding: 0 } }}>
        <div aria-busy={loading}>{body}</div>
      </Card>
      {approval === undefined ? null : (
        <WriteoffApproveDialog
          key={approval.item.id}
          item={approval.item}
          planned={approvePlanned}
          onClose={cancelApprove}
          onApproved={approved}
          onStale={approvalStale}
          onCheck={checkApprove}
        />
      )}
    </>
  );
}
