// 「批准调账单」对话框（系统预填的 ACCOUNT_CLOSED 待批准单，fund.adjust，BR-FUND-24 ①⑧）：只读的单据摘要、
// 关联单据、余额前后预览（adminGetAdjustment 的 balance_preview，打开时重新读取，经 @couli/money）与后果说明；
// 前后余额显示前（读单在途或失败）【批准并短信验证】不可用，失败时给【重新读取】，【驳回】不受影响（BR-FUND-24 ④）；
// 唯一的输入是驳回原因（只给【驳回】用）。
// - 【批准并短信验证】：短信档二次验证后只发一次 POST …/approve，请求体恰为 {}（金额由服务端按批准时可用
//   余额取，可能与预览不同）；20001 adjust_no_balance 提示改为驳回。
// - 【驳回】：本地校验去首尾空白后 1–200 字（不截断），不验证，只发一次 POST …/reject，请求体只有 reason。
// 两个决定都经 useAdjustmentWrite（F1-08ce 的结果未知处理，驳回用不验证的写法），各自一个实例：
// - 没拿到带统一外壳的回答（网络、无法解析）：该决定进入结果未知（编排 D10-1731），原键原请求体保留，只能
//   原样重试（再按同一个决定即【重试】：批准重新短信验证；驳回原因锁定、按已发的请求体重发），对话框不能
//   关闭、【取消】换成【去列表核对】；之后遇 40901 / 5xx 仍结果未知，拿到确定的回答才解除。
// - 带外壳的结果未定（5xx、40901）：沿用原键（驳回原因同样锁定，原请求体重发）。
// - 以上结果未定都提示失败，并先重新读取该单：读回前两个决定都不可用，读回仍待批准才放开，已不是待批准就
//   交回页面提示并刷新、不再提交。20902 同样交回页面。
// 任何失败都不自动重发。
import {
  Alert,
  Button,
  Descriptions,
  Flex,
  Form,
  Input,
  Modal,
  Table,
  Typography,
  theme,
} from 'antd';
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { plannedButtonProps } from '../../components/planned/index.ts';
import { adjustmentsTexts } from '../../texts/adjustments.ts';
import { stepUpTexts } from '../../texts/step-up.ts';
import {
  adjustmentUrl,
  beijingTime,
  directionLabel,
  money,
  reasonLabel,
  refTypeLabel,
  subjectLabel,
  type Adjustment,
  type AdjustmentDetail,
} from './model.ts';
import { useAdjustmentWrite } from './useAdjustmentWrite.tsx';
import { useRead } from './useRead.ts';
import {
  approveUrl,
  decisionErrorText,
  feedback,
  outcomeUnknown,
  rejectReasonError,
  rejectUrl,
  stateChanged,
  type ApproveRequest,
  type Executed,
  type Rejection,
  type RejectRequest,
} from './write.ts';

const a = adjustmentsTexts.approve;
const w = adjustmentsTexts.write;
/** The approval body: always exactly {} (the same object on every resend). */
const APPROVE_BODY: ApproveRequest = {};
const s = a.summary;
const b = a.balance;

type Ref = Adjustment['refs'][number];

export interface ApproveDialogProps {
  /** The PENDING form (as the list or the detail last read it). */
  readonly item: Adjustment;
  /** adminApproveAdjustment / adminRejectAdjustment still planned: that decision is greyed out. */
  readonly approvePlanned: boolean;
  readonly rejectPlanned: boolean;
  /** 【取消】; `uncertain`: a write of this dialog may have been carried out (refresh). */
  readonly onClose: (uncertain: boolean) => void;
  readonly onApproved: (executed: Executed) => void;
  readonly onRejected: (rejection: Rejection) => void;
  /** 20902, or the read after an unknown outcome found the form no longer PENDING. */
  readonly onStale: () => void;
  /** 【去列表核对】 while a decision's result is unknown: close and read the list again. */
  readonly onCheck: () => void;
}

