// 提现单详情标题行的【审核通过】【驳回】（规格 admin-withdrawal-detail.md §2 标题行与驳回对话框、
// §4–§6；契约 CT-24y adminBatchApproveWithdrawals / adminRejectWithdrawal，BR-WDR-10、BR-WDR-05）。
// 只有持 withdraw.review（超管持有全部点）且状态可审时显示：通过只从 PENDING_REVIEW，驳回从
// PENDING_REVIEW 或 APPROVED；不可审或无权限时不显示。会员有冻结 / 挂起记录照样显示，阻断只由
// 服务端判。流程：确认框 → 动态码（totp 档）→ 只发一次写请求（带 X-Step-Up-Token 与
// Idempotency-Key）→ 重新拉详情。通过走批量接口、只传当前这一张，逐单结果被跳过时按契约原因提示，
// 不报成功。10003 重新要动态码（新凭证、原幂等键、原请求体）；20902 提示并刷新；其余失败提示后
// 保留确认框，不自动重发。提交中确认框保留、提交按钮禁用；关闭后焦点回触发按钮。
import type { Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import { Alert, Button, Descriptions, Flex, Form, Input, Modal, Radio, message, theme } from 'antd';
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { StepUpModal, type StepUpResult } from '../../components/step-up/index.ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { codePointLength } from '../../text-length.ts';
import { withdrawalsTexts } from '../../texts/withdrawals.ts';
import {
  APPROVE_URL,
  REJECT_NOTE_MAX,
  REJECT_REASONS,
  REVIEW_PERMISSION,
  STEP_UP_URL,
  canApprove,
  canReject,
  fieldsOf,
  money,
  newRequestKey,
  reasonOf,
  rejectReasonText,
  rejectUrl,
  statusLabel,
  type RejectReason,
  type WithdrawalDetail,
} from './model.ts';

const t = withdrawalsTexts.review;
const STEP_UP_REFUSED = 10003;
const STATE_CHANGED = 20902;

type Action = 'approve' | 'reject';
type ApprovePayload = Schema<'AdminWithdrawalBatchApproveRequest'>;
type RejectPayload = Schema<'AdminWithdrawalRejectRequest'>;
type ApproveResult = Schema<'AdminWithdrawalBatchApprove'>;
type Notify = ReturnType<typeof message.useMessage>[0];

export interface ReviewActionsProps {
  readonly item: WithdrawalDetail;
  readonly access: AccessControl;
  /** Read the withdrawal again (after a write, a skip or a state conflict). */
  readonly onChanged: () => void;
}

export function ReviewActions({
  item,
  access,
  onChanged,
}: ReviewActionsProps): ReactElement | null {
  const [notify, contextHolder] = message.useMessage();
  const [target, setTarget] = useState<Action>();
  const approveRef = useRef<HTMLButtonElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const closedRef = useRef<Action | undefined>(undefined);
  const allowed = access.can(REVIEW_PERMISSION);
  const approve = allowed && canApprove(item.status);
  const reject = allowed && canReject(item.status);

  // 确认框关闭后焦点回到触发它的按钮（按钮已因状态变化消失时不处理）。
  useEffect(() => {
    if (target !== undefined) return;
    const closed = closedRef.current;
    closedRef.current = undefined;
    if (closed === undefined) return;
    const node = (closed === 'approve' ? approveRef : rejectRef).current;
    if (node?.isConnected === true) node.focus();
  }, [target]);

  const close = useCallback(() => {
    setTarget((current) => {
      closedRef.current = current;
      return undefined;
    });
  }, []);

  const open = (action: Action) => {
    if (target === undefined) setTarget(action);
  };

  return (
    <>
      {contextHolder}
      {approve || reject ? (
        <Flex gap={8} wrap>
          {approve ? (
            <Button
              ref={approveRef}
              autoInsertSpace={false}
              type="primary"
              onClick={() => open('approve')}
            >
              {t.approve}
            </Button>
          ) : null}
          {reject ? (
            <Button ref={rejectRef} autoInsertSpace={false} danger onClick={() => open('reject')}>
              {t.reject}
            </Button>
          ) : null}
        </Flex>
      ) : null}
      {target === undefined ? null : (
        <ReviewDialog
          key={target}
          item={item}
          action={target}
          notify={notify}
          onClose={close}
          onChanged={onChanged}
        />
      )}
    </>
  );
}

type Phase = 'idle' | 'verify' | 'sending';

interface Pending {
  readonly key: string;
  readonly payload: ApprovePayload | RejectPayload;
}

/** 动态码与写请求：一次操作一个幂等键；10003 后重新验证，新凭证、原键、原请求体再发。 */
function useReviewWrite(options: {
  readonly url: string;
  readonly onDone: (data: unknown) => void;
  readonly onFailed: (cause: unknown) => void;
}) {
  const getProvider = useDataProvider();
  const [phase, setPhaseValue] = useState<Phase>('idle');
  const [again, setAgain] = useState(false);
  const phaseRef = useRef<Phase>('idle');
  const pendingRef = useRef<Pending | undefined>(undefined);
  const alive = useRef(true);
  const { url, onDone, onFailed } = options;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const setPhase = (next: Phase) => {
    phaseRef.current = next;
    setPhaseValue(next);
  };

  const customOf = () => {
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    return custom;
  };

  const start = (payload: ApprovePayload | RejectPayload) => {
    if (phaseRef.current !== 'idle') return;
    pendingRef.current = { key: newRequestKey(), payload };
    setAgain(false);
    setPhase('verify');
  };

  const cancel = () => {
    if (phaseRef.current !== 'verify') return;
    pendingRef.current = undefined;
    setPhase('idle');
  };

  const verify = async (code: string): Promise<StepUpResult> => {
    const request: Schema<'AdminStepUpRequest'> = { tier: 'totp', code };
    try {
      const response = await customOf()<Schema<'AdminStepUpResponse'>['data']>({
        url: STEP_UP_URL,
        method: 'post',
        payload: request,
      });
      return { ok: true, stepUpToken: response.data.step_up_token };
    } catch (cause) {
      if (cause instanceof AdminApiError)
        return cause.retryAfterSeconds === undefined
          ? { ok: false, code: cause.code }
          : { ok: false, code: cause.code, retryAfterSeconds: cause.retryAfterSeconds };
      return { ok: false, code: 0 };
    }
  };

  const send = async (pending: Pending, stepUpToken: string): Promise<void> => {
    try {
      const response = await customOf()({
        url,
        method: 'post',
        payload: pending.payload,
        meta: { stepUpToken, idempotencyKey: pending.key },
      });
      if (!alive.current) return;
      pendingRef.current = undefined;
      setPhase('idle');
      onDone(response.data);
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof AdminApiError && cause.code === STEP_UP_REFUSED) {
        // 凭证未被接受：不重用旧凭证，重新验证后以原幂等键与原请求体再发。
        setAgain(true);
        setPhase('verify');
        return;
      }
      pendingRef.current = undefined;
      setPhase('idle');
      onFailed(cause);
    }
  };

  const onVerified = (stepUpToken: string) => {
    const pending = pendingRef.current;
    if (phaseRef.current !== 'verify' || pending === undefined) return;
    setPhase('sending');
    void send(pending, stepUpToken);
  };

  return { phase, again, start, cancel, verify, onVerified };
}

