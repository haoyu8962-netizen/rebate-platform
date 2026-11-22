// 调账写入流程（fund.adjust）：adminCreateAdjustment（POST /admin/v1/adjustments，默认）、
// adminApproveAdjustment（POST …/{adjust_id}/approve，请求体 {}，F1-08cc）共用短信档（BR-ID-34）：每次提交先发
// 验证码（POST /admin/v1/auth/step-up/sms-codes），弹 StepUpModal（短信档）验证（POST /admin/v1/auth/step-up），
// 通过后带 X-Step-Up-Token 与 Idempotency-Key 只发一次写请求。adminRejectAdjustment（…/reject，F1-08cc）
// 不需二次验证（`verify: false`）：直接带 Idempotency-Key 只发一次；下面的结果未知与换键规则对它同样适用。
// - 10003 data.reason=verify_phone_missing（发码或写入时）：不弹验证、不发写请求，此后本次表单不再发码。
// - 写入返回 10003（验证已失效）：重新发码、再验证，用新的验证重放同一请求体与同一个键。
// - 没拿到带统一外壳的回答（网络错误、无法解析）：进入「结果未知」（编排 D10-1731）——保留原键与原请求体，
//   表单由调用方锁定，只能【重试】（原键、同一个请求体对象逐字节相同地重发，需要时重新短信验证）或去列表核对；
//   重试拿到确定的回答（成功、确定的拒绝）才退出；重试又遇 5xx / 40901 仍留在结果未知。
//   重试遇到契约里先于幂等回放判、又随状态变化的拒绝（10403 admin_permission_denied；发码或写入时的
//   10003 data.reason=verify_phone_missing）不算确定的回答：第一次提交仍可能已生效，所以仍留在结果未知
//   （原键原体保留、表单锁定、只能【重试】或去列表核对），拒绝原文经 onFailed 交调用方显示（F1-08as，
//   D10-2060 / 2061）。这条对每个决定一致生效，包括不验证的写法（驳回）。
// - 带外壳的结果未定（5xx、40901）：提示失败，下次提交沿用原键；其余确定的回答（成功、20001、20901、
//   20902、10403 等）后下次提交换新键。任何失败都不自动重发。
// 一次打开（抽屉或对话框）一个写操作一个实例；卸载后迟到的回答不再更新表单，但照常作用于结果未知标记（F1-08atb）。
// F1-08at（D10-2075）：进入「结果未知」时为本页（adjustments）与登录账号存一个不含业务数据的标记，
// 带外壳的 5xx / 40901（保留原键、未落定）同样存标记；拿到确定的回答（成功或确定的拒绝）时清掉；
// 10001（会话失效）不算确定的回答，标记留给重新登录后的提示。
// F1-08atb（D10-2508）：标记按提交持有；页顶提示【关闭】时仍在途的写，之后结果未知或收到 10001 时重新登记。
// F1-08atb 资金评审 r1：每次发写（首次与【重试】）先登记为在途（begin，不写标记）；另记「当前幂等键是否收到过
// 未定的回答」（无外壳、带外壳的 5xx / 40901），先于幂等回放判的拒绝（10403、10003 verify_phone_missing）
// 按它判定：收到过就仍未知、标记留着、原键保留，不论表单是否锁定、是否已卸载。
import { useDataProvider, type BaseRecord } from '@refinedev/core';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { StepUpModal, type StepUpResult } from '../../components/step-up/index.ts';
import {
  endsSession,
  useUnknownMarker,
  type MarkerClock,
} from '../../components/unknown-marker/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { adjustmentsTexts } from '../../texts/adjustments.ts';
import { ADJUSTMENTS_URL } from './model.ts';
import {
  newRequestKey,
  noEnvelope,
  outcomeUnknown,
  phoneMissing as isPhoneMissing,
  refusedBeforeReplay,
  type CreateRequest,
  type Executed,
} from './write.ts';

const SMS_CODES_URL = '/admin/v1/auth/step-up/sms-codes';
const STEP_UP_URL = '/admin/v1/auth/step-up';
const STEP_UP_REFUSED = 10003;
const TOO_FREQUENT = 42901;

type Phase = 'idle' | 'code' | 'verify' | 'writing';

export interface AdjustmentWriteOptions<R extends BaseRecord = Executed> {
  /** 「本次操作」 of the verification dialog. */
  readonly operation: string;
  /** The write (POST); adminCreateAdjustment when left out. */
  readonly url?: string;
  /** false: the write needs no step-up (adminRejectAdjustment); the sms tier when left out. */
  readonly verify?: boolean;
  readonly onDone: (result: R) => void;
  /**
   * A failed submission; `stillUnknown`: the earlier result under this key is still unknown (a
   * refusal judged before the idempotent replay after an undetermined answer): the key and the
   * body stay, and the lock while `unknown` is true.
   */
  readonly onFailed: (cause: unknown, stillUnknown: boolean) => void;
  /** The write got no reply in the unified envelope (`unknown` is now true). */
  readonly onUnknown?: () => void;
  /**
   * The page's injected clock: the moment kept with the result-unknown marker (F1-08at), passed
   * down from 调账与核销 (CONSOLE_CLOCK there when none was injected).
   */
  readonly clock: MarkerClock;
}

