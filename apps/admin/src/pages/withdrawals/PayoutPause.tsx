// 打款队列的【暂停队列】/【解除暂停】（标题行）与【解除通道暂停】（暂停的通道卡）（F1-08bd；契约
// adminUpdateKillSwitch PUT /admin/v1/kill-switches/{key}：payout.queue_paused 与
// payout.channel_paused.<channel> 需 switch.payout 或 switch.all（超管持全部点），totp 档 step-up
// （档位按契约固定为 totp，不取权限快照的标注），CAS expected_version，没有 Idempotency-Key；
// BR-WDR-17、BR-WDR-33 ①）。入口随打款概览：队列运行时【暂停队列】、暂停时【解除暂停】；只有暂停的
// 通道有【解除通道暂停】（系统置位、人工解除，队列与通道分开解除）。不放通道暂停、开通与打款开关的写入口。
// 流程：确认对话框（原因选填 ≤200 码点，原样发送）→ 动态码 → 读开关列表（adminListKillSwitches，
// 逐页找到该开关）取 version → 只发一次 PUT。成功后关闭、提示并重新读概览，页面状态完全以重新读到的
// 概览为准。20902：提示并刷新概览、不自动重发；10003：重新验证后原样重发（同一请求体、同一
// expected_version）；其余失败提示、不自动重发，再试时重新读开关列表。
import type { Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import { Button, Flex, Form, Input, Modal, Typography, message, theme } from 'antd';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { StepUpModal, type StepUpResult } from '../../components/step-up/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { rawCodePointLength } from '../../text-length.ts';
import { withdrawalsTexts } from '../../texts/withdrawals.ts';
import {
  KILL_SWITCHES_URL,
  QUEUE_PAUSED_KEY,
  STEP_UP_URL,
  SWITCH_PAGE_SIZE,
  SWITCH_REASON_MAX,
  channelPausedKey,
  fieldsOf,
  killSwitchUrl,
  nameOr,
  type KillSwitch,
  type KillSwitchPage,
  type KillSwitchUpdate,
  type PayoutChannel,
  type PayoutOverview,
} from './model.ts';

const t = withdrawalsTexts.pause;
const channelTitles = withdrawalsTexts.payouts.channelTitles;
const STEP_UP_REFUSED = 10003;
const CONFLICT = 20902;
/** Upper bound of list pages read to find one switch (the registry is far smaller). */
const MAX_PAGES = 20;

/** One write of this page: pause the queue, lift the queue pause, lift one channel's pause. */
export type PauseAction =
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'channel'; readonly channel: PayoutChannel };

type Phase = 'idle' | 'verify' | 'sending';

const channelName = (code: string): string => nameOr(channelTitles, code);

/** The switch `action` changes and the value it sets. */
function targetOf(action: PauseAction): { readonly key: string; readonly value: boolean } {
  if (action.kind === 'channel') return { key: channelPausedKey(action.channel), value: false };
  return { key: QUEUE_PAUSED_KEY, value: action.kind === 'pause' };
}

/** A stable identity of `action` (the dialog is keyed by it). */
export function actionId(action: PauseAction): string {
  return action.kind === 'channel' ? `channel:${action.channel}` : action.kind;
}

/** Whether `action` applies to what `overview` shows (else its entry is not offered). */
export function applies(action: PauseAction, overview: PayoutOverview): boolean {
  if (action.kind === 'pause') return !overview.queue_paused;
  if (action.kind === 'resume') return overview.queue_paused;
  return overview.channels.some((item) => item.channel === action.channel && item.paused);
}

function titleOf(action: PauseAction): string {
  return action.kind === 'channel'
    ? t.titles.channel(channelName(action.channel))
    : t.titles[action.kind];
}
function textOf(action: PauseAction): string {
  return action.kind === 'channel'
    ? t.texts.channel(channelName(action.channel))
    : t.texts[action.kind];
}
function doneOf(action: PauseAction): string {
  return action.kind === 'channel'
    ? t.done.channel(channelName(action.channel))
    : t.done[action.kind];
}
function targetName(action: PauseAction): string {
  return action.kind === 'channel'
    ? channelName(action.channel)
    : withdrawalsTexts.payouts.cards.queue;
}