/** The notice of a refused write (the dialog stays open, nothing is sent again). */
function failureNotice(cause: unknown): string {
  if (!(cause instanceof AdminApiError)) return t.failed;
  if (cause.kind === 'network') return t.network;
  if (cause.code === 10403) return t.forbidden;
  if (cause.code === 20001) {
    const fields = fieldsOf(cause);
    if (fields.includes('note')) return t.noteInvalid;
    if (fields.includes('withdrawal_ids')) return t.idsInvalid;
    if (fields.includes('withdrawal_id')) {
      const reason = reasonOf(cause);
      if (reason === 'reject_attempt_exists') return t.attemptExists;
      if (reason === 'reject_query_required') return t.queryRequired;
      if (reason === 'reject_query_success') return t.querySuccess;
      return t.missing;
    }
    return t.invalid;
  }
  return t.failed;
}

/** 内部备注的问题：USER_REQUEST 必填（去首尾空白后非空），最多 500 码点。 */
function noteProblem(reason: RejectReason | undefined, note: string): string | undefined {
  const count = codePointLength(note);
  if (count > REJECT_NOTE_MAX) return t.noteTooLong(count, REJECT_NOTE_MAX);
  if (reason === 'USER_REQUEST' && count === 0) return t.noteRequired;
  return undefined;
}

interface ReviewDialogProps {
  readonly item: WithdrawalDetail;
  readonly action: Action;
  readonly notify: Notify;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}

