// STAGING-SMOKE (QA-04b): cases 1–6 and 8 of the first phase (STAGING-SMOKE brief), plus the
// closing logout. Each checks the envelope and the contract shape of what it reads, and a state
// change where the operation has one. Output: step names, HTTP status, business codes only.
import { randomUUID } from 'node:crypto';
import { okData } from '../lib/http.ts';
import { newIdempotencyKey } from '../lib/member-client.ts';
import { Fail, Skipped, Yellow, type CaseContext } from '../lib/report.ts';
import { checkProductCard, checkWithdrawal, Shape, UNION_PLATFORMS } from '../lib/shape.ts';
import type { SmokeContext } from './context.ts';

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const LEDGER_TYPES = [
  'REBATE_CREDIT',
  'SHARE_CREDIT',
  'REFERRAL_CREDIT',
  'CLAWBACK',
  'SETTLE_ADJUST',
  'WITHDRAW_FREEZE',
  'WITHDRAW_RETURN',
  'WITHDRAW_FEE',
  'TAX_WITHHOLD',
  'REWARD',
  'ADMIN_ADJUST',
  'BAD_DEBT_WRITEOFF',
];
const ORDER_DISPLAY_STATUSES = [
  'PAID',
  'DEPOSIT_PAID',
  'WAITING',
  'CREDITING',
  'REVIEWING',
  'RIGHTS_PENDING',
  'CREDITED',
  'CREDITED_PART_CLAWED',
  'NO_REBATE',
  'INVALID',
  'CLAWED_BACK',
];

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10));
  const pb = b.split('.').map((part) => Number.parseInt(part, 10));
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function checkTokenPair(shape: Shape, tokens: Record<string, unknown>, path: string): void {
  shape.str(tokens, 'session_scope', { enum: ['full', 'deletion_only'] }, path);
  shape.str(tokens, 'access_token', {}, path);
  shape.str(tokens, 'access_expires_at', {}, path);
  shape.str(tokens, 'refresh_token', {}, path);
  shape.str(tokens, 'refresh_expires_at', {}, path);
}

