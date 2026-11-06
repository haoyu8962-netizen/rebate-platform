// B2-05c: GET /v1/withdrawals/rules (getWithdrawRules; 规划/04 §6.4; 08 BR-WDR-03 细则「rules 接口」,
// BR-WDR-04 细则「提现页的金额输入」). x-auth login, unsigned, not idempotent, no version gate: the
// request checks have judged the token (h5_token is refused before the handler, H5_EXCLUDED_PREFIXES)
// and contractRouteSchema the query (amount_fen a positive integer or 20001 data.fields). The
// subject is the token principal only (app_id, uid, device_id; BR-AI-03), never a header or a
// query value. The handler calls the rules use case on the process handle and returns the
// contract envelope; a blocked withdrawal is a successful response (code 0) with can_withdraw
// false, never an error envelope.
//
// B2-05d: POST /v1/withdrawals (createWithdrawal; 规划/04 §6.4; 08 BR-WDR-01, BR-WDR-03, BR-WDR-07).
// x-auth realname, signed, idempotent, x-step-up withdraw, version gate. Before the handler the
// request checks judged the signature, the token (h5_token 10403), the version gate, the risk
// state (10006) and the real name (30304); the claim of idempotency.executeInTransaction answers
// a replay, 20001 (missing key), 20901, 20903 and 40901 itself and judges the step-up token on
// the post-miss path (identity's stage ⑫, 10003). The handler runs the application use case on
// the claim's transaction: code 0 and 3xxxx are stored with the key (BR-WDR-07 ⑧), everything
// else rolls back and leaves the key reusable; withStepUp consumes the step-up token on code 0
// and releases it otherwise (BR-WDR-01). `msg` is the package default text
// (contracts/texts.default.json) and `data` only what the result carries.
// B2-05q (BR-ID-36 细则「被拦截请求申诉」): a 44001 the handler produced in this call has its hit
// recorded after executeInTransaction (and the step-up wrapper) returned — the application's
// transaction has rolled back and released its connection — and before the answer is written; an
// answer of the idempotency layer (source other than 'handler') records nothing. A failed record
// throws (5xx, as identity's bind-phone): the refusal stays, nothing was created or stored.
//
// B2-05f: GET /v1/withdrawals (listWithdrawals) and GET /v1/withdrawals/{withdrawal_id}
// (getWithdrawal): x-auth login, unsigned, not idempotent. The subject is the token principal;
// the query (cursor, limit) is already judged by contractRouteSchema; the records come from the
// same projection the read-only entry read.ts uses, through the process's snapshot decryption
// (WITHDRAW_READS). Someone else's, another app's or an unknown id → 404 / 30701, never a
// different answer per case.
//
// Nest's decorators are applied as plain calls (erasable syntax, as the orders module does).
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { fenToJsonNumber } from '@couli/money';
import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Optional,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Kysely } from 'kysely';
import {
  IDEMPOTENCY,
  CLOCK,
  ROOT_LOGGER,
  contractRouteSchema,
  fieldsErrorEnvelope,
  tokenPrincipal,
  type CheckedRequest,
  type Clock,
  type RootLogger,
  type HandlerResult,
  type Idempotency,
  type IdempotentResponse,
  type TokenPrincipal,
} from '../../../platform/index.ts';
import {
  isWithdrawAccepted,
  type WithdrawApplyResult,
  type WithdrawApplyService,
} from '../../application/withdraw-apply.ts';
import type { WithdrawActor, WithdrawRulesService } from '../../application/withdraw-rules.ts';
import {
  listWithdrawalsForUser,
  readWithdrawalForUser,
  WithdrawalReadError,
  type DecryptWithdrawalAccount,
} from '../../application/withdrawal-reads.ts';
import {
  WITHDRAW_APPLY,
  WITHDRAW_READS,
  WITHDRAW_RULES,
  WITHDRAW_RULES_HANDLE,
  WITHDRAW_STEP_UP,
} from '../../tokens.ts';

const WITHDRAWALS_PATH = '/v1/withdrawals';

/** What the handler reads of the Fastify request, already checked by the request checks. */
export interface WithdrawRulesHttpRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly query?: { readonly amount_fen?: number | string };
  /** Attached by the token check (platform PrincipalCarrier); read with tokenPrincipal. */
  readonly principal?: TokenPrincipal;
}

