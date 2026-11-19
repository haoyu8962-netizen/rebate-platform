// STAGING-SMOKE (QA-04b) case 7: the cross-end withdrawal loop on the dedicated smoke member.
//
//   preconditions (rules, balance ≥ ¥10, a bound payout account) → console login (TOTP)
//   → path A: apply ¥1 → frozen → console rejects → money back, WITHDRAW_RETURN, WD_REJECTED message
//   → path B: apply ¥1 → frozen → console approves → payout batch (staging fake channel)
//             → poll to the result (bounded) → frozen released, withdrawn +¥1, WITHDRAW_PAID,
//               the record PAID_*, WD_SUCCESS message.
//
// Order matters for the daily rules (BR-WDR-04, defaults): one withdrawal per member per natural
// day and ten per month, counting every withdrawal not in REJECTED / FAILED. Rejecting first frees
// the day's count again (「驳回和打款失败不占次数」), so both paths fit one day; the paid one uses
// one of the month's ten (see README for the monthly limit).
//
// The console login comes before any withdrawal is created, so a console that cannot be reached
// (10403 admin_ip_not_allowed, a refused code) never leaves a fresh withdrawal pending.
// Withdrawal step-up: BR-ID-08 (2026-11-14) dropped it, while the contract still marks x-step-up
// withdraw; the request goes without a token and, on 10003, takes an SMS step-up with the
// withdraw summary and replays with the same Idempotency-Key (error-codes 10003 action).
import { setTimeout as sleep } from 'node:timers/promises';
import { AdminClient } from '../lib/admin-client.ts';
import { okData, reasonOf } from '../lib/http.ts';
import { newIdempotencyKey } from '../lib/member-client.ts';
import { Fail, Yellow, yuan, type CaseContext } from '../lib/report.ts';
import { checkWithdrawal, Shape, WITHDRAWAL_STATUSES } from '../lib/shape.ts';
import { LOW_BALANCE_FEN, WITHDRAW_AMOUNT_FEN, type SmokeContext } from './context.ts';
import { checkLedger, checkRules, checkWalletSummary, type WalletSummary } from './member-cases.ts';

const PAYOUT_POLL_LIMIT_MS = 6 * 60_000;
const PAYOUT_POLL_EVERY_MS = 15_000;
const MESSAGE_POLL_LIMIT_MS = 90_000;
const MESSAGE_POLL_EVERY_MS = 5_000;

type Obj = Record<string, unknown>;

async function walletSummary(ctx: SmokeContext): Promise<WalletSummary> {
  return checkWalletSummary(
    okData(
      await ctx.member.request('GET', '/v1/wallet/summary', {
        label: 'GET /v1/wallet/summary',
        auth: true,
      }),
      'wallet summary',
    ),
  );
}

async function ledgerEntry(
  ctx: SmokeContext,
  withdrawalId: string,
  type: string,
): Promise<Obj | null> {
  const items = checkLedger(
    okData(
      await ctx.member.request('GET', '/v1/wallet/ledger?limit=50', {
        label: 'GET /v1/wallet/ledger',
        auth: true,
      }),
      'wallet ledger',
    ),
  );
  return (
    items.find(
      (item) =>
        item.ledger_type === type &&
        item.link_type === 'withdrawal' &&
        item.link_id === withdrawalId,
    ) ?? null
  );
}

async function messageIds(ctx: SmokeContext): Promise<Obj[]> {
  const data = okData(
    await ctx.member.request('GET', '/v1/messages?limit=50', {
      label: 'GET /v1/messages',
      auth: true,
    }),
    'messages',
  );
  const shape = new Shape('messages');
  const items = shape.objects(shape.arr(data, 'items', { max: 50 }), 'items');
  items.forEach((item, i) => {
    const path = `items[${String(i)}].`;
    shape.str(item, 'message_id', {}, path);
    shape.str(item, 'code', {}, path);
    shape.str(item, 'title', {}, path);
    shape.str(item, 'body', {}, path);
    shape.str(item, 'created_at', {}, path);
    shape.str(item, 'read_at', { nullable: true }, path);
    if (item.route !== null) shape.obj(item, 'route', {}, path);
  });
  shape.str(data, 'next_cursor', { nullable: true });
  shape.done();
  return items;
}

