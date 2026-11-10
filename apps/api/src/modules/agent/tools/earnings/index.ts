// B3-16a · BR-AI-01 细则「收益查询」/ BR-AI-04 / BR-AI-05 / BR-AI-07 (D32): get_my_earnings, the
// read-only earnings tool. Kept outside tools/registry/**; the figures come only through the
// EarningsReads port (production: the composition root's apps/api/src/agent-earnings-reads.ts over
// ledger/read.ts and payout/read.ts, D10-1244; agent itself reads neither).
// Rule tests: test/spec/agent/earnings-tool/**. Names, signatures and the semantics written here
// are the contract.
//
// createGetMyEarningsHandler(deps): ToolHandler
//   name 'get_my_earnings', audience 'phone_bound'. Definition: no arguments (parameters an empty
//   object schema with additionalProperties=false); name, description and schema hit no BR-AI-02 ②
//   denylist word. Any argument is invalid_args (the registry rejects it before run).
//   run(args, ctx): identity only from ctx (appId, userId; a guest or an unbound caller is refused
//   without reading). One reads.read({appId, userId}) per call; as_of = clock.now() as +08:00 ISO.
//   ok → one earnings_summary card (schema_version 1, data = contract earnings_summary_live:
//     withdrawable_fen, estimated_total_fen, next_credit_period, credit_overdue copied from the
//     wallet summary as read; latest_withdrawal = null without a withdrawal, else exactly
//     {title_key: dictionary key of that withdrawal's main status title as the withdrawal records
//     show it (BR-TEXT-06), amount_fen: its applied amount}; actions = the two fixed buttons;
//     fallback_text = texts(appId, 'agent.earnings.fallback')), modelView exactly
//     {card_id: cardReference(ctx, 0), status: 'shown'}.
//   A failing or rejected read → no card, modelView exactly {status: 'unavailable'}.
//   Neither modelView nor trace carries any amount, month or withdrawal status (BR-AI-05 / 19).
//
// Implementation notes (B3-16a):
// - The read failing (either query), or a figure the contract card cannot carry (not a safe
//   integer, a malformed month, an unknown status code), is the same 'unavailable' outcome
//   (kind 'failed'): never a half card, never 0 or an earlier read in its place (BR-AI-04).
// - title_key follows the records' own display judgement (payout's projection, BR-TEXT-06 /
//   BR-WDR-25): sub_text_branch 'wechat_wait_confirm' (a WeChat transfer waiting for the user, not
//   past confirm_deadline, needs_manual=false) is「待确认收款」; every other withdrawal is the main
//   title of its status, `withdrawal_status.<STATUS>.label` (expired / needs_manual / canceling
//   WeChat transfers stay PAYING「打款中」).
// - trace carries only {earnings: 'shown'} for the core's reply template (core/reply-templates.ts).
import type { Schema } from '@couli/contracts-ts';
import type { Clock } from '../../../platform/index.ts';
import type { ToolOutcome } from '../../orchestrator/index.ts';
import type { ReplyTemplateTrace } from '../../orchestrator/core/reply-templates.ts';
import type { UnnumberedCard } from '../../stream/run/index.ts';
import type { ToolCallContext, ToolDefinition, ToolHandler } from '../registry/index.ts';

/** The authenticated caller whose own figures are read (never a model argument). */
export interface EarningsSubject {
  readonly appId: string;
  readonly userId: string;
}

/** One read of both sources: the wallet summary and the latest withdrawal record (or none). */
export interface EarningsRead {
  readonly wallet: Schema<'WalletSummary'>;
  readonly latestWithdrawal: Schema<'WithdrawalSummary'> | null;
}

/** The figures behind the card: the same query functions as the wallet page and the records. */
export interface EarningsReads {
  read(subject: EarningsSubject): Promise<EarningsRead>;
}

export interface GetMyEarningsDeps {
  readonly reads: EarningsReads;
  readonly clock: Clock;
  texts(appId: string, key: string): Promise<string>;
  cardReference(ctx: ToolCallContext, index: number): string;
}

function toolName(): 'get_my_earnings' {
  return 'get_my_earnings';
}

function fallbackKey(): string {
  return 'agent.earnings.fallback';
}

/** The records' sub-text branch of a WeChat transfer waiting for the user's confirmation. */
function waitConfirmBranch(): string {
  return 'wechat_wait_confirm';
}

/** contracts/texts.default.json: the records' 「待确认收款」 title. */
function waitConfirmKey(): string {
  return 'withdraw_detail.status.wechat_wait_confirm';
}

/** BR-TEXT-12 key naming of a withdrawal's main status title. */
function statusTitleKey(status: string): string {
  return `withdrawal_status.${status}.label`;
}

