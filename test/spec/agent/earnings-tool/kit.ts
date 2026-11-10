// B3-16a rule-test kit · get_my_earnings (D32; 08 BR-AI-01 细则「收益查询」, BR-AI-02, BR-AI-04,
// BR-AI-05, BR-AI-07, BR-AI-19, BR-FUND-18, BR-TEXT-06, BR-TEXT-22; 04 §8.3 earnings_summary,
// §8.5 get_my_earnings). No database here: the *.int.test.ts files of this directory bring PG.
// Everything under test is built inside the tests (never in hooks), so NotImplemented of the
// skeletons (tools/earnings/index.ts, stream/mount/earnings.ts) reddens the test body itself.
// Synthetic values only; every amount is a long, unusual digit run so a leak is easy to see.
import { expect, vi } from 'vitest';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import type {
  OrchestratorTools,
  ToolContext,
  ToolOutcome,
} from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import type { UnnumberedCard } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import {
  createGetMyEarningsHandler,
  type EarningsRead,
  type EarningsReads,
  type GetMyEarningsDeps,
} from '../../../../apps/api/src/modules/agent/tools/earnings/index.ts';
import {
  createToolRegistry,
  type ToolHandler,
  type ToolSwitches,
} from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import {
  projectWithdrawalSummary,
  registerWithdrawalAccountDecrypt,
  type WithdrawalRecordRow,
} from '../../../../apps/api/src/modules/payout/application/withdrawal-reads.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { sources } from '../../ledger/wallet-summary/kit.ts';
import { frameIsValid } from '../stream-writer/kit.ts';

export const TOOL = 'get_my_earnings';
export const SWITCH = 'agent.tools.get_my_earnings.enabled';

/** BR-AI-02 细则 ② 原文正则，大小写不敏感。 */
export const DENYLIST =
  /withdraw|payout|balance|ledger|payee|payout_account|inviter|bind_parent|change_phone|reward|prize|taolijin.*(create|issue|claim)/iu;

/** The instant the clock reads; as_of is this instant at +08:00. */
export const NOW = '2026-11-03T02:04:05.678Z';
export const NOW_MS = Date.parse(NOW);

/** BR-TEXT-22 keys of the earnings card and its texts. */
export const KEYS = {
  summary: 'agent.earnings.summary',
  unavailable: 'agent.earnings.unavailable',
  fallback: 'agent.earnings.fallback',
} as const;

/** 04 §8.3: exactly these two buttons, in this order, no params. */
export const ACTIONS = [
  { route: 'Wallet', text_key: 'agent.earnings.open_wallet' },
  { route: 'WithdrawRecords', text_key: 'agent.earnings.open_records' },
];

export type WalletSummary = EarningsRead['wallet'];
export type WithdrawalSummary = NonNullable<EarningsRead['latestWithdrawal']>;

/** A wallet summary as GET /v1/wallet/summary returns it (BR-FUND-18), synthetic figures. */
export const WALLET: WalletSummary = {
  available_fen: 987_654_321,
  withdrawable_fen: 987_654_321,
  negative_fen: 0,
  frozen_fen: 24_681_357,
  estimated_total_fen: 135_792_468,
  estimated_fen: 113_355_779,
  pending_credit_fen: 22_436_689,
  pending_credit_paused_fen: 1_357_913,
  // Far from any "today" a prompt or trace could carry, so a month leak is unambiguous.
  next_credit_period: '2031-07',
  credit_overdue: false,
  withdrawn_fen: 864_209_753,
  risk_paused_reason: null,
  withdraw_enabled: true,
};

/** The applied amount, fee and tax of the synthetic withdrawals (net = amount − fee − tax). */
export const WD = { amount: 55_443_322n, fee: 1_234_567n, tax: 2_345_678n } as const;

/** Every synthetic figure that must never reach the model, a text or a stored row. */
export const AMOUNTS: readonly number[] = [
  WALLET.available_fen,
  WALLET.frozen_fen,
  WALLET.estimated_total_fen,
  WALLET.estimated_fen,
  WALLET.pending_credit_fen,
  WALLET.pending_credit_paused_fen,
  WALLET.withdrawn_fen,
  Number(WD.amount),
  Number(WD.fee),
  Number(WD.tax),
  Number(WD.amount - WD.fee - WD.tax),
];

