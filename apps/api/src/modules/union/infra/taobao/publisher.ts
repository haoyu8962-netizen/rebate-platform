// 淘宝渠道备案的报文口径（B1-04zzzzm，D10-2713 / D10-2716；BR-ID-17、BR-ATTR-05）：
// - taobao.tbk.sc.publisher.info.save（docs-mirror taobao/api/taobao.tbk.sc.publisher.info.save.md）：
//   session = 用户令牌、inviter_code、info_type=1；外层键 tbk_sc_publisher_info_save_response，
//   取 data.relation_id；重复备案时 data.desc 为「重复绑定渠道」，可能不带 relation_id。
// - taobao.tbk.sc.publisher.info.get（…publisher.info.get.md）：同一 session、info_type=1、
//   relation_app=common；外层键 tbk_sc_publisher_info_get_response，取 data.inviter_list 里
//   relation_app 为 common（或缺）的行的 relation_id。去重后恰好一个才算取回；多个不同编号不猜
//   （不把别人的渠道当成该用户的），按取不到处理。
// relation_id 按报文原文取（JSON 数字取源文本，不经 JS number：大数不丢精度；字符串原样：前导零
// 保留），只认 1–64 位十进制数字。account_name、taobao_user_id 等个人信息不读、不返回。
// 错误（error_response、外层键缺失）仍由 response.ts unwrapTaobaoResponse 分类；这里只取编号。
// B1-04zzzzp（D10-3196）：save 的 data.desc 带「重复」时，不论带不带 relation_id 都按重复处理
// （saveIsDuplicate）；备案调用里 sub_code 为 isp.*（isp.call-limited 除外）的网关系统错误按依赖
// 不可用处理（isGatewaySystemError），不当凭证无效。

export const TAOBAO_PUBLISHER_SAVE = 'taobao.tbk.sc.publisher.info.save';
export const TAOBAO_PUBLISHER_SAVE_ENVELOPE = 'tbk_sc_publisher_info_save_response';
export const TAOBAO_PUBLISHER_GET = 'taobao.tbk.sc.publisher.info.get';
export const TAOBAO_PUBLISHER_GET_ENVELOPE = 'tbk_sc_publisher_info_get_response';
/** The channel filing type (info_type=1: 渠道). */
export const TAOBAO_PUBLISHER_INFO_TYPE = 1;
/** The filing scene publisher.info.get is asked for. */
export const TAOBAO_PUBLISHER_RELATION_APP = 'common';

/** JSON.parse 的源文本访问（Node ≥ 21；本仓库 engines 为 Node 24）。 */
interface ReviverContext {
  readonly source?: string;
}

const RELATION_ID = /^[0-9]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The body parsed with every `relation_id` number kept as its literal text; undefined if not JSON. */
function parseLossless(body: string): unknown {
  try {
    return JSON.parse(body, (name: string, value: unknown, context?: ReviverContext) =>
      name === 'relation_id' && typeof value === 'number'
        ? typeof context?.source === 'string'
          ? context.source
          : undefined
        : value,
    );
  } catch {
    return undefined;
  }
}

/** The `data` object inside `envelope`, or undefined. */
function dataOf(body: string, envelope: string): Record<string, unknown> | undefined {
  const parsed = parseLossless(body);
  const inner = isRecord(parsed) ? parsed[envelope] : undefined;
  const data = isRecord(inner) ? inner['data'] : undefined;
  return isRecord(data) ? data : undefined;
}

function relationIdOf(value: unknown): string | null {
  return typeof value === 'string' && RELATION_ID.test(value) ? value : null;
}

/** publisher.info.save: data.relation_id as on the wire, or null (duplicate filing, absent). */
export function savedRelationId(body: string): string | null {
  return relationIdOf(dataOf(body, TAOBAO_PUBLISHER_SAVE_ENVELOPE)?.['relation_id']);
}

/** The text in data.desc of a publisher.info.save answer that marks a duplicate filing. */
const DUPLICATE_MARK = '重复';

/**
 * B1-04zzzzp (D10-3196; BR-ATTR-05): whether a publisher.info.save answer says the filing is a
 * duplicate (data.desc carries 「重复」, e.g. 「重复绑定渠道」) — with or without a relation_id. Such an
 * answer never counts as saved: whose filing the id is cannot be told from it.
 */
export function saveIsDuplicate(body: string): boolean {
  const desc = dataOf(body, TAOBAO_PUBLISHER_SAVE_ENVELOPE)?.['desc'];
  return typeof desc === 'string' && desc.includes(DUPLICATE_MARK);
}