/** Case 1: device (reused or registered), test-phone SMS login, refresh-token rotation. */
export async function case1(c: CaseContext, ctx: SmokeContext): Promise<void> {
  const { member, config } = ctx;
  await c.step('设备：复用 device.json 或注册', async (s) => {
    const how = await member.ensureDevice();
    s.note(how === 'reused' ? '复用已登记的设备' : '注册了新设备并写入 device.json');
  });
  await c.step('版本检查（取本次请求用的 X-App-Version）', async (s) => {
    const result = await member.request('GET', '/v1/app-versions/check', {
      label: 'GET /v1/app-versions/check',
    });
    const data = okData(result, 'app version check');
    const shape = new Shape('app version check');
    const latest = shape.str(data, 'latest_version');
    const min = shape.str(data, 'min_supported_version', { nullable: true });
    shape.done();
    if (latest === null || !SEMVER.test(latest))
      throw new Fail('app version check: latest_version not x.y.z');
    ctx.minSupportedVersion = min;
    if (config.appVersion !== null) {
      member.appVersion = config.appVersion;
      s.note('X-App-Version 取 member.json 的 app_version');
    } else {
      member.appVersion = latest;
      s.note('X-App-Version 取 latest_version');
    }
  });
  await c.step('读取配置（取协议版本）', async () => {
    const data = okData(
      await member.request('GET', '/v1/config', { label: 'GET /v1/config' }),
      'config',
    );
    const shape = new Shape('config');
    const legal = shape.obj(data, 'legal');
    const privacy = legal === null ? null : shape.obj(legal, 'privacy', {}, 'legal.');
    const agreement = legal === null ? null : shape.obj(legal, 'agreement', {}, 'legal.');
    const privacyVersion =
      privacy === null ? null : shape.int(privacy, 'version', { min: 1 }, 'legal.privacy.');
    const agreementVersion =
      agreement === null ? null : shape.int(agreement, 'version', { min: 1 }, 'legal.agreement.');
    shape.done();
    if (privacyVersion === null || agreementVersion === null)
      throw new Fail('config: legal versions missing');
    ctx.legal = { privacy: Number(privacyVersion), agreement: Number(agreementVersion) };
  });
  await c.step('发送登录验证码（测试号，不发真短信）', async () => {
    const data = await member.sendSmsCode('login', config.phone, null);
    const shape = new Shape('sms code');
    shape.int(data, 'resend_after_sec');
    shape.int(data, 'expires_in_sec');
    shape.done();
  });
  await c.step('测试号短信登录', async (s) => {
    const legal = ctx.legal;
    if (legal === null) throw new Fail('login: no legal versions');
    const result = await member.request('POST', '/v1/auth/login/sms', {
      label: 'POST /v1/auth/login/sms',
      signed: true,
      body: {
        phone: config.phone,
        code: config.smsCode,
        legal_versions: legal,
        consent_at: new Date().toISOString(),
      },
    });
    const data = okData(result, 'sms login');
    const shape = new Shape('sms login');
    shape.str(data, 'user_id');
    const isNew = shape.bool(data, 'is_new_user');
    const tokens = shape.obj(data, 'tokens');
    if (tokens !== null) checkTokenPair(shape, tokens, 'tokens.');
    shape.done();
    if (tokens === null) throw new Fail('sms login: no tokens');
    member.tokens = { access: String(tokens.access_token), refresh: String(tokens.refresh_token) };
    if (tokens.session_scope !== 'full') throw new Fail('sms login: session_scope is not full');
    ctx.loggedIn = true;
    if (isNew === true) s.warn('is_new_user=true：测试号此前没有账号，钱包与订单用例会缺数据');
  });
  await c.step('刷新令牌（轮换）', async () => {
    const before = member.tokens;
    if (before === null) throw new Fail('refresh: not logged in');
    const after = await member.refresh();
    if (after.refresh === before.refresh) throw new Fail('refresh: refresh_token was not rotated');
    if (after.access === before.access) throw new Fail('refresh: access_token unchanged');
    // The new access token must work: a read that needs a session.
    okData(
      await member.request('GET', '/v1/messages/unread-count', {
        label: 'GET /v1/messages/unread-count',
        auth: true,
      }),
      'unread count with the refreshed token',
    );
  });
}