/** The entry button of `action` (the trigger is handed over so the focus can return to it). */
export function PauseEntryButton(props: {
  readonly action: PauseAction;
  readonly onOpen: (action: PauseAction, trigger: HTMLElement) => void;
}): ReactElement {
  const { action, onOpen } = props;
  const queue = action.kind !== 'channel';
  return (
    <Button
      autoInsertSpace={false}
      size={queue ? 'middle' : 'small'}
      danger={action.kind === 'pause'}
      onClick={(event) => onOpen(action, event.currentTarget)}
    >
      {action.kind === 'channel' ? t.entries.channel : t.entries[action.kind]}
    </Button>
  );
}

/** The notice of a failed submit or list read (the dialog and the reason stay, nothing is resent). */
function failureNotice(cause: unknown): string {
  if (!(cause instanceof AdminApiError)) return t.failed;
  if (cause.kind === 'network') return t.network;
  if (cause.code === 10403) return t.forbidden;
  if (cause.code === 20001) return t.invalid;
  return t.failed;
}

export interface PauseEntryProps {
  /** The action whose dialog is open (undefined: closed). */
  readonly action: PauseAction | undefined;
  /** Closes the dialog (the caller returns the focus to the entry). */
  readonly onClose: () => void;
  /** The switch changed, or was found changed by someone else: read the overview again. */
  readonly onChanged: () => void;
}

/** The confirmation dialog, its step-up and the notices (kept mounted so a notice outlives it). */
export function PauseEntry(props: PauseEntryProps): ReactElement {
  const { action, onClose, onChanged } = props;
  const getProvider = useDataProvider();
  const [notify, contextHolder] = message.useMessage();
  const [phase, setPhaseValue] = useState<Phase>('idle');
  const [again, setAgain] = useState(false);
  const [reasonError, setReasonError] = useState<string>();
  const phaseRef = useRef<Phase>('idle');
  /** The action and reason being submitted; the body once the version was read (kept for 10003). */
  const pendingRef = useRef<{
    readonly action: PauseAction;
    readonly reason: string;
    body?: KillSwitchUpdate;
  }>(undefined);
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

  const start = (reason: string) => {
    if (phaseRef.current !== 'idle' || action === undefined) return;
    pendingRef.current = { action, reason };
    setReasonError(undefined);
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

  /** The switch `key` as the list shows it now (page by page); undefined when not registered. */
  const readSwitch = async (key: string): Promise<KillSwitch | undefined> => {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await customOf()<KillSwitchPage>({
        url: KILL_SWITCHES_URL,
        method: 'get',
        query: { page, page_size: SWITCH_PAGE_SIZE },
      });
      const { items, total, page_size: size } = response.data;
      const found = items.find((item) => item.key === key);
      if (found !== undefined) return found;
      if (items.length === 0 || page * size >= total) return undefined;
    }
    return undefined;
  };

  /** The switch moved on (someone else changed it): say so and read the overview again. */
  const moved = () => {
    pendingRef.current = undefined;
    setPhase('idle');
    void notify.warning(t.conflict);
    onChanged();
  };

  /** The request failed: nothing is resent; the dialog stays unless the switch moved on. */
  const failed = (cause: unknown) => {
    pendingRef.current = undefined;
    setPhase('idle');
    if (cause instanceof AdminApiError && cause.kind === 'api' && cause.code === CONFLICT) {
      moved();
      return;
    }
    if (cause instanceof AdminApiError && cause.kind === 'api' && cause.code === 20001) {
      if (fieldsOf(cause).includes('reason')) {
        setReasonError(t.serverReason);
        return;
      }
    }
    void notify.error(failureNotice(cause));
  };

  const send = async (stepUpToken: string) => {
    const pending = pendingRef.current;
    if (pending === undefined) return;
    const target = targetOf(pending.action);
    try {
      if (pending.body === undefined) {
        // 每次提交（含失败后再试）都重新读开关列表取当前 version；10003 重验后沿用原请求体。
        const found = await readSwitch(target.key);
        if (!alive.current) return;
        if (found === undefined) {
          failed(undefined);
          return;
        }
        if ((found.value ?? found.default) === target.value) {
          // 已经是目标值（别人刚改过）：不发写请求，按状态已变化处理。
          moved();
          return;
        }
        pending.body = {
          value: target.value,
          expected_version: found.version,
          ...(pending.reason.trim() === '' ? {} : { reason: pending.reason }),
        };
      }
      await customOf()({
        url: killSwitchUrl(target.key),
        method: 'put',
        payload: pending.body,
        meta: { stepUpToken },
      });
      pendingRef.current = undefined;
      if (!alive.current) return;
      setPhase('idle');
      setReasonError(undefined);
      void notify.success(doneOf(pending.action));
      onClose();
      onChanged();
    } catch (cause) {
      if (!alive.current) return;
      if (cause instanceof AdminApiError && cause.code === STEP_UP_REFUSED) {
        // 凭证未被接受：重新验证后以新凭证与原请求体再发。
        setAgain(true);
        setPhase('verify');
        return;
      }
      failed(cause);
    }
  };

  const onVerified = (stepUpToken: string) => {
    if (phaseRef.current !== 'verify' || pendingRef.current === undefined) return;
    setPhase('sending');
    void send(stepUpToken);
  };

  const close = () => {
    if (phaseRef.current !== 'idle') return;
    setReasonError(undefined);
    onClose();
  };

  return (
    <>
      {contextHolder}
      {action === undefined ? null : (
        <PauseDialog
          key={actionId(action)}
          action={action}
          phase={phase}
          reasonError={reasonError}
          onReasonError={setReasonError}
          onSubmit={start}
          onCancel={close}
        />
      )}
      <StepUpModal
        open={action !== undefined && phase === 'verify'}
        tier="totp"
        operation={
          action === undefined
            ? ''
            : action.kind === 'channel'
              ? t.operations.channel
              : t.operations[action.kind]
        }
        details={[
          t.stepUpTarget(action === undefined ? '' : targetName(action)),
          ...(again ? [t.stepUpAgain] : []),
        ]}
        onSubmit={verify}
        onClose={cancelVerify}
        onVerified={onVerified}
      />
    </>
  );
}

