/**
 * App-facing operations that do not require a user (contracts/openapi.yaml operation `security`
 * is `[]`, or lists `{}` for optional auth). They are sent without asking native for an h5_token
 * and without Authorization, so signed-out users can still read articles, pages and the like
 * (BR-ID-11); every other operation needs the token. Unknown operations fall back to needing the
 * token. anonymous.test.ts compares this list with the contract, so a new public operation fails
 * the unit tests until it is added here.
 */
const ANONYMOUS_OPERATIONS: readonly (readonly [method: string, path: string])[] = [
  ['GET', '/healthz'],
  ['POST', '/v1/devices'],
  ['POST', '/v1/auth/sms-codes'],
  ['POST', '/v1/auth/login/sms'],
  ['POST', '/v1/auth/oauth-attempts'],
  ['POST', '/v1/auth/login/wechat'],
  ['POST', '/v1/auth/login/apple'],
  ['POST', '/v1/auth/login/huawei'],
  ['POST', '/v1/auth/refresh'],
  ['GET', '/v1/app-versions/check'],
  ['GET', '/v1/config'],
  ['GET', '/v1/dict'],
  ['POST', '/v1/consents'],
  ['GET', '/v1/articles'],
  ['GET', '/v1/articles/{article_id}'],
  ['GET', '/v1/agreements'],
  ['GET', '/v1/agreements/{type}'],
  ['GET', '/v1/pages/{page_key}'],
  ['GET', '/v1/pages/{page_key}/preview'],
  ['GET', '/v1/pages/{page_key}/sections/{section_id}/items'],
  ['GET', '/v1/products/search'],
  ['GET', '/v1/products/{product_key}'],
  ['GET', '/v1/products/{product_key}/price-trend'],
  ['POST', '/v1/products/{product_key}/feedback'],
  ['GET', '/v1/rank/hot'],
  ['GET', '/v1/search/hot-words'],
  ['POST', '/v1/inputs/parse'],
  ['GET', '/v1/links/{link_id}'],
  ['POST', '/v1/links/{link_id}/open'],
  ['GET', '/v1/share-pages/{link_id}'],
  ['POST', '/v1/share-pages/{link_id}/tpwd'],
  ['POST', '/v1/landing/sms-codes'],
  ['POST', '/v1/invites/landing-register'],
  ['POST', '/v1/agent/sessions'],
  ['GET', '/v1/agent/sessions/current'],
  ['GET', '/v1/agent/sessions/{id}/messages'],
  ['POST', '/v1/agent/sessions/{id}/messages'],
  ['POST', '/v1/agent/runs/{run_id}/cancel'],
  ['POST', '/v1/agent/messages/{message_id}/report'],
  ['POST', '/v1/agent/messages/{message_id}/feedback'],
];

/** For the contract cross-check in anonymous.test.ts. */
export const anonymousOperations: readonly string[] = Object.freeze(
  ANONYMOUS_OPERATIONS.map(([method, path]) => `${method} ${path}`),
);

const ANONYMOUS = new Set(anonymousOperations);

/** Matches the contract path template, as passed to H5ApiClient.request; the method is exact. */
export function isAnonymousOperation(method: string, path: string): boolean {
  return ANONYMOUS.has(`${method.toUpperCase()} ${path}`);
}