/** Waits (bounded) for a new in-app message with `code` that was not in `before`. */
async function awaitMessage(
  ctx: SmokeContext,
  before: ReadonlySet<unknown>,
  code: string,
): Promise<void> {
  const deadline = Date.now() + MESSAGE_POLL_LIMIT_MS;
  for (;;) {
    const items = await messageIds(ctx);
    if (items.some((item) => item.code === code && !before.has(item.message_id))) return;
    if (Date.now() >= deadline) {
      throw new Fail(`no new ${code} message within ${String(MESSAGE_POLL_LIMIT_MS / 1000)} s`);
    }
    await sleep(MESSAGE_POLL_EVERY_MS);
  }
}

async function memberWithdrawal(
  ctx: SmokeContext,
  id: string,
): Promise<{ status: string; net: bigint }> {
  const data = okData(
    await ctx.member.request('GET', `/v1/withdrawals/${encodeURIComponent(id)}`, {
      label: 'GET /v1/withdrawals/{withdrawal_id}',
      auth: true,
    }),
    'withdrawal detail',
  );
  const shape = new Shape('withdrawal detail');
  const checked = checkWithdrawal(shape, data, '', true);
  shape.done();
  if (checked.id !== id) throw new Fail('withdrawal detail: another withdrawal_id');
  return { status: checked.status ?? '', net: checked.net ?? 0n };
}

interface Applied {
  readonly id: string;
  readonly status: string;
  readonly net: bigint;
  readonly before: WalletSummary;
  readonly messagesBefore: ReadonlySet<unknown>;
}

/** Applies for WITHDRAW_AMOUNT_FEN and checks the freeze (summary deltas and WITHDRAW_FREEZE). */
async function apply(
  c: CaseContext,
  ctx: SmokeContext,
  path: string,
  payoutAccountId: string,
): Promise<Applied> {
  const applied = await c.step(`${path}：会员申请提现 ${yuan(WITHDRAW_AMOUNT_FEN)}`, async (s) => {
    const before = await walletSummary(ctx);
    const messagesBefore = new Set((await messageIds(ctx)).map((item) => item.message_id));
    const key = newIdempotencyKey();
    const body = { amount_fen: Number(WITHDRAW_AMOUNT_FEN) };
    const request = {
      label: 'POST /v1/withdrawals',
      signed: true,
      auth: true,
      idempotencyKey: key,
      body,
    };
    let result = await ctx.member.request('POST', '/v1/withdrawals', request);
    if (result.code === 10003) {
      s.note('提现要二次验证（10003）：短信 step-up 后沿用同一幂等键重放');
      const token = await ctx.member.stepUp('withdraw', ctx.config.smsCode, {
        payout_account_id: payoutAccountId,
        amount_fen: Number(WITHDRAW_AMOUNT_FEN),
      });
      result = await ctx.member.request('POST', '/v1/withdrawals', {
        ...request,
        stepUpToken: token,
      });
    }
    if (result.code === 30303) {
      throw new Fail(`withdraw: 30303 reason=${reasonOf(result) ?? 'none'}`);
    }
    const data = okData(result, 'withdraw');
    const shape = new Shape('withdraw');
    const checked = checkWithdrawal(shape, data, '', true);
    shape.done();
    if (checked.amount !== WITHDRAW_AMOUNT_FEN)
      throw new Fail('withdraw: amount_fen differs from the request');
    if (checked.id === null || checked.status === null) throw new Fail('withdraw: no id or status');
    s.note(`withdrawal_id ${checked.id}，状态 ${checked.status}`);
    return {
      id: checked.id,
      status: checked.status,
      net: checked.net ?? 0n,
      before,
      messagesBefore,
    };
  });
  await c.step(`${path}：冻结核对（可用 −、冻结 +、WITHDRAW_FREEZE）`, async (s) => {
    if (applied.status !== 'PENDING_REVIEW') {
      // Auto review (BR-WDR-30) may have paid already: the freeze is released by now, so the
      // frozen delta is not checked here; the paths below handle the non-manual status.
      s.notChecked(`申请后状态是 ${applied.status}（自动到账已接手？），冻结前后不核`);
      return;
    }
    const after = await walletSummary(ctx);
    if (after.available !== applied.before.available - WITHDRAW_AMOUNT_FEN) {
      throw new Fail('after apply: available_fen did not drop by the amount');
    }
    if (after.frozen !== applied.before.frozen + WITHDRAW_AMOUNT_FEN) {
      throw new Fail('after apply: frozen_fen did not grow by the amount');
    }
    const entry = await ledgerEntry(ctx, applied.id, 'WITHDRAW_FREEZE');
    if (entry === null)
      throw new Fail('after apply: no WITHDRAW_FREEZE entry linked to the withdrawal');
    if (entry.amount_fen !== -Number(WITHDRAW_AMOUNT_FEN)) {
      throw new Fail('after apply: WITHDRAW_FREEZE amount is not −amount');
    }
  });
  return applied;
}

