// B1-12u (BR-TEXT-09, BR-TEXT-08, BR-WDR-26; D10-228, D10-235, D10-260): the withdrawal result
// messages WD_SUCCESS / WD_REJECTED / WD_FAILED. notification consumes wallet.withdrawal_changed
// (payload {withdrawal_id, user_id, status}, D10-260) as consumer notification-withdrawal-result on
// queue evt.notification-withdrawal-result (worker only, concurrency 5).
//
// Only PAID_API / PAID_MANUAL → WD_SUCCESS, REJECTED → WD_REJECTED and FAILED → WD_FAILED are sent;
// any other status is acknowledged and writes nothing. The template follows the event's status
// (the withdrawal may have moved on since); amounts, reasons and the channel come from payout's
// read port createWithdrawalNotificationReader (B2-05l). An unknown withdrawal logs a warn and
// writes nothing. Service category: the inbox message is always written, the push follows the
// recipient's service switch (B1-12o push sending core: record() in the event transaction,
// dispatch() after the commit). notify_logs dedupe key `{withdrawal_id}:{status}` (BR-WDR-26).
// TODO(规划/11 §7.1): WD_FAILED 短信渠道 — blocked on 负责人短信签名与模板审批
import type { DB } from '@couli/db';
import { formatYuan } from '@couli/money';
import type { Kysely } from 'kysely';
import type {
  Clock,
  EventHandler,
  JobPayload,
  ReceivedEvent,
  RootLogger,
} from '../../platform/index.ts';
import type { PushEvent, PushSendCore } from './push-send.ts';
import { withdrawFailReasonText } from './withdraw-fail-texts.ts';
import { withdrawRejectReasonText } from './withdraw-reject-texts.ts';

/** D10-260: the wallet.withdrawal_changed payload, frozen. */
export interface WithdrawalResultMessagePayload extends JobPayload {
  readonly withdrawal_id: string;
  readonly user_id: string;
  readonly status: string;
}

export type WithdrawalResultCode = 'WD_SUCCESS' | 'WD_REJECTED' | 'WD_FAILED';

/** notify_templates variant: WD_REJECTED with NEGATIVE_BALANCE is `negative_balance` (D10-235). */
export type WithdrawalResultVariant = 'default' | 'negative_balance';

export type WithdrawalPayoutChannel = 'alipay' | 'bank_card' | 'wechat';

/** The event's status, and the withdrawal's fields as payout's read port returns them. */
export interface WithdrawalResultFacts {
  readonly status: string;
  readonly reject_reason_code: string | null;
  readonly amount_fen: bigint;
  readonly net_fen: bigint;
  readonly fail_code: string | null;
  readonly payout_channel: WithdrawalPayoutChannel;
}

/** notify_templates title_override / body_override of the app, code and variant. */
export interface WithdrawalResultOverride {
  readonly title_override: string | null;
  readonly body_override: string | null;
}

export interface WithdrawalResultMessage {
  readonly code: WithdrawalResultCode;
  readonly variant: WithdrawalResultVariant;
  readonly category: 'service';
  readonly title: string;
  readonly body: string;
}

/** The consumer name of EVENT_SUBSCRIPTIONS; its queue is `evt.notification-withdrawal-result`. */
export const WITHDRAWAL_RESULT_MESSAGE_CONSUMER = 'notification-withdrawal-result';

const EVENT_NAME = 'wallet.withdrawal_changed';

/** The statuses that send a result message (BR-TEXT-09); every other one is acknowledged only. */
const RESULT_STATUSES: ReadonlySet<string> = new Set([
  'PAID_API',
  'PAID_MANUAL',
  'REJECTED',
  'FAILED',
]);

/** inbox.title.<code> (BR-TEXT-09 细则标题表; contracts/texts.default.json). */
const DEFAULT_TITLES: Readonly<Record<WithdrawalResultCode, string>> = Object.freeze({
  WD_SUCCESS: '提现到账',
  WD_REJECTED: '提现未通过',
  WD_FAILED: '提现打款未成功',
});

/** BR-TEXT-09 细则模板表, verbatim (WD_REJECTED negative_balance: D10-235). */
const DEFAULT_BODIES: Readonly<Record<string, string>> = Object.freeze({
  'WD_SUCCESS:default': '提现已到账：{net} 已转入{payout_channel_name}',
  'WD_REJECTED:default': '提现未通过：{reason}，{amount} 已退回余额',
  'WD_REJECTED:negative_balance': '提现未通过：{reason}；抵扣后的余额以钱包显示为准',
  'WD_FAILED:default': '提现打款未成功：{reason}，{amount} 已退回余额',
});

/** {payout_channel_name}: BR-TEXT-06, the same names as the withdrawal detail. */
const CHANNEL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  alipay: '支付宝',
  bank_card: '银行卡',
  wechat: '微信零钱',
});

