// 差错单详情抽屉（getAdminReconDiff）：三项金额（分 → 元）、类型 / 来源 / 状态（后台字典名）、周期、
// 关联单据、创建 / 更新 / 结案时刻、处理人（未处理时显示文案）、resolution.reason（有才显示；
// resolution 的其他键不读）。持 fund.recon 且状态为待处理 / 处理中时给【已关闭（不处理）】；持
// payout.execute 且为 R2、待处理 / 处理中时给【核销】（F1-08eb，W11 凭账单行）；持
// order.blacklist_clawback 且为 blacklist_after_credit、待处理 / 处理中时给【确认扣回】（F1-08ec）。
// TODO(规划/11 §7): 申诉恢复、去调账、重算余额缓存的操作区 — blocked on 契约未出
import { Alert, Button, Descriptions, Drawer, Flex, Result, Tag, Typography, theme } from 'antd';
import type { ReactElement } from 'react';
import { reconTexts } from '../../texts/recon.ts';
import {
  beijingTime,
  clawable,
  closable,
  money,
  resolutionReason,
  sourceLabel,
  statusColor,
  statusLabel,
  typeLabel,
  writableOff,
  type ReconDiffDetail,
} from './model.ts';

const t = reconTexts.drawer;

export type DetailState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: ReconDiffDetail }
  | { readonly status: 'missing' }
  | { readonly status: 'failed' };

export interface DetailDrawerProps {
  readonly open: boolean;
  readonly state: DetailState;
  readonly canClose: boolean;
  /** The account holds payout.execute (【核销】 of R2 late successes). */
  readonly canWriteOff: boolean;
  /** The account holds order.blacklist_clawback (【确认扣回】 of blacklist_after_credit). */
  readonly canClawback: boolean;
  /** A close, write-off or clawback is under way (its dialog is open). */
  readonly closing: boolean;
  /**
   * A step-up dialog is open above: the drawer drops its antd title meanwhile (it is inert then).
   * Under NODE_ENV=test antd gives every title the same id, so a title here would name that dialog.
   */
  readonly covered: boolean;
  readonly onClose: () => void;
  readonly onRetry: () => void;
  readonly onCloseDiff: (item: ReconDiffDetail) => void;
  readonly onWriteOff: (item: ReconDiffDetail) => void;
  readonly onClawback: (item: ReconDiffDetail) => void;
}

export function DetailDrawer({
  open,
  state,
  canClose,
  canWriteOff,
  canClawback,
  closing,
  covered,
  onClose,
  onRetry,
  onCloseDiff,
  onWriteOff,
  onClawback,
}: DetailDrawerProps): ReactElement {
  const { token } = theme.useToken();
  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;

  let body: ReactElement;
  if (state.status === 'loading') {
    body = (
      <Typography.Text type="secondary" role="status">
        {t.loading}
      </Typography.Text>
    );
  } else if (state.status === 'missing' || state.status === 'failed') {
    body = (
      <Result
        status={state.status === 'missing' ? 'warning' : 'error'}
        title={state.status === 'missing' ? t.missing : t.failed}
        extra={<Button onClick={onRetry}>{t.retry}</Button>}
      />
    );
  } else {
    const item = state.data;
    const reason = resolutionReason(item.resolution);
    const showClose = closable(item.status) && canClose;
    const showWriteOff = canWriteOff && writableOff(item);
    const showClawback = canClawback && clawable(item);
    body = (
      <Flex vertical gap={16}>
        <Descriptions
          bordered
          size="small"
          column={1}
          items={[
            { key: 'id', label: t.id, children: <span style={code}>{item.recon_diff_id}</span> },
            { key: 'type', label: t.type, children: typeLabel(item.type) },
            { key: 'source', label: t.source, children: sourceLabel(item.source) },
            {
              key: 'status',
              label: t.status,
              children: (
                <Tag color={statusColor(item.status)} style={{ marginInlineEnd: 0 }}>
                  {statusLabel(item.status)}
                </Tag>
              ),
            },
            { key: 'period', label: t.period, children: item.period },
            {
              key: 'ref',
              label: t.ref,
              children: (
                <span>
                  <Typography.Text type="secondary">{item.ref_type}</Typography.Text>{' '}
                  <span style={code}>{item.ref_id}</span>
                </span>
              ),
            },
            { key: 'expected', label: t.expected, children: money(item.expected_fen) },
            { key: 'actual', label: t.actual, children: money(item.actual_fen) },
            { key: 'diff', label: t.diff, children: money(item.diff_fen) },
            { key: 'createdAt', label: t.createdAt, children: beijingTime(item.created_at) },
            { key: 'updatedAt', label: t.updatedAt, children: beijingTime(item.updated_at) },
            { key: 'closedAt', label: t.closedAt, children: beijingTime(item.closed_at) },
            {
              key: 'handler',
              label: t.handler,
              children:
                item.handler_id === null ? (
                  <Typography.Text type="secondary">{t.unhandled}</Typography.Text>
                ) : (
                  <span style={code}>{item.handler_id}</span>
                ),
            },
            ...(reason === undefined
              ? []
              : [{ key: 'resolution', label: t.resolution, children: reason }]),
          ]}
        />
        {showClose || showWriteOff || showClawback ? (
          <Flex gap={8} wrap>
            {showClawback ? (
              <Button type="primary" danger disabled={closing} onClick={() => onClawback(item)}>
                {t.clawbackEntry}
              </Button>
            ) : null}
            {showWriteOff ? (
              <Button type="primary" disabled={closing} onClick={() => onWriteOff(item)}>
                {t.writeOffEntry}
              </Button>
            ) : null}
            {showClose ? (
              <Button danger disabled={closing} onClick={() => onCloseDiff(item)}>
                {t.closeEntry}
              </Button>
            ) : null}
          </Flex>
        ) : null}
        {closable(item.status) && !canClose ? (
          <Alert role="note" type="info" showIcon message={t.readOnly} />
        ) : null}
      </Flex>
    );
  }

  return (
    <Drawer
      open={open}
      width={560}
      title={covered ? undefined : t.title}
      destroyOnHidden
      onClose={onClose}
    >
      {body}
    </Drawer>
  );
}