async function preconditions(c: CaseContext, ctx: SmokeContext): Promise<string> {
  return c.step('前置：提现规则、余额（≥ ¥10）、收款账号', async (s) => {
    const rules = checkRules(
      okData(
        await ctx.member.request('GET', '/v1/withdrawals/rules', {
          label: 'GET /v1/withdrawals/rules',
          auth: true,
        }),
        'withdraw rules',
      ),
    );
    if (rules.withdrawable < LOW_BALANCE_FEN) {
      throw new Yellow(
        `可提现余额 ${yuan(rules.withdrawable)} 低于 ${yuan(LOW_BALANCE_FEN)}：跳过会动钱的用例，请补种子余额`,
      );
    }
    if (!rules.canWithdraw) {
      throw new Yellow(
        `can_withdraw=false，block_code ${String(rules.blockCode ?? 'none')}，block_reason ${rules.blockReason ?? 'none'}（测试会员前置未满足或开关关闭）`,
      );
    }
    if (rules.dailyRemaining < 1n || rules.monthlyRemaining < 1n) {
      throw new Yellow(
        `提现次数用完（今日剩 ${String(rules.dailyRemaining)}、本月剩 ${String(rules.monthlyRemaining)}，BR-WDR-04）`,
      );
    }
    if (rules.maxWithdrawable < WITHDRAW_AMOUNT_FEN) {
      throw new Yellow(`max_withdrawable_fen 低于 ${yuan(WITHDRAW_AMOUNT_FEN)}`);
    }
    s.note(`可提现余额 ${yuan(rules.withdrawable)}`);
    const account = okData(
      await ctx.member.request('GET', '/v1/me/payout-account', {
        label: 'GET /v1/me/payout-account',
        auth: true,
      }),
      'payout account',
    );
    const id = account.payout_account_id;
    if (typeof id !== 'string' || id.length === 0) throw new Yellow('测试会员没有绑定收款账号');
    const list = okData(
      await ctx.member.request('GET', '/v1/withdrawals?limit=50', {
        label: 'GET /v1/withdrawals',
        auth: true,
      }),
      'withdrawal list',
    );
    const items = Array.isArray(list.items) ? (list.items as Obj[]) : [];
    const open = items.filter(
      (w) => w.status === 'PENDING_REVIEW' || w.status === 'APPROVED',
    ).length;
    if (open > 0) s.warn(`有 ${String(open)} 笔未审完的旧提现（以前的冒烟中断留下的？需人工驳回）`);
    return id;
  });
}

export async function case7(c: CaseContext, ctx: SmokeContext): Promise<void> {
  const payoutAccountId = await preconditions(c, ctx);
  const credential = ctx.adminCredential;
  const admin = await c.step('后台登录（账号密码 + 动态码）', async () => {
    if (credential === null)
      throw new Fail('admin.json missing: run enroll-admin.ts on the test node first');
    const client = new AdminClient(ctx.target.adminBaseUrl, credential);
    await client.login();
    return client;
  });
  try {
    await rejectPath(c, ctx, admin, payoutAccountId);
    await approvePath(c, ctx, admin, payoutAccountId);
  } finally {
    // Never throws: a failure here must not hide the failure that ended the paths above.
    await c.step('后台退出登录', async (s) => {
      const result = await admin.logout().catch(() => null);
      if (result === null || (result.status !== 200 && result.status !== 204)) {
        s.warn('后台退出登录没有成功（会话会按空闲超时失效）');
      }
    });
  }
}