/**
 * BR-TEXT-08 细则「修改收款账号」= 显示, code by code (D10-229, not a PAYEE_ prefix); the same list
 * as payout's isAccountFailure (domain/display.ts), which this synchronous renderer cannot import.
 */
const ACCOUNT_FAILURE_CODES: ReadonlySet<string> = new Set([
  'PAYEE_NOT_EXIST',
  'PAYEE_USER_INFO_ERROR',
  'PAYEE_ACCOUNT_STATUS_ERROR',
]);

/** Appended after the WD_FAILED sentence for an account-type failure code. */
const CHANGE_ACCOUNT = '，可修改收款账号后重试';

function isAccountFailure(code: string | null): boolean {
  return code !== null && ACCOUNT_FAILURE_CODES.has(code);
}

function reasonOf(code: WithdrawalResultCode, facts: WithdrawalResultFacts): string {
  // BR-TEXT-08 驳回原因: contracts/texts.default.json withdraw_reject_reason.<CODE>.title (CT-26zo).
  if (code === 'WD_REJECTED') return withdrawRejectReasonText(facts.reject_reason_code);
  // BR-TEXT-08 失败原因映射 + 兜底 (D10-228): withdraw_fail_reason.<CODE>.title (CT-26zp).
  if (code === 'WD_FAILED') return withdrawFailReasonText(facts.fail_code);
  return '';
}

/** The template of the event status; null for a status that sends nothing. */
function pickTemplate(
  facts: WithdrawalResultFacts,
): { code: WithdrawalResultCode; variant: WithdrawalResultVariant } | null {
  switch (facts.status) {
    case 'PAID_API':
    case 'PAID_MANUAL':
      return { code: 'WD_SUCCESS', variant: 'default' };
    case 'REJECTED':
      return {
        code: 'WD_REJECTED',
        variant: facts.reject_reason_code === 'NEGATIVE_BALANCE' ? 'negative_balance' : 'default',
      };
    case 'FAILED':
      return { code: 'WD_FAILED', variant: 'default' };
    default:
      return null;
  }
}

/** BR-WDR-26: one message per withdrawal and status (PAID_API and PAID_MANUAL are distinct). */
function dedupeKey(payload: WithdrawalResultMessagePayload): string {
  return `${payload.withdrawal_id}:${payload.status}`;
}