export interface WithdrawalListHttpRequest {
  readonly id: string;
  readonly query?: { readonly cursor?: string; readonly limit?: number | string };
  readonly principal?: TokenPrincipal;
}

export interface CreateWithdrawalHttpRequest extends CheckedRequest {
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Schema<'CreateWithdrawalRequest'>;
}

/**
 * Identity's withStepUp (stage ⑫ context + settlement of the step-up reservation), handed in by
 * app.module: the controller never imports identity's barrel, which carries Nest controllers the
 * `test` project (erasable syntax only) must not compile.
 */
export type WithdrawStepUp = (
  request: CreateWithdrawalHttpRequest,
  execute: () => Promise<IdempotentResponse>,
) => Promise<IdempotentResponse>;

/** HTTP status and package default text of the chain's codes (contracts/error-codes.yaml, texts.default.json). */
const APPLY_ERRORS: Readonly<Record<number, { readonly status: number; readonly msg: string }>> =
  Object.freeze({
    10003: { status: 403, msg: '为保障资金安全，请先完成短信验证' },
    10004: { status: 403, msg: '请先阅读并同意相关授权' },
    10006: { status: 403, msg: '账号已被限制使用' },
    10010: { status: 403, msg: '需要先核实是你本人' },
    30301: { status: 422, msg: '可提现余额不足' },
    30302: { status: 422, msg: '账户有待抵扣金额，抵扣完成前暂不能提现' },
    30303: { status: 422, msg: '暂不满足提现条件' },
    30304: { status: 422, msg: '请先完成实名认证' },
    30305: { status: 422, msg: '请先绑定收款账号' },
    30306: { status: 422, msg: '提现功能暂时关闭，请稍后再试' },
    30307: { status: 422, msg: '收款账号姓名与实名姓名不一致，请修改收款账号' },
    30309: { status: 422, msg: '未成年人提现受限' },
    44001: { status: 403, msg: '操作未通过安全校验' },
  });

/** error.30303.<reason> texts of contracts/texts.default.json. */
const REASON_TEXTS: Readonly<Record<string, string>> = Object.freeze({
  account_frozen: '提现已暂停，如有疑问请联系客服',
  below_min: '单笔最低提现金额不足',
  not_multiple: '提现金额需为规定的整数倍',
  above_max: '超过单笔最高提现金额',
  above_method_max: '超过当前收款方式的单笔上限',
  net_too_small: '扣除税费后实际到账金额过低，请提高提现金额',
  daily_count: '今日提现次数已用完，请明天再试',
  monthly_count: '本月提现次数已用完',
  payee_daily_count: '该收款账号今日暂不能再收款，请明天再试',
  payee_daily_users: '该收款账号今日暂不能再收款，请明天再试',
  self_purchase_required: '需有近期已确认收货的自购订单才能提现',
});

/** The contract envelope of a use case result; bigint data (remaining_fen) becomes a JSON number. */
function applyResult(result: WithdrawApplyResult, traceId: string): HandlerResult {
  if (isWithdrawAccepted(result)) {
    const envelope: Schema<'WithdrawalResponse'> = {
      code: 0,
      msg: '',
      data: result.data,
      trace_id: traceId,
    };
    return { status: 200, envelope };
  }
  const known = APPLY_ERRORS[result.code];
  // A port's own code (③b re-verification, identity's contract) carries its data through.
  const status = known?.status ?? (result.code >= 30000 && result.code < 40000 ? 422 : 403);
  const reason = result.data['reason'];
  const msg =
    (typeof reason === 'string' ? REASON_TEXTS[reason] : undefined) ?? known?.msg ?? '请求未通过';
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result.data)) {
    data[key] = typeof value === 'bigint' ? fenToJsonNumber(value) : value;
  }
  return {
    status,
    envelope: {
      code: result.code,
      msg,
      ...(Object.keys(data).length === 0 ? {} : { data }),
      trace_id: traceId,
    },
  };
}

export class WithdrawalsController {
  readonly #service: WithdrawRulesService | null;
  readonly #handle: Kysely<DB> | null;
  readonly #apply: WithdrawApplyService | null;
  readonly #idempotency: Idempotency | undefined;
  readonly #stepUp: WithdrawStepUp | null;
  readonly #reads: DecryptWithdrawalAccount | null;
  readonly #clock: Clock | null;
  readonly #logger: RootLogger | null;

