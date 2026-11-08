// 京东转链接口（jd.union.open.promotion.common.get，B1-04zd、D10-500 ①）的请求参数、内层 code 细分
// 与结果映射。规则测试：test/spec/union/jd-convert/**；口径见 specs/union/jd.md。
// 身份只用 linking 在服务端构造的（BR-ATTR-05）：positionId 取 identity.promotionSlot，subUnionId 取
// 身份的同名属性，原样上行，不拼不改；身份没有这个属性就是 no_rebate，请求里没有这个键。
// 结果只取 data.clickURL，jCommand 不进结果，不自行拼 scheme，不回退原链接，也没有短链。
// 错误只带固定文案，不带 subUnionId、clickURL、itemId、推广位与上游 message。
import {
  isServerIdentity,
  UnionError,
  type ConvertReq,
  type ConvertResult,
  type ItemRef,
  type UnionIdentity,
} from '../../domain/types.ts';
import type { JdInner, JdInnerCodeMap, JdResponseKeys } from './response.ts';

export const JD_PROMOTION_COMMON_GET = 'jd.union.open.promotion.common.get';
/** 外层键的 `_responce` 是网关自己的拼写。 */
export const JD_PROMOTION_KEYS: JdResponseKeys = {
  envelope: 'jd_union_open_promotion_common_get_responce',
  resultKey: 'getResult',
};
/** promotionCodeReq.sceneId 固定 1。 */
export const JD_PROMOTION_SCENE = 1;

/**
 * 其余内层 code 按底座（403 → upstream_misconfigured，其他 upstream_rejected）；429 由底座先判限流。
 * 2001403「无调用权限，请联系联盟运营申请」与 2001602「无母账号权限或未签署协议」是我方账号 / 接口
 * 权限问题 → upstream_misconfigured（B1-04zzzzc / D10-1073；出处
 * docs-mirror/jd/api/jd.union.open.promotion.common.get.md 错误代码示例、guides/108188.md）。
 * 2001603（子联盟法律协议）原文不足以判定我方是否用子联盟，留 upstream_rejected。
 */
export const JD_PROMOTION_INNER_CODES: JdInnerCodeMap = {
  '2001104': 'item_unavailable',
  '2001101': 'link_unrecognized',
  '2001102': 'link_unrecognized',
  '2001703': 'link_unrecognized',
  '2001706': 'link_unrecognized',
  '2001707': 'link_unrecognized',
  '2001208': 'upstream_rejected',
  '2001609': 'upstream_unavailable',
  '2001403': 'upstream_misconfigured',
  '2001602': 'upstream_misconfigured',
};
/**
 * 告警一次的内层 code（403 由底座告警）。2001701 本单不用 couponUrl，只可能是 siteId 类型不符
 * （CAP-JD-06），upstream_rejected；2001403 / 2001602 是 upstream_misconfigured（见上表）；2001603 是
 * upstream_rejected。后三个都是权限或协议问题，要人去处理。
 */
export const JD_PROMOTION_WARN_CODES: ReadonlySet<string> = new Set([
  '2001701',
  '2001403',
  '2001602',
  '2001603',
]);

const JINGFEN_DETAIL_PREFIX = 'https://jingfen.jd.com/detail/';
/** 联盟 itemId 的字符集，与 resolveLink 认的 jingfen 详情页一致；白名单之外绝不拼进 materialId。 */
const ITEM_ID = /^[A-Za-z0-9_-]+$/;
const SUB_UNION_ID = /^[A-Za-z0-9_-]{1,80}$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const CLICK_URL = /^https?:\/\/\S+$/;

/** union 侧对 linking 身份子类的局部结构声明（不 import linking）。 */
type WithSubUnionId = UnionIdentity & { readonly subUnionId?: unknown };

/** 转链用的身份参数：只给 positionId 与（有的话）subUnionId，不给 userId。 */
export interface JdIdentityParameters {
  readonly positionId: number;
  readonly subUnionId?: string;
}

/** 在读商品键模式、取凭据、发请求之前同步校验；不合格 invalid_identity。 */
export function jdIdentityParameters(identity: UnionIdentity): JdIdentityParameters {
  const refuse = (reason: string) =>
    new UnionError('invalid_identity', `jd convert: identity ${reason}`, 'jd');
  if (!isServerIdentity(identity) || identity.claims.platform !== 'jd') {
    throw refuse('is not a server-built jd identity');
  }
  const slot: unknown = identity.claims.promotionSlot;
  const positionId = typeof slot === 'string' && POSITIVE_DECIMAL.test(slot) ? Number(slot) : 0;
  if (!Number.isSafeInteger(positionId) || positionId <= 0) {
    throw refuse('has no usable promotion slot');
  }
  const { subUnionId } = identity as WithSubUnionId;
  if (subUnionId === undefined) return { positionId };
  if (typeof subUnionId !== 'string' || !SUB_UNION_ID.test(subUnionId)) {
    throw refuse('has a malformed subUnionId');
  }
  return { positionId, subUnionId };
}

/**
 * item 模式的联盟 itemId：item_id 优先，其次 itemId（linking 传这个）。item_id 只要给了值就只看它，
 * 不合格不换另一个键。两个键走同一套校验。
 */
function convertItemId(item: ItemRef | undefined): string {
  const id: unknown = item?.item_id ?? item?.itemId;
  if (item?.platform !== 'jd' || typeof id !== 'string' || !ITEM_ID.test(id)) {
    throw new UnionError('invalid_dto', 'jd convert: union item id is required', 'jd');
  }
  return id;
}

/**
 * item 模式下一次转链的 promotionCodeReq：materialId、siteId、positionId、sceneId，身份有 subUnionId
 * 时原样带上。身份不合 invalid_identity，商品不合 invalid_dto。idempotencyKey 不上行。
 */
export function jdPromotionCodeReq(
  req: ConvertReq,
  identity: UnionIdentity,
  siteId: string,
): Readonly<Record<string, unknown>> {
  const { positionId, subUnionId } = jdIdentityParameters(identity);
  const itemId = convertItemId(req?.item);
  return {
    materialId: `${JINGFEN_DETAIL_PREFIX}${itemId}.html`,
    siteId,
    positionId,
    sceneId: JD_PROMOTION_SCENE,
    ...(subUnionId === undefined ? {} : { subUnionId }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 非空的 http(s) 绝对地址；前导空格这类 URL 解析会吞掉的情况先由正则挡下。 */
function clickUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !CLICK_URL.test(value)) return undefined;
  try {
    return new URL(value).hostname === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

/** 内层 200 的 data.clickURL → 转链结果；不合格 upstream_unavailable，错误不带链接原文。 */
export function mapJdConvertResult(inner: JdInner): ConvertResult {
  const { data } = inner;
  const url = clickUrl(isRecord(data) ? data.clickURL : undefined);
  if (url === undefined) {
    throw new UnionError(
      'upstream_unavailable',
      `jd ${JD_PROMOTION_COMMON_GET}: no usable clickURL in response`,
      'jd',
    );
  }
  return { kind: 'url', url };
}
