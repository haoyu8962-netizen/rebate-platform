// GET / PUT /v1/me/payout-account (getPayoutAccount, savePayoutAccount; 规划/04 §6.1; 08 BR-WDR-01,
// BR-WDR-02, BR-ID-33; tasks B1-13e, B1-13f).
// GET — contract x-auth realname, not signed, not idempotent. Before the handler, guard stage ⑨
// answers 30304 to a member without a verified real name (B1-02za), and the token check refuses an
// h5_token with 10403 (H5_EXCLUDED_PREFIXES). The handler returns only the masked projection of
// application/payout-account.ts ({} when nothing is bound).
// PUT — x-auth realname, signed, idempotent, x-step-up payout_account_change, version gate. The
// handler is withStepUp(request, () => idempotency.executeInTransaction(…, keyedRequestDigest: true
// — the body carries a card number or logon id —, business)): the claim answers a replay, 20901,
// 20903, 40901 and a bad key itself; its post-miss checks judge ④a, ⑨ (30304, stored) and ⑫ (the
// step-up token, reserved in Redis) before the business; withStepUp consumes the token on HTTP 2xx
// with code 0 and releases it on every other outcome (BR-WDR-01: 3xxxx, 50401, 50301 keep it
// usable). The business: alipay → B1-13e's save in the claim's transaction; bank_card → the
// verification flow of application/payout-bank-card.ts. 0 and 3xxxx are stored with the key;
// everything else rolls back and leaves the key reusable (idempotency module rule).
// `msg` is the package default text of contracts/texts.default.json without placeholders; `data`
// carries only what the result defines (fields, reason, risk_msg_code), never a submitted value.
import { Controller, Get, Inject, Optional, Put, Req, Res } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import {
  IDEMPOTENCY,
  contractRouteSchema,
  tokenPrincipal,
  type CheckedRequest,
  type HandlerResult,
  type Idempotency,
} from '../../../platform/index.ts';
import type { PayoutAccountReader, SaveAlipayResult } from '../../application/payout-account.ts';
import type {
  BankCardSubmitResult,
  PayoutAccountChange,
} from '../../application/payout-bank-card.ts';
import type { ReverifyRefusal } from '../../application/reverify-gate.ts';
import { withStepUp } from '../../application/step-up-verify.ts';
import { PAYOUT_ACCOUNT_CHANGE, PAYOUT_ACCOUNT_READER } from '../../application/tokens.ts';
import { identityFailure } from './error-envelopes.ts';

const PATH = '/v1/me/payout-account';

interface SavePayoutAccountHttpRequest extends CheckedRequest {
  readonly id: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Schema<'SavePayoutAccountRequest'>;
}

interface RawReply {
  code(status: number): RawReply;
  type(contentType: string): RawReply;
  send(body: string): unknown;
}

type ChangeResult = SaveAlipayResult | BankCardSubmitResult | ReverifyRefusal;

const ERRORS: Readonly<Record<number, { readonly status: number; readonly msg: string }>> =
  Object.freeze({
    10010: { status: 403, msg: '需要先核实是你本人' },
    20001: { status: 400, msg: '填写内容有误，请检查' },
    // The key's verification record is of another card: the idempotency module's own 20901
    // (status, msg, no data), since the claim found no stored result to compare the body with.
    20901: { status: 409, msg: 'Idempotency-Key was used with a different request body' },
    30303: { status: 422, msg: '暂不满足提现条件' },
    30304: { status: 422, msg: '请先完成实名认证' },
    30307: { status: 422, msg: '收款账号姓名与实名姓名不一致，请修改收款账号' },
    30308: { status: 422, msg: '该收款账号已被其他实名用户绑定，请更换账号' },
    40901: { status: 409, msg: '正在处理，请稍候' },
    44001: { status: 403, msg: '操作未通过安全校验' },
    50301: { status: 503, msg: '服务暂不可用，请稍后再试' },
    // Outcome unknown (vendor timeout or no answer): the text realname uses for the same case.
    50401: { status: 504, msg: '网络不稳定，请重试' },
  });