  constructor(
    service: WithdrawRulesService | null,
    handle: Kysely<DB> | null,
    apply: WithdrawApplyService | null,
    idempotency?: Idempotency,
    stepUp?: WithdrawStepUp | null,
    reads?: DecryptWithdrawalAccount | null,
    clock?: Clock | null,
    logger?: RootLogger | null,
  ) {
    this.#service = service;
    this.#handle = handle;
    this.#apply = apply;
    this.#idempotency = idempotency;
    this.#stepUp = stepUp ?? null;
    this.#reads = reads ?? null;
    this.#clock = clock ?? null;
    this.#logger = logger ?? null;
  }

  async listWithdrawals(
    request: WithdrawalListHttpRequest,
  ): Promise<Schema<'WithdrawalListResponse'>> {
    const actor = this.#actor(request);
    const handle = this.#readsHandle();
    const query = request.query ?? {};
    const rawLimit = query.limit;
    try {
      const data = await listWithdrawalsForUser(
        handle,
        {
          appId: actor.appId,
          userId: actor.userId,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(rawLimit === undefined ? {} : { limit: Number(rawLimit) }),
        },
        this.#projectionContext(),
      );
      return { code: 0, msg: '', data, trace_id: request.id };
    } catch (error) {
      if (error instanceof WithdrawalReadError) {
        const refused = fieldsErrorEnvelope(error.fields, request.id);
        throw new HttpException(refused.body, refused.statusCode);
      }
      throw error;
    }
  }

  async getWithdrawal(
    request: WithdrawalListHttpRequest,
    withdrawalId: string,
  ): Promise<Schema<'WithdrawalResponse'>> {
    const actor = this.#actor(request);
    const handle = this.#readsHandle();
    const data = await readWithdrawalForUser(
      handle,
      { appId: actor.appId, userId: actor.userId, withdrawalId },
      this.#projectionContext(),
    );
    if (data === null) {
      throw new HttpException(
        { code: 30701, msg: '内容不存在或已下线', trace_id: request.id },
        404,
      );
    }
    return { code: 0, msg: '', data, trace_id: request.id };
  }

  /** The records need the process handle and the registered snapshot decryption. */
  #readsHandle(): Kysely<DB> {
    const handle = this.#handle;
    if (handle === null || this.#reads === null) {
      throw new Error('payout: the withdrawal records need the database and the field cipher');
    }
    return handle;
  }

  /**
   * Takes only @Req() and answers the stored envelope: HTTP 200 as the return value, anything
   * else thrown as HttpException for the global filter to write back unchanged (the deletion
   * controller's convention, which identity's step-up fixtures rely on to swap the handler).
   */
  async createWithdrawal(
    request: CreateWithdrawalHttpRequest,
  ): Promise<Schema<'WithdrawalResponse'>> {
    const actor = this.#actor(request);
    const apply = this.#apply;
    const idempotency = this.#idempotency;
    const stepUp = this.#stepUp;
    if (apply === null || idempotency === undefined || stepUp === null) {
      throw new Error(
        'payout: the withdrawal application needs the database, idempotency and the step-up wrapper',
      );
    }
    const header = request.headers['idempotency-key'];
    const key = typeof header === 'string' ? header : undefined;
    const body = request.body;
    // The hit record of this call's own 44001 (B2-05q); set by the handler only.
    const blocked: { record: (() => Promise<void>) | null } = { record: null };
    const response = await stepUp(request, () =>
      idempotency.executeInTransaction(
        {
          appId: actor.appId,
          actor: { userId: actor.userId, deviceId: actor.deviceId, phoneHmac: null },
          method: 'POST',
          path: WITHDRAWALS_PATH,
          key,
          body,
          traceId: request.id,
        },
        async (trx) => {
          // The claim answered 20001 before the handler when the key is missing.
          if (key === undefined) throw new Error('payout: withdrawal application without a key');
          // Stage ⑫ judged the step-up token on the post-miss path: the chain's ② holds here.
          const result = await apply.apply(trx, {
            ...actor,
            amountFen: BigInt(body.amount_fen),
            stepUpValid: true,
          });
          blocked.record = isWithdrawAccepted(result) ? null : (result.recordBlocked ?? null);
          return applyResult(result, request.id);
        },
      ),
    );
    if (blocked.record !== null && response.source === 'handler') await blocked.record();
    const envelope = JSON.parse(response.body) as unknown;
    if (response.status === 200) return envelope as Schema<'WithdrawalResponse'>;
    throw new HttpException(envelope as Record<string, unknown>, response.status);
  }

  async getWithdrawRules(
    request: WithdrawRulesHttpRequest,
  ): Promise<Schema<'WithdrawRulesResponse'>> {
    const actor = this.#actor(request);
    const service = this.#service;
    const handle = this.#handle;
    if (service === null || handle === null) {
      throw new Error('payout: the withdrawal rules need the database');
    }
    const raw = request.query?.amount_fen;
    const amount = raw === undefined ? undefined : BigInt(raw);
    const data = await service.getRules(handle, actor, amount);
    return { code: 0, msg: '', data, trace_id: request.id };
  }

  /** CT-20b: the response instant for the BR-WDR-25 branches; no Clock registered → row time. */
  #projectionContext(): {
    readonly now?: Date;
    readonly logger?: { warn(fields: Record<string, unknown>, message: string): void };
  } {
    return {
      ...(this.#clock === null ? {} : { now: this.#clock.now() }),
      ...(this.#logger === null ? {} : { logger: this.#logger.child({ module: 'payout' }) }),
    };
  }

  #actor(request: { readonly id: string; readonly principal?: TokenPrincipal }): WithdrawActor {
    const principal = tokenPrincipal(request);
    if (principal === undefined) {
      throw new HttpException({ code: 10001, msg: '未登录', trace_id: request.id }, 401);
    }
    return { appId: principal.app_id, userId: principal.uid, deviceId: principal.device_id };
  }
}