function ReviewDialog({
  item,
  action,
  notify,
  onClose,
  onChanged,
}: ReviewDialogProps): ReactElement {
  const { token } = theme.useToken();
  const reasonId = useId();
  const noteId = useId();
  const [reason, setReason] = useState<RejectReason>();
  const [reasonError, setReasonError] = useState<string>();
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string>();
  const secondary = { fontSize: token.fontSizeSM, color: token.colorTextSecondary } as const;

  const finish = (notice: () => void) => {
    notice();
    onClose();
    onChanged();
  };

  const write = useReviewWrite({
    url: action === 'approve' ? APPROVE_URL : rejectUrl(item.withdrawal_id),
    onDone: (data) => {
      if (action === 'reject') {
        finish(() => void notify.success(t.rejected));
        return;
      }
      const result = (data as ApproveResult | undefined)?.items?.find(
        (row) => row.withdrawal_id === item.withdrawal_id,
      );
      if (result?.result === 'approved') {
        finish(() => void notify.success(t.approved));
        return;
      }
      const code = result?.reason ?? null;
      // 跳过（或回答里没有这一张）：按契约原因提示，不报成功，并重新拉详情看真实状态。
      finish(
        () =>
          void notify.warning(code === null ? t.failed : (t.skipped[code] ?? t.skippedOther(code))),
      );
    },
    onFailed: (cause) => {
      if (cause instanceof AdminApiError && cause.code === STATE_CHANGED) {
        finish(() => void notify.warning(t.changed));
        return;
      }
      if (
        cause instanceof AdminApiError &&
        cause.code === 20001 &&
        fieldsOf(cause).includes('note')
      )
        setNoteError(t.noteInvalid);
      void notify.error(failureNotice(cause));
    },
  });
  const busy = write.phase !== 'idle';

  const submit = () => {
    if (busy) return;
    if (action === 'approve') {
      write.start({ withdrawal_ids: [item.withdrawal_id] });
      return;
    }
    const reasonIssue = reason === undefined ? t.reasonEmpty : undefined;
    const noteIssue = noteProblem(reason, note);
    setReasonError(reasonIssue);
    setNoteError(noteIssue);
    if (reason === undefined || noteIssue !== undefined) return;
    const trimmed = note.trim();
    write.start(trimmed === '' ? { reason_code: reason } : { reason_code: reason, note: trimmed });
  };

  const cancel = () => {
    if (write.phase === 'sending') return;
    onClose();
  };

  const title =
    action === 'approve' ? t.approveTitle(item.out_biz_no) : t.rejectTitle(item.out_biz_no);

  return (
    <>
      <Modal
        open
        width={560}
        title={title}
        destroyOnHidden
        maskClosable={false}
        keyboard={write.phase !== 'sending'}
        closable={write.phase !== 'sending'}
        onCancel={cancel}
        footer={
          <Flex justify="end" gap={8}>
            <Button autoInsertSpace={false} disabled={write.phase === 'sending'} onClick={cancel}>
              {t.cancel}
            </Button>
            <Button
              autoInsertSpace={false}
              type="primary"
              danger={action === 'reject'}
              disabled={busy}
              onClick={submit}
            >
              {action === 'approve' ? t.approveSubmit : t.rejectSubmit}
            </Button>
          </Flex>
        }
      >
        <Form layout="vertical" component={false}>
          <Flex vertical gap={token.marginSM} style={{ paddingTop: token.paddingXS }}>
            <Descriptions
              bordered
              size="small"
              column={1}
              items={[
                { key: 'number', label: t.number, children: item.out_biz_no },
                { key: 'amount', label: t.amount, children: money(item.amount_fen) },
                { key: 'status', label: t.status, children: statusLabel(item.status) },
              ]}
            />
            <Alert
              type={action === 'approve' ? 'info' : 'warning'}
              showIcon
              message={action === 'approve' ? t.approveConsequence : t.rejectConsequence}
            />
            {item.holds.length === 0 ? null : (
              <Alert type="warning" showIcon message={t.holdsNotice(item.holds.length)} />
            )}
            {action === 'reject' ? (
              <>
                <Form.Item
                  label={<span id={reasonId}>{t.reasonLabel}</span>}
                  required
                  validateStatus={reasonError === undefined ? '' : 'error'}
                  help={reasonError}
                  style={{ marginBottom: 0 }}
                >
                  <Radio.Group
                    aria-labelledby={reasonId}
                    value={reason}
                    disabled={busy}
                    onChange={(event) => {
                      const next = event.target.value as RejectReason;
                      setReason(next);
                      setReasonError(undefined);
                      if (noteError !== undefined) setNoteError(noteProblem(next, note));
                    }}
                  >
                    <Flex vertical gap={8}>
                      {REJECT_REASONS.map((code) => (
                        <div key={code}>
                          <Radio value={code}>
                            {withdrawalsTexts.withCode(t.reasonNames[code] ?? code, code)}
                          </Radio>
                          <div style={{ ...secondary, paddingInlineStart: token.paddingLG }}>
                            {t.userTextLabel}
                            {rejectReasonText(code)}
                          </div>
                        </div>
                      ))}
                    </Flex>
                  </Radio.Group>
                </Form.Item>
                <Form.Item
                  label={t.noteLabel}
                  htmlFor={noteId}
                  required={reason === 'USER_REQUEST'}
                  validateStatus={noteError === undefined ? '' : 'error'}
                  help={noteError}
                  extra={t.noteExtra(codePointLength(note), REJECT_NOTE_MAX)}
                  style={{ marginBottom: 0 }}
                >
                  <Input.TextArea
                    id={noteId}
                    rows={3}
                    value={note}
                    disabled={busy}
                    onChange={(event) => {
                      setNote(event.target.value);
                      if (noteError !== undefined)
                        setNoteError(noteProblem(reason, event.target.value));
                    }}
                  />
                </Form.Item>
              </>
            ) : null}
          </Flex>
        </Form>
      </Modal>
      <StepUpModal
        open={write.phase === 'verify'}
        tier="totp"
        operation={action === 'approve' ? t.operationApprove : t.operationReject}
        details={[t.stepUpTarget(item.out_biz_no), ...(write.again ? [t.stepUpAgain] : [])]}
        onSubmit={write.verify}
        onClose={write.cancel}
        onVerified={write.onVerified}
      />
    </>
  );
}