async function rejectPath(
  c: CaseContext,
  ctx: SmokeContext,
  admin: AdminClient,
  accountId: string,
) {
  const path = '驳回路径';
  const applied = await apply(c, ctx, path, accountId);
  await c.step(`${path}：后台驳回（totp 二次验证）`, async () => {
    if (applied.status !== 'PENDING_REVIEW') {
      throw new Yellow(`申请后状态是 ${applied.status}（自动到账已接手？），驳回路径没走到`);
    }
    const token = await admin.stepUp();
    const result = await admin.post(
      `/admin/v1/withdrawals/${encodeURIComponent(applied.id)}/reject`,
      {
        label: 'POST /admin/v1/withdrawals/{withdrawal_id}/reject',
        idempotencyKey: newIdempotencyKey(),
        stepUpToken: token,
        body: { reason_code: 'OTHER', note: 'staging smoke' },
      },
    );
    const data = okData(result, 'console reject');
    const shape = new Shape('console reject');
    if (shape.str(data, 'withdrawal_id') !== applied.id) shape.error('withdrawal_id differs');
    if (shape.str(data, 'status') !== 'REJECTED') shape.error('status is not REJECTED');
    shape.str(data, 'reject_reason_code');
    shape.str(data, 'reviewer_id');
    shape.str(data, 'reviewed_at');
    shape.done();
  });
  await c.step(`${path}：会员侧退回核对（状态、余额、WITHDRAW_RETURN）`, async () => {
    const detail = await memberWithdrawal(ctx, applied.id);
    if (detail.status !== 'REJECTED')
      throw new Fail('after reject: member sees another status than REJECTED');
    const after = await walletSummary(ctx);
    if (after.available !== applied.before.available || after.frozen !== applied.before.frozen) {
      throw new Fail(
        'after reject: available / frozen did not return to the values before the apply',
      );
    }
    const entry = await ledgerEntry(ctx, applied.id, 'WITHDRAW_RETURN');
    if (entry === null || entry.amount_fen !== Number(WITHDRAW_AMOUNT_FEN)) {
      throw new Fail('after reject: no WITHDRAW_RETURN of +amount linked to the withdrawal');
    }
  });
  await c.step(`${path}：站内信多一条 WD_REJECTED`, async () => {
    await awaitMessage(ctx, applied.messagesBefore, 'WD_REJECTED');
  });
}

