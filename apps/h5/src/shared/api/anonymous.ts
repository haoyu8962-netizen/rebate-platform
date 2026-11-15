/**
 * App-facing operations that do not require a user, split as contracts/openapi.yaml declares them.
 * x-auth none (`security: []`): sent without asking native for an h5_token and without
 * Authorization. x-auth optional (`security` lists `{}`): sent with the h5_token when native gives
 * one, anonymously when it does not (D10-1745), so signed-out users can still read pages, products
 * and the like (BR-ID-11). Every other operation needs the token; unknown operations fall back to
 * needing it. anonymous.test.ts compares both lists with the contract, so a new public operation
 * fails the unit tests until it is added here.
 */
const NONE_OPERATIONS: readonly (readonly [method: string, path: string])[] = [
  ['GET', '/healthz'],
  ['POST', '/v1/devices'],
  ['POST', '/v1/auth/login/sms'],
  ['POST', '/v1/auth/login/wechat'],
  ['POST', '/v1/auth/login/apple'],
  ['POST', '/v1/auth/login/huawei'],
  ['POST', '/v1/auth/refresh'],
  ['GET', '/v1/app-versions/check'],
  ['GET', '/v1/dict'],
  ['GET', '/v1/articles'],
  ['GET', '/v1/articles/{article_id}'],
  ['GET', '/v1/agreements'],
  ['GET', '/v1/agreements/{type}'],
  ['GET', '/v1/pages/{page_key}/preview'],
  ['GET', '/v1/products/{product_key}/price-trend'],
  ['GET', '/v1/search/hot-words'],
  ['GET', '/v1/share-pages/{link_id}'],
  ['POST', '/v1/share-pages/{link_id}/tpwd'],
  ['POST', '/v1/landing/sms-codes'],
  ['POST', '/v1/invites/landing-register'],
];

const OPTIONAL_OPERATIONS: readonly (readonly [method: string, path: string])[] = [
  ['POST', '/v1/auth/sms-codes'],
  ['POST', '/v1/auth/oauth-attempts'],
  ['GET', '/v1/config'],
  ['POST', '/v1/consents'],
  ['GET', '/v1/pages/{page_key}'],
  ['GET', '/v1/pages/{page_key}/sections/{section_id}/items'],
  ['GET', '/v1/products/search'],
  ['GET', '/v1/products/{product_key}'],
  ['POST', '/v1/products/{product_key}/feedback'],
  ['GET', '/v1/rank/hot'],
  ['POST', '/v1/inputs/parse'],
  ['GET', '/v1/links/{link_id}'],
  ['POST', '/v1/links/{link_id}/open'],
  // C-31 埋点上报（CT-13d）：x-auth optional，未登录也上报。
  ['POST', '/v1/events'],
  ['POST', '/v1/agent/sessions'],
  ['GET', '/v1/agent/sessions/current'],
  ['GET', '/v1/agent/sessions/{id}/messages'],
  ['POST', '/v1/agent/sessions/{id}/messages'],
  ['POST', '/v1/agent/runs/{run_id}/cancel'],
  ['POST', '/v1/agent/messages/{message_id}/report'],
  ['POST', '/v1/agent/messages/{message_id}/feedback'],
];

const toKeys = (operations: typeof NONE_OPERATIONS): readonly string[] =>
  Object.freeze(operations.map(([method, path]) => `${method} ${path}`));

/** For the contract cross-check in anonymous.test.ts. */
export const noneAuthOperations: readonly string[] = toKeys(NONE_OPERATIONS);
export const optionalAuthOperations: readonly string[] = toKeys(OPTIONAL_OPERATIONS);
/** Both kinds together: the operations a signed-out user may call. */
export const anonymousOperations: readonly string[] = Object.freeze([
  ...noneAuthOperations,
  ...optionalAuthOperations,
]);

const NONE = new Set(noneAuthOperations);
const OPTIONAL = new Set(optionalAuthOperations);

const operationKey = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

/** x-auth none: never carries a token. Matches the contract path template; the method is exact. */
export function isNoneAuthOperation(method: string, path: string): boolean {
  return NONE.has(operationKey(method, path));
}

/** x-auth optional: carries the h5_token when native gives one, otherwise goes anonymously. */
export function isOptionalAuthOperation(method: string, path: string): boolean {
  return OPTIONAL.has(operationKey(method, path));
}

/** Callable without a user (none or optional), e.g. by the signed-out landing pages. */
export function isAnonymousOperation(method: string, path: string): boolean {
  return isNoneAuthOperation(method, path) || isOptionalAuthOperation(method, path);
}
