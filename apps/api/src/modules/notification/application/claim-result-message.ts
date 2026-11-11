// CLAIM_RESULT inbox message (BR-TEXT-09, B1-12r): notification consumes claim.resolved and writes
// one inbox message plus one notify_logs row in the consumer's transaction, deduplicated by the
// event id. Service category, inbox only: never a push or an SMS. The recipient is the claim's
// applicant (payload user_id). approved: the applicant's own shares in the current commission
// version of the approved items' orders; rejected: the dictionary title of the first rejected
// item's reason. Any other status sends nothing and logs nothing. Facts are read only through the
// orders and commission public ports (their index.ts), loaded on first use: a static import would
// pull both modules' Nest graphs into every importer of this file, including the erasable-only
// test project that imports it directly.
import type { DB } from '@couli/db';
import { addFen, formatYuan } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import { newUuidV7, type Clock, type EventHandler, type JobPayload } from '../../platform/index.ts';

/** The part of orders' readNotifyClaimFacts (B1-12j) this consumer uses, structurally. */
interface ClaimFacts {
  readonly applicant_user_id: string;
  readonly items: readonly {
    readonly order_id: string;
    readonly decision: string | null;
    readonly reject_reason: string | null;
  }[];
}

interface OrdersPorts {
  readNotifyClaimFacts(
    db: Kysely<DB>,
    input: { app_id: string; claim_id: string },
  ): Promise<ClaimFacts | null>;
}

interface CommissionPorts {
  readNotifyBeneficiaries(
    db: Kysely<DB>,
    input: { app_id: string; order_id: string; exclude_terminal?: boolean },
  ): Promise<readonly { readonly user_id: string; readonly amount_fen: bigint }[]>;
}

/** A module's index.ts beside this file's own extension: .ts from source, .js from dist. */
function moduleIndex(name: 'orders' | 'commission'): string {
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  return new URL(`../../${name}/index${extension}`, import.meta.url).href;
}

/** Each call goes through the module's live export (the loader caches the module itself). */
async function ordersPorts(): Promise<OrdersPorts> {
  return (await import(moduleIndex('orders'))) as OrdersPorts;
}

async function commissionPorts(): Promise<CommissionPorts> {
  return (await import(moduleIndex('commission'))) as CommissionPorts;
}

export interface ClaimResultMessagePayload extends JobPayload {
  readonly app_id: string;
  readonly claim_id: string;
  readonly user_id: string;
  readonly status: string;
}

export interface ClaimResultOverride {
  readonly title_override: string | null;
  readonly body_override: string | null;
}

export type ClaimResultVariant = 'approved' | 'rejected';

export interface ClaimResultMessage {
  readonly code: 'CLAIM_RESULT';
  readonly variant: ClaimResultVariant;
  readonly category: 'service';
  readonly channels: readonly ['inbox'];
  readonly title: string;
  readonly body: string;
  readonly route: null;
}

/** The consumer name of EVENT_SUBSCRIPTIONS; its queue is `evt.notification-claim-result`. */
export const CLAIM_RESULT_MESSAGE_CONSUMER = 'notification-claim-result';

const CODE = 'CLAIM_RESULT';
/** inbox.title.CLAIM_RESULT (contracts/texts.default.json). */
const DEFAULT_TITLE = '找回结果';

/** BR-TEXT-09 模板表, verbatim; {rebate} is a BR-TEXT-10 string (already carries ¥). */
const DEFAULT_BODIES: Readonly<Record<ClaimResultVariant, string>> = Object.freeze({
  approved: '订单找回成功，预估返 {rebate}',
  rejected: '订单找回未通过：{reason}',
});

/** claim_reject_reason.<CODE>.title (contracts/texts.default.json). */
const REJECT_REASON_TITLES: Readonly<Record<string, string>> = Object.freeze({
  NOT_IN_POOL: '该订单已由平台记录归属，找回已关闭',
  NO_EVIDENCE: '没有找到这笔订单经凑狸下单的记录',
});

/** Codes without a dictionary entry (or no rejected item): the orchestrator's default text. */
const REJECT_REASON_FALLBACK = '暂无法找回该订单，请联系客服';

function variantOf(status: string): ClaimResultVariant | null {
  if (status === 'approved' || status === 'rejected') return status;
  return null;
}

function reasonTitle(code: string | null): string {
  if (code !== null && Object.hasOwn(REJECT_REASON_TITLES, code)) {
    return REJECT_REASON_TITLES[code] as string;
  }
  return REJECT_REASON_FALLBACK;
}