/** Case 2: home configuration, page and product pool (one search call). */
export async function case2(c: CaseContext, ctx: SmokeContext): Promise<void> {
  const { member, config } = ctx;
  await c.step('配置：契约形状 + ETag 条件请求', async (s) => {
    const result = await member.request('GET', '/v1/config', {
      label: 'GET /v1/config',
      auth: ctx.loggedIn,
    });
    const data = okData(result, 'config');
    const shape = new Shape('config');
    shape.str(data, 'dict_version');
    shape.str(data, 'h5_base_url');
    shape.obj(data, 'h5_release');
    shape.arr(data, 'share_domains');
    const features = shape.obj(data, 'features');
    if (features !== null) {
      shape.obj(features, 'flags', {}, 'features.');
      shape.obj(features, 'platform_status', {}, 'features.');
    }
    shape.obj(data, 'texts');
    shape.obj(data, 'legal');
    shape.obj(data, 'invite');
    shape.obj(data, 'agent');
    shape.obj(data, 'kf');
    shape.obj(data, 'bridge_origins');
    const version = shape.str(data, 'config_version', { optional: true });
    shape.done();
    if (version === null) {
      s.notChecked('响应没有 config_version，未做条件请求');
      return;
    }
    const etag = result.etag?.replace(/^W\//, '').replace(/"/g, '') ?? null;
    if (etag !== version) throw new Fail('config: ETag does not equal data.config_version');
    const again = await member.request('GET', '/v1/config', {
      label: 'GET /v1/config (If-None-Match)',
      auth: ctx.loggedIn,
      headers: { 'If-None-Match': result.etag ?? '' },
    });
    if (again.status !== 304)
      throw new Fail(`config: If-None-Match answered HTTP ${String(again.status)}, not 304`);
  });
  await c.step('首页页面配置 /v1/pages/home', async () => {
    const result = await member.request('GET', '/v1/pages/home', {
      label: 'GET /v1/pages/{page_key}',
      auth: ctx.loggedIn,
    });
    if (result.code === 30701) throw new Yellow('home 页没有已发布版本（30701）');
    const data = okData(result, 'home page');
    const shape = new Shape('home page');
    if (shape.str(data, 'page_key') !== 'home') shape.error('page_key is not home');
    shape.int(data, 'version', { min: 1 });
    shape.int(data, 'ttl_sec', { min: 1 });
    shape.objects(shape.arr(data, 'sections'), 'sections');
    shape.done();
  });
  await c.step('商品池：关键词搜索（真实联盟，只调 1 次）', async (s) => {
    const query = `platform=${encodeURIComponent(config.searchPlatform)}&q=${encodeURIComponent(config.searchQuery)}&limit=10`;
    const result = await member.request('GET', `/v1/products/search?${query}`, {
      label: 'GET /v1/products/search',
      auth: ctx.loggedIn,
    });
    if (result.code === 50304) throw new Yellow('联盟搜索暂不可用（50304）');
    const data = okData(result, 'product search');
    const shape = new Shape('product search');
    const items = shape.objects(shape.arr(data, 'items', { max: 50 }), 'items');
    items.forEach((card, i) => checkProductCard(shape, card, `items[${String(i)}].`));
    shape.str(data, 'next_cursor', { nullable: true });
    shape.bool(data, 'has_more');
    const fallback = shape.objects(
      shape.arr(data, 'fallback_items', { max: 10 }),
      'fallback_items',
    );
    fallback.forEach((card, i) => checkProductCard(shape, card, `fallback_items[${String(i)}].`));
    shape.done();
    if (items.length === 0 && fallback.length === 0)
      s.warn('搜索没有任何结果（items 与 fallback_items 都为空）');
    if (items.some((card) => card.platform !== config.searchPlatform)) {
      throw new Fail('product search: an item of another platform');
    }
  });
}

/** Case 3: one pasted product link → rebate card (a real union call, once per run). */
export async function case3(c: CaseContext, ctx: SmokeContext): Promise<void> {
  const text = ctx.config.parseText;
  await c.step('粘贴商品链接查返利（POST /v1/inputs/parse，1 次）', async (s) => {
    if (text === null) throw new Skipped('member.json 没有 parse_text（商品链接），本用例不跑');
    const result = await ctx.member.request('POST', '/v1/inputs/parse', {
      label: 'POST /v1/inputs/parse',
      signed: true,
      auth: true,
      body: { text, scene: 'clipboard' },
    });
    if (result.code === 30131 || result.code === 30132) {
      throw new Yellow(`识别不到链接或口令（${String(result.code)}）：parse_text 可能过期`);
    }
    const data = okData(result, 'parse input');
    const shape = new Shape('parse input');
    const results = shape.objects(shape.arr(data, 'results', { max: 3 }), 'results');
    if (results.length === 0) shape.error('results is empty');
    const errorCodes: string[] = [];
    results.forEach((item, i) => {
      const path = `results[${String(i)}].`;
      if ('card' in item) {
        const card = shape.obj(item, 'card', {}, path);
        if (card !== null) checkProductCard(shape, card, `${path}card.`);
      } else {
        const code = shape.int(item, 'error_code', { min: 10000 }, path);
        if (code !== null) errorCodes.push(String(code));
      }
    });
    shape.done();
    if (errorCodes.length === results.length) {
      throw new Yellow(
        `链接没有换出商品卡（error_code ${errorCodes.join(', ')}）：商品可能下架或联盟异常`,
      );
    }
    if (errorCodes.length > 0) s.warn(`部分结果是错误码 ${errorCodes.join(', ')}`);
  });
}

/** Case 4: order list and one detail (staging seed orders). */
export async function case4(c: CaseContext, ctx: SmokeContext): Promise<void> {
  const first = await c.step('订单列表（scope=self）', async () => {
    const data = okData(
      await ctx.member.request('GET', '/v1/orders?scope=self&limit=20', {
        label: 'GET /v1/orders',
        auth: true,
      }),
      'order list',
    );
    const shape = new Shape('order list');
    const items = shape.objects(shape.arr(data, 'items'), 'items');
    items.forEach((item, i) => {
      const path = `items[${String(i)}].`;
      shape.str(item, 'order_id', {}, path);
      shape.str(item, 'platform', { enum: UNION_PLATFORMS }, path);
      shape.str(item, 'display_status', { enum: ORDER_DISPLAY_STATUSES }, path);
      shape.int(item, 'pay_amount_fen', { nullable: true }, path);
      shape.int(item, 'est_rebate_fen', { nullable: true }, path);
      shape.bool(item, 'is_other_product', {}, path);
      if (!('order_no' in item))
        shape.error(`${path}order_no missing (scope=self gives the full number)`);
    });
    shape.str(data, 'next_cursor', { nullable: true });
    shape.str(data, 'earliest_visible_date', { nullable: true });
    shape.done();
    if (items.length === 0) throw new Yellow('测试会员没有订单（staging 种子订单缺失）');
    return items[0] as Record<string, unknown>;
  });
  await c.step('订单详情（列表第一条）', async () => {
    const id = String(first.order_id);
    const data = okData(
      await ctx.member.request('GET', `/v1/orders/${encodeURIComponent(id)}`, {
        label: 'GET /v1/orders/{order_id}',
        auth: true,
      }),
      'order detail',
    );
    const shape = new Shape('order detail');
    if (shape.str(data, 'order_id') !== id) shape.error('order_id differs from the list item');
    if (
      shape.str(data, 'display_status', { enum: ORDER_DISPLAY_STATUSES }) !== first.display_status
    ) {
      shape.error('display_status differs from the list item');
    }
    shape.arr(data, 'reason_action');
    shape.objects(shape.arr(data, 'timeline'), 'timeline');
    shape.str(data, 'expected_credit_period', { nullable: true });
    shape.bool(data, 'credit_overdue');
    shape.int(data, 'actual_fen', { nullable: true });
    shape.int(data, 'clawback_fen', { nullable: true });
    shape.bool(data, 'appeal_pending');
    shape.done();
  });
}

/** Case 5: wallet summary, ledger, withdraw rules and records (read only, cross-checked). */
export async function case5(c: CaseContext, ctx: SmokeContext): Promise<void> {
  const summary = await c.step('钱包汇总', async () => {
    const data = okData(
      await ctx.member.request('GET', '/v1/wallet/summary', {
        label: 'GET /v1/wallet/summary',
        auth: true,
      }),
      'wallet summary',
    );
    return checkWalletSummary(data);
  });
  await c.step('余额流水', async () => {
    const data = okData(
      await ctx.member.request('GET', '/v1/wallet/ledger?limit=20', {
        label: 'GET /v1/wallet/ledger',
        auth: true,
      }),
      'wallet ledger',
    );
    checkLedger(data);
  });
  await c.step('提现规则与汇总一致', async () => {
    const rules = okData(
      await ctx.member.request('GET', '/v1/withdrawals/rules', {
        label: 'GET /v1/withdrawals/rules',
        auth: true,
      }),
      'withdraw rules',
    );
    const checked = checkRules(rules);
    if (checked.withdrawable !== summary.withdrawable) {
      throw new Fail('withdraw rules: withdrawable_fen differs from the wallet summary');
    }
  });
  await c.step('提现记录列表', async () => {
    const data = okData(
      await ctx.member.request('GET', '/v1/withdrawals?limit=20', {
        label: 'GET /v1/withdrawals',
        auth: true,
      }),
      'withdrawal list',
    );
    const shape = new Shape('withdrawal list');
    shape.objects(shape.arr(data, 'items'), 'items').forEach((w, i) => {
      checkWithdrawal(shape, w, `items[${String(i)}].`, false);
    });
    shape.str(data, 'next_cursor', { nullable: true });
    shape.done();
  });
}

export interface WalletSummary {
  readonly available: bigint;
  readonly withdrawable: bigint;
  readonly frozen: bigint;
  readonly withdrawn: bigint;
}

export function checkWalletSummary(data: Record<string, unknown>): WalletSummary {
  const shape = new Shape('wallet summary');
  const available = shape.int(data, 'available_fen');
  const withdrawable = shape.int(data, 'withdrawable_fen');
  shape.int(data, 'negative_fen');
  const frozen = shape.int(data, 'frozen_fen', { min: 0 });
  for (const key of [
    'estimated_total_fen',
    'estimated_fen',
    'pending_credit_fen',
    'pending_credit_paused_fen',
  ]) {
    shape.int(data, key);
  }
  shape.str(data, 'next_credit_period', { nullable: true });
  shape.bool(data, 'credit_overdue');
  const withdrawn = shape.int(data, 'withdrawn_fen', { min: 0 });
  shape.str(data, 'risk_paused_reason', { nullable: true });
  shape.bool(data, 'withdraw_enabled');
  shape.done();
  return {
    available: available ?? 0n,
    withdrawable: withdrawable ?? 0n,
    frozen: frozen ?? 0n,
    withdrawn: withdrawn ?? 0n,
  };
}

export function checkLedger(data: Record<string, unknown>): Record<string, unknown>[] {
  const shape = new Shape('wallet ledger');
  const items = shape.objects(shape.arr(data, 'items', { max: 50 }), 'items');
  items.forEach((item, i) => {
    const path = `items[${String(i)}].`;
    const paid = item.ledger_type === 'WITHDRAW_PAID';
    if (!paid) shape.str(item, 'ledger_type', { enum: LEDGER_TYPES }, path);
    shape.str(item, 'sub_type', { nullable: true }, path);
    shape.int(item, 'amount_fen', {}, path);
    shape.str(item, 'accounting_date', {}, path);
    shape.str(item, 'link_type', { nullable: true, enum: ['order', 'withdrawal'] }, path);
    shape.str(item, 'link_id', { nullable: true }, path);
    shape.bool(item, 'masked', {}, path);
    if (paid) {
      if (item.balance_after_fen !== null)
        shape.error(`${path}balance_after_fen of WITHDRAW_PAID is not null`);
      shape.int(item, 'fee_fen', {}, path);
      shape.int(item, 'tax_fen', {}, path);
    } else {
      shape.int(item, 'balance_after_fen', {}, path);
    }
  });
  shape.str(data, 'next_cursor', { nullable: true });
  shape.done();
  return items;
}

export interface Rules {
  readonly canWithdraw: boolean;
  readonly blockCode: bigint | null;
  readonly blockReason: string | null;
  readonly maxWithdrawable: bigint;
  readonly withdrawable: bigint;
  readonly dailyRemaining: bigint;
  readonly monthlyRemaining: bigint;
}

export function checkRules(data: Record<string, unknown>): Rules {
  const shape = new Shape('withdraw rules');
  const canWithdraw = shape.bool(data, 'can_withdraw');
  const blockCode = shape.int(data, 'block_code', { nullable: true });
  const blockReason = shape.str(data, 'block_reason', { nullable: true });
  const maxWithdrawable = shape.int(data, 'max_withdrawable_fen');
  const withdrawable = shape.int(data, 'withdrawable_fen');
  const dailyRemaining = shape.int(data, 'daily_remaining', { min: 0 });
  const monthlyRemaining = shape.int(data, 'monthly_remaining', { min: 0 });
  for (const key of ['est_fee_fen', 'est_tax_fen', 'est_net_fen'])
    shape.int(data, key, { nullable: true });
  shape.arr(data, 'quick_amounts_fen');
  shape.done();
  return {
    canWithdraw: canWithdraw === true,
    blockCode,
    blockReason,
    maxWithdrawable: maxWithdrawable ?? 0n,
    withdrawable: withdrawable ?? 0n,
    dailyRemaining: dailyRemaining ?? 0n,
    monthlyRemaining: monthlyRemaining ?? 0n,
  };
}

interface PayoutAccountView {
  readonly id: string;
  readonly method: string;
  readonly masked: string;
  readonly changeRemaining: bigint;
}

function checkPayoutAccount(
  data: Record<string, unknown>,
  where: string,
): PayoutAccountView | null {
  if (Object.keys(data).length === 0) return null;
  const shape = new Shape(where);
  const id = shape.str(data, 'payout_account_id');
  const method = shape.str(data, 'payout_method', { enum: ['alipay', 'bank_card'] });
  const masked = shape.str(data, 'masked_account');
  shape.str(data, 'masked_payee_name');
  if (method === 'bank_card') shape.str(data, 'bank_name');
  const changeRemaining = shape.int(data, 'change_remaining_this_month', { min: 0 });
  shape.done();
  return {
    id: id ?? '',
    method: method ?? '',
    masked: masked ?? '',
    changeRemaining: changeRemaining ?? 0n,
  };
}

/**
 * Case 6: payout account change with an SMS step-up bound to the account summary. The same
 * account that is bound now is saved again: BR-WDR-02 ④ counts a change only when the new account
 * differs from the current one, so a daily run never uses up the monthly change limit (default 2).
 */
export async function case6(c: CaseContext, ctx: SmokeContext): Promise<void> {
  const { member, config } = ctx;
  const before = await c.step('读取当前收款账号', async () => {
    const data = okData(
      await member.request('GET', '/v1/me/payout-account', {
        label: 'GET /v1/me/payout-account',
        auth: true,
      }),
      'payout account',
    );
    const view = checkPayoutAccount(data, 'payout account');
    if (view === null)
      throw new Yellow('测试会员还没有绑定收款账号（先由负责人或编排绑一次支付宝）');
    return view;
  });
  const account = config.payoutAccount;
  if (account === null) {
    await c.step('改收款账号', async () => {
      throw new Skipped('member.json 没有 payout_account，只读不改');
    });
    return;
  }
  if (before.method !== 'alipay') {
    await c.step('改收款账号', async () => {
      throw new Yellow('当前绑定的不是支付宝：为免计入每月变更次数，不保存');
    });
    return;
  }
  const token = await c.step('二次验证（payout_account_change，带账号摘要）', async () =>
    member.stepUp('payout_account_change', config.smsCode, {
      payout_method: 'alipay',
      alipay_logon_id: account.alipayLogonId,
    }),
  );
  await c.step('保存收款账号（与当前相同，不计变更次数）', async () => {
    const result = await member.request('PUT', '/v1/me/payout-account', {
      label: 'PUT /v1/me/payout-account',
      signed: true,
      auth: true,
      idempotencyKey: newIdempotencyKey(),
      stepUpToken: token,
      body: {
        payout_method: 'alipay',
        alipay_logon_id: account.alipayLogonId,
        payee_name: account.payeeName,
      },
    });
    if (result.code === 30303) {
      throw new Fail(
        'save payout account: 30303 (change limit reached: member.json account differs from the bound one?)',
      );
    }
    const saved = checkPayoutAccount(okData(result, 'save payout account'), 'save payout account');
    if (saved === null) throw new Fail('save payout account: empty answer');
    if (saved.method !== 'alipay' || saved.masked !== before.masked) {
      throw new Fail('save payout account: the saved account is not the one bound before');
    }
    if (saved.changeRemaining !== before.changeRemaining) {
      throw new Fail(
        'save payout account: change_remaining_this_month moved (counted as a change)',
      );
    }
  });
  await c.step('复读收款账号', async () => {
    const data = okData(
      await member.request('GET', '/v1/me/payout-account', {
        label: 'GET /v1/me/payout-account',
        auth: true,
      }),
      'payout account',
    );
    const after = checkPayoutAccount(data, 'payout account');
    if (
      after === null ||
      after.masked !== before.masked ||
      after.changeRemaining !== before.changeRemaining
    ) {
      throw new Fail('payout account after save: differs from the account before');
    }
  });
}

/** Case 8: event upload and the update check, with a 10405 probe below the minimum version. */
export async function case8(c: CaseContext, ctx: SmokeContext): Promise<void> {
  const { member } = ctx;
  await c.step('事件上报 /v1/events（1 条 app_launch）', async () => {
    const event = {
      event_id: randomUUID(),
      name: 'app_launch',
      client_at: new Date().toISOString(),
      session_id: randomUUID(),
      device_id: member.deviceId,
      platform: 'android',
      app_version: member.appVersion,
      channel: 'official',
      page: 'staging_smoke',
    };
    const data = okData(
      await member.request('POST', '/v1/events', {
        label: 'POST /v1/events',
        auth: ctx.loggedIn,
        body: { events: [event] },
      }),
      'events',
    );
    const shape = new Shape('events');
    const dropped = shape.int(data, 'dropped_count', { min: 0 });
    shape.done();
    if (dropped !== 0n) throw new Fail('events: the conforming app_launch event was dropped');
  });
  await c.step('强更检查：契约形状', async () => {
    const data = okData(
      await member.request('GET', '/v1/app-versions/check', {
        label: 'GET /v1/app-versions/check',
      }),
      'app version check',
    );
    const shape = new Shape('app version check');
    for (const key of ['latest_version']) {
      const value = shape.str(data, key);
      if (value !== null && !SEMVER.test(value)) shape.error(`${key} not x.y.z`);
    }
    for (const key of ['min_supported_version', 'recommended_version']) {
      const value = shape.str(data, key, { nullable: true });
      if (value !== null && !SEMVER.test(value)) shape.error(`${key} not x.y.z`);
    }
    shape.str(data, 'update_title');
    shape.str(data, 'update_notes');
    shape.str(data, 'store_url');
    shape.str(data, 'default_store');
    const stores = shape.objects(shape.arr(data, 'stores'), 'stores');
    if (stores.length === 0) shape.error('stores is empty');
    stores.forEach((store, i) => {
      shape.str(store, 'store', {}, `stores[${String(i)}].`);
      shape.str(store, 'listed_version', { nullable: true }, `stores[${String(i)}].`);
    });
    shape.done();
  });
  await c.step('强更拦截：低于最低版本的写接口回 10405', async (s) => {
    const min = ctx.minSupportedVersion;
    if (min === null || compareSemver(min, '0.0.0') <= 0) {
      s.notChecked('staging 没有设最低支持版本，未探测 10405');
      return;
    }
    const result = await member.request('POST', '/v1/events', {
      label: 'POST /v1/events (X-App-Version 0.0.0)',
      appVersion: '0.0.0',
      body: { events: [] },
    });
    if (result.status !== 403 || result.code !== 10405) {
      throw new Fail(
        `version gate: HTTP ${String(result.status)}, code ${String(result.code ?? 'none')}, not 403 / 10405`,
      );
    }
    const data = result.data as Record<string, unknown> | null;
    if (data?.min_supported_version !== min) {
      throw new Fail('version gate: data.min_supported_version differs from the update check');
    }
  });
}

/** Closing: member logout; the old access token must be refused afterwards. */
export async function caseLogout(c: CaseContext, ctx: SmokeContext): Promise<void> {
  await c.step('会员退出登录', async () => {
    okData(
      await ctx.member.request('POST', '/v1/auth/logout', {
        label: 'POST /v1/auth/logout',
        auth: true,
      }),
      'logout',
    );
    ctx.loggedIn = false;
    const result = await ctx.member.request('GET', '/v1/wallet/summary', {
      label: 'GET /v1/wallet/summary (after logout)',
      auth: true,
      noRefresh: true,
    });
    ctx.member.tokens = null;
    if (result.status !== 401) {
      throw new Fail(
        `after logout: the old access token answered HTTP ${String(result.status)}, not 401`,
      );
    }
  });
}
