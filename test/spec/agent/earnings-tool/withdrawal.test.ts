// B3-16a · the withdrawal part of the earnings card (08 BR-AI-01 细则「收益查询」「提现部分只放最小摘要」
// 第 1 轮评审 R-06; BR-TEXT-06; 04 §8.3 earnings_latest_withdrawal). The latest withdrawal is given
// as the records show it (payout's own projection, kit.ts withdrawal()); the card carries exactly
// {title_key, amount_fen}: the dictionary key of its main status title and the applied amount. Pinned:
// what 08 says about the titles (扣税后已到账与未扣税已到账同为「已到账」、失败不论原因同为「打款未成功」、
// 结果未知超时仍是「打款中」、微信待确认显示「待确认收款」（≠「打款中」）), the exact key of every main
// status (TITLE_KEYS below), and that no other withdrawal field reaches the card.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { WithdrawalRecordRow } from '../../../../apps/api/src/modules/payout/application/withdrawal-reads.ts';
import {
  NOW_MS,
  WALLET,
  WD,
  callEarnings,
  dataOf,
  earningsCard,
  earningsDeps,
  expectContractCard,
  expectNoAmounts,
  registryWith,
  withdrawal,
  type WithdrawalSummary,
} from './kit.ts';

const MINUTE = 60_000;
const at = (offsetMs: number) => new Date(NOW_MS + offsetMs);

/** A WeChat (微信零钱) withdrawal waiting for the user to confirm, deadline not yet passed. */
const WECHAT_WAIT = {
  status: 'PAYING',
  review_mode: 'manual',
  payout_method: 'wechat',
  payout_channel: 'wechat',
  executed_at: at(-10 * MINUTE),
  channel_state: 'wait_user_confirm',
  confirm_deadline: at(24 * 60 * MINUTE),
} satisfies Partial<WithdrawalRecordRow>;

/** Synthetic withdrawals of one user, each the latest in its own case. */
const CASES = {
  pendingReview: { status: 'PENDING_REVIEW' },
  approvedManual: { status: 'APPROVED', review_mode: 'manual' },
  approvedAuto: { status: 'APPROVED', review_mode: 'auto' },
  paidTaxed: { status: 'PAID_API', paid_at: at(-60 * MINUTE) },
  paidUntaxed: {
    status: 'PAID_API',
    paid_at: at(-60 * MINUTE),
    fee_fen: 0n,
    tax_fen: 0n,
    net_fen: WD.amount,
  },
  paidManual: { status: 'PAID_MANUAL', review_mode: 'manual', paid_at: at(-60 * MINUTE) },
  rejected: {
    status: 'REJECTED',
    review_mode: 'manual',
    reject_reason_code: 'SYNTHETIC_REJECT_REASON',
  },
  rejectedOffset: { status: 'REJECTED', reject_reason_code: 'NEGATIVE_BALANCE' },
  failedAccount: { status: 'FAILED', fail_code: 'PAYEE_NOT_EXIST' },
  failedOther: { status: 'FAILED', fail_code: 'SYNTHETIC_CHANNEL_ERROR' },
  failedManual: {
    status: 'FAILED',
    review_mode: 'manual',
    fail_code: 'SYNTHETIC_UNKNOWN_RESULT',
    manual_resolution: 'failed',
  },
  payingOnTime: { status: 'PAYING', review_mode: 'manual', executed_at: at(-10 * MINUTE) },
  payingTimedOut: { status: 'PAYING', review_mode: 'manual', executed_at: at(-180 * MINUTE) },
  wechatWaitConfirm: WECHAT_WAIT,
  // BR-TEXT-06: 「待确认收款」 only while not past confirm_deadline and needs_manual=false.
  wechatConfirmExpired: { ...WECHAT_WAIT, confirm_deadline: at(-1 * MINUTE) },
  wechatNeedsManual: { ...WECHAT_WAIT, needs_manual: true },
  wechatCanceling: { ...WECHAT_WAIT, channel_state: 'canceling' },
} satisfies Record<string, Partial<WithdrawalRecordRow>>;

type CaseName = keyof typeof CASES;