/** BR-TEXT-09: amount is the applicant's summed current-version shares, in integer fen. */
export function renderClaimResultMessage(
  input: {
    readonly status: string;
    readonly rebate_fen: bigint;
    readonly reject_reason: string | null;
  },
  override: ClaimResultOverride | null,
): ClaimResultMessage | null {
  const variant = variantOf(input.status);
  if (variant === null) return null;
  const title = override?.title_override ?? DEFAULT_TITLE;
  const template = override?.body_override ?? DEFAULT_BODIES[variant];
  // Function replacers: the substituted text is taken literally (no `$` patterns).
  const body =
    variant === 'approved'
      ? template.replaceAll('{rebate}', () => formatYuan(input.rebate_fen))
      : template.replaceAll('{reason}', () => reasonTitle(input.reject_reason));
  return {
    code: CODE,
    variant,
    category: 'service',
    channels: ['inbox'],
    title,
    body,
    route: null,
  };
}

/** Checks the event data shape; a malformed event fails the job (retries, then dead letter). */
function readPayload(appId: string, data: JobPayload): ClaimResultMessagePayload {
  const value = data as Partial<Record<keyof ClaimResultMessagePayload, unknown>>;
  if (
    value.app_id !== appId ||
    typeof value.claim_id !== 'string' ||
    typeof value.user_id !== 'string' ||
    typeof value.status !== 'string'
  ) {
    throw new Error('notification: invalid claim.resolved payload');
  }
  return value as ClaimResultMessagePayload;
}

/**
 * Sum of the applicant's own current-version shares over the approved items' orders.
 * B1-18kn（D10-1274；BR-TEXT-09、BR-CALC-15）：只计发送那一刻不在终态（VOID、CLAWED_BACK）的订单，
 * 终态订单按 0 计；全部终态时得 0，照发「预估返 ¥0」，不吞通知。
 */
async function applicantRebate(
  trx: Transaction<DB>,
  appId: string,
  applicant: string,
  facts: ClaimFacts,
): Promise<bigint> {
  const orderIds = new Set<string>();
  for (const item of facts.items) {
    if (item.decision === 'approved') orderIds.add(item.order_id);
  }
  if (orderIds.size === 0) return 0n;
  const commission = await commissionPorts();
  let total = 0n;
  for (const orderId of orderIds) {
    const shares = await commission.readNotifyBeneficiaries(trx, {
      app_id: appId,
      order_id: orderId,
      exclude_terminal: true,
    });
    for (const share of shares) {
      if (share.user_id === applicant) total = addFen(total, share.amount_fen);
    }
  }
  return total;
}

/** {reason}: only rejected items, the first by created_at then id (the port's order). */
function firstRejectReason(facts: ClaimFacts): string | null {
  const item = facts.items.find((candidate) => candidate.decision === 'rejected');
  return item?.reject_reason ?? null;
}

async function deliver(
  trx: Transaction<DB>,
  eventId: string,
  payload: ClaimResultMessagePayload,
  clock: Clock,
): Promise<void> {
  const variant = variantOf(payload.status);
  if (variant === null) return;
  const appId = payload.app_id;
  const userId = payload.user_id;
  // One SELECT: the claim and its items come from the same snapshot.
  const orders = await ordersPorts();
  const facts = await orders.readNotifyClaimFacts(trx, {
    app_id: appId,
    claim_id: payload.claim_id,
  });
  if (facts === null) throw new Error('notification: claim.resolved names an unknown claim');
  if (facts.applicant_user_id !== userId) {
    throw new Error('notification: claim.resolved user is not the applicant');
  }
  const db = trx.withSchema('app');
  const now = clock.now();
  // The dedupe boundary: ON CONFLICT DO NOTHING keeps the transaction usable, and a concurrent
  // delivery of the same event waits on the unique key until the first one ends.
  const logged = await db
    .insertInto('notify_logs')
    .values({
      id: newUuidV7(now),
      app_id: appId,
      user_id: userId,
      code: CODE,
      channel: 'inbox',
      dedupe_key: `claim.resolved:${eventId}`,
      planned_at: now,
      sent_at: now,
      status: 'success',
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.columns(['app_id', 'dedupe_key']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (logged === undefined) return;
  const rebateFen = variant === 'approved' ? await applicantRebate(trx, appId, userId, facts) : 0n;
  const override = await db
    .selectFrom('notify_templates')
    .select(['title_override', 'body_override'])
    .where('app_id', '=', appId)
    .where('code', '=', CODE)
    .where('variant', '=', variant)
    .executeTakeFirst();
  const message = renderClaimResultMessage(
    {
      status: variant,
      rebate_fen: rebateFen,
      reject_reason: variant === 'rejected' ? firstRejectReason(facts) : null,
    },
    override ?? null,
  );
  if (message === null) return;
  await db
    .insertInto('inbox_messages')
    .values({
      message_id: newUuidV7(now),
      app_id: appId,
      user_id: userId,
      code: CODE,
      title: message.title,
      body: message.body,
      route: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

/** Reads orders/commission through their public ports and writes in the supplied event transaction. */
export function createClaimResultMessageHandler(options: { readonly clock: Clock }): EventHandler {
  const { clock } = options;
  return async (event, trx) => {
    if (event.name !== 'claim.resolved') {
      throw new Error('notification: unexpected event for the claim result message');
    }
    await deliver(trx, event.eventId, readPayload(event.appId, event.payload), clock);
  };
}
