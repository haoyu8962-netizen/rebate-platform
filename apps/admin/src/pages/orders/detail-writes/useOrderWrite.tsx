// One write of the order detail page (F1-07ee): POST the body once; the answer decides.
// - success: the order detail in the response replaces the shown one (no local derivation);
// - 20902: tell the page, which reads the detail once again; the write is not resent;
// - 10003 (totp, 【指定归属】 only): verify the 动态码 with StepUpModal, then resend the same body
//   once with the new X-Step-Up-Token (the first request never carries one, D10-2792 ⑦);
// - result unknown (no answer within WRITE_TIMEOUT_MS, network failure, 5xx): the form stays
//   locked, the dialog cannot be closed and only 【重试】 resends the very same body (and token);
//   a success, 20902 or an explicit refusal unlocks it;
// - an explicit refusal: its message, the form may be edited again.
// The order's result-unknown marker (components/unknown-marker, page markerPageOf, this account
// only) is held from the moment a request is sent until a definite answer to that very request:
// a page remounted or reloaded meanwhile finds it and offers no new submission (OrderWrites). A
// definite answer releases only this hook's hold; an ended session (10001) leaves it in place. No
// body is kept outside this hook: a remount never restores a form.
// From sending until any answer (or the deadline) the request also counts as open for the order
// (./openWrites.ts, memory only): a page opened again meanwhile does not offer 【放弃这次提交】.
// The marker is moved first and the open count ends after it, so no moment shows the marker still
// kept while no request of the order is open.
import type { Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { StepUpModal, type StepUpResult } from '../../../components/step-up/index.ts';
import {
  endsSession,
  useUnknownMarker,
  type MarkerClock,
} from '../../../components/unknown-marker/index.ts';
import { AdminApiError } from '../../../providers/data/index.ts';
import { ordersTexts } from '../../../texts/orders.ts';
import type { OrderDetail } from '../model.ts';
import {
  STEP_UP_URL,
  WRITE_TIMEOUT_MS,
  markerPageOf,
  withDeadline,
  writeFailureOf,
  type SentWrite,
  type WritePhase,
} from './model.ts';
import { beginWrite } from './openWrites.ts';

export type { WritePhase };

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

type Sent<B> = SentWrite<B>;

export function useOrderWrite<B>(options: {
  readonly url: string;
  /** 「本次操作：」 of the 动态码 dialog. */
  readonly operation: string;
  readonly onDone: (done: WriteDone) => void;
  /** The order whose result-unknown marker this write holds while its result is open. */
  readonly orderId: string;
  /** The console clock of the marker's moment. */
  readonly clock: MarkerClock;
  /** Nothing may be sent now (the shown detail has a status this console does not know). */
  readonly blocked: boolean;
}): OrderWrite<B> {
  const getProvider = useDataProvider();
  const { url, operation, onDone, orderId, clock, blocked } = options;
  const marker = useUnknownMarker(markerPageOf(orderId), clock);
  const [phase, setPhase] = useState<WritePhase>('editing');
  const [error, setError] = useState<string>();
  const last = useRef<Sent<B> | undefined>(undefined);
  const busy = useRef(false);
  const blockedRef = useRef(blocked);
  useEffect(() => {
    blockedRef.current = blocked;
  }, [blocked]);

  const post = async (sent: Sent<B>): Promise<void> => {
    if (busy.current || blockedRef.current) return;
    busy.current = true;
    // In flight counts as open: a remount before the answer must not offer a second submission.
    marker.mark();
    const ended = beginWrite(orderId);
    last.current = sent;
    setPhase('sending');
    setError(undefined);
    try {
      const custom = getProvider().custom;
      if (custom === undefined) throw new Error('Missing custom data provider');
      const response = await withDeadline(
        (signal) =>
          custom<OrderDetail>({
            url,
            method: 'post',
            payload: sent.body,
            meta: sent.token === undefined ? { signal } : { signal, stepUpToken: sent.token },
          }),
        WRITE_TIMEOUT_MS,
      );
      busy.current = false;
      marker.clear();
      ended();
      onDone({ kind: 'saved', order: response.data });
    } catch (cause) {
      busy.current = false;
      const failure = writeFailureOf(cause);
      if (failure.kind === 'unknown') {
        // The marker stays held (marked before sending) until a definite answer.
        ended();
        setPhase('unknown');
        return;
      }
      // A definite answer to this very request; an ended session settles nothing.
      if (endsSession(cause)) marker.leave();
      else marker.clear();
      ended();
      if (failure.kind === 'conflict') onDone({ kind: 'conflict' });
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
      if (phase !== 'editing' || blocked) return;
      void post({ body });
    },
    retry: () => {
      const sent = last.current;
      if (phase !== 'unknown' || sent === undefined || blocked) return;
      void post(sent);
    },
    stepUpModal,
  };
}