{
  const prototype = WithdrawalsController.prototype;
  const rules = Object.getOwnPropertyDescriptor(prototype, 'getWithdrawRules')!;
  const create = Object.getOwnPropertyDescriptor(prototype, 'createWithdrawal')!;
  Inject(WITHDRAW_RULES)(WithdrawalsController, undefined, 0);
  Optional()(WithdrawalsController, undefined, 1);
  Inject(WITHDRAW_RULES_HANDLE)(WithdrawalsController, undefined, 1);
  Inject(WITHDRAW_APPLY)(WithdrawalsController, undefined, 2);
  Optional()(WithdrawalsController, undefined, 3);
  Inject(IDEMPOTENCY)(WithdrawalsController, undefined, 3);
  Optional()(WithdrawalsController, undefined, 4);
  Inject(WITHDRAW_STEP_UP)(WithdrawalsController, undefined, 4);
  Optional()(WithdrawalsController, undefined, 5);
  Inject(WITHDRAW_READS)(WithdrawalsController, undefined, 5);
  Optional()(WithdrawalsController, undefined, 6);
  Inject(CLOCK)(WithdrawalsController, undefined, 6);
  Optional()(WithdrawalsController, undefined, 7);
  Inject(ROOT_LOGGER)(WithdrawalsController, undefined, 7);
  const list = Object.getOwnPropertyDescriptor(prototype, 'listWithdrawals')!;
  const detail = Object.getOwnPropertyDescriptor(prototype, 'getWithdrawal')!;
  Req()(prototype, 'listWithdrawals', 0);
  Get()(prototype, 'listWithdrawals', list);
  RouteSchema(contractRouteSchema('listWithdrawals'))(prototype, 'listWithdrawals', list);
  Req()(prototype, 'getWithdrawal', 0);
  Param('withdrawal_id')(prototype, 'getWithdrawal', 1);
  Get(':withdrawal_id')(prototype, 'getWithdrawal', detail);
  RouteSchema(contractRouteSchema('getWithdrawal'))(prototype, 'getWithdrawal', detail);
  Req()(prototype, 'getWithdrawRules', 0);
  Get('rules')(prototype, 'getWithdrawRules', rules);
  RouteSchema(contractRouteSchema('getWithdrawRules'))(prototype, 'getWithdrawRules', rules);
  Req()(prototype, 'createWithdrawal', 0);
  Post()(prototype, 'createWithdrawal', create);
  HttpCode(200)(prototype, 'createWithdrawal', create);
  RouteSchema(contractRouteSchema('createWithdrawal'))(prototype, 'createWithdrawal', create);
  Controller('v1/withdrawals')(WithdrawalsController);
}
