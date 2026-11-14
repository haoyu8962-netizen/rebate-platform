// 提现单详情标题行的【立即查询】【人工处置】（结果未知转人工的单，BR-WDR-14、BR-WDR-15、BR-WDR-28；
// 契约 adminQueryPayoutResult：POST …/{id}/query，adminResolveUnknownPayout：POST …/{id}/resolve）。
// 只在 PAYING 且 needs_manual=true、持 payout.execute（超管持有全部点）时显示，否则不显示。
// 查询：动态码（totp 档）→ 只发一次 query → 提示已提交并重新拉详情；查询不改状态、页面不报成功，
// 也绝不发转账类请求（只查不重提）。处置：对话框选结论、贴文字凭证（paid 另填通道流水号与实付时间）
// → 本地校验 → 动态码 → 只发一次 resolve → 成功后提示并重新拉详情；服务端拒绝时照原因提示，
// 对话框与已填内容保留，不自动重发。
// 幂等键：一次操作一个键；10003 重新验证后以原键原样再发；结果未定的失败（网络、40901、5xx 等）
// 与 2xxxx 拒绝（契约：不存）都保留原键，手动再提交沿用；只有成功、20901（键冲突，契约要求换键）、
// 20902（状态已变化）与 10403 才丢弃，之后的操作用新键。
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
  EXECUTE_PERMISSION,
  PROOF_MAX,
  STEP_UP_URL,
  canHandleUnknown,
  checkOrderId,
  fieldsOf,
  money,
  newRequestKey,
  parseBeijingTime,
  queryUrl,
  reasonOf,
  resolveUrl,
  statusLabel,
  type WithdrawalDetail,
} from './model.ts';

const t = withdrawalsTexts.unknown;
const STEP_UP_REFUSED = 10003;
const STATE_CHANGED = 20902;
/** Answers after which the Idempotency-Key is dropped (the next operation uses a new one). */
const DROP_KEY: ReadonlySet<number> = new Set([10403, 20901, STATE_CHANGED]);

type ResolvePayload = Schema<'AdminUnknownPayoutResolveRequest'>;
type Resolution = ResolvePayload['resolution'];
type QueryPayload = Record<string, never>;
type Notify = ReturnType<typeof message.useMessage>[0];
type Phase = 'idle' | 'verify' | 'sending';

interface Handlers {
  readonly onDone: (data: unknown) => void;
  readonly onFailed: (cause: unknown) => void;
}

interface Pending<P> {
  readonly payload: P;
  readonly handlers: Handlers;
}

/** Keep the key unless the answer is final for this operation. */
function keepsKey(cause: unknown): boolean {
  if (!(cause instanceof AdminApiError) || cause.kind !== 'api') return true;
  return !DROP_KEY.has(cause.code);
}

/**
 * 动态码与一个写请求。键跨越重新验证与结果未定的失败保留（见文件头）；每次提交都重新验证，不
 * 沿用上一次的凭证。
 */