/** The records' own sub-text branch of each case: the fixtures mean what their names say. */
const BRANCHES: Record<CaseName, string> = {
  pendingReview: 'processing',
  approvedManual: 'processing',
  approvedAuto: 'auto_expected_soon',
  paidTaxed: 'paid_api',
  paidUntaxed: 'paid_api',
  paidManual: 'paid_manual',
  rejected: 'rejected',
  rejectedOffset: 'rejected_offset',
  failedAccount: 'failed_account',
  failedOther: 'failed_other',
  failedManual: 'failed_manual',
  payingOnTime: 'channel_processing',
  payingTimedOut: 'paying_delayed',
  wechatWaitConfirm: 'wechat_wait_confirm',
  wechatConfirmExpired: 'wechat_confirm_expired',
  wechatNeedsManual: 'paying_delayed',
  wechatCanceling: 'wechat_canceling',
};

/**
 * The records page's main status title key of each case. BR-TEXT-06: PENDING_REVIEW / APPROVED
 * 「审核中」, PAYING「打款中」, PAID_API / PAID_MANUAL「已到账」, REJECTED「未通过」, FAILED「打款未成功」
 * (whatever the reason or branch), each by its status code under the BR-TEXT-12 key naming
 * `withdrawal_status.<CODE>.label` (the form contracts/fixtures/agent-streams/normal-earnings.ndjson
 * carries); only a WeChat withdrawal waiting for confirmation, not past confirm_deadline and with
 * needs_manual=false, reads「待确认收款」(contracts/texts.default.json
 * withdraw_detail.status.wechat_wait_confirm). Expired, needs_manual and canceling stay「打款中」.
 */
const label = (code: string) => `withdrawal_status.${code}.label`;
const WAIT_CONFIRM_KEY = 'withdraw_detail.status.wechat_wait_confirm';
const TITLE_KEYS: Record<CaseName, string> = {
  pendingReview: label('PENDING_REVIEW'),
  approvedManual: label('APPROVED'),
  approvedAuto: label('APPROVED'),
  paidTaxed: label('PAID_API'),
  paidUntaxed: label('PAID_API'),
  paidManual: label('PAID_MANUAL'),
  rejected: label('REJECTED'),
  rejectedOffset: label('REJECTED'),
  failedAccount: label('FAILED'),
  failedOther: label('FAILED'),
  failedManual: label('FAILED'),
  payingOnTime: label('PAYING'),
  payingTimedOut: label('PAYING'),
  wechatWaitConfirm: WAIT_CONFIRM_KEY,
  wechatConfirmExpired: label('PAYING'),
  wechatNeedsManual: label('PAYING'),
  wechatCanceling: label('PAYING'),
};

const TEXTS_FILE = new URL('../../../../contracts/texts.default.json', import.meta.url);

/** Card data.latest_withdrawal of every case, through the real handler behind the registry. */
async function latestOfEach() {
  let current: WithdrawalSummary | null = null;
  const { deps } = earningsDeps(async () => ({ wallet: WALLET, latestWithdrawal: current }));
  const { registry } = registryWith(deps);
  type Shown = { readonly record: WithdrawalSummary; readonly data: Record<string, unknown> };
  const out = {} as Record<CaseName, Shown>;
  for (const name of Object.keys(CASES) as CaseName[]) {
    const record = withdrawal(CASES[name]);
    expect(record.sub_text_branch, `fixture ${name}`).toBe(BRANCHES[name]);
    current = record;
    const card = earningsCard(await callEarnings(registry, {}));
    expectContractCard(card);
    out[name] = { record, data: dataOf(card) };
  }
  return out;
}

function titleKeyOf(latest: unknown): string {
  expect(latest, 'latest_withdrawal').toBeTypeOf('object');
  expect(latest).not.toBeNull();
  const value = (latest as Record<string, unknown>)['title_key'];
  expect(value, 'title_key').toBeTypeOf('string');
  return value as string;
}

