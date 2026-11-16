// adminCreateAdjustment 的写入流程（fund.adjust，短信档 BR-ID-34）：每次提交先发验证码
// （POST /admin/v1/auth/step-up/sms-codes），弹 StepUpModal（短信档）验证（POST /admin/v1/auth/step-up），
// 通过后带 X-Step-Up-Token 与 Idempotency-Key 只发一次 POST /admin/v1/adjustments。
// - 10003 data.reason=verify_phone_missing（发码或写入时）：不弹验证、不发写请求，此后本次表单不再发码。
// - 写入返回 10003（验证已失效）：重新发码、再验证，用新的验证重放同一请求体与同一个键。
// - 结果未定（网络、无法解析、5xx、40901）：下次提交沿用原键；其余确定的回答（成功、20001、20901、
//   20902、10403 等）后下次提交换新键。任何失败都不自动重发。
// 一次打开（抽屉或对话框）一个实例；卸载后迟到的回答被丢弃。
import { useDataProvider } from '@refinedev/core';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { StepUpModal, type StepUpResult } from '../../components/step-up/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { adjustmentsTexts } from '../../texts/adjustments.ts';
import { ADJUSTMENTS_URL } from './model.ts';
import {
  newRequestKey,
  outcomeUnknown,
  phoneMissing as isPhoneMissing,
  type CreateRequest,
  type Executed,
} from './write.ts';

const SMS_CODES_URL = '/admin/v1/auth/step-up/sms-codes';
const STEP_UP_URL = '/admin/v1/auth/step-up';
const STEP_UP_REFUSED = 10003;
const TOO_FREQUENT = 42901;

type Phase = 'idle' | 'code' | 'verify' | 'writing';

export interface AdjustmentWriteOptions {
  /** 「本次操作」 of the verification dialog. */
  readonly operation: string;
  readonly onDone: (executed: Executed) => void;
  readonly onFailed: (cause: unknown) => void;
}

export interface AdjustmentWrite {
  /** A code is being sent, the verification is open or the write is in flight. */
  readonly busy: boolean;
  /** The account has no registered verify phone (10003 verify_phone_missing). */
  readonly phoneMissing: boolean;
  /** Starts one submission of `body` (ignored while busy or without a verify phone). */
  submit(body: CreateRequest): void;
  /** The sms-tier verification dialog (render it once). */
  readonly stepUp: ReactElement;
}

function resultOf(cause: unknown): StepUpResult {
  if (!(cause instanceof AdminApiError)) return { ok: false, code: 0 };
  return cause.retryAfterSeconds === undefined
    ? { ok: false, code: cause.code }
    : { ok: false, code: cause.code, retryAfterSeconds: cause.retryAfterSeconds };
}

export function useAdjustmentWrite({
  operation,
  onDone,
  onFailed,
}: AdjustmentWriteOptions): AdjustmentWrite {
  const getProvider = useDataProvider();
  const [phase, setPhaseValue] = useState<Phase>('idle');
  const phaseRef = useRef<Phase>('idle');
  const [missing, setMissingValue] = useState(false);
  const missingRef = useRef(false);
  const bodyRef = useRef<CreateRequest | undefined>(undefined);
  /** The Idempotency-Key of the submission whose outcome is still open; undefined: take a new one. */
  const keyRef = useRef<string | undefined>(undefined);
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
      onFailed(cause);
    }
  };

  const submit = (body: CreateRequest) => {
    if (phaseRef.current !== 'idle' || missingRef.current) return;
    bodyRef.current = body;
    keyRef.current ??= newRequestKey();
    void requestCode();
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

  const write = async (body: CreateRequest, key: string, stepUpToken: string) => {
    try {
      const response = await customOf()<Executed>({
        url: ADJUSTMENTS_URL,
        method: 'post',
        payload: body,
        meta: { stepUpToken, idempotencyKey: key },
      });
      if (!alive.current) return;
      keyRef.current = undefined;
      setPhase('idle');
      onDone(response.data);
    } catch (cause) {
      if (!alive.current) return;
      if (isPhoneMissing(cause)) {
        markMissing();
        return;
      }
      if (cause instanceof AdminApiError && cause.code === STEP_UP_REFUSED) {
        // The verification was not accepted: verify again and replay the same body and key.
        void requestCode();
        return;
      }
      if (!outcomeUnknown(cause)) keyRef.current = undefined;
      setPhase('idle');
      onFailed(cause);
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

  return { busy: phase !== 'idle', phoneMissing: missing, submit, stepUp };
}
