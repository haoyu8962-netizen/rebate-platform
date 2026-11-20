// The error answers of the B1-02f identity endpoints (oauth-attempts, step-up, h5-token, consents):
// contracts/error-codes.yaml statuses (10001 / 10002 401, 10403 403, 20001–20004 400, 50001 500,
// 50305 503) and the ErrorEnvelope { code, msg, data?, trace_id }. `msg` is a fixed fallback text (clients show
// their dictionary text error.<code>[.<reason>], BR-TEXT-14); `data` only carries what the result
// defines (fields, reason, provider), never a submitted value.
import { HttpException } from '@nestjs/common';

/** Fallback texts: the package defaults of contracts/texts.default.json without placeholders. */
const MESSAGES: Readonly<Record<number, string>> = Object.freeze({
  10001: '未登录',
  10002: 'access_token 过期',
  10403: '请在 App 内操作',
  20001: '填写内容有误，请检查',
  20002: '验证码错误，请重新输入',
  20003: '验证码已失效，请重新获取',
  20004: '授权未完成，请重新授权',
  30414: '暂不支持自助更换手机号，请联系客服',
  30415: '本月昵称修改次数已用完，下月可再修改',
  50001: '服务端错误',
  50305: '该登录方式暂时不可用，请稍后再试或改用其他登录方式',
});
const SERVER_ERROR_MSG = '服务端错误';
const IDENTITY_MISMATCH_MSG = '请使用本账号已绑定的登录方式验证';

const STATUSES: Readonly<Record<number, number>> = Object.freeze({
  10001: 401,
  10002: 401,
  10403: 403,
  20001: 400,
  20002: 400,
  20003: 400,
  20004: 400,
  30414: 422,
  30415: 422,
  50001: 500,
  50305: 503,
});

export type IdentityFailure =
  | { readonly code: 10001 | 10002 | 10403 | 20002 | 20003 | 30414 | 30415 | 50001 }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } }
  | { readonly code: 20001; readonly data: { readonly reason: 'nickname_sensitive' } }
  | { readonly code: 20004; readonly data?: { readonly reason: 'identity_mismatch' } }
  | { readonly code: 50305; readonly data: { readonly provider: string } };

/** The HttpException the global error filter writes back unchanged. */
export function identityFailure(result: IdentityFailure, traceId: string): HttpException {
  const status = STATUSES[result.code] ?? 500;
  let msg = MESSAGES[result.code] ?? SERVER_ERROR_MSG;
  let data: Readonly<Record<string, unknown>> | undefined;
  if (result.code === 20001) {
    if ('reason' in result.data) {
      data = { reason: result.data.reason };
      msg = '昵称含不允许使用的内容，请修改';
    } else {
      data = { fields: [...result.data.fields] };
    }
  }
  if (result.code === 20004 && result.data !== undefined) {
    data = { reason: result.data.reason };
    msg = IDENTITY_MISMATCH_MSG;
  }
  if (result.code === 50305) data = { provider: result.data.provider };
  return new HttpException(
    { code: result.code, msg, ...(data === undefined ? {} : { data }), trace_id: traceId },
    status,
  );
}
