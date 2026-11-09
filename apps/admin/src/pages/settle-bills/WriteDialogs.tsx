// 月结账单写操作的对话框（F1-08db，契约 CT-24zd）：确认立即 / 定时（一次确认全部待确认批次）、驳回
// （必填原因）、撤销定时、继续执行、发起补充批次。每个对话框：说明 → 提交 → 动态码 → 写请求；成功、
// 20902（状态已变化）与批次不可见交回详情页（关框、提示、重新读取账单），其余失败留在对话框里提示。
// 发起补充批次的 Idempotency-Key 在对话框打开时生成，同一对话框再次提交沿用，重新打开换新。
import { Alert, Button, Flex, Form, Input, Modal, Radio, Typography, theme } from 'antd';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { StepUpModal } from '../../components/step-up/index.ts';
import { codePointLength } from '../../text-length.ts';
import { settleBillsTexts } from '../../texts/settle-bills.ts';
import { DictName } from './DictName.tsx';
import {
  batchKindLabel,
  batchWriteUrl,
  beijingIso,
  billPlatforms,
  codeOf,
  confirmUrl,
  draftBatches,
  expectedBatches,
  fieldsOf,
  newRequestKey,
  reasonOf,
  supplementUrl,
  type BatchWrite,
  type ConfirmRequest,
  type PlatformCode,
  type SettleBatch,
  type SettleBillDetail,
  type SupplementResult,
} from './model.ts';
import { useSettleWrite, type SettleWrite } from './useSettleWrite.ts';

const t = settleBillsTexts.writes;

const CONFLICT = 20902;
const INVALID = 20001;
const FORBIDDEN = 10403;
const KEY_CONFLICT = 20901;
const RUNNING = 40901;
const REASON_MAX = 200;

/** What the detail page does once a write is over: close the dialog, tell, read the bill again. */
export interface WriteNotice {
  readonly type: 'success' | 'info' | 'warning';
  readonly text: string;
}

interface DialogBase {
  readonly onClose: () => void;
  readonly onFinished: (notice: WriteNotice) => void;
}

/** Failures every write hands back to the page: the state moved on, or the batch is gone. */
function pageNotice(cause: unknown): WriteNotice | undefined {
  const code = codeOf(cause);
  if (code === CONFLICT) return { type: 'warning', text: t.changed };
  // An unknown batch is 20001 [batch_id] without a reason; the resume guard adds data.reason.
  if (code === INVALID && fieldsOf(cause).includes('batch_id') && reasonOf(cause) === undefined)
    return { type: 'warning', text: t.batchMissing };
  return undefined;
}

/** Text of a failure shown in the dialog when nothing more specific applies. */
function generalText(cause: unknown): string {
  return codeOf(cause) === FORBIDDEN ? t.forbidden : t.failed;
}

interface ShellProps {
  readonly title: string;
  readonly submitText: string;
  readonly canSubmit: boolean;
  readonly write: SettleWrite;
  readonly operation: string;
  readonly details: readonly string[];
  readonly error: string | undefined;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
  readonly children: ReactNode;
}

/** The dialog, its footer and its step-up. */
function WriteShell(props: ShellProps): ReactElement {
  const { write, onClose } = props;
  const busy = write.phase !== 'idle';
  const close = () => {
    if (write.phase === 'sending') return;
    onClose();
  };
  // While the code dialog is open this dialog is taken out (its state stays in the caller): antd
  // gives every dialog title the same id outside production builds, so two dialogs on the page
  // would share one accessible name.
  const verifying = write.phase === 'verify';
  return (
    <>
      {verifying ? null : (
        <Modal
          open
          width={560}
          title={props.title}
          destroyOnHidden
          maskClosable={false}
          keyboard={!busy}
          closable={!busy}
          onCancel={close}
          footer={
            <Flex justify="flex-end" gap={8}>
              <Button onClick={close} disabled={write.phase === 'sending'}>
                {t.cancel}
              </Button>
              <Button
                type="primary"
                autoInsertSpace={false}
                loading={write.phase === 'sending'}
                disabled={!props.canSubmit}
                onClick={props.onSubmit}
              >
                {props.submitText}
              </Button>
            </Flex>
          }
        >
          <Flex vertical gap={12}>
            {props.children}
            {props.error === undefined ? null : (
              <Alert type="error" showIcon role="alert" message={props.error} />
            )}
          </Flex>
        </Modal>
      )}
      <StepUpModal
        open={verifying}
        tier="totp"
        operation={props.operation}
        details={[...props.details, ...(write.again ? [t.stepUpAgain] : [])]}
        onSubmit={write.verify}
        onClose={write.cancel}
        onVerified={write.onVerified}
      />
    </>
  );
}

function BatchSummary({ batch }: { readonly batch: SettleBatch }): ReactElement {
  const { token } = theme.useToken();
  return (
    <Typography.Text>
      <span style={{ fontFamily: token.fontFamilyCode }}>
        {t.batchLine(batch.batch_id, batch.platform)}
      </span>{' '}
      · <DictName>{batchKindLabel(batch.kind)}</DictName>
    </Typography.Text>
  );
}