/** The marker's page: the menu id of 调账与核销. */
const MARKER_PAGE = 'adjustments';

export interface AdjustmentWrite<B extends object = CreateRequest> {
  /** A code is being sent, the verification is open or the write is in flight. */
  readonly busy: boolean;
  /** The account has no registered verify phone (10003 verify_phone_missing). */
  readonly phoneMissing: boolean;
  /**
   * The last submission got no reply in the unified envelope: the form stays locked and only
   * retry() (or checking the list) is offered.
   */
  readonly unknown: boolean;
  /** Starts one submission of `body` (ignored while busy, unknown or without a verify phone). */
  submit(body: B): void;
  /** Sends the unknown submission again: the same key and the same body (verified again). */
  retry(): void;
  /** The sms-tier verification dialog (render it once). */
  readonly stepUp: ReactElement;
}

function resultOf(cause: unknown): StepUpResult {
  if (!(cause instanceof AdminApiError)) return { ok: false, code: 0 };
  return cause.retryAfterSeconds === undefined
    ? { ok: false, code: cause.code }
    : { ok: false, code: cause.code, retryAfterSeconds: cause.retryAfterSeconds };
}

export function useAdjustmentWrite<
  B extends object = CreateRequest,
  R extends BaseRecord = Executed,
>({
  operation,
  url = ADJUSTMENTS_URL,
  verify: needsStepUp = true,
  onDone,
  onFailed,
  onUnknown,
  clock,
}: AdjustmentWriteOptions<R>): AdjustmentWrite<B> {
  const getProvider = useDataProvider();
  const marker = useUnknownMarker(MARKER_PAGE, clock);
  const [phase, setPhaseValue] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  const [missing, setMissingValue] = useState(false);
  const missingRef = useRef(false);
  const [unknown, setUnknownValue] = useState(false);
  const unknownRef = useRef(false);
  const bodyRef = useRef<B | undefined>(undefined);
  /** The Idempotency-Key of the submission whose outcome is still open; undefined: take a new one. */
  const keyRef = useRef<string | undefined>(undefined);
  /**
   * A send under the current key got an undetermined answer (no envelope, or an enveloped 5xx /
   * 40901): it may have taken effect, so a refusal judged before the replay settles nothing. Reset
   * only with the key (a settled answer). Not tied to `unknown`: an enveloped 5xx leaves the form
   * unlocked, and the answer may come after the dialog was left.
   */
  const uncertainRef = useRef(false);
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
  const setUnknown = (next: boolean) => {
    unknownRef.current = next;
    setUnknownValue(next);
  };
  const markMissing = () => {
    missingRef.current = true;
    setMissingValue(true);
    setPhase('idle');
  };
  const customOf = () => {
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    return custom;
  };

  /** Sends a code and opens the verification. */
  const requestCode = async (): Promise<void> => {
    setPhase('code');
    try {
      await customOf()({ url: SMS_CODES_URL, method: 'post' });
      if (!alive.current) return;
      setPhase('verify');
    } catch (cause) {
      if (!alive.current) return;
      if (unknownRef.current && refusedBeforeReplay(cause)) {
        // The first submission may still have taken effect: stay unknown, show the refusal.
        setPhase('idle');
        onFailed(cause, true);
        return;
      }
      if (isPhoneMissing(cause)) {
        markMissing();
        return;
      }
      // Sent too often: a code sent moments ago is still valid, so the verification opens.
      if (cause instanceof AdminApiError && cause.code === TOO_FREQUENT) {
        setPhase('verify');
        return;
      }
      setPhase('idle');
      onFailed(cause, unknownRef.current);
    }
  };

  /** The sms tier: send a code and verify first; without step-up: write right away. */
  const start = (body: B, key: string) => {
    if (needsStepUp) {
      void requestCode();
      return;
    }
    setPhase('writing');
    void write(body, key, undefined);
  };

  const submit = (body: B) => {
    if (phaseRef.current !== 'idle' || missingRef.current || unknownRef.current) return;
    bodyRef.current = body;
    keyRef.current ??= newRequestKey();
    start(body, keyRef.current);
  };

  const retry = () => {
    if (phaseRef.current !== 'idle' || missingRef.current || !unknownRef.current) return;
    if (bodyRef.current === undefined || keyRef.current === undefined) return;
    start(bodyRef.current, keyRef.current);
  };

  const verify = async (code: string): Promise<StepUpResult> => {
    const request: { tier: 'sms'; code: string } = { tier: 'sms', code };
    try {
      const response = await customOf()<{ step_up_token: string }>({
        url: STEP_UP_URL,
        method: 'post',
        payload: request,
      });
      return { ok: true, stepUpToken: response.data.step_up_token };
    } catch (cause) {
      return resultOf(cause);
    }
  };

  const resend = async (): Promise<StepUpResult> => {
    try {
      await customOf()({ url: SMS_CODES_URL, method: 'post' });
      return { ok: true };
    } catch (cause) {
      return resultOf(cause);
    }
  };

  const write = async (body: B, key: string, stepUpToken: string | undefined) => {
    // F1-08atb: the marker follows every answer whether or not the dialog is still shown (left
    // while the write was under way); only the form and the callbacks wait for `alive`.
    // Money r1 S1-1: the request goes out — noted as this submission's (no marker yet).
    marker.begin();
    try {
      const response = await customOf()<R>({
        url,
        method: 'post',
        payload: body,
        meta:
          stepUpToken === undefined
            ? { idempotencyKey: key }
            : { stepUpToken, idempotencyKey: key },
      });
      // A settled answer (the idempotent replay or the first time): the submission's marker goes.
      marker.clear();
      keyRef.current = undefined;
      uncertainRef.current = false;
      if (!alive.current) return;
      setUnknown(false);
      setPhase('idle');
      onDone(response.data);
    } catch (cause) {
      if (unknownRef.current && refusedBeforeReplay(cause)) {
        // Judged before the idempotent replay and changing with the account's state (D10-2060):
        // the first submission may still have taken effect. Key, body and lock stay; no resend.
        marker.mark();
        if (!alive.current) return;
        setPhase('idle');
        onFailed(cause, true);
        return;
      }
      if (isPhoneMissing(cause)) {
        // After an undetermined answer under this key (an enveloped 5xx / 40901, form unlocked)
        // it settles nothing: the marker stays (held afresh if 【关闭】 dropped it), the key too.
        if (uncertainRef.current) marker.mark();
        else marker.clear();
        if (!alive.current) return;
        markMissing();
        return;
      }
      if (needsStepUp && cause instanceof AdminApiError && cause.code === STEP_UP_REFUSED) {
        // The verification was not accepted: verify again and replay the same body and key. An
        // earlier undetermined submission under this key stays unknown.
        if (uncertainRef.current) marker.mark();
        if (!alive.current) return;
        void requestCode();
        return;
      }
      if (noEnvelope(cause)) {
        // It may have taken effect: keep the key and the body, lock, no failure prompt.
        marker.mark();
        uncertainRef.current = true;
        if (!alive.current) return;
        setUnknown(true);
        setPhase('idle');
        onUnknown?.();
        return;
      }
      let stillUnknown = unknownRef.current;
      if (outcomeUnknown(cause)) {
        // An enveloped 5xx / 40901: the key is kept, the write may have taken effect, so it is
        // result-unknown for the marker too (D10-2075 / D10-1731).
        marker.mark();
        uncertainRef.current = true;
        if (!alive.current) return;
      } else if (uncertainRef.current && refusedBeforeReplay(cause)) {
        // Money r1 S1-2: a 10403 judged before the replay, after an enveloped 5xx / 40901 under
        // this key (the form unlocked): the earlier send may have taken effect. The marker and
        // the key stay — also after the dialog was left; the form shows the refusal as before.
        marker.mark();
        stillUnknown = true;
        if (!alive.current) return;
      } else {
        // A settled refusal settles the submission; an ended session (10001) settles nothing.
        if (endsSession(cause)) marker.sessionEnded();
        else marker.clear();
        keyRef.current = undefined;
        uncertainRef.current = false;
        if (!alive.current) return;
        setUnknown(false);
      }
      setPhase('idle');
      onFailed(cause, stillUnknown);
    }
  };

  const onVerified = (stepUpToken: string) => {
    const body = bodyRef.current;
    const key = keyRef.current;
    if (phaseRef.current !== 'verify' || body === undefined || key === undefined) return;
    setPhase('writing');
    void write(body, key, stepUpToken);
  };

  const cancel = () => {
    if (phaseRef.current === 'verify') setPhase('idle');
  };

  const stepUp = (
    <StepUpModal
      open={phase === 'verify'}
      tier="sms"
      operation={operation}
      maskedPhone={adjustmentsTexts.write.verifyPhone}
      onSubmit={verify}
      onResend={resend}
      onClose={cancel}
      onVerified={onVerified}
    />
  );

  return { busy: phase !== 'idle', phoneMissing: missing, unknown, submit, retry, stepUp };
}