const STATUS_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/u;
const PLUS_EIGHT_MS = 8 * 3_600_000;

/** 04 §8.3: exactly these two buttons, in this order, no params. */
function actions(): readonly { readonly route: string; readonly text_key: string }[] {
  return [
    { route: 'Wallet', text_key: 'agent.earnings.open_wallet' },
    { route: 'WithdrawRecords', text_key: 'agent.earnings.open_records' },
  ];
}

function definition(): ToolDefinition {
  return {
    name: toolName(),
    description:
      '用户询问本人的可提现金额、预估收益、预计结算月份或最近一笔提现进度时调用。无参数，身份由服务端确定；数字只在卡片上展示，你看不到具体数字。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  };
}

/** 04 §5 timestamp: the same instant with the fixed +08:00 offset. */
function plusEight(at: Date): string {
  // A shifted copy of the clock's instant (no wall clock read; the input is never modified).
  const copy = structuredClone(at);
  copy.setTime(at.getTime() + PLUS_EIGHT_MS);
  const shifted = copy.toISOString();
  return `${shifted.slice(0, -1)}+08:00`;
}

function isFen(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** The records' main status title key of a withdrawal, or null when it cannot be named. */
function titleKey(record: Schema<'WithdrawalSummary'>): string | null {
  if (record.sub_text_branch === waitConfirmBranch()) return waitConfirmKey();
  const status: unknown = record.status;
  return typeof status === 'string' && STATUS_CODE.test(status) ? statusTitleKey(status) : null;
}

type LatestWithdrawal = { readonly title_key: string; readonly amount_fen: number } | null;

/** The card's withdrawal part; undefined when the record cannot make a contract-valid part. */
function latestWithdrawal(
  record: Schema<'WithdrawalSummary'> | null,
): LatestWithdrawal | undefined {
  if (record === null) return null;
  const key = titleKey(record);
  if (key === null || !isFen(record.amount_fen)) return undefined;
  return { title_key: key, amount_fen: record.amount_fen };
}

/** The live card data (earnings_summary_live), or undefined when a figure cannot be carried. */
function cardData(read: EarningsRead, asOf: string): Record<string, unknown> | undefined {
  const { wallet } = read;
  if (!isFen(wallet.withdrawable_fen) || !isFen(wallet.estimated_total_fen)) return undefined;
  if (typeof wallet.credit_overdue !== 'boolean') return undefined;
  const period: unknown = wallet.next_credit_period;
  if (period !== null && (typeof period !== 'string' || !MONTH.test(period))) return undefined;
  const latest = latestWithdrawal(read.latestWithdrawal);
  if (latest === undefined) return undefined;
  return {
    as_of: asOf,
    withdrawable_fen: wallet.withdrawable_fen,
    estimated_total_fen: wallet.estimated_total_fen,
    next_credit_period: period,
    credit_overdue: wallet.credit_overdue,
    latest_withdrawal: latest,
    actions: actions().map((action) => ({ ...action })),
  };
}

/** BR-AI-05: no card, no figure, no reason (a failure's message never reaches the model). */
function unavailable(): ToolOutcome {
  return { kind: 'failed', modelView: { status: 'unavailable' } };
}

async function fallbackText(deps: GetMyEarningsDeps, appId: string): Promise<string> {
  const key = fallbackKey();
  try {
    const text = await deps.texts(appId, key);
    return typeof text === 'string' && text !== '' ? text : key;
  } catch {
    return key;
  }
}

export function createGetMyEarningsHandler(deps: GetMyEarningsDeps): ToolHandler {
  async function run(
    _args: Readonly<Record<string, unknown>>,
    ctx: ToolCallContext,
  ): Promise<ToolOutcome> {
    // BR-AI-01 / BR-AI-03: identity only from the server context; never for a guest or unbound.
    const { appId, userId } = ctx;
    if (userId === null || !ctx.phoneBound) {
      return { kind: 'rejected', modelView: { error: 'invalid_args' } };
    }
    const asOf = plusEight(deps.clock.now());
    let read: EarningsRead;
    try {
      read = await deps.reads.read({ appId, userId });
    } catch {
      return unavailable();
    }
    const data = cardData(read, asOf);
    if (data === undefined) return unavailable();
    const card: UnnumberedCard = {
      type: 'earnings_summary',
      schema_version: 1,
      data,
      fallback_text: await fallbackText(deps, appId),
    };
    const trace: ReplyTemplateTrace = { earnings: 'shown' };
    return {
      kind: 'ok',
      modelView: { card_id: deps.cardReference(ctx, 0), status: 'shown' },
      cards: [card],
      trace,
    };
  }

  return { name: toolName(), definition: definition(), audience: 'phone_bound', run };
}