it('[AC-B3-16a#9][BR-TEXT-06][BR-AI-01] 最近一笔提现只放 {title_key, amount_fen}：amount_fen 为申请金额（不是到账净额），title_key 为字典键；不带净额、手续费、税、原因、账号、渠道、时效与确认截止时间', async () => {
  const cases = await latestOfEach();
  for (const [name, { record, data }] of Object.entries(cases)) {
    const latest = data['latest_withdrawal'] as Record<string, unknown>;
    expect(Object.keys(latest).sort(), name).toEqual(['amount_fen', 'title_key']);
    expect(latest['amount_fen'], `${name}: applied amount`).toBe(record.amount_fen);
    expect(titleKeyOf(latest), name).toMatch(/^[a-z][a-z0-9_]*(\.[A-Za-z0-9_]+)*$/u);
    const text = JSON.stringify(data);
    const others = [record.fee_fen, record.tax_fen, record.net_fen].filter(
      (fen) => fen !== record.amount_fen,
    );
    expectNoAmounts(text, `${name}: card data`, others);
    for (const leak of [
      record.withdrawal_id,
      record.masked_account,
      record.payout_channel_name,
      record.reason_code,
      record.confirm_deadline,
      record.created_at,
    ]) {
      if (leak !== null) expect(text, `${name}: no ${leak}`).not.toContain(leak);
    }
  }
});

it('[AC-B3-16a#10][BR-TEXT-06][BR-AI-01] 主状态标题键随提现记录的展示判定：扣税到账与未扣税到账同键、失败不论原因同键、结果未知超时与正常打款中同键、微信待确认与打款中不同键，已到账 / 打款未成功 / 打款中三者互不相同', async () => {
  const cases = await latestOfEach();
  const key = (name: CaseName) => titleKeyOf(cases[name].data['latest_withdrawal']);
  expect(key('paidUntaxed'), '已到账').toBe(key('paidTaxed'));
  expect(key('failedOther'), '打款未成功').toBe(key('failedAccount'));
  expect(key('payingTimedOut'), '打款中').toBe(key('payingOnTime'));
  expect(key('wechatWaitConfirm'), '待确认收款 ≠ 打款中').not.toBe(key('payingOnTime'));
  const distinct = new Set([key('paidTaxed'), key('failedAccount'), key('payingOnTime')]);
  expect(distinct.size, '已到账 / 打款未成功 / 打款中').toBe(3);
  expect(key('pendingReview'), '审核中 ≠ 打款中').not.toBe(key('payingOnTime'));
});

it('[AC-B3-16a#22][BR-TEXT-06][BR-WDR-25][BR-AI-01] 每个主状态的标题键逐个等于提现记录页的那一个：PENDING_REVIEW / APPROVED（自动、人工）→ 审核中、PAYING → 打款中、PAID_API / PAID_MANUAL → 已到账、REJECTED（含 NEGATIVE_BALANCE 抵扣）→ 未通过、FAILED（账号类、其他、人工判失败）→ 打款未成功、微信待确认 → 待确认收款', async () => {
  const texts = (JSON.parse(readFileSync(TEXTS_FILE, 'utf8')) as { texts: Record<string, string> })
    .texts;
  expect(texts[WAIT_CONFIRM_KEY], 'fixture: the 待确认收款 key of the records').toBe('待确认收款');
  const cases = await latestOfEach();
  for (const name of Object.keys(CASES) as CaseName[]) {
    expect(titleKeyOf(cases[name].data['latest_withdrawal']), name).toBe(TITLE_KEYS[name]);
  }
});

it.each([
  { name: 'wechatConfirmExpired', why: '确认期已过' },
  { name: 'wechatNeedsManual', why: 'needs_manual=true' },
] as const)(
  '[AC-B3-16a#23][BR-TEXT-06][BR-WDR-25] 微信零钱单 channel_state=wait_user_confirm 但 $why：不显示「待确认收款」，标题为「打款中」（withdrawal_status.PAYING.label）',
  async ({ name }) => {
    const cases = await latestOfEach();
    const key = titleKeyOf(cases[name].data['latest_withdrawal']);
    expect(key, `${name}: not 待确认收款`).not.toBe(WAIT_CONFIRM_KEY);
    expect(key, `${name}: 打款中`).toBe(label('PAYING'));
    expect(key, `${name}: same title as a PAYING withdrawal`).toBe(
      titleKeyOf(cases.payingOnTime.data['latest_withdrawal']),
    );
  },
);