/** Checks the event data shape (D10-260); a malformed event fails the job (retries, dead letter). */
function readPayload(data: JobPayload): WithdrawalResultMessagePayload {
  const value = data as Partial<Record<keyof WithdrawalResultMessagePayload, unknown>>;
  if (
    typeof value.withdrawal_id !== 'string' ||
    !UUID.test(value.withdrawal_id) ||
    typeof value.user_id !== 'string' ||
    typeof value.status !== 'string'
  ) {
    throw new Error('notification: invalid wallet.withdrawal_changed payload');
  }
  return value as WithdrawalResultMessagePayload;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The part of payout's createWithdrawalNotificationReader (B2-05l) this consumer uses. */
interface WithdrawalView {
  readonly user_id: string;
  readonly reject_reason_code: string | null;
  readonly amount_fen: bigint;
  readonly net_fen: bigint;
  readonly fail_code: string | null;
  readonly payout_channel: WithdrawalPayoutChannel;
}

interface WithdrawalReader {
  read(
    handle: Kysely<DB>,
    subject: { appId: string; withdrawalId: string },
  ): Promise<WithdrawalView | null>;
}

interface PayoutPorts {
  createWithdrawalNotificationReader(): WithdrawalReader;
}

/**
 * payout's index.ts beside this file's own extension (.ts from source, .js from dist), loaded on
 * first use: a static import would pull payout's Nest graph into every importer of this file,
 * including the erasable-only test project that imports the renderer directly (as B1-12r).
 */
async function withdrawalReader(): Promise<WithdrawalReader> {
  const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
  const href = new URL(`../../payout/index${extension}`, import.meta.url).href;
  const payout = (await import(href)) as PayoutPorts;
  return payout.createWithdrawalNotificationReader();
}

/** The event's status (the template follows it) with the withdrawal's current fields. */
function factsOf(status: string, view: WithdrawalView): WithdrawalResultFacts {
  return {
    status,
    reject_reason_code: view.reject_reason_code,
    amount_fen: view.amount_fen,
    net_fen: view.net_fen,
    fail_code: view.fail_code,
    payout_channel: view.payout_channel,
  };
}

/**
 * BR-TEXT-09 template of the event status with BR-TEXT-08 reasons and BR-TEXT-10 amounts; the
 * override's title and body apply independently. null for a status that sends nothing.
 */
export function renderWithdrawalResultMessage(
  facts: WithdrawalResultFacts,
  override: WithdrawalResultOverride | null,
): WithdrawalResultMessage | null {
  const pick = pickTemplate(facts);
  if (pick === null) return null;
  const { code, variant } = pick;
  const title = override?.title_override ?? DEFAULT_TITLES[code];
  const template = override?.body_override ?? DEFAULT_BODIES[`${code}:${variant}`] ?? '';
  // Function replacers: the substituted text is taken literally (no `$` patterns).
  let body = template
    .replaceAll('{net}', () => formatYuan(facts.net_fen))
    .replaceAll('{amount}', () => formatYuan(facts.amount_fen))
    .replaceAll('{payout_channel_name}', () => CHANNEL_NAMES[facts.payout_channel] ?? '')
    .replaceAll('{reason}', () => reasonOf(code, facts));
  // BR-TEXT-09: an account-type failure code ends the sentence with the change-account hint,
  // default or override alike (as the reauthorization sentence of APPEAL_RESULT).
  if (code === 'WD_FAILED' && isAccountFailure(facts.fail_code)) body = `${body}${CHANGE_ACCOUNT}`;
  return { code, variant, category: 'service', title, body };
}

export interface WithdrawalResultMessageOptions {
  readonly clock: Clock;
  readonly logger: RootLogger;
  /** B1-12o: record() inside the event transaction, dispatch() on the root handle after commit. */
  readonly push: PushSendCore;
}

export interface WithdrawalResultMessageConsumer {
  /** The event transaction: read the withdrawal, render, record inbox + notify_logs (+ push log). */
  readonly handle: EventHandler;
  /** After the event transaction committed (root handle): dispatch the event's push, if any. */
  dispatch(db: Kysely<DB>, event: ReceivedEvent): Promise<void>;
}

export function createWithdrawalResultMessageConsumer(
  options: WithdrawalResultMessageOptions,
): WithdrawalResultMessageConsumer {
  // options.clock: the push core stamps its rows with its own Clock; nothing here reads time.
  const { logger, push } = options;
  const log = logger.child({ module: 'notification' });

  async function handle(event: ReceivedEvent, trx: Parameters<EventHandler>[1]): Promise<void> {
    if (event.name !== EVENT_NAME) {
      throw new Error('notification: unexpected event for the withdrawal result message');
    }
    const payload = readPayload(event.payload);
    if (!RESULT_STATUSES.has(payload.status)) return;
    const reader = await withdrawalReader();
    const view = await reader.read(trx, {
      appId: event.appId,
      withdrawalId: payload.withdrawal_id,
    });
    if (view === null) {
      log.warn(
        {
          consumer: WITHDRAWAL_RESULT_MESSAGE_CONSUMER,
          eventId: event.eventId,
          withdrawalId: payload.withdrawal_id,
          status: payload.status,
        },
        'withdrawal_result_message_unknown_withdrawal',
      );
      return;
    }
    // The recipient is the withdrawal's owner; a payload naming someone else is a producer fault:
    // the job fails (retries, then dead letter) and nobody is notified by mistake.
    if (view.user_id !== payload.user_id) {
      throw new Error('notification: wallet.withdrawal_changed user is not the withdrawal owner');
    }
    const facts = factsOf(payload.status, view);
    const pick = pickTemplate(facts);
    if (pick === null) return;
    const override = await trx
      .withSchema('app')
      .selectFrom('notify_templates')
      .select(['title_override', 'body_override'])
      .where('app_id', '=', event.appId)
      .where('code', '=', pick.code)
      .where('variant', '=', pick.variant)
      .executeTakeFirst();
    const message = renderWithdrawalResultMessage(facts, override ?? null);
    if (message === null) return;
    // inbox + inbox log (dedupe boundary, BR-WDR-26) + push log, all in this transaction.
    await push.record(trx, {
      app_id: event.appId,
      user_id: view.user_id,
      code: message.code,
      variant: message.variant,
      eventKey: dedupeKey(payload),
      title: message.title,
      body: message.body,
      route: null,
      category: message.category,
    });
    // TODO(规划/11 §7.1): WD_FAILED 短信渠道 — blocked on 负责人短信签名与模板审批
  }

  async function dispatch(db: Kysely<DB>, event: ReceivedEvent): Promise<void> {
    if (event.name !== EVENT_NAME) return;
    const payload = readPayload(event.payload);
    if (!RESULT_STATUSES.has(payload.status)) return;
    const reader = await withdrawalReader();
    const view = await reader.read(db, { appId: event.appId, withdrawalId: payload.withdrawal_id });
    if (view === null || view.user_id !== payload.user_id) return;
    const pick = pickTemplate(factsOf(payload.status, view));
    if (pick === null) return;
    const target: PushEvent = {
      app_id: event.appId,
      user_id: view.user_id,
      code: pick.code,
      variant: pick.variant,
      eventKey: dedupeKey(payload),
      category: 'service',
    };
    await push.dispatch(db, target);
  }

  return { handle, dispatch };
}