interface PauseDialogProps {
  readonly action: PauseAction;
  readonly phase: Phase;
  readonly reasonError: string | undefined;
  readonly onReasonError: (text: string | undefined) => void;
  readonly onSubmit: (reason: string) => void;
  readonly onCancel: () => void;
}

function PauseDialog(props: PauseDialogProps): ReactElement {
  const { action, phase, reasonError, onReasonError, onSubmit, onCancel } = props;
  const { token } = theme.useToken();
  const reasonId = useId();
  const errorId = `${reasonId}-error`;
  const [reason, setReason] = useState('');
  const busy = phase !== 'idle';
  const sending = phase === 'sending';
  const submitText = action.kind === 'channel' ? t.submits.channel : t.submits[action.kind];

  const submit = () => {
    if (busy) return;
    if (rawCodePointLength(reason) > SWITCH_REASON_MAX) {
      onReasonError(t.reasonLong);
      return;
    }
    onSubmit(reason);
  };

  return (
    <Modal
      open
      width={560}
      title={titleOf(action)}
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
          <Button
            autoInsertSpace={false}
            type="primary"
            danger={action.kind === 'pause'}
            disabled={busy}
            onClick={submit}
          >
            {submitText}
          </Button>
        </Flex>
      }
    >
      <Form layout="vertical" component={false}>
        <Flex vertical gap={token.marginSM} style={{ paddingTop: token.paddingXS }}>
          <Typography.Paragraph style={{ marginBottom: 0 }}>{textOf(action)}</Typography.Paragraph>
          <Form.Item
            label={t.reason}
            htmlFor={reasonId}
            validateStatus={reasonError === undefined ? '' : 'error'}
            extra={t.reasonExtra(rawCodePointLength(reason), SWITCH_REASON_MAX)}
            style={{ marginBottom: 0 }}
          >
            <Input.TextArea
              id={reasonId}
              {...(reasonError === undefined
                ? {}
                : { 'aria-invalid': true, 'aria-errormessage': errorId })}
              rows={3}
              value={reason}
              disabled={busy}
              onChange={(event) => {
                setReason(event.target.value);
                onReasonError(undefined);
              }}
            />
            {reasonError === undefined ? null : (
              <Typography.Text id={errorId} type="danger" role="alert" style={{ display: 'block' }}>
                {reasonError}
              </Typography.Text>
            )}
          </Form.Item>
        </Flex>
      </Form>
    </Modal>
  );
}