/** error.<code>.<reason> texts of contracts/texts.default.json. */
const REASON_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  phone_invalid: '请输入 11 位中国大陆手机号',
  payout_account_change_limit: '本月收款账号变更次数已用完，下月可再变更',
  payout_account_verify_limit: '今日收款账号核验次数已用完，请明天再试',
});

function handlerResult(result: ChangeResult, traceId: string): HandlerResult {
  if (result.code === 0) {
    const envelope: Schema<'PayoutAccountResponse'> = {
      code: 0,
      msg: '',
      data: result.data,
      trace_id: traceId,
    };
    return { status: 200, envelope };
  }
  const error = ERRORS[result.code];
  if (error === undefined) throw new Error('identity: unmapped payout account answer');
  const data: Readonly<Record<string, unknown>> | undefined =
    'data' in result ? (result.data as Readonly<Record<string, unknown>>) : undefined;
  const reason = data?.['reason'];
  const msg = (typeof reason === 'string' ? REASON_MESSAGES[reason] : undefined) ?? error.msg;
  return {
    status: error.status,
    envelope: {
      code: result.code,
      msg,
      ...(data === undefined ? {} : { data }),
      trace_id: traceId,
    },
  };
}

@Controller('v1')
export class PayoutAccountController {
  constructor(
    @Inject(PAYOUT_ACCOUNT_READER) private readonly reader: PayoutAccountReader | null,
    @Inject(PAYOUT_ACCOUNT_CHANGE) private readonly change: PayoutAccountChange | null,
    @Optional() @Inject(IDEMPOTENCY) private readonly idempotency?: Idempotency,
  ) {}

  @Get('me/payout-account')
  @RouteSchema(contractRouteSchema('getPayoutAccount'))
  async getPayoutAccount(
    @Req() request: CheckedRequest & { readonly id: string },
  ): Promise<Schema<'PayoutAccountResponse'>> {
    const principal = tokenPrincipal(request);
    if (principal === undefined) throw identityFailure({ code: 10001 }, request.id);
    if (this.reader === null) {
      throw new Error('identity: payout account needs the database and the field cipher');
    }
    const data = await this.reader.read({ appId: principal.app_id, userId: principal.uid });
    return { code: 0, msg: '', data, trace_id: request.id };
  }

  @Put('me/payout-account')
  @RouteSchema(contractRouteSchema('savePayoutAccount'))
  async savePayoutAccount(
    @Req() request: SavePayoutAccountHttpRequest,
    @Res() reply: RawReply,
  ): Promise<void> {
    const principal = tokenPrincipal(request);
    if (principal === undefined) throw identityFailure({ code: 10001 }, request.id);
    const change = this.change;
    const idempotency = this.idempotency;
    if (change === null || idempotency === undefined) {
      throw new Error(
        'identity: payout account change needs the database, field cipher, blocklist and idempotency',
      );
    }
    const header = request.headers['idempotency-key'];
    const key = typeof header === 'string' ? header : undefined;
    const body = request.body;
    const subject = {
      appId: principal.app_id,
      userId: principal.uid,
      deviceId: principal.device_id,
    };
    const response = await withStepUp(request, () =>
      idempotency.executeInTransaction(
        {
          appId: principal.app_id,
          actor: { userId: principal.uid, deviceId: principal.device_id, phoneHmac: null },
          method: 'PUT',
          path: PATH,
          key,
          body,
          traceId: request.id,
          // Card number / logon id: keyed request digest, never an unkeyed SHA-256 (BR-WDR-07).
          keyedRequestDigest: true,
        },
        async (trx) => {
          // The claim answered 20001 before the handler when the key is missing.
          if (key === undefined) throw new Error('identity: payout account change without a key');
          const result =
            body.payout_method === 'alipay'
              ? await change.saveAlipay(trx, {
                  ...subject,
                  alipayLogonId: body.alipay_logon_id,
                  payeeName: body.payee_name,
                })
              : await change.submitBankCard(trx, {
                  ...subject,
                  cardNo: body.card_no,
                  payeeName: body.payee_name,
                  idempotencyKey: key,
                });
          return handlerResult(result, request.id);
        },
      ),
    );
    reply.code(response.status).type('application/json; charset=utf-8').send(response.body);
  }
}