// ---- 确认立即执行 / 定时执行 (SB2) ---------------------------------------------------------

export interface ConfirmDialogProps extends DialogBase {
  readonly bill: SettleBillDetail;
  readonly mode: 'IMMEDIATE' | 'SCHEDULED';
}

export function ConfirmDialog({
  bill,
  mode,
  onClose,
  onFinished,
}: ConfirmDialogProps): ReactElement {
  const { token } = theme.useToken();
  const timeId = useId();
  const [time, setTime] = useState('');
  const [timeError, setTimeError] = useState<string>();
  const [error, setError] = useState<string>();
  const drafts = draftBatches(bill);
  const c = t.confirm;

  const write = useSettleWrite<SettleBillDetail>({
    onDone: () => onFinished({ type: 'success', text: c.done(drafts.length) }),
    onFailed: (cause) => {
      const notice = pageNotice(cause);
      if (notice !== undefined) {
        onFinished(notice);
        return;
      }
      if (codeOf(cause) === INVALID) {
        if (fieldsOf(cause).includes('scheduled_at')) {
          setTimeError(c.timeInvalid);
          return;
        }
        if (reasonOf(cause) === 'bill_not_ready') {
          setError(c.notReady);
          return;
        }
        setError(c.bodyInvalid);
        return;
      }
      setError(generalText(cause));
    },
  });

  const scheduled = mode === 'SCHEDULED';
  const submit = () => {
    if (write.phase !== 'idle') return;
    setError(undefined);
    const body: ConfirmRequest = { expected_batches: expectedBatches(bill) };
    if (scheduled) {
      const at = beijingIso(time);
      if (at === undefined) {
        setTimeError(c.timeRequired);
        return;
      }
      if (Date.parse(at) <= Date.now()) {
        setTimeError(c.timeInvalid);
        return;
      }
      setTimeError(undefined);
      body.settle_mode = 'SCHEDULED';
      body.scheduled_at = at;
    } else {
      body.settle_mode = 'IMMEDIATE';
    }
    write.start({ url: confirmUrl(bill.bill_id), payload: body });
  };

  return (
    <WriteShell
      title={scheduled ? c.titleSchedule(bill.bill_id) : c.titleNow(bill.bill_id)}
      submitText={scheduled ? c.submitSchedule : c.submitNow}
      canSubmit={drafts.length > 0 && (!scheduled || time.trim() !== '')}
      write={write}
      operation={scheduled ? c.operationSchedule(bill.bill_id) : c.operationNow(bill.bill_id)}
      details={[c.scope(drafts.length)]}
      error={error}
      onClose={onClose}
      onSubmit={submit}
    >
      <Alert type="info" showIcon message={c.scope(drafts.length)} />
      <ul style={{ margin: 0, paddingInlineStart: token.paddingLG }}>
        {drafts.map((batch) => (
          <li key={batch.batch_id}>
            <BatchSummary batch={batch} />
            {batch.in_current_round ? null : (
              <Typography.Text type="secondary"> {c.outsideRound}</Typography.Text>
            )}
          </li>
        ))}
      </ul>
      {scheduled ? (
        <Form layout="vertical" component={false}>
          <Form.Item
            label={c.time}
            htmlFor={timeId}
            required
            extra={c.timeExtra}
            validateStatus={timeError === undefined ? '' : 'error'}
            help={timeError}
            style={{ marginBottom: 0 }}
          >
            <Input
              id={timeId}
              type="datetime-local"
              value={time}
              disabled={write.phase !== 'idle'}
              onChange={(event) => {
                setTime(event.target.value);
                setTimeError(undefined);
              }}
            />
          </Form.Item>
        </Form>
      ) : (
        <Typography.Text type="secondary">{c.nowNote}</Typography.Text>
      )}
    </WriteShell>
  );
}

// ---- 驳回 / 撤销定时 / 继续执行 (SB4 / SB3 / SB8) -----------------------------------------

export interface BatchDialogProps extends DialogBase {
  readonly batch: SettleBatch;
  readonly action: BatchWrite;
}

function batchCopy(action: BatchWrite) {
  if (action === 'reject') return t.reject;
  if (action === 'cancel-schedule') return t.cancelSchedule;
  return t.resume;
}

