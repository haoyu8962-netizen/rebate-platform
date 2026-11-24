// Shared part of the manual order sync (CT-24n): one POST /admin/v1/order-syncs through the data
// provider (order.view, no step-up, no Idempotency-Key; identity comes from the admin token) and
// the notice of each outcome. A press while a request is in flight sends nothing.
import { useDataProvider } from '@refinedev/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ordersTexts } from '../../texts/orders.ts';
import {
  SYNCS_URL,
  platformLabel,
  syncFailureOf,
  type SyncCreateRequest,
  type SyncCreated,
  type SyncOutcome,
} from './model.ts';

const t = ordersTexts.sync;

/** A notice shown for an outcome; `id` changes with every notice so it reads as new. */
export interface SyncNotice {
  readonly id: number;
  readonly type: 'success' | 'info' | 'warning' | 'error';
  readonly text: string;
}

/** The notice of an outcome that is not tied to one field (undefined for field refusals). */
export function noticeOf(outcome: SyncOutcome): Omit<SyncNotice, 'id'> | undefined {
  switch (outcome.kind) {
    case 'created':
      return { type: 'success', text: t.submitted };
    case 'reused':
      return { type: 'info', text: t.reused };
    case 'paused':
      return { type: 'warning', text: t.paused(platformLabel(outcome.platform)) };
    case 'forbidden':
      return { type: 'error', text: t.forbidden };
    case 'rateLimited':
      return { type: 'warning', text: t.rateLimited };
    case 'network':
      return { type: 'error', text: t.network };
    case 'failed':
      return { type: 'error', text: t.failed };
    case 'fields':
      return undefined;
  }
}

let noticeCount = 0;
/** A fresh notice id. */
export function nextNoticeId(): number {
  noticeCount += 1;
  return noticeCount;
}

/**
 * Sends a manual sync request. `send` resolves to the outcome, or undefined when a request is
 * already in flight (nothing sent) or the component went away.
 */
export function useSyncRequest(): {
  readonly busy: boolean;
  readonly send: (body: SyncCreateRequest) => Promise<SyncOutcome | undefined>;
} {
  const getProvider = useDataProvider();
  const inFlight = useRef(false);
  const alive = useRef(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const send = useCallback(
    async (body: SyncCreateRequest): Promise<SyncOutcome | undefined> => {
      if (inFlight.current) return undefined;
      inFlight.current = true;
      setBusy(true);
      let outcome: SyncOutcome;
      try {
        const custom = getProvider().custom;
        if (custom === undefined) throw new Error('Missing custom data provider');
        const response = await custom<SyncCreated>({
          url: SYNCS_URL,
          method: 'post',
          payload: body,
        });
        outcome = { kind: response.data.reused ? 'reused' : 'created' };
      } catch (cause) {
        outcome = syncFailureOf(cause, body.platform);
      } finally {
        inFlight.current = false;
      }
      if (!alive.current) return undefined;
      setBusy(false);
      return outcome;
    },
    [getProvider],
  );

  return { busy, send };
}