export type QueriedRelationId =
  | { readonly kind: 'found'; readonly relationId: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous' };

/** The rows of data.inviter_list: an array, or the TOP list wrapper `{ map_data: [...] }`. */
function inviterRows(data: Record<string, unknown> | undefined): readonly unknown[] {
  const list = data?.['inviter_list'];
  if (Array.isArray(list)) return list;
  if (isRecord(list)) {
    const rows = list['map_data'];
    if (Array.isArray(rows)) return rows;
    if (isRecord(rows)) return [rows];
  }
  return [];
}

/** publisher.info.get: the one common-scene relation_id of the answer (distinct ids counted). */
export function queriedRelationId(body: string): QueriedRelationId {
  const ids = new Set<string>();
  for (const row of inviterRows(dataOf(body, TAOBAO_PUBLISHER_GET_ENVELOPE))) {
    if (!isRecord(row)) continue;
    const app = row['relation_app'];
    if (app !== undefined && app !== null && app !== TAOBAO_PUBLISHER_RELATION_APP) continue;
    const id = relationIdOf(row['relation_id']);
    if (id !== null) ids.add(id);
  }
  if (ids.size === 0) return { kind: 'none' };
  if (ids.size > 1) return { kind: 'ambiguous' };
  const [relationId = ''] = ids;
  return { kind: 'found', relationId };
}

/**
 * B1-04zzzzn (D10-2850): whether a publisher.info.save answer is a definite refusal — the gateway
 * answered (status below 500, a JSON object) with an error_response that is not a TOP system error.
 * A system error (sub_code isp.*, except the call limit, which is refused before the call runs)
 * may hide a filing that went through, so it counts as unknown, like a transport failure.
 */
export function saveRefusalIsDefinite(status: number, body: string): boolean {
  if (status >= 500) return false;
  const parsed = parseLossless(body);
  if (!isRecord(parsed) || !Object.hasOwn(parsed, 'error_response')) return false;
  return !isSystemSubCode(parsed['error_response']);
}

/** An error_response whose sub_code is a TOP system error (isp.*), the call limit excepted. */
function isSystemSubCode(error: unknown): boolean {
  const subCode = isRecord(error) ? error['sub_code'] : undefined;
  if (typeof subCode !== 'string') return false;
  const text = subCode.trim();
  return text.startsWith('isp.') && !text.startsWith('isp.call-limited');
}

/**
 * B1-04zzzzp (D10-3196; BR-ID-17): whether a publisher answer is a TOP gateway system error — an
 * error_response with a sub_code isp.* other than the call limit (any such sub_code, not only
 * timeouts). The gateway failed; the user's credential was not refused, so the filing calls answer
 * it as a dependency failure (upstream_unavailable), never as an invalid credential.
 */
export function isGatewaySystemError(body: string): boolean {
  const parsed = parseLossless(body);
  return isRecord(parsed) && isSystemSubCode(parsed['error_response']);
}

/** TOP's call limit (never an authorization refusal). */
const TOP_CALL_LIMIT_CODE = '7';
/**
 * TOP platform codes refusing the authorization: 11 / 12 / 13 insufficient ISV / user / partner
 * permissions, 26 / 27 missing / invalid session, 28 / 29 missing / invalid app key.
 */
const TOP_AUTH_CODES: ReadonlySet<string> = new Set(['11', '12', '13', '26', '27', '28', '29']);
/** isv.* sub_codes of the same families (e.g. isv.invalid-session, isv.permission-api-package-limit). */
const TOP_AUTH_SUB_CODE = /^isv\.[a-z0-9._:-]*(?:session|app-?key|permission)/i;
/** Codes echoed into errors and warnings: short and plain, never free upstream text. */
const PLAIN_CODE = /^[A-Za-z0-9._:-]{1,64}$/;

function plainCode(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value === 'string' && PLAIN_CODE.test(value.trim())) return value.trim();
  return undefined;
}

/**
 * B1-04zzzzq (D10-3709 ⑤ / D10-3726; BR-ID-17): the TOP code / sub_code of a filing answer that
 * refuses the user's authorization itself — the session (missing, invalid, expired), the app key it
 * was issued for (missing, invalid, not this app's) or the permissions behind it (ISV, user,
 * partner, API package). Judged by category: the TOP codes of those three families, and any isv.*
 * sub_code naming a session, an app key or a permission (whatever its code). The call limit and
 * gateway system errors (isp.*) never count: neither says anything about the credential. Only short
 * plain codes are returned (never msg, sub_msg or any other upstream text); null otherwise.
 */
export function publisherAuthRefusal(
  body: string,
): { readonly code: string; readonly sub_code?: string } | null {
  const parsed = parseLossless(body);
  if (!isRecord(parsed) || !isRecord(parsed['error_response'])) return null;
  const error = parsed['error_response'];
  const code = plainCode(error['code']);
  const subCode = plainCode(error['sub_code']);
  if (code === undefined) return null;
  if (code === TOP_CALL_LIMIT_CODE || subCode?.startsWith('isp.') === true) return null;
  const refused =
    TOP_AUTH_CODES.has(code) || (subCode !== undefined && TOP_AUTH_SUB_CODE.test(subCode));
  if (!refused) return null;
  return subCode === undefined ? { code } : { code, sub_code: subCode };
}

/**
 * B1-04zzzzq: the one flat warning of a filing whose authorization TOP refused — the TOP code /
 * sub_code and how the user authorized; never the token, the relation id or any upstream text.
 * `method` (the TOP method) is for the warn hook's shape only and is not logged with it.
 */
export interface TaobaoPublisherAuthWarning {
  readonly method: string;
  readonly code: string;
  readonly sub_code?: string;
  readonly auth_method: 'sdk_token' | 'web_code';
}

export function isTaobaoPublisherAuthWarning(
  warning: object,
): warning is TaobaoPublisherAuthWarning {
  const fields = warning as Partial<TaobaoPublisherAuthWarning>;
  return (
    (fields.auth_method === 'sdk_token' || fields.auth_method === 'web_code') &&
    typeof fields.code === 'string'
  );
}