function useStepUpWrite<P>(url: string) {
  const getProvider = useDataProvider();
  const [phase, setPhaseValue] = useState<Phase>('idle');
  const [again, setAgain] = useState(false);
  const phaseRef = useRef<Phase>('idle');
  const keyRef = useRef<string | undefined>(undefined);
  const pendingRef = useRef<Pending<P> | undefined>(undefined);
  const alive = useRef(true);

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

  const start = (payload: P, handlers: Handlers): void => {
    if (phaseRef.current !== 'idle') return;
    keyRef.current ??= newRequestKey();
    pendingRef.current = { payload, handlers };
    setAgain(false);
    setPhase('verify');
  };

  const cancel = (): void => {
    if (phaseRef.current !== 'verify') return;
    pendingRef.current = undefined;
    setAgain(false);
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

  const send = async (pending: Pending<P>, key: string, stepUpToken: string): Promise<void> => {
    try {
      const response = await customOf()({
        url,
        method: 'post',
        payload: pending.payload,
        meta: { stepUpToken, idempotencyKey: key },
      });
      keyRef.current = undefined;
      if (!alive.current) return;
      pendingRef.current = undefined;
      setPhase('idle');
      pending.handlers.onDone(response.data);
    } catch (cause) {
      if (!keepsKey(cause)) keyRef.current = undefined;
      if (!alive.current) return;
      if (cause instanceof AdminApiError && cause.code === STEP_UP_REFUSED) {
        // 凭证未被接受：不重用旧凭证，重新验证后以原幂等键与原请求体再发。
        setAgain(true);
        setPhase('verify');
        return;
      }
      pendingRef.current = undefined;
      setAgain(false);
      setPhase('idle');
      pending.handlers.onFailed(cause);
    }
  };

  const onVerified = (stepUpToken: string): void => {
    const pending = pendingRef.current;
    const key = keyRef.current;
    if (phaseRef.current !== 'verify' || pending === undefined || key === undefined) return;
    setPhase('sending');
    void send(pending, key, stepUpToken);
  };

  return { phase, again, start, cancel, verify, onVerified };
}

/** The notice of a refused write common to both operations. */
function commonNotice(cause: unknown): string {
  if (!(cause instanceof AdminApiError)) return t.failed;
  if (cause.kind === 'network') return t.network;
  if (cause.code === 10403) return t.forbidden;
  if (cause.code === 20001)
    return fieldsOf(cause).includes('withdrawal_id') ? t.missing : t.invalid;
  return t.failed;
}

type FieldKey = 'proof' | 'orderId' | 'paidAt';

/** The notice of a 20001 refusal of the disposal and the field it points at. */
function resolveRefusal(cause: AdminApiError): { notice: string; field?: FieldKey } {
  const reason = reasonOf(cause);
  const fields = fieldsOf(cause);
  if (reason !== undefined && Object.hasOwn(t.reasons, reason))
    return { notice: t.reasons[reason] ?? t.invalid };
  if (fields.includes('proof_text')) return { notice: t.proofField, field: 'proof' };
  if (fields.includes('channel_order_id')) return { notice: t.orderIdField, field: 'orderId' };
  if (fields.includes('paid_at')) return { notice: t.paidAtField, field: 'paidAt' };
  if (fields.includes('withdrawal_id')) return { notice: t.missing };
  return { notice: t.invalid };
}

export interface UnknownPayoutActionsProps {
  readonly item: WithdrawalDetail;
  readonly access: AccessControl;
  /** Read the withdrawal again (after a write or a state conflict). */
  readonly onChanged: () => void;
}

export function UnknownPayoutActions({
  item,
  access,
  onChanged,
}: UnknownPayoutActionsProps): ReactElement | null {
  const [notify, contextHolder] = message.useMessage();
  const [resolving, setResolving] = useState(false);
  const resolveRef = useRef<HTMLButtonElement>(null);
  const closedRef = useRef(false);
  const query = useStepUpWrite<QueryPayload>(queryUrl(item.withdrawal_id));
  const resolve = useStepUpWrite<ResolvePayload>(resolveUrl(item.withdrawal_id));
  const shown = access.can(EXECUTE_PERMISSION) && canHandleUnknown(item);

  // 处置对话框关闭后焦点回到【人工处置】（按钮已因状态变化消失时不处理）。
  useEffect(() => {
    if (resolving || !closedRef.current) return;
    closedRef.current = false;
    const node = resolveRef.current;
    if (node?.isConnected === true) node.focus();
  }, [resolving]);

  const close = useCallback(() => {
    closedRef.current = true;
    setResolving(false);
  }, []);

  const startQuery = () => {
    query.start(
      {},
      {
        onDone: () => {
          void notify.success(t.querySubmitted);
          onChanged();
        },
        onFailed: (cause) => {
          if (cause instanceof AdminApiError && cause.code === STATE_CHANGED) {
            void notify.warning(t.changed);
            onChanged();
            return;
          }
          void notify.error(commonNotice(cause));
        },
      },
    );
  };

  if (!shown && !resolving) return contextHolder;

  return (
    <>
      {contextHolder}
      {shown ? (
        <Flex gap={8} wrap>
          <Button autoInsertSpace={false} disabled={query.phase === 'sending'} onClick={startQuery}>
            {t.query}
          </Button>
          <Button
            ref={resolveRef}
            autoInsertSpace={false}
            type="primary"
            onClick={() => setResolving(true)}
          >
            {t.resolve}
          </Button>
        </Flex>
      ) : null}
      <StepUpModal
        open={query.phase === 'verify'}
        tier="totp"
        operation={t.operationQuery}
        details={[t.stepUpTarget(item.out_biz_no), ...(query.again ? [t.stepUpAgain] : [])]}
        onSubmit={query.verify}
        onClose={query.cancel}
        onVerified={query.onVerified}
      />
      {resolving ? (
        <ResolveDialog
          item={item}
          write={resolve}
          notify={notify}
          onClose={close}
          onChanged={onChanged}
        />
      ) : null}
      <StepUpModal
        open={resolve.phase === 'verify'}
        tier="totp"
        operation={t.operationResolve}
        details={[t.stepUpTarget(item.out_biz_no), ...(resolve.again ? [t.stepUpAgain] : [])]}
        onSubmit={resolve.verify}
        onClose={resolve.cancel}
        onVerified={resolve.onVerified}
      />
    </>
  );
}

interface Draft {
  readonly resolution: Resolution | undefined;
  readonly proof: string;
  readonly orderId: string;
  readonly paidAt: string;
}

interface DraftErrors {
  readonly resolution?: string;
  readonly proof?: string;
  readonly orderId?: string;
  readonly paidAt?: string;
}

function proofProblem(proof: string): string | undefined {
  const count = codePointLength(proof);
  if (count === 0) return t.proofEmpty;
  if (count > PROOF_MAX) return t.proofTooLong(count, PROOF_MAX);
  return undefined;
}

/** Local checks of the draft; the payload when all pass (failed never carries the paid fields). */
function checkResolve(draft: Draft): { payload: ResolvePayload } | { errors: DraftErrors } {
  const errors: { -readonly [K in keyof DraftErrors]: DraftErrors[K] } = {};
  if (draft.resolution === undefined) errors.resolution = t.resolutionEmpty;
  const proofIssue = proofProblem(draft.proof);
  if (proofIssue !== undefined) errors.proof = proofIssue;
  let paidAt: string | undefined;
  if (draft.resolution === 'paid') {
    if (!checkOrderId(draft.orderId)) errors.orderId = t.orderIdInvalid;
    paidAt = parseBeijingTime(draft.paidAt);
    if (paidAt === undefined) errors.paidAt = t.paidAtInvalid;
  }
  if (Object.keys(errors).length > 0 || draft.resolution === undefined) return { errors };
  const proof_text = draft.proof.trim();
  if (draft.resolution === 'failed') return { payload: { resolution: 'failed', proof_text } };
  return {
    payload: { resolution: 'paid', proof_text, channel_order_id: draft.orderId, paid_at: paidAt! },
  };
}

interface ResolveDialogProps {
  readonly item: WithdrawalDetail;
  readonly write: ReturnType<typeof useStepUpWrite<ResolvePayload>>;
  readonly notify: Notify;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}

function ResolveDialog({
  item,
  write,
  notify,
  onClose,
  onChanged,
}: ResolveDialogProps): ReactElement {
  const { token } = theme.useToken();
  const resolutionId = useId();
  const proofId = useId();
  const orderIdId = useId();
  const paidAtId = useId();
  const [draft, setDraft] = useState<Draft>({
    resolution: undefined,
    proof: '',
    orderId: '',
    paidAt: '',
  });
  const [errors, setErrors] = useState<DraftErrors>({});
  const busy = write.phase !== 'idle';
  const sending = write.phase === 'sending';

  const edit = (patch: Partial<Draft>, clear: keyof DraftErrors) => {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors((current) => ({ ...current, [clear]: undefined }));
  };

  const submit = () => {
    if (busy) return;
    const checked = checkResolve(draft);
    if ('errors' in checked) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    write.start(checked.payload, {
      onDone: () => {
        void notify.success(t.resolved(statusLabel('PAID_API')));
        onClose();
        onChanged();
      },
      onFailed: (cause) => {
        if (cause instanceof AdminApiError && cause.code === STATE_CHANGED) {
          void notify.warning(t.changed);
          onClose();
          onChanged();
          return;
        }
        if (cause instanceof AdminApiError && cause.kind === 'api' && cause.code === 20001) {
          const refusal = resolveRefusal(cause);
          if (refusal.field !== undefined) setErrors({ [refusal.field]: refusal.notice });
          void notify.error(refusal.notice);
          return;
        }
        void notify.error(commonNotice(cause));
      },
    });
  };

  const cancel = () => {
    if (sending) return;
    onClose();
  };

  const status = (message: string | undefined) => (message === undefined ? '' : 'error');

  return (
    <Modal
      open
      width={600}
      title={t.title(item.out_biz_no)}
      destroyOnHidden
      maskClosable={false}
      keyboard={!sending}
      closable={!sending}
      onCancel={cancel}
      footer={
        <Flex justify="end" gap={8}>
          <Button autoInsertSpace={false} disabled={sending} onClick={cancel}>
            {t.cancel}
          </Button>
          <Button autoInsertSpace={false} type="primary" disabled={busy} onClick={submit}>
            {t.submit}
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
              { key: 'net', label: t.netAmount, children: money(item.net_fen) },
              { key: 'status', label: t.status, children: statusLabel(item.status) },
            ]}
          />
          <Alert type="warning" showIcon message={t.consequence} />
          <Form.Item
            label={<span id={resolutionId}>{t.resolutionLabel}</span>}
            required
            validateStatus={status(errors.resolution)}
            help={errors.resolution}
            style={{ marginBottom: 0 }}
          >
            <Radio.Group
              aria-labelledby={resolutionId}
              value={draft.resolution}
              disabled={busy}
              onChange={(event) =>
                edit({ resolution: event.target.value as Resolution }, 'resolution')
              }
            >
              <Flex vertical gap={8}>
                {(['paid', 'failed'] as const).map((code) => (
                  <Radio key={code} value={code}>
                    {code === 'paid'
                      ? t.resolutionPaid(statusLabel('PAID_API'))
                      : t.resolutionFailed}
                  </Radio>
                ))}
              </Flex>
            </Radio.Group>
          </Form.Item>
          {draft.resolution === 'failed' ? (
            <Alert type="info" showIcon message={t.failedNotice} />
          ) : null}
          <Form.Item
            label={t.proofLabel}
            htmlFor={proofId}
            required
            validateStatus={status(errors.proof)}
            help={errors.proof}
            extra={t.proofExtra(codePointLength(draft.proof), PROOF_MAX)}
            style={{ marginBottom: 0 }}
          >
            <Input.TextArea
              id={proofId}
              rows={5}
              value={draft.proof}
              disabled={busy}
              onChange={(event) => edit({ proof: event.target.value }, 'proof')}
            />
          </Form.Item>
          {draft.resolution === 'paid' ? (
            <>
              <Form.Item
                label={t.orderIdLabel}
                htmlFor={orderIdId}
                required
                validateStatus={status(errors.orderId)}
                help={errors.orderId}
                extra={t.orderIdExtra}
                style={{ marginBottom: 0 }}
              >
                <Input
                  id={orderIdId}
                  value={draft.orderId}
                  disabled={busy}
                  autoComplete="off"
                  onChange={(event) => edit({ orderId: event.target.value }, 'orderId')}
                />
              </Form.Item>
              <Form.Item
                label={t.paidAtLabel}
                htmlFor={paidAtId}
                required
                validateStatus={status(errors.paidAt)}
                help={errors.paidAt}
                extra={t.paidAtExtra}
                style={{ marginBottom: 0 }}
              >
                <Input
                  id={paidAtId}
                  value={draft.paidAt}
                  disabled={busy}
                  autoComplete="off"
                  placeholder={t.paidAtPlaceholder}
                  onChange={(event) => edit({ paidAt: event.target.value }, 'paidAt')}
                />
              </Form.Item>
            </>
          ) : null}
        </Flex>
      </Form>
    </Modal>
  );
}