/**
 * No amount of `amounts` appears in `value` (JSON), neither in fen nor as the whole-yuan digits.
 * The yuan digits are checked only when they are 6 digits or more (shorter runs could match a
 * random id by chance); every fen figure here has 7 digits or more.
 * `months`: month strings that must not appear either (BR-AI-05: 不含月份).
 */
export function expectNoAmounts(
  value: unknown,
  what: string,
  amounts: readonly number[] = AMOUNTS,
  months: readonly string[] = [],
): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const fen of amounts) {
    if (fen === 0) continue;
    const yuan = String(Math.floor(fen / 100));
    expect(text, `${what}: no amount ${String(fen)}`).not.toContain(String(fen));
    if (yuan.length >= 6) {
      expect(text, `${what}: no yuan amount ${yuan}`).not.toContain(yuan);
    }
  }
  for (const month of months) {
    expect(text, `${what}: no month ${month}`).not.toContain(month);
  }
}

// ---- withdrawals through the records' own projection ------------------------------------------

/** One withdrawals row as the records read it (snapshot fields only); synthetic values. */
export function withdrawalRow(patch: Partial<WithdrawalRecordRow> = {}): WithdrawalRecordRow {
  return {
    id: '0192f3a1-7c00-7000-8000-00000000e001',
    status: 'PENDING_REVIEW',
    review_mode: null,
    amount_fen: WD.amount,
    fee_fen: WD.fee,
    tax_fen: WD.tax,
    net_fen: WD.amount - WD.fee - WD.tax,
    payout_method: 'alipay',
    payout_channel: 'alipay',
    payee_account_cipher: Buffer.from('synthetic.payee@example.test'),
    reject_reason_code: null,
    fail_code: null,
    created_at: new Date('2026-11-02T01:00:00.000Z'),
    channel_order_id: null,
    ...patch,
  };
}

/**
 * The record GET /v1/withdrawals shows for that row at NOW: payout's own projection (the same
 * display judgement as the records page, BR-TEXT-06 / BR-WDR-25).
 */
export function withdrawal(patch: Partial<WithdrawalRecordRow> = {}): WithdrawalSummary {
  return projectWithdrawalSummary(withdrawalRow(patch), (cipher) => cipher.toString('utf8'), {
    now: new Date(NOW),
  });
}

// ---- the handler behind the real registry -------------------------------------------------------

/** A reference string the fake cardReference issues for outcome.cards[0]. */
export const CARD_REF = '@synthetic-card-ref:0';

export function caller(userId: string | null = 'synthetic-user', phoneBound = true): AgentCaller {
  return {
    appId: 'synthetic-app-b3-16a',
    userId,
    phoneBound,
    deviceId: 'synthetic-device',
    deviceHash: 'synthetic-device-hash',
    ipKey: 'synthetic-ip-key',
    traceId: 'synthetic-trace',
  };
}

export function contextOf(subject: AgentCaller = caller()): ToolContext {
  return {
    subject,
    runId: 'synthetic-run-b3-16a',
    sessionId: 'synthetic-session-b3-16a',
    signal: new AbortController().signal,
    placeholders: {},
  };
}

/**
 * Handler deps over a recording reads port (answers `answer`, default: WALLET and no withdrawal),
 * the fixed clock, `固定文案:<key>` texts and a fake cardReference. Nothing is built yet.
 */
export function earningsDeps(answer?: () => Promise<EarningsRead>) {
  const clock = new FixedClock(NOW);
  const read = vi.fn<EarningsReads['read']>(
    answer ?? (async () => ({ wallet: WALLET, latestWithdrawal: null })),
  );
  const texts = vi.fn<GetMyEarningsDeps['texts']>(async (_appId, key) => `固定文案:${key}`);
  const cardReference = vi.fn<GetMyEarningsDeps['cardReference']>(() => CARD_REF);
  const deps: GetMyEarningsDeps = { reads: { read }, clock, texts, cardReference };
  return { deps, read, texts, cardReference, clock };
}

/**
 * The real handler behind the real ToolRegistry, switch answering `switchOn` (only an explicit
 * true enables a tool). Built when called: NotImplemented reddens the calling test.
 */
