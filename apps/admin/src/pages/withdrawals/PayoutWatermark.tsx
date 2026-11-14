// 打款队列的【录入企业支付宝余额】（标题行）与【录入运营账户余额】（微信零钱通道卡）（F1-08bc；契约
// adminCreatePayoutWatermark POST /admin/v1/payout-watermarks，fund.cash_entry，totp 档 step-up，
// Idempotency-Key 必填；BR-WDR-18 W 与 t_W）。只在持 fund.cash_entry 时出现（超管持有全部点）；
// 银行卡没有入口。对话框：账户、该通道当前 W（取打款概览）、可用余额（元，经 @couli/money 换成
// 整数分）、取数时间（北京时间，发送带 +08:00）、备注（选填）→ 本地校验 → 动态码 → 只发一次 POST →
// 成功后关闭、提示并重新读概览。取数时间是否超前 / 过旧 / 倒退由服务端按注入时钟判定（20001）。
// 幂等键：一次录入一个键，跟请求体走；10003 重新验证与结果未定的失败（网络、40901、5xx）后原样
// 再提交沿用原键；成功、服务端已确定的拒绝（4xx，40901 除外）或改了内容之后换新键。不自动重发。
import { InvalidAmount, fenToJsonNumber, yuanStrToFen } from '@couli/money';
import type { Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import { Button, Descriptions, Flex, Form, Input, Modal, Typography, message, theme } from 'antd';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { StepUpModal, type StepUpResult } from '../../components/step-up/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { codePointLength } from '../../text-length.ts';
import { withdrawalsTexts } from '../../texts/withdrawals.ts';
import {
  STEP_UP_URL,
  WATERMARKS_URL,
  WATERMARK_NOTE_MAX,
  beijingTime,
  fieldsOf,
  isSettledRejection,
  money,
  nameOr,
  newRequestKey,
  parseBeijingTime,
  type PayoutOverview,
  type WatermarkChannel,
  type WatermarkRequest,
} from './model.ts';

const t = withdrawalsTexts.watermark;
const channelTitles = withdrawalsTexts.payouts.channelTitles;
const STEP_UP_REFUSED = 10003;
const AMOUNT = /^[0-9]+(?:\.[0-9]{1,2})?$/;

type Phase = 'idle' | 'verify' | 'sending';

const channelName = (code: WatermarkChannel): string => nameOr(channelTitles, code);

/** The entry button of `channel` (the trigger is handed over so the focus can return to it). */
export function WatermarkEntryButton(props: {
  readonly channel: WatermarkChannel;
  readonly onEnter: (channel: WatermarkChannel, trigger: HTMLElement) => void;
}): ReactElement {
  const { channel, onEnter } = props;
  return (
    <Button
      autoInsertSpace={false}
      size={channel === 'alipay' ? 'middle' : 'small'}
      type={channel === 'alipay' ? 'primary' : 'default'}
      onClick={(event) => onEnter(channel, event.currentTarget)}
    >
      {t.entries[channel]}
    </Button>
  );
}

interface Draft {
  readonly available: string;
  readonly measuredAt: string;
  readonly note: string;
}

interface DraftErrors {
  readonly available?: string;
  readonly measuredAt?: string;
  readonly note?: string;
}

const EMPTY: Draft = { available: '', measuredAt: '', note: '' };

/** Yuan as typed → integer fen (≥ 0, at most two decimals), only through @couli/money. */
function fenOf(text: string): number | undefined {
  if (!AMOUNT.test(text)) return undefined;
  try {
    return fenToJsonNumber(yuanStrToFen(text));
  } catch (cause) {
    if (cause instanceof InvalidAmount) return undefined;
    throw cause;
  }
}

/** Local checks of the draft; the request body when all pass (note only when filled). */
function checkDraft(
  channel: WatermarkChannel,
  draft: Draft,
): { payload: WatermarkRequest } | { errors: DraftErrors } {
  const errors: { -readonly [K in keyof DraftErrors]: DraftErrors[K] } = {};
  const amount = draft.available.trim();
  const fen = amount === '' ? undefined : fenOf(amount);
  if (amount === '') errors.available = t.amountRequired;
  else if (fen === undefined) errors.available = t.amountInvalid;
  const time = draft.measuredAt.trim();
  const measuredAt = time === '' ? undefined : parseBeijingTime(time);
  if (time === '') errors.measuredAt = t.timeRequired;
  else if (measuredAt === undefined) errors.measuredAt = t.timeInvalid;
  const note = draft.note.trim();
  if (draft.note !== '' && note === '') errors.note = t.noteBlank;
  else if (codePointLength(note) > WATERMARK_NOTE_MAX) errors.note = t.noteLong;
  if (Object.keys(errors).length > 0 || fen === undefined || measuredAt === undefined)
    return { errors };
  return {
    payload: {
      channel,
      available_fen: fen,
      measured_at: measuredAt,
      ...(note === '' ? {} : { note }),
    },
  };
}

/** The field messages of a 20001 by data.fields (empty: a dialog notice instead). */
function refusalErrors(cause: AdminApiError): DraftErrors {
  const fields = fieldsOf(cause);
  return {
    ...(fields.includes('available_fen') ? { available: t.serverAmount } : {}),
    ...(fields.includes('measured_at') ? { measuredAt: t.serverTime } : {}),
    ...(fields.includes('note') ? { note: t.serverNote } : {}),
  };
}

/** The notice of a failed submit (the dialog and what was typed stay, nothing is resent). */
function failureNotice(cause: unknown): string {
  if (!(cause instanceof AdminApiError)) return t.failed;
  if (cause.kind === 'network') return t.network;
  if (cause.code === 10403) return t.forbidden;
  if (cause.code === 20001) return t.invalid;
  return t.failed;
}

export interface WatermarkEntryProps {
  /** The channel whose dialog is open (undefined: closed). */
  readonly channel: WatermarkChannel | undefined;
  /** The payout overview (the current W of each channel). */
  readonly overview: PayoutOverview | undefined;
  /** Closes the dialog (the caller returns the focus to the entry). */
  readonly onClose: () => void;
  /** An entry was recorded: read the overview again. */
  readonly onEntered: () => void;
}

/** The entry dialog, its step-up and the notices (kept mounted so a notice outlives the dialog). */
export function WatermarkEntry(props: WatermarkEntryProps): ReactElement {
  const { channel, overview, onClose, onEntered } = props;
  const getProvider = useDataProvider();
  const [notify, contextHolder] = message.useMessage();
  const [phase, setPhaseValue] = useState<Phase>('idle');
  const [again, setAgain] = useState(false);
  const [errors, setErrors] = useState<DraftErrors>({});
  const phaseRef = useRef<Phase>('idle');
  /** The key of the last unconfirmed entry and the body it was for. */
  const keyRef = useRef<{ readonly body: string; readonly key: string } | undefined>(undefined);
  const pendingRef = useRef<{ readonly payload: WatermarkRequest; readonly key: string }>(
    undefined,
  );
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

  const keyFor = (payload: WatermarkRequest): string => {
    const body = JSON.stringify(payload);
    if (keyRef.current?.body === body) return keyRef.current.key;
    const key = newRequestKey();
    keyRef.current = { body, key };
    return key;
  };

  const start = (payload: WatermarkRequest) => {
    if (phaseRef.current !== 'idle') return;
    pendingRef.current = { payload, key: keyFor(payload) };
    setErrors({});
    setAgain(false);
    setPhase('verify');
  };

  const cancelVerify = () => {
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

  const send = async (payload: WatermarkRequest, key: string, stepUpToken: string) => {
    try {
      await customOf()({
        url: WATERMARKS_URL,
        method: 'post',
        payload,
        meta: { stepUpToken, idempotencyKey: key },
      });
      // 已录入：下一次录入是新操作，换新键。
      keyRef.current = undefined;
      pendingRef.current = undefined;
      if (!alive.current) return;
      setPhase('idle');
      setErrors({});
      void notify.success(t.done);
      onClose();
      onEntered();
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof AdminApiError && cause.code === STEP_UP_REFUSED) {
        // 凭证未被接受：重新验证后以新凭证、原幂等键与原请求体再发。
        setAgain(true);
        setPhase('verify');
        return;
      }
      pendingRef.current = undefined;
      // 服务端已确定的拒绝换新键；网络错误、40901、5xx 等结果未定的失败保留原键。
      if (isSettledRejection(cause)) keyRef.current = undefined;
      setPhase('idle');
      if (cause instanceof AdminApiError && cause.kind === 'api' && cause.code === 20001) {
        const placed = refusalErrors(cause);
        if (Object.keys(placed).length > 0) {
          setErrors(placed);
          return;
        }
      }
      void notify.error(failureNotice(cause));
    }
  };

  const onVerified = (stepUpToken: string) => {
    const pending = pendingRef.current;
    if (phaseRef.current !== 'verify' || pending === undefined) return;
    setPhase('sending');
    void send(pending.payload, pending.key, stepUpToken);
  };

  const close = () => {
    if (phaseRef.current !== 'idle') return;
    setErrors({});
    onClose();
  };

  const current = overview?.channels.find((item) => item.channel === channel)?.watermark ?? null;

  return (
    <>
      {contextHolder}
      {channel === undefined ? null : (
        <WatermarkDialog
          key={channel}
          channel={channel}
          current={current}
          phase={phase}
          errors={errors}
          onErrors={setErrors}
          onSubmit={start}
          onCancel={close}
        />
      )}
      <StepUpModal
        open={channel !== undefined && phase === 'verify'}
        tier="totp"
        operation={t.operation}
        details={[
          t.stepUpTarget(channel === undefined ? '' : channelName(channel)),
          ...(again ? [t.stepUpAgain] : []),
        ]}
        onSubmit={verify}
        onClose={cancelVerify}
        onVerified={onVerified}
      />
    </>
  );
}

type Watermark = PayoutOverview['channels'][number]['watermark'];

interface WatermarkDialogProps {
  readonly channel: WatermarkChannel;
  readonly current: Watermark;
  readonly phase: Phase;
  readonly errors: DraftErrors;
  readonly onErrors: (update: (current: DraftErrors) => DraftErrors) => void;
  readonly onSubmit: (payload: WatermarkRequest) => void;
  readonly onCancel: () => void;
}

function WatermarkDialog(props: WatermarkDialogProps): ReactElement {
  const { channel, current, phase, errors, onErrors, onSubmit, onCancel } = props;
  const { token } = theme.useToken();
  const availableId = useId();
  const measuredAtId = useId();
  const noteId = useId();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const busy = phase !== 'idle';
  const sending = phase === 'sending';
  const amount = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;

  const edit = (name: keyof Draft, value: string) => {
    setDraft((before) => ({ ...before, [name]: value }));
    onErrors((before) => ({ ...before, [name]: undefined }));
  };

  const submit = () => {
    if (busy) return;
    const checked = checkDraft(channel, draft);
    if ('errors' in checked) {
      onErrors(() => checked.errors);
      return;
    }
    onSubmit(checked.payload);
  };

  const status = (text: string | undefined) => (text === undefined ? '' : 'error');
  /** The field's own message (no list motion: a replaced message never lingers). */
  const fieldError = (id: string, text: string | undefined) =>
    text === undefined ? null : (
      <Typography.Text id={id} type="danger" role="alert" style={{ display: 'block' }}>
        {text}
      </Typography.Text>
    );
  const invalid = (id: string, text: string | undefined) =>
    text === undefined ? {} : { 'aria-invalid': true, 'aria-errormessage': id };

  return (
    <Modal
      open
      width={600}
      title={t.title(channelName(channel))}
      destroyOnHidden
      maskClosable={false}
      keyboard={!sending}
      closable={!sending}
      onCancel={onCancel}
      footer={
        <Flex justify="end" gap={8}>
          <Button autoInsertSpace={false} disabled={sending} onClick={onCancel}>
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
              { key: 'account', label: t.account, children: channelName(channel) },
              {
                key: 'current',
                label: t.current,
                children:
                  current === null ? (
                    <Typography.Text type="warning">{t.unentered}</Typography.Text>
                  ) : (
                    <span style={amount}>{money(current.available_fen)}</span>
                  ),
              },
              {
                key: 'currentAt',
                label: t.currentAt,
                children: beijingTime(current?.measured_at ?? null),
              },
            ]}
          />
          <Typography.Text type="secondary">{t.purpose}</Typography.Text>
          <Form.Item
            label={t.available}
            htmlFor={availableId}
            required
            validateStatus={status(errors.available)}
            extra={t.availableExtra}
            style={{ marginBottom: 0 }}
          >
            <Input
              id={availableId}
              {...invalid(`${availableId}-error`, errors.available)}
              inputMode="decimal"
              autoComplete="off"
              value={draft.available}
              disabled={busy}
              onChange={(event) => edit('available', event.target.value)}
            />
            {fieldError(`${availableId}-error`, errors.available)}
          </Form.Item>
          <Form.Item
            label={t.measuredAt}
            htmlFor={measuredAtId}
            required
            validateStatus={status(errors.measuredAt)}
            extra={t.measuredAtExtra}
            style={{ marginBottom: 0 }}
          >
            <Input
              id={measuredAtId}
              {...invalid(`${measuredAtId}-error`, errors.measuredAt)}
              autoComplete="off"
              placeholder={t.measuredAtPlaceholder}
              value={draft.measuredAt}
              disabled={busy}
              onChange={(event) => edit('measuredAt', event.target.value)}
            />
            {fieldError(`${measuredAtId}-error`, errors.measuredAt)}
          </Form.Item>
          <Form.Item
            label={t.note}
            htmlFor={noteId}
            validateStatus={status(errors.note)}
            extra={t.noteExtra(codePointLength(draft.note), WATERMARK_NOTE_MAX)}
            style={{ marginBottom: 0 }}
          >
            <Input.TextArea
              id={noteId}
              {...invalid(`${noteId}-error`, errors.note)}
              rows={3}
              value={draft.note}
              disabled={busy}
              onChange={(event) => edit('note', event.target.value)}
            />
            {fieldError(`${noteId}-error`, errors.note)}
          </Form.Item>
        </Flex>
      </Form>
    </Modal>
  );
}
