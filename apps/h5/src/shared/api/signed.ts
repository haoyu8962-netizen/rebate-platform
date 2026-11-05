/**
 * Operations marked `x-signed: true` in contracts/openapi.yaml (method + path template). The
 * generated types carry no x-signed metadata, so the list is kept here; the rule tests compare it
 * with the contract on every run, so a new signed operation fails the suite until it is added.
 */
const SIGNED_OPERATIONS: readonly (readonly [method: string, path: string])[] = [
  ['POST', '/v1/auth/sms-codes'],
  ['POST', '/v1/auth/login/sms'],
  ['POST', '/v1/auth/oauth-attempts'],
  ['POST', '/v1/auth/login/wechat'],
  ['POST', '/v1/auth/login/apple'],
  ['POST', '/v1/auth/login/huawei'],
  ['POST', '/v1/auth/merge'],
  ['POST', '/v1/auth/step-up'],
  ['POST', '/v1/auth/refresh'],
  ['POST', '/v1/unions/{platform}/bindings'],
  ['POST', '/v1/withdrawals'],
  ['POST', '/v1/me/phone'],
  ['POST', '/v1/me/realname'],
  ['POST', '/v1/me/labor-agreement/sign'],
  ['POST', '/v1/me/inviter'],
  ['POST', '/v1/me/reverify/id-number'],
  ['POST', '/v1/me/reverify/oauth'],
  ['POST', '/v1/me/oauth-bindings'],
  ['PUT', '/v1/me/payout-account'],
  ['POST', '/v1/me/deletion'],
  ['POST', '/v1/idempotency-keys/abandon'],
  ['POST', '/v1/inputs/parse'],
  ['POST', '/v1/links/{link_id}/open'],
  ['POST', '/v1/links/convert'],
  // CT-26q: product feedback is native-only (signed, 04 §6.3).
  ['POST', '/v1/products/{product_key}/feedback'],
  // CT-15t: share material generation is native-only (signed).
  ['POST', '/v1/shares'],
  ['POST', '/v1/orders/claims'],
  // CT-21c: pay order creation, return and cancel are native-only (BR-PAY-01 ②).
  ['POST', '/v1/pay/orders'],
  ['POST', '/v1/pay/orders/{pay_order_id}/returned'],
  ['POST', '/v1/pay/orders/{pay_order_id}/cancel'],
];

const SIGNED = new Set(SIGNED_OPERATIONS.map(([method, path]) => `${method} ${path}`));

/** Matches the contract path template, as passed to H5ApiClient.request; the method is exact. */
export function isSignedOperation(method: string, path: string): boolean {
  return SIGNED.has(`${method.toUpperCase()} ${path}`);
}

/** Raised before anything is sent: H5 never signs, and native signing is not wired yet. */
export class SignedOperationError extends Error {
  declare readonly method: string;
  declare readonly path: string;

  constructor(method: string, path: string) {
    super(`signed operation ${method} ${path} is not sent from H5 (requires native signing)`);
    this.name = 'SignedOperationError';
    this.method = method;
    this.path = path;
  }
}