async function approvePath(
  c: CaseContext,
  ctx: SmokeContext,
  admin: AdminClient,
  accountId: string,
) {
  const path = '通过路径';
  const applied = await apply(c, ctx, path, accountId);
  const manual = applied.status === 'PENDING_REVIEW';
  await c.step(`${path}：后台审批通过（totp 二次验证）`, async (s) => {
    if (!manual) {
      s.notChecked(`申请后状态是 ${applied.status}（自动到账已接手），跳过人工审批`);
      return;
    }
    const token = await admin.stepUp();
    const data = okData(
      await admin.post('/admin/v1/withdrawals/batch-approve', {
        label: 'POST /admin/v1/withdrawals/batch-approve',
        idempotencyKey: newIdempotencyKey(),
        stepUpToken: token,
        body: { withdrawal_ids: [applied.id] },
      }),
      'console approve',
    );
    const shape = new Shape('console approve');
    const items = shape.objects(shape.arr(data, 'items'), 'items');
    shape.done();
    const item = items.find((entry) => entry.withdrawal_id === applied.id);
    if (item?.result !== 'approved') {
      throw new Fail(
        `console approve: result ${String(item?.result ?? 'missing')}, reason ${String(item?.reason ?? 'none')}`,
      );
    }
  });
  const batchId = await c.step(
    `${path}：执行打款批次（staging 假通道，totp 二次验证）`,
    async (s) => {
      if (!manual) {
        s.notChecked('自动到账已接手，跳过人工执行');
        return null;
      }
      const token = await admin.stepUp();
      const data = okData(
        await admin.post('/admin/v1/payout-batches', {
          label: 'POST /admin/v1/payout-batches',
          idempotencyKey: newIdempotencyKey(),
          stepUpToken: token,
          body: { withdrawal_ids: [applied.id] },
        }),
        'payout batch',
      );
      const shape = new Shape('payout batch');
      const outcome = shape.str(data, 'outcome', { enum: ['executed', 'rejected'] });
      const batch = shape.str(data, 'batch_id', { nullable: true });
      shape.str(data, 'reason', { nullable: true });
      const paying = shape.arr(data, 'paying');
      const left = shape.objects(shape.arr(data, 'left'), 'left');
      shape.done();
      if (outcome === 'rejected')
        throw new Fail(`payout batch rejected: reason ${String(data.reason ?? 'none')}`);
      if (!paying.includes(applied.id)) {
        const reason = left.find((entry) => entry.withdrawal_id === applied.id)?.reason;
        throw new Fail(`payout batch: withdrawal left, reason ${String(reason ?? 'none')}`);
      }
      return batch;
    },
  );
  await c.step(`${path}：打款批次详情`, async (s) => {
    if (batchId === null) {
      s.notChecked('没有人工批次');
      return;
    }
    const result = await admin.get(
      `/admin/v1/payout-batches/${encodeURIComponent(batchId)}`,
      'GET /admin/v1/payout-batches/{batch_id}',
    );
    if (result.status !== 200 || result.code !== 0) {
      // x-implementation: planned in the contract: not failing the loop while it is not served.
      s.notChecked(
        `批次详情未提供（HTTP ${String(result.status)}，code ${String(result.code ?? 'none')}；契约标 planned）`,
      );
      return;
    }
    const data = okData(result, 'payout batch detail');
    const shape = new Shape('payout batch detail');
    if (shape.str(data, 'batch_id') !== batchId) shape.error('batch_id differs');
    const members = shape.objects(shape.arr(data, 'members'), 'members');
    if (!members.some((m) => m.withdrawal_id === applied.id))
      shape.error('the withdrawal is not a member');
    shape.done();
  });
  const finalStatus = await c.step(
    `${path}：轮询打款结果（≤ ${String(PAYOUT_POLL_LIMIT_MS / 60_000)} 分钟）`,
    async (s) => {
      const deadline = Date.now() + PAYOUT_POLL_LIMIT_MS;
      for (;;) {
        const detail = await memberWithdrawal(ctx, applied.id);
        if (detail.status === 'PAID_API' || detail.status === 'PAID_MANUAL') {
          s.note(`结果 ${detail.status}`);
          return detail;
        }
        if (detail.status === 'FAILED' || detail.status === 'REJECTED') {
          throw new Fail(`payout ended ${detail.status}`);
        }
        if (!WITHDRAWAL_STATUSES.includes(detail.status as (typeof WITHDRAWAL_STATUSES)[number])) {
          throw new Fail('payout: unknown status');
        }
        if (Date.now() >= deadline) {
          throw new Fail(
            `payout: still ${detail.status} after ${String(PAYOUT_POLL_LIMIT_MS / 60_000)} minutes`,
          );
        }
        await sleep(PAYOUT_POLL_EVERY_MS);
      }
    },
  );
  await c.step(`${path}：余额、流水、提现记录核对`, async () => {
    const after = await walletSummary(ctx);
    if (after.available !== applied.before.available - WITHDRAW_AMOUNT_FEN) {
      throw new Fail('after payout: available_fen is not the value before minus the amount');
    }
    if (after.frozen !== applied.before.frozen)
      throw new Fail('after payout: frozen_fen not released');
    if (after.withdrawn !== applied.before.withdrawn + WITHDRAW_AMOUNT_FEN) {
      throw new Fail('after payout: withdrawn_fen did not grow by the amount');
    }
    const entry = await ledgerEntry(ctx, applied.id, 'WITHDRAW_PAID');
    if (entry === null)
      throw new Fail('after payout: no WITHDRAW_PAID entry linked to the withdrawal');
    if (entry.amount_fen !== -Number(finalStatus.net)) {
      throw new Fail('after payout: WITHDRAW_PAID amount is not −net_fen');
    }
    const list = okData(
      await ctx.member.request('GET', '/v1/withdrawals?limit=20', {
        label: 'GET /v1/withdrawals',
        auth: true,
      }),
      'withdrawal list',
    );
    const items = Array.isArray(list.items) ? (list.items as Obj[]) : [];
    const record = items.find((w) => w.withdrawal_id === applied.id);
    if (record === undefined)
      throw new Fail('after payout: the withdrawal is not in the member list');
    if (record.status !== finalStatus.status)
      throw new Fail('after payout: list status differs from the detail');
    if (record.sub_text_branch !== 'paid_api' && record.sub_text_branch !== 'paid_manual') {
      throw new Fail('after payout: sub_text_branch is not paid_*');
    }
  });
  await c.step(`${path}：站内信多一条 WD_SUCCESS`, async () => {
    await awaitMessage(ctx, applied.messagesBefore, 'WD_SUCCESS');
  });
}