export function registryWith(
  deps: GetMyEarningsDeps,
  switchOn: (appId: string, key: string) => boolean = () => true,
) {
  const handler: ToolHandler = createGetMyEarningsHandler(deps);
  const get = vi.fn<ToolSwitches['get']>(async (appId, key) => switchOn(appId, key));
  const warn = vi.fn();
  const registry: OrchestratorTools = createToolRegistry({
    handlers: [handler],
    switches: { get },
    logger: { warn },
  });
  return { handler, registry, get, warn };
}

export async function callEarnings(
  registry: OrchestratorTools,
  args: unknown = {},
  ctx: ToolContext = contextOf(),
): Promise<ToolOutcome> {
  return registry.execute({ id: 'synthetic-call-b3-16a', name: TOOL, args }, ctx);
}

/** The cards of an outcome (none for failed / rejected). */
export function cardsOf(outcome: ToolOutcome): readonly UnnumberedCard[] {
  return outcome.kind === 'ok' ? outcome.cards : [];
}

/** The one earnings_summary card of an ok outcome (assertion failures otherwise). */
export function earningsCard(outcome: ToolOutcome): UnnumberedCard {
  expect(outcome.kind, JSON.stringify(outcome)).toBe('ok');
  const cards = cardsOf(outcome);
  expect(
    cards.map((card) => card.type),
    'exactly one earnings_summary card',
  ).toEqual(['earnings_summary']);
  return cards[0]!;
}

export function dataOf(card: UnnumberedCard): Record<string, unknown> {
  return card.data as Record<string, unknown>;
}

/** A numbered card (card_id, type, schema_version, data, fallback_text) as one SSE card frame
 * passes contracts/agent-stream.schema.json. */
export function frameIsValidCard(card: Readonly<Record<string, unknown>>): boolean {
  return frameIsValid({ event: 'card', id: 1, data: { seq: 1, ...card } });
}

/** The card as one SSE card frame passes contracts/agent-stream.schema.json. */
export function expectContractCard(card: UnnumberedCard, cardId = 'c1'): void {
  const numbered = { card_id: cardId, ...card };
  expect(frameIsValidCard(numbered), JSON.stringify(numbered)).toBe(true);
}

/** BR-AI-01 细则「收益查询」: only the wallet page's four figures of the summary, as read. */
export function walletFigures(wallet: WalletSummary) {
  return {
    withdrawable_fen: wallet.withdrawable_fen,
    estimated_total_fen: wallet.estimated_total_fen,
    next_credit_period: wallet.next_credit_period,
    credit_overdue: wallet.credit_overdue,
  };
}

// ---- the real queries' inputs (integration tests) -----------------------------------------------

/** Synthetic owner-module figures of the wallet summary (getWalletSummary's ports). */
export const SOURCE_FIGURES = {
  estimated_fen: 113_355_779n,
  pending_credit_fen: 22_436_689n,
  pending_credit_paused_fen: 1_357_913n,
  next_credit_period: '2031-07',
  credit_overdue: false,
  withdrawn_fen: 864_209_753n,
} as const;

/**
 * getWalletSummary's owner-module ports (the ledger wallet-summary kit's recording sources) with
 * the large synthetic SOURCE_FIGURES; the balance itself is ledger's real account_balances row.
 */
export function walletSources() {
  const s = sources();
  s.readUser.mockResolvedValue({
    estimated_fen: SOURCE_FIGURES.estimated_fen,
    pending_credit_fen: SOURCE_FIGURES.pending_credit_fen,
    pending_credit_paused_fen: SOURCE_FIGURES.pending_credit_paused_fen,
    next_credit_period: SOURCE_FIGURES.next_credit_period,
    credit_overdue: SOURCE_FIGURES.credit_overdue,
  });
  s.readPaidTotal.mockResolvedValue(SOURCE_FIGURES.withdrawn_fen);
  return s;
}

/** The records' decryption port, as app.module registers it (synthetic cipher = 'cipher:' + plain). */
export function registerDecrypt(): void {
  registerWithdrawalAccountDecrypt((cipher) => cipher.toString('utf8').replace(/^cipher:/u, ''));
}

/** as_of: the read instant at +08:00 (contract timestamp). */
export function expectAsOf(value: unknown, instantMs: number = NOW_MS): void {
  expect(value).toBeTypeOf('string');
  expect(value as string).toMatch(/\+08:00$/u);
  expect(Date.parse(value as string)).toBe(instantMs);
}