export function BatchDialog({
  batch,
  action,
  onClose,
  onFinished,
}: BatchDialogProps): ReactElement {
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string>();
  const [error, setError] = useState<string>();
  const copy = batchCopy(action);
  const rejecting = action === 'reject';
  const trimmed = reason.trim();

  const write = useSettleWrite<SettleBillDetail>({
    onDone: () => onFinished({ type: 'success', text: copy.done }),
    onFailed: (cause) => {
      const notice = pageNotice(cause);
      if (notice !== undefined) {
        onFinished(notice);
        return;
      }
      if (codeOf(cause) === INVALID) {
        if (rejecting && fieldsOf(cause).includes('reason')) {
          setReasonError(t.reject.reasonInvalid);
          return;
        }
        const why = reasonOf(cause);
        if (action === 'resume' && why === 'switches_off') {
          setError(t.resume.switchesOff);
          return;
        }
        if (action === 'resume' && why === 'snapshot_pending') {
          setError(t.resume.snapshotPending);
          return;
        }
      }
      setError(generalText(cause));
    },
  });

  const submit = () => {
    if (write.phase !== 'idle') return;
    setError(undefined);
    if (rejecting) {
      if (trimmed === '' || codePointLength(trimmed) > REASON_MAX) {
        setReasonError(trimmed === '' ? t.reject.reasonInvalid : t.reject.reasonTooLong);
        return;
      }
      write.start({
        url: batchWriteUrl(batch.batch_id, action),
        payload: { expected_row_version: batch.row_version, reason: trimmed },
      });
      return;
    }
    write.start({
      url: batchWriteUrl(batch.batch_id, action),
      payload: { expected_row_version: batch.row_version },
    });
  };

  return (
    <WriteShell
      title={copy.title}
      submitText={copy.submit}
      canSubmit={!rejecting || (trimmed !== '' && codePointLength(trimmed) <= REASON_MAX)}
      write={write}
      operation={copy.operation(batch.batch_id)}
      details={[]}
      error={error}
      onClose={onClose}
      onSubmit={submit}
    >
      <BatchSummary batch={batch} />
      <Typography.Text type="secondary">{copy.note}</Typography.Text>
      {rejecting ? (
        <Form layout="vertical" component={false}>
          <Form.Item
            label={t.reject.reason}
            htmlFor={reasonId}
            required
            validateStatus={reasonError === undefined ? '' : 'error'}
            help={reasonError}
            style={{ marginBottom: 0 }}
          >
            <Input.TextArea
              id={reasonId}
              value={reason}
              rows={3}
              placeholder={t.reject.reasonPlaceholder}
              disabled={write.phase !== 'idle'}
              onChange={(event) => {
                setReason(event.target.value);
                setReasonError(
                  codePointLength(event.target.value) > REASON_MAX
                    ? t.reject.reasonTooLong
                    : undefined,
                );
              }}
            />
          </Form.Item>
        </Form>
      ) : null}
    </WriteShell>
  );
}

// ---- 发起补充批次 --------------------------------------------------------------------------

function supplementFailure(cause: unknown): string {
  const s = t.supplement;
  const code = codeOf(cause);
  if (code === INVALID) {
    const why = reasonOf(cause);
    if (why === 'pending_draft') return s.pendingDraft;
    if (why === 'credit_disabled') return s.creditDisabled;
    if (why === 'bill_not_ready') return s.notReady;
  }
  if (code === KEY_CONFLICT) return s.keyConflict;
  if (code === RUNNING) return s.running;
  return generalText(cause);
}

export interface SupplementDialogProps extends DialogBase {
  readonly bill: SettleBillDetail;
}

export function SupplementDialog({
  bill,
  onClose,
  onFinished,
}: SupplementDialogProps): ReactElement {
  const s = t.supplement;
  const platforms = billPlatforms(bill);
  // One key per opening: a second submission of the same dialog replays it.
  const [requestKey] = useState(newRequestKey);
  const [platform, setPlatform] = useState<PlatformCode | undefined>(
    platforms.length === 1 ? platforms[0] : undefined,
  );
  const [error, setError] = useState<string>();

  const write = useSettleWrite<SupplementResult>({
    onDone: (result) => {
      if (result.outcome === 'duplicate') {
        onFinished({ type: 'info', text: s.duplicate });
        return;
      }
      onFinished(
        result.batch_ids.length === 0
          ? { type: 'info', text: s.nothing }
          : { type: 'success', text: s.generated(result.batch_ids.length) },
      );
    },
    onFailed: (cause) => {
      setError(supplementFailure(cause));
    },
  });

  const submit = () => {
    if (write.phase !== 'idle' || platform === undefined) return;
    setError(undefined);
    write.start({
      url: supplementUrl(bill.bill_id),
      payload: { platform },
      idempotencyKey: requestKey,
    });
  };

  return (
    <WriteShell
      title={s.title(bill.bill_id)}
      submitText={s.submit}
      canSubmit={platform !== undefined}
      write={write}
      operation={s.operation(bill.bill_id, platform ?? '')}
      details={[]}
      error={error}
      onClose={onClose}
      onSubmit={submit}
    >
      <Typography.Text type="secondary">{s.note}</Typography.Text>
      <Form layout="vertical" component={false}>
        <Form.Item label={s.platform} required style={{ marginBottom: 0 }}>
          <Radio.Group
            value={platform}
            disabled={write.phase !== 'idle'}
            options={platforms.map((code) => ({ value: code, label: code }))}
            onChange={(event) => setPlatform(event.target.value as PlatformCode)}
          />
        </Form.Item>
      </Form>
    </WriteShell>
  );
}
