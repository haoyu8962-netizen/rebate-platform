// 调账单详情抽屉（adminGetAdjustment，只读）：单号、用户、方向、金额、原因与状态（后台字典名）、对方科目
// （连同 contra_platform）、说明、凭证、原调账单 / 红冲单（链接，点开在同一抽屉里读那张单）、创建与审核、
// 驳回原因；关联单据逐行；reversed_by_adjust_id 有值时另有「已红冲」标记（不是状态）。持 fund.adjust 时
// 已生效、非红冲单、未被红冲的单另有【红冲】（F1-08cb），待批准单另有【批准】（F1-08cc，批准 / 驳回都在
// 批准对话框里）；对话框都由页签打开。
import { Button, Descriptions, Drawer, Flex, Result, Table, Tag, Typography, theme } from 'antd';
import type { ReactElement, ReactNode } from 'react';
import { adjustmentsTexts } from '../../texts/adjustments.ts';
import { plannedButtonProps } from '../../components/planned/index.ts';
import {
  beijingTime,
  directionLabel,
  money,
  reasonLabel,
  refTypeLabel,
  statusLabel,
  subjectLabel,
  type Adjustment,
} from './model.ts';
import { reversible } from './write.ts';

const t = adjustmentsTexts.detail;
const f = t.fields;

export type DetailState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: Adjustment }
  | { readonly status: 'missing' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'failed' };

export interface DetailDrawerProps {
  readonly open: boolean;
  readonly state: DetailState;
  readonly onClose: () => void;
  readonly onRetry: () => void;
  /** Opens another form (原调账单 / 红冲单) in this drawer. */
  readonly onOpenForm: (adjustId: string) => void;
  /** 【红冲】 of a reversible form (undefined: no fund.adjust, no entry). */
  readonly onReverse?: (item: Adjustment, trigger: HTMLElement) => void;
  /** adminCreateAdjustment is still planned: 【红冲】 is greyed out. */
  readonly planned?: boolean;
  /** 【批准】 of a PENDING form (undefined: no fund.adjust, no entry). */
  readonly onApprove?: (item: Adjustment, trigger: HTMLElement) => void;
  /** Both decisions are still planned: 【批准】 is greyed out. */
  readonly approvePlanned?: boolean;
}

type Ref = Adjustment['refs'][number];

export function DetailDrawer({
  open,
  state,
  onClose,
  onRetry,
  onOpenForm,
  onReverse,
  planned = false,
  onApprove,
  approvePlanned = false,
}: DetailDrawerProps): ReactElement {
  const { token } = theme.useToken();
  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const id = (value: string | null): ReactNode =>
    value === null ? adjustmentsTexts.dash : <span style={code}>{value}</span>;
  const formLink = (value: string | null): ReactNode =>
    value === null ? (
      adjustmentsTexts.dash
    ) : (
      <Button
        type="link"
        size="small"
        autoInsertSpace={false}
        style={{ ...code, padding: 0, height: 'auto' }}
        onClick={() => onOpenForm(value)}
      >
        {value}
      </Button>
    );
  const text = (value: string | null): ReactNode => value ?? adjustmentsTexts.dash;

  let body: ReactElement;
  if (state.status === 'loading') {
    body = (
      <Typography.Text type="secondary" role="status">
        {t.loading}
      </Typography.Text>
    );
  } else if (state.status === 'missing' || state.status === 'forbidden') {
    body = (
      <Result
        status={state.status === 'missing' ? 'warning' : '403'}
        title={state.status === 'missing' ? t.missing : t.forbidden}
      />
    );
  } else if (state.status === 'failed') {
    body = (
      <Result
        status="error"
        title={t.failed}
        extra={<Button onClick={onRetry}>{adjustmentsTexts.retry}</Button>}
      />
    );
  } else {
    const item = state.data;
    const reverse = onReverse !== undefined && reversible(item);
    const approve = onApprove !== undefined && item.status === 'PENDING';
    body = (
      <Flex vertical gap={16}>
        {item.reversed_by_adjust_id === null ? null : (
          <Flex>
            <Tag color="warning" style={{ marginInlineEnd: 0 }}>
              {adjustmentsTexts.adjustments.reversed}
            </Tag>
          </Flex>
        )}
        {reverse ? (
          <Flex justify="flex-end">
            <Button
              danger
              autoInsertSpace={false}
              {...plannedButtonProps(planned)}
              onClick={(event) => onReverse?.(item, event.currentTarget)}
            >
              {adjustmentsTexts.adjustments.reverseEntry}
            </Button>
          </Flex>
        ) : null}
        {approve ? (
          <Flex justify="flex-end">
            <Button
              type="primary"
              autoInsertSpace={false}
              {...plannedButtonProps(approvePlanned)}
              onClick={(event) => onApprove?.(item, event.currentTarget)}
            >
              {adjustmentsTexts.adjustments.approveEntry}
            </Button>
          </Flex>
        ) : null}
        <Descriptions
          bordered
          size="small"
          column={1}
          items={[
            { key: 'id', label: f.id, children: id(item.adjust_id) },
            { key: 'user', label: f.user, children: id(item.user_id) },
            { key: 'direction', label: f.direction, children: directionLabel(item.direction) },
            { key: 'amount', label: f.amount, children: money(item.amount_fen) },
            { key: 'reason', label: f.reason, children: reasonLabel(item.reason_code) },
            {
              key: 'status',
              label: f.status,
              children: <Tag style={{ marginInlineEnd: 0 }}>{statusLabel(item.status)}</Tag>,
            },
            {
              key: 'subject',
              label: f.subject,
              children: subjectLabel(item.contra_subject, item.contra_platform),
            },
            { key: 'note', label: f.note, children: text(item.note) },
            { key: 'voucher', label: f.voucher, children: id(item.voucher_id) },
            { key: 'reverses', label: f.reverses, children: formLink(item.reverses_adjust_id) },
            {
              key: 'reversedBy',
              label: f.reversedBy,
              children: formLink(item.reversed_by_adjust_id),
            },
            {
              key: 'creator',
              label: f.creator,
              children: item.created_by === null ? adjustmentsTexts.system : id(item.created_by),
            },
            { key: 'created', label: f.created, children: beijingTime(item.created_at) },
            { key: 'reviewer', label: f.reviewer, children: id(item.reviewed_by) },
            { key: 'reviewed', label: f.reviewed, children: beijingTime(item.reviewed_at) },
            { key: 'rejectNote', label: f.rejectNote, children: text(item.reject_note) },
          ]}
        />
        <Flex vertical gap={8}>
          <Typography.Text strong>{t.refsTitle}</Typography.Text>
          {item.refs.length === 0 ? (
            <Typography.Text type="secondary">{t.noRefs}</Typography.Text>
          ) : (
            <Table<Ref>
              size="small"
              pagination={false}
              rowKey={(ref) => `${ref.ref_type}:${ref.ref_id}`}
              dataSource={item.refs}
              columns={[
                {
                  key: 'type',
                  title: t.refColumns.type,
                  render: (_, ref) => refTypeLabel(ref.ref_type),
                },
                {
                  key: 'id',
                  title: t.refColumns.id,
                  render: (_, ref) => <span style={code}>{ref.ref_id}</span>,
                },
              ]}
            />
          )}
        </Flex>
      </Flex>
    );
  }

  return (
    <Drawer open={open} width={600} title={t.title} destroyOnHidden onClose={onClose}>
      {body}
    </Drawer>
  );
}
