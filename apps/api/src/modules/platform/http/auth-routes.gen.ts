// Generated from contracts/openapi.yaml by platform/http/scripts/generate-auth-routes.ts.
// Do not edit by hand. Regenerate after contract changes.
export const CONTRACT_AUTH_ROUTES = [
  {
    "method": "GET",
    "path": "/healthz",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/v1/devices",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/v1/devices/push-token",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/auth/sms-codes",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/v1/auth/login/sms",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/v1/auth/oauth-attempts",
    "auth": "optional"
  },
  {
    "method": "POST",
    "path": "/v1/auth/login/wechat",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/v1/auth/login/apple",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/v1/auth/login/huawei",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/v1/auth/merge",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/auth/step-up",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/auth/refresh",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/v1/auth/logout",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/consents",
    "auth": "optional"
  },
  {
    "method": "POST",
    "path": "/v1/auth/h5-token",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/unions/bindings",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/unions/:platform/auth-url",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/unions/:platform/bindings",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/orders",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/orders/claims",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/orders/claims",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/orders/pending-tracks",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/orders/pending-tracks/:link_id/dismiss",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/orders/:order_id",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/agreements",
    "auth": "none"
  },
  {
    "method": "GET",
    "path": "/v1/agreements/:type",
    "auth": "none"
  },
  {
    "method": "GET",
    "path": "/v1/articles",
    "auth": "none"
  },
  {
    "method": "GET",
    "path": "/v1/articles/:article_id",
    "auth": "none"
  },
  {
    "method": "GET",
    "path": "/v1/app-versions/check",
    "auth": "none"
  },
  {
    "method": "GET",
    "path": "/v1/pages/:page_key",
    "auth": "optional"
  },
  {
    "method": "GET",
    "path": "/v1/pages/:page_key/preview",
    "auth": "none"
  },
  {
    "method": "GET",
    "path": "/v1/pages/:page_key/sections/:section_id/items",
    "auth": "optional"
  },
  {
    "method": "GET",
    "path": "/v1/messages/:message_id",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/messages",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/messages/read",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/messages/unread-count",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/wallet/summary",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/earnings/summary",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/wallet/ledger",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/withdrawals/rules",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/withdrawals",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/withdrawals",
    "auth": "realname"
  },
  {
    "method": "GET",
    "path": "/v1/withdrawals/:withdrawal_id",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/pay/orders",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/pay/orders/:pay_order_id",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/pay/orders/:pay_order_id/returned",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/pay/orders/:pay_order_id/cancel",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/me",
    "auth": "login"
  },
  {
    "method": "PATCH",
    "path": "/v1/me",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/me/phone",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/me/inviter",
    "auth": "phone"
  },
  {
    "method": "GET",
    "path": "/v1/invites/me",
    "auth": "phone"
  },
  {
    "method": "POST",
    "path": "/v1/landing/sms-codes",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/v1/invites/landing-register",
    "auth": "none"
  },
  {
    "method": "GET",
    "path": "/v1/me/reverify",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/me/reverify/id-number",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/me/reverify/oauth",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/me/oauth-bindings",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/me/payout-account",
    "auth": "realname"
  },
  {
    "method": "PUT",
    "path": "/v1/me/payout-account",
    "auth": "realname"
  },
  {
    "method": "POST",
    "path": "/v1/me/realname",
    "auth": "phone"
  },
  {
    "method": "GET",
    "path": "/v1/me/labor-agreement",
    "auth": "realname"
  },
  {
    "method": "POST",
    "path": "/v1/me/labor-agreement/sign",
    "auth": "realname"
  },
  {
    "method": "GET",
    "path": "/v1/me/tips",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/me/tips/:tip_key/read",
    "auth": "login"
  },
  {
    "method": "DELETE",
    "path": "/v1/me/tips/:tip_key",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/me/notification-settings",
    "auth": "login"
  },
  {
    "method": "PUT",
    "path": "/v1/me/notification-settings",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/me/deletion",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/me/deletion",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/me/deletion/cancel",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/me/data-copies",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/me/data-copies/:id/download",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/me/appeals",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/me/appeals",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/idempotency-keys/abandon",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/config",
    "auth": "optional"
  },
  {
    "method": "GET",
    "path": "/v1/dict",
    "auth": "none"
  },
  {
    "method": "GET",
    "path": "/v1/products/search",
    "auth": "optional"
  },
  {
    "method": "GET",
    "path": "/v1/products/:product_key",
    "auth": "optional"
  },
  {
    "method": "GET",
    "path": "/v1/products/:product_key/price-trend",
    "auth": "none"
  },
  {
    "method": "GET",
    "path": "/v1/rank/hot",
    "auth": "optional"
  },
  {
    "method": "GET",
    "path": "/v1/search/hot-words",
    "auth": "none"
  },
  {
    "method": "GET",
    "path": "/v1/me/favorites",
    "auth": "login"
  },
  {
    "method": "PUT",
    "path": "/v1/me/favorites/:platform/:product_key",
    "auth": "login"
  },
  {
    "method": "DELETE",
    "path": "/v1/me/favorites/:platform/:product_key",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/me/favorites/batch-delete",
    "auth": "login"
  },
  {
    "method": "POST",
    "path": "/v1/inputs/parse",
    "auth": "optional"
  },
  {
    "method": "POST",
    "path": "/v1/links/:link_id/open",
    "auth": "optional"
  },
  {
    "method": "POST",
    "path": "/v1/links/convert",
    "auth": "login"
  },
  {
    "method": "GET",
    "path": "/v1/links/:link_id",
    "auth": "optional"
  },
  {
    "method": "GET",
    "path": "/v1/share-pages/:link_id",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/v1/share-pages/:link_id/tpwd",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/v1/shares",
    "auth": "phone"
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/login",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/password",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/totp/secret",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/totp/bind",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/totp",
    "auth": "none"
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/logout",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/step-up/sms-codes",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/step-up",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/me/permissions",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/me/verify-phone/sms-codes",
    "auth": "admin"
  },
  {
    "method": "PUT",
    "path": "/admin/v1/me/verify-phone",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/dashboard",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/admins",
    "auth": "super"
  },
  {
    "method": "POST",
    "path": "/admin/v1/admins",
    "auth": "super"
  },
  {
    "method": "GET",
    "path": "/admin/v1/admins/:admin_id",
    "auth": "super"
  },
  {
    "method": "POST",
    "path": "/admin/v1/admins/:admin_id/initial-password",
    "auth": "super"
  },
  {
    "method": "POST",
    "path": "/admin/v1/admins/:admin_id/disable",
    "auth": "super"
  },
  {
    "method": "POST",
    "path": "/admin/v1/admins/:admin_id/enable",
    "auth": "super"
  },
  {
    "method": "PUT",
    "path": "/admin/v1/admins/:admin_id/permissions",
    "auth": "super"
  },
  {
    "method": "POST",
    "path": "/admin/v1/admins/:admin_id/totp/reset",
    "auth": "super"
  },
  {
    "method": "PUT",
    "path": "/admin/v1/admins/:admin_id/display-name",
    "auth": "super"
  },
  {
    "method": "POST",
    "path": "/admin/v1/admins/:admin_id/verify-phone/sms-codes",
    "auth": "super"
  },
  {
    "method": "PUT",
    "path": "/admin/v1/admins/:admin_id/verify-phone",
    "auth": "super"
  },
  {
    "method": "GET",
    "path": "/admin/v1/audit-logs",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/audit-logs/:id",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/exports",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/exports",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/exports/:id/download",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/exports/:id/retry",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/users",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/invite-rewards",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/invite-rewards/:invitee_id",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/search",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/users/lookup",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/users/:user_id",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/reveal",
    "auth": "admin"
  },
  {
    "method": "PUT",
    "path": "/admin/v1/users/:user_id/risk-state",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/union-bindings/:platform/reset",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/union-bindings/:platform/disable",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/union-bindings/:platform/enable",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/users/:user_id/invitees",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/level",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/inviter",
    "auth": "admin"
  },
  {
    "method": "PATCH",
    "path": "/admin/v1/users/:user_id/profile",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/users/:user_id/devices",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/reverified-devices",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/realname-correction",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/users/:user_id/data-exports",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/data-exports",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/data-exports/:export_id/download",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/orders",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/orders/:order_id",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/orders/:order_id/hold",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/orders/:order_id/unhold",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/orders/:order_id/reassign",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/order-syncs",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/order-syncs",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/order-syncs/limits",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/rights-imports",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/rights-imports",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/rights-imports/:import_id",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/claims",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/claims/:claim_id",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/claims/:claim_id/items/:item_id/approve",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/claims/:claim_id/items/:item_id/reject",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/union-accounts",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/union-accounts/:union_account_id/reauthorize",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/union-accounts/:union_account_id/reauthorize/:session_id",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/union-accounts/oauth/callback",
    "auth": "admin"
  },
  {
    "method": "PUT",
    "path": "/admin/v1/union-accounts/:union_account_id/credential",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/union-accounts/alert-phones",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/union-accounts/alert-phones",
    "auth": "admin"
  },
  {
    "method": "DELETE",
    "path": "/admin/v1/union-accounts/alert-phones",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/union/account-options",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/union-pids",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/union-pids",
    "auth": "admin"
  },
  {
    "method": "PATCH",
    "path": "/admin/v1/union-pids/:pid_id",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/union-pids/:pid_id/activate",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/union-pids/:pid_id/retire",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/platform-icons",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/platform-icons/:key/versions",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/platform-icons/:key/versions",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/platform-icons/:key/uploads",
    "auth": "admin"
  },
  {
    "method": "PATCH",
    "path": "/admin/v1/platform-icons/:key/versions/:version",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/platform-icons/:key/publish",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/platform-icons/:key/restore-builtin",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/pages",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/pages/popup-assets",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/pages/:page_key",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/pages/:page_key/versions",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/versions",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/pages/:page_key/versions/:version",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/publish",
    "auth": "admin"
  },
  {
    "method": "DELETE",
    "path": "/admin/v1/pages/:page_key/schedule",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/gray",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/rollback",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/preview-tokens",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/agreements",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/agreements/:type/versions",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/agreements/:type/versions/:version",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/product-pools",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/product-pools",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/product-pools/candidates",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/product-pools/:pool_id",
    "auth": "admin"
  },
  {
    "method": "PATCH",
    "path": "/admin/v1/product-pools/:pool_id",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/product-pools/:pool_id/items",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/product-pools/:pool_id/items",
    "auth": "admin"
  },
  {
    "method": "DELETE",
    "path": "/admin/v1/product-pools/:pool_id/items/:product_key",
    "auth": "admin"
  },
  {
    "method": "PATCH",
    "path": "/admin/v1/product-pools/:pool_id/items/:product_key",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/articles",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/articles",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/articles/:article_id",
    "auth": "admin"
  },
  {
    "method": "PUT",
    "path": "/admin/v1/articles/:article_id/draft",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/articles/:article_id/publish",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/articles/:article_id/offline",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/dict-items",
    "auth": "admin"
  },
  {
    "method": "PUT",
    "path": "/admin/v1/dict-items",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/dict-items/versions",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/dict-items/rollback",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/dict",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/notify-channels",
    "auth": "admin"
  },
  {
    "method": "PATCH",
    "path": "/admin/v1/notify-channels/:code",
    "auth": "admin"
  },
  {
    "method": "PUT",
    "path": "/admin/v1/notify-channels/:code/sms",
    "auth": "admin"
  },
  {
    "method": "DELETE",
    "path": "/admin/v1/notify-channels/:code/sms/pending",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/notify-channels/:code/sms/pending/test",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/notify-channels/:code/sms/pending/enable",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/app-versions",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/app-versions/:platform/:channel",
    "auth": "admin"
  },
  {
    "method": "PUT",
    "path": "/admin/v1/app-versions/:platform/:channel",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/risk-rules",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/risk-rules/:rule_id/enable",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/risk-rules/:rule_id/disable",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/appeals",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/appeals",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/appeals/:appeal_id",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/appeals/:appeal_id/claim",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/appeals/:appeal_id/resolve",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/blocked-requests",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/pay-orders",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/pay-orders/:pay_order_id",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/pay-orders/:pay_order_id/resolve",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/pay-orders/:pay_order_id/refunds",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/pay-refunds",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/pay-refunds/:pay_refund_id",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/pay-anomalies",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/pay-anomalies/:pay_anomaly_id/refunds",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/pay-recon-diffs",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/recon-diffs",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/recon-diffs/:recon_diff_id",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/recon-diffs/:recon_diff_id/close",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/recon-diffs/:recon_diff_id/write-off",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/recon-diffs/:recon_diff_id/restore",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/adjustments",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/adjustments",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/adjustments/:adjust_id",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/adjustments/:adjust_id/approve",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/adjustments/:adjust_id/reject",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/bad-debt-writeoffs",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/bad-debt-writeoffs/:id/approve",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/withdrawals",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/withdrawals/:withdrawal_id",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/settle-bills",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/settle-bills/:bill_id",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/settle-bills/:bill_id/confirm",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/settle-bills/:bill_id/supplement-batches",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/settle-batches/:batch_id/items",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/settle-batches/:batch_id/cancel-schedule",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/settle-batches/:batch_id/reject",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/settle-batches/:batch_id/resume",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/asset-snapshots",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/union-receipts",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/union-receipts",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/union-receipts/:receipt_id/reverse",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/payout-watermarks",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/fund-ledger",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/kill-switches",
    "auth": "admin"
  },
  {
    "method": "PUT",
    "path": "/admin/v1/kill-switches/:key",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/config-items",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/config-items/batch",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/config-items/:key",
    "auth": "admin"
  },
  {
    "method": "PUT",
    "path": "/admin/v1/config-items/:key",
    "auth": "admin"
  },
  {
    "method": "GET",
    "path": "/admin/v1/config-items/:key/versions",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/admin/v1/config-items/:key/rollback",
    "auth": "admin"
  },
  {
    "method": "POST",
    "path": "/v1/agent/sessions",
    "auth": "optional"
  },
  {
    "method": "GET",
    "path": "/v1/agent/sessions/current",
    "auth": "optional"
  },
  {
    "method": "GET",
    "path": "/v1/agent/sessions/:id/messages",
    "auth": "optional"
  },
  {
    "method": "POST",
    "path": "/v1/agent/sessions/:id/messages",
    "auth": "optional"
  },
  {
    "method": "POST",
    "path": "/v1/agent/runs/:run_id/cancel",
    "auth": "optional"
  },
  {
    "method": "POST",
    "path": "/v1/agent/messages/:message_id/feedback",
    "auth": "optional"
  },
  {
    "method": "POST",
    "path": "/v1/agent/messages/:message_id/report",
    "auth": "optional"
  }
] as const;
