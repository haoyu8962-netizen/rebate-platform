// Generated from contracts/openapi.yaml by platform/validation/scripts/generate-signing-routes.ts.
// Do not edit by hand. Regenerate after contract changes.
export const CONTRACT_SIGNING_ROUTES = [
  {
    "method": "GET",
    "path": "/healthz",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/devices",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/devices/push-token",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/auth/sms-codes",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/auth/login/sms",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/auth/oauth-attempts",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/auth/login/wechat",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/auth/login/apple",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/auth/login/huawei",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/auth/merge",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/auth/step-up",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/auth/refresh",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/auth/logout",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/consents",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/auth/h5-token",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/unions/bindings",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/unions/:platform/auth-url",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/unions/:platform/bindings",
    "signed": true
  },
  {
    "method": "GET",
    "path": "/v1/orders",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/orders/claims",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/orders/claims",
    "signed": true
  },
  {
    "method": "GET",
    "path": "/v1/orders/pending-tracks",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/orders/pending-tracks/:link_id/dismiss",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/orders/:order_id",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/agreements",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/agreements/:type",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/articles",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/articles/:article_id",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/app-versions/check",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/pages/:page_key",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/pages/:page_key/preview",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/pages/:page_key/sections/:section_id/items",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/messages/:message_id",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/messages",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/messages/read",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/messages/unread-count",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/wallet/summary",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/earnings/summary",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/wallet/ledger",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/withdrawals/rules",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/withdrawals",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/withdrawals",
    "signed": true
  },
  {
    "method": "GET",
    "path": "/v1/withdrawals/:withdrawal_id",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/pay/orders",
    "signed": true
  },
  {
    "method": "GET",
    "path": "/v1/pay/orders/:pay_order_id",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/pay/orders/:pay_order_id/returned",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/pay/orders/:pay_order_id/cancel",
    "signed": true
  },
  {
    "method": "GET",
    "path": "/v1/me",
    "signed": false
  },
  {
    "method": "PATCH",
    "path": "/v1/me",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/me/phone",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/me/inviter",
    "signed": true
  },
  {
    "method": "GET",
    "path": "/v1/invites/me",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/landing/sms-codes",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/invites/landing-register",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/me/reverify",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/me/reverify/id-number",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/me/reverify/oauth",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/me/oauth-bindings",
    "signed": true
  },
  {
    "method": "GET",
    "path": "/v1/me/payout-account",
    "signed": false
  },
  {
    "method": "PUT",
    "path": "/v1/me/payout-account",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/me/realname",
    "signed": true
  },
  {
    "method": "GET",
    "path": "/v1/me/labor-agreement",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/me/labor-agreement/sign",
    "signed": true
  },
  {
    "method": "GET",
    "path": "/v1/me/tips",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/me/tips/:tip_key/read",
    "signed": false
  },
  {
    "method": "DELETE",
    "path": "/v1/me/tips/:tip_key",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/me/notification-settings",
    "signed": false
  },
  {
    "method": "PUT",
    "path": "/v1/me/notification-settings",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/me/deletion",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/me/deletion",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/me/deletion/cancel",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/me/data-copies",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/me/data-copies/:id/download",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/me/appeals",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/me/appeals",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/idempotency-keys/abandon",
    "signed": true
  },
  {
    "method": "GET",
    "path": "/v1/config",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/dict",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/products/search",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/products/:product_key",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/products/:product_key/price-trend",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/products/:product_key/feedback",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/products/:product_key/shop/open",
    "signed": true
  },
  {
    "method": "GET",
    "path": "/v1/rank/hot",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/search/hot-words",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/me/favorites",
    "signed": false
  },
  {
    "method": "PUT",
    "path": "/v1/me/favorites/:platform/:product_key",
    "signed": false
  },
  {
    "method": "DELETE",
    "path": "/v1/me/favorites/:platform/:product_key",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/me/favorites/batch-delete",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/inputs/parse",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/links/:link_id/open",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/v1/links/convert",
    "signed": true
  },
  {
    "method": "GET",
    "path": "/v1/links/:link_id",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/share-pages/:link_id",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/share-pages/:link_id/tpwd",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/shares",
    "signed": true
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/login",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/password",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/totp/secret",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/totp/bind",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/totp",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/logout",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/step-up/sms-codes",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/auth/step-up",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/me/permissions",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/me/verify-phone/sms-codes",
    "signed": false
  },
  {
    "method": "PUT",
    "path": "/admin/v1/me/verify-phone",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/dashboard",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/admins",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/admins",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/admins/:admin_id",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/admins/:admin_id/initial-password",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/admins/:admin_id/disable",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/admins/:admin_id/enable",
    "signed": false
  },
  {
    "method": "PUT",
    "path": "/admin/v1/admins/:admin_id/permissions",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/admins/:admin_id/totp/reset",
    "signed": false
  },
  {
    "method": "PUT",
    "path": "/admin/v1/admins/:admin_id/display-name",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/admins/:admin_id/verify-phone/sms-codes",
    "signed": false
  },
  {
    "method": "PUT",
    "path": "/admin/v1/admins/:admin_id/verify-phone",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/audit-logs",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/audit-logs/:id",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/exports",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/exports",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/exports/:id/download",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/exports/:id/retry",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/users",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/invite-rewards",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/invite-rewards/:invitee_id",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/search",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/users/lookup",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/users/:user_id",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/reveal",
    "signed": false
  },
  {
    "method": "PUT",
    "path": "/admin/v1/users/:user_id/risk-state",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/union-bindings/:platform/reset",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/union-bindings/:platform/disable",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/union-bindings/:platform/enable",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/users/:user_id/invitees",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/level",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/inviter",
    "signed": false
  },
  {
    "method": "PATCH",
    "path": "/admin/v1/users/:user_id/profile",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/users/:user_id/devices",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/reverified-devices",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/realname-correction",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/users/:user_id/data-exports",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/data-exports",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/users/:user_id/data-exports/:export_id/download",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/orders",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/orders/:order_id",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/orders/:order_id/hold",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/orders/:order_id/unhold",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/orders/:order_id/reassign",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/order-syncs",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/order-syncs",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/order-syncs/limits",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/rights-imports",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/rights-imports",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/rights-imports/:import_id",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/claims",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/claims/:claim_id",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/claims/:claim_id/items/:item_id/approve",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/claims/:claim_id/items/:item_id/reject",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/union-accounts",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/union-accounts/:union_account_id/reauthorize",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/union-accounts/:union_account_id/reauthorize/:session_id",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/union-accounts/oauth/callback",
    "signed": false
  },
  {
    "method": "PUT",
    "path": "/admin/v1/union-accounts/:union_account_id/credential",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/union-accounts/alert-phones",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/union-accounts/alert-phones",
    "signed": false
  },
  {
    "method": "DELETE",
    "path": "/admin/v1/union-accounts/alert-phones",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/union/account-options",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/union-pids",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/union-pids",
    "signed": false
  },
  {
    "method": "PATCH",
    "path": "/admin/v1/union-pids/:pid_id",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/union-pids/:pid_id/activate",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/union-pids/:pid_id/retire",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/platform-icons",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/platform-icons/:key/versions",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/platform-icons/:key/versions",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/platform-icons/:key/uploads",
    "signed": false
  },
  {
    "method": "PATCH",
    "path": "/admin/v1/platform-icons/:key/versions/:version",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/platform-icons/:key/publish",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/platform-icons/:key/restore-builtin",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/pages",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/pages/popup-assets",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/pages/:page_key",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/pages/:page_key/versions",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/versions",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/pages/:page_key/versions/:version",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/publish",
    "signed": false
  },
  {
    "method": "DELETE",
    "path": "/admin/v1/pages/:page_key/schedule",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/gray",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/rollback",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/preview-tokens",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/agreements",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/agreements/:type/versions",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/agreements/:type/versions/:version",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/product-pools",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/product-pools",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/product-pools/candidates",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/product-pools/:pool_id",
    "signed": false
  },
  {
    "method": "PATCH",
    "path": "/admin/v1/product-pools/:pool_id",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/product-pools/:pool_id/items",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/product-pools/:pool_id/items",
    "signed": false
  },
  {
    "method": "DELETE",
    "path": "/admin/v1/product-pools/:pool_id/items/:product_key",
    "signed": false
  },
  {
    "method": "PATCH",
    "path": "/admin/v1/product-pools/:pool_id/items/:product_key",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/articles",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/articles",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/articles/:article_id",
    "signed": false
  },
  {
    "method": "PUT",
    "path": "/admin/v1/articles/:article_id/draft",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/articles/:article_id/publish",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/articles/:article_id/offline",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/dict-items",
    "signed": false
  },
  {
    "method": "PUT",
    "path": "/admin/v1/dict-items",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/dict-items/versions",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/dict-items/rollback",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/dict",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/notify-channels",
    "signed": false
  },
  {
    "method": "PATCH",
    "path": "/admin/v1/notify-channels/:code",
    "signed": false
  },
  {
    "method": "PUT",
    "path": "/admin/v1/notify-channels/:code/sms",
    "signed": false
  },
  {
    "method": "DELETE",
    "path": "/admin/v1/notify-channels/:code/sms/pending",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/notify-channels/:code/sms/pending/test",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/notify-channels/:code/sms/pending/enable",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/app-versions",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/app-versions/:platform/:channel",
    "signed": false
  },
  {
    "method": "PUT",
    "path": "/admin/v1/app-versions/:platform/:channel",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/risk-rules",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/risk-rules/:rule_id/enable",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/risk-rules/:rule_id/disable",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/appeals",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/appeals",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/appeals/:appeal_id",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/appeals/:appeal_id/claim",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/appeals/:appeal_id/resolve",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/blocked-requests",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/pay-orders",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/pay-orders/:pay_order_id",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/pay-orders/:pay_order_id/resolve",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/pay-orders/:pay_order_id/refunds",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/pay-refunds",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/pay-refunds/:pay_refund_id",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/pay-anomalies",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/pay-anomalies/:pay_anomaly_id/refunds",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/pay-recon-diffs",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/recon-diffs",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/recon-diffs/:recon_diff_id",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/recon-diffs/:recon_diff_id/close",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/recon-diffs/:recon_diff_id/write-off",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/recon-diffs/:recon_diff_id/restore",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/adjustments",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/adjustments",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/adjustments/:adjust_id",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/adjustments/:adjust_id/approve",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/adjustments/:adjust_id/reject",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/bad-debt-writeoffs",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/bad-debt-writeoffs/:id/approve",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/withdrawals",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/withdrawals/:withdrawal_id",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/withdrawals/batch-approve",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/withdrawals/batch-manual-paid",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/unknown-payouts",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/withdrawals/:withdrawal_id/query",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/withdrawals/:withdrawal_id/resolve",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/withdrawals/:withdrawal_id/reject",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/settle-bills",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/settle-bills/:bill_id",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/settle-bills/:bill_id/confirm",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/settle-bills/:bill_id/supplement-batches",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/settle-batches/:batch_id/items",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/settle-batches/:batch_id/cancel-schedule",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/settle-batches/:batch_id/reject",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/settle-batches/:batch_id/resume",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/asset-snapshots",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/union-receipts",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/union-receipts",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/union-receipts/:receipt_id/reverse",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/payout-watermarks",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/payout-batches",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/payout-overview",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/fund-ledger",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/kill-switches",
    "signed": false
  },
  {
    "method": "PUT",
    "path": "/admin/v1/kill-switches/:key",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/config-items",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/config-items/batch",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/config-items/:key",
    "signed": false
  },
  {
    "method": "PUT",
    "path": "/admin/v1/config-items/:key",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/admin/v1/config-items/:key/versions",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/admin/v1/config-items/:key/rollback",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/agent/sessions",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/agent/sessions/current",
    "signed": false
  },
  {
    "method": "GET",
    "path": "/v1/agent/sessions/:id/messages",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/agent/sessions/:id/messages",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/agent/runs/:run_id/cancel",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/agent/messages/:message_id/feedback",
    "signed": false
  },
  {
    "method": "POST",
    "path": "/v1/agent/messages/:message_id/report",
    "signed": false
  }
] as const;
