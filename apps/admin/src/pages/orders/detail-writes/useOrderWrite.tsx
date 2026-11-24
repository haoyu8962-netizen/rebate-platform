// One write of the order detail page (F1-07ee): POST the body once; the answer decides.
// - success: the order detail in the response replaces the shown one (no local derivation);
// - 20902: tell the page, which reads the detail once again; the write is not resent;
// - 10003 (totp, 【指定归属】 only): verify the 动态码 with StepUpModal, then resend the same body
//   once with the new X-Step-Up-Token (the first request never carries one, D10-2792 ⑦);
// - result unknown (timeout, network failure, 5xx): the form stays locked and only 【重试】
//   resends the very same body (and token); a success or an explicit refusal unlocks it;
// - an explicit refusal: its message, the form may be edited again.
import type { Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import { useRef, useState, type ReactElement } from 'react';
import { StepUpModal, type StepUpResult } from '../../../components/step-up/index.ts';
import { AdminApiError } from '../../../providers/data/index.ts';
import { ordersTexts } from '../../../texts/orders.ts';
import type { OrderDetail } from '../model.ts';
import { STEP_UP_URL, writeFailureOf } from './model.ts';

export type WritePhase = 'editing' | 'sending' | 'verifying' | 'unknown';

export interface WriteDone {
  readonly kind: 'saved' | 'conflict';
  readonly order?: OrderDetail;
}

export interface OrderWrite<B> {
  readonly phase: WritePhase;
  /** Inputs and the submit button are locked (sending, verifying or result unknown). */
  readonly locked: boolean;
  /** The message of the last explicit refusal. */
  readonly error: string | undefined;
  submit(body: B): void;
  retry(): void;
  readonly stepUpModal: ReactElement | null;
}

interface Sent<B> {
  readonly body: B;
  readonly token?: string;
}

export function useOrderWrite<B>(options: {
  readonly url: string;
  /** 「本次操作：」 of the 动态码 dialog. */
  readonly operation: string;
  readonly onDone: (done: WriteDone) => void;
}): OrderWrite<B> {
  const getProvider = useDataProvider();
  const [phase, setPhase] = useState<WritePhase>('editing');
  const [error, setError] = useState<string>();
  const last = useRef<Sent<B> | undefined>(undefined);
  const busy = useRef(false);
  const { url, operation, onDone } = options;

  const post = async (sent: Sent<B>): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    last.current = sent;
    setPhase('sending');
    setError(undefined);
    try {
      const custom = getProvider().custom;
      if (custom === undefined) throw new Error('Missing custom data provider');
      const response = await custom<OrderDetail>({
        url,
        method: 'post',
        payload: sent.body,
        ...(sent.token === undefined ? {} : { meta: { stepUpToken: sent.token } }),
      });
      busy.current = false;
      onDone({ kind: 'saved', order: response.data });
    } catch (cause) {
      busy.current = false;
      const failure = writeFailureOf(cause);
      if (failure.kind === 'unknown') setPhase('unknown');
      else if (failure.kind === 'conflict') onDone({ kind: 'conflict' });
      else if (failure.kind === 'stepUp') setPhase('verifying');
      else {
        setPhase('editing');
        setError(failure.message);
      }
    }
  };

  const verify = async (code: string): Promise<StepUpResult> => {
    const custom = getProvider().custom;
    if (custom === undefined) return { ok: false, code: 0 };
    const payload: Schema<'AdminStepUpRequest'> = { tier: 'totp', code };
    try {
      const response = await custom<Schema<'AdminStepUpResponse'>['data']>({
        url: STEP_UP_URL,
        method: 'post',
        payload,
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

  const stepUpModal =
    phase === 'verifying' ? (
      <StepUpModal
        open
        tier="totp"
        operation={operation}
        onSubmit={verify}
        onClose={() => {
          setPhase('editing');
          setError(ordersTexts.writes.result.stepUpFailed);
        }}
        onVerified={(token) => {
          const sent = last.current;
          if (sent === undefined) setPhase('editing');
          else void post({ body: sent.body, token });
        }}
      />
    ) : null;

  return {
    phase,
    locked: phase !== 'editing',
    error,
    submit: (body) => {
      if (phase !== 'editing') return;
      void post({ body });
    },
    retry: () => {
      const sent = last.current;
      if (phase !== 'unknown' || sent === undefined) return;
      void post(sent);
    },
    stepUpModal,
  };
}