export function ApproveDialog({
  item,
  approvePlanned,
  rejectPlanned,
  onClose,
  onApproved,
  onRejected,
  onStale,
  onCheck,
}: ApproveDialogProps): ReactElement {
  const { token } = theme.useToken();
  const ids = { reason: useId(), phone: useId() };
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState(false);
  const [writeError, setWriteError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  /** An outcome was unknown: the decisions stay locked until a fresh read shows the form PENDING. */
  const [checking, setChecking] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  /**
   * The rejection body whose outcome is still open (its key is kept): it is resent as it is and
   * 驳回原因 is locked meanwhile; undefined: the next rejection takes the reason as typed.
   */
  const [openRejection, setOpenRejection] = useState<RejectRequest>();
  const staleSent = useRef(false);
  const detail = useRead<AdjustmentDetail>(adjustmentUrl(item.adjust_id), undefined, attempt);

  const stale = () => {
    if (staleSent.current) return;
    staleSent.current = true;
    onStale();
  };

  /** It may have been carried out: read the form again before anything is sent again. */
  const recheck = () => {
    setUncertain(true);
    setChecking(true);
    setAttempt((value) => value + 1);
  };
  const failed = (cause: unknown) => {
    if (stateChanged(cause)) {
      stale();
      return;
    }
    setWriteError(decisionErrorText(cause));
    if (outcomeUnknown(cause)) recheck();
  };
  const unknownOutcome = () => {
    setWriteError(w.errors.failed);
    recheck();
  };

  const approval = useAdjustmentWrite<ApproveRequest, Executed>({
    operation: a.operation,
    url: approveUrl(item.adjust_id),
    onDone: onApproved,
    onFailed: failed,
    onUnknown: unknownOutcome,
  });
  const rejection = useAdjustmentWrite<RejectRequest, Rejection>({
    operation: a.reject,
    url: rejectUrl(item.adjust_id),
    verify: false,
    onDone: onRejected,
    onFailed: (cause) => {
      // A final answer: the next rejection takes a new key and the reason as typed.
      if (!outcomeUnknown(cause)) setOpenRejection(undefined);
      failed(cause);
    },
    onUnknown: unknownOutcome,
  });

  // useRead is ready only for the latest attempt: after an unknown outcome `fresh` is that read.
  const fresh = detail.status === 'ready' ? detail.data : undefined;
  const rechecking = checking && fresh?.adjustment.status !== 'PENDING';
  useEffect(() => {
    if (!checking || fresh === undefined || fresh.adjustment.status === 'PENDING') return;
    if (staleSent.current) return;
    staleSent.current = true;
    onStale();
  }, [checking, fresh, onStale]);

  const inFlight = approval.busy || rejection.busy;
  const locked = inFlight || rechecking;
  /** A decision got no reply in the unified envelope: the dialog cannot be closed, only checked. */
  const unknown = approval.unknown || rejection.unknown;
  const reasonLocked = openRejection !== undefined;
  /** BR-FUND-24 ④: approval needs the balance before and after shown (the read has answered). */
  const approveLocked = locked || detail.status !== 'ready';
  const reasonError = checked && !reasonLocked ? rejectReasonError(reason) : undefined;

  const approve = () => {
    if (approveLocked || approval.phoneMissing || approvePlanned) return;
    setWriteError(undefined);
    if (approval.unknown) approval.retry();
    else approval.submit(APPROVE_BODY);
  };

  const reject = () => {
    if (locked || rejectPlanned) return;
    if (rejection.unknown) {
      setWriteError(undefined);
      rejection.retry();
      return;
    }
    if (openRejection !== undefined) {
      // 40901 / 5xx before: the same body under the same key.
      setWriteError(undefined);
      rejection.submit(openRejection);
      return;
    }
    setChecked(true);
    if (rejectReasonError(reason) !== undefined) return;
    setWriteError(undefined);
    const body: RejectRequest = { reason: reason.trim() };
    setOpenRejection(body);
    rejection.submit(body);
  };

  const close = () => {
    if (inFlight || unknown) return;
    onClose(uncertain);
  };
  const check = () => {
    if (inFlight || !unknown) return;
    onCheck();
  };

  const code = { fontFamily: token.fontFamilyCode, wordBreak: 'break-all' } as const;
  const amount = { fontVariantNumeric: 'tabular-nums' } as const;

  let before: ReactNode;
  let take: ReactNode;
  let after: ReactNode;
  if (detail.status === 'ready') {
    const preview = detail.data.balance_preview;
    before = preview === null ? adjustmentsTexts.dash : money(preview.available_before_fen);
    take = preview === null ? adjustmentsTexts.dash : money(preview.amount_fen);
    after = preview === null ? adjustmentsTexts.dash : money(preview.available_after_fen);
  } else if (detail.status === 'failed') {
    before = (
      <Flex align="center" gap={8}>
        <span>{a.readFailed}</span>
        <Button size="small" onClick={() => setAttempt((value) => value + 1)}>
          {a.reread}
        </Button>
      </Flex>
    );
    take = adjustmentsTexts.dash;
    after = adjustmentsTexts.dash;
  } else {
    before = a.balanceLoading;
    take = a.balanceLoading;
    after = a.balanceLoading;
  }

  const footer = [
    unknown ? (
      <Button key="check" autoInsertSpace={false} disabled={inFlight} onClick={check}>
        {w.check}
      </Button>
    ) : (
      <Button key="cancel" autoInsertSpace={false} disabled={inFlight} onClick={close}>
        {a.cancel}
      </Button>
    ),
    <Button
      key="reject"
      danger
      autoInsertSpace={false}
      disabled={locked}
      {...plannedButtonProps(rejectPlanned)}
      onClick={reject}
    >
      {a.reject}
    </Button>,
    <Button
      key="approve"
      type="primary"
      autoInsertSpace={false}
      disabled={approveLocked}
      aria-disabled={approval.phoneMissing ? true : undefined}
      aria-describedby={approval.phoneMissing ? ids.phone : undefined}
      {...plannedButtonProps(approvePlanned)}
      onClick={approve}
    >
      {a.approve}
    </Button>,
  ];

  return (
    <Modal
      open
      width={600}
      title={a.title}
      maskClosable={false}
      keyboard={!inFlight && !unknown}
      closable={!unknown}
      destroyOnHidden
      footer={footer}
      onCancel={close}
    >
      <Flex vertical gap={16}>
        <Alert type="warning" showIcon role="note" message={a.consequence} />
        <Descriptions
          bordered
          size="small"
          column={1}
          items={[
            { key: 'id', label: s.id, children: <span style={code}>{item.adjust_id}</span> },
            { key: 'user', label: s.user, children: <span style={code}>{item.user_id}</span> },
            { key: 'direction', label: s.direction, children: directionLabel(item.direction) },
            { key: 'reason', label: s.reason, children: reasonLabel(item.reason_code) },
            {
              key: 'subject',
              label: s.subject,
              children: subjectLabel(item.contra_subject, item.contra_platform),
            },
            {
              key: 'creator',
              label: s.creator,
              children:
                item.created_by === null ? (
                  adjustmentsTexts.system
                ) : (
                  <span style={code}>{item.created_by}</span>
                ),
            },
            { key: 'created', label: s.created, children: beijingTime(item.created_at) },
          ]}
        />
        <Flex vertical gap={8}>
          <Typography.Text strong>{adjustmentsTexts.detail.refsTitle}</Typography.Text>
          {item.refs.length === 0 ? (
            <Typography.Text type="secondary">{adjustmentsTexts.detail.noRefs}</Typography.Text>
          ) : (
            <Table<Ref>
              size="small"
              pagination={false}
              rowKey={(ref) => `${ref.ref_type}:${ref.ref_id}`}
              dataSource={item.refs}
              columns={[
                {
                  key: 'type',
                  title: adjustmentsTexts.detail.refColumns.type,
                  render: (_, ref) => refTypeLabel(ref.ref_type),
                },
                {
                  key: 'id',
                  title: adjustmentsTexts.detail.refColumns.id,
                  render: (_, ref) => <span style={code}>{ref.ref_id}</span>,
                },
              ]}
            />
          )}
        </Flex>
        <Descriptions
          bordered
          size="small"
          column={1}
          items={[
            { key: 'before', label: b.before, children: <span style={amount}>{before}</span> },
            { key: 'amount', label: b.amount, children: <span style={amount}>{take}</span> },
            { key: 'after', label: b.after, children: <span style={amount}>{after}</span> },
          ]}
        />
        <Typography.Text type="secondary">{a.actualAmount}</Typography.Text>
        <Form layout="vertical" component="div">
          <Form.Item
            label={a.reasonLabel}
            htmlFor={ids.reason}
            {...feedback(reasonError)}
            style={{ marginBottom: 0 }}
          >
            <Input.TextArea
              id={ids.reason}
              value={openRejection?.reason ?? reason}
              readOnly={reasonLocked}
              autoSize={{ minRows: 2, maxRows: 6 }}
              onChange={(event) => setReason(event.target.value)}
            />
          </Form.Item>
        </Form>
        {approval.phoneMissing ? (
          <div id={ids.phone}>
            <Alert type="warning" showIcon message={stepUpTexts.verifyPhoneMissing} />
          </div>
        ) : null}
        {rechecking ? <Alert type="info" showIcon message={a.rechecking} /> : null}
        {unknown ? <Alert type="warning" showIcon message={a.unknown} /> : null}
        {writeError === undefined ? null : <Alert type="error" showIcon message={writeError} />}
      </Flex>
      {approval.stepUp}
    </Modal>
  );
}
