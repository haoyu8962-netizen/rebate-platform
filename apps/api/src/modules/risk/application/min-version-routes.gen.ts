// Generated from contracts/openapi.yaml by risk/application/scripts/generate-min-version-routes.ts.
// Do not edit by hand. Regenerate after contract changes.
export const CONTRACT_MIN_VERSION_ROUTES = [
  {
    "operationId": "getHealthz",
    "method": "GET",
    "path": "/healthz",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "registerDevice",
    "method": "POST",
    "path": "/v1/devices",
    "gate": false,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "reportPushToken",
    "method": "POST",
    "path": "/v1/devices/push-token",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "sendSmsCode",
    "method": "POST",
    "path": "/v1/auth/sms-codes",
    "gate": "conditional",
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "loginBySms",
    "method": "POST",
    "path": "/v1/auth/login/sms",
    "gate": false,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "createOauthAttempt",
    "method": "POST",
    "path": "/v1/auth/oauth-attempts",
    "gate": "conditional",
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "loginByWechat",
    "method": "POST",
    "path": "/v1/auth/login/wechat",
    "gate": false,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "loginByApple",
    "method": "POST",
    "path": "/v1/auth/login/apple",
    "gate": false,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "loginByHuawei",
    "method": "POST",
    "path": "/v1/auth/login/huawei",
    "gate": false,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "mergeAccount",
    "method": "POST",
    "path": "/v1/auth/merge",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "stepUp",
    "method": "POST",
    "path": "/v1/auth/step-up",
    "gate": "conditional",
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "refreshToken",
    "method": "POST",
    "path": "/v1/auth/refresh",
    "gate": false,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "logout",
    "method": "POST",
    "path": "/v1/auth/logout",
    "gate": false,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "recordConsent",
    "method": "POST",
    "path": "/v1/consents",
    "gate": "conditional",
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "issueH5Token",
    "method": "POST",
    "path": "/v1/auth/h5-token",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "listUnionBindings",
    "method": "GET",
    "path": "/v1/unions/bindings",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getUnionAuthUrl",
    "method": "GET",
    "path": "/v1/unions/:platform/auth-url",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "bindUnion",
    "method": "POST",
    "path": "/v1/unions/:platform/bindings",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "listOrders",
    "method": "GET",
    "path": "/v1/orders",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "listOrderClaims",
    "method": "GET",
    "path": "/v1/orders/claims",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "createOrderClaim",
    "method": "POST",
    "path": "/v1/orders/claims",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "listPendingTracks",
    "method": "GET",
    "path": "/v1/orders/pending-tracks",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "dismissPendingTrack",
    "method": "POST",
    "path": "/v1/orders/pending-tracks/:link_id/dismiss",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getOrder",
    "method": "GET",
    "path": "/v1/orders/:order_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getAgreements",
    "method": "GET",
    "path": "/v1/agreements",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getAgreementVersion",
    "method": "GET",
    "path": "/v1/agreements/:type",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "listArticles",
    "method": "GET",
    "path": "/v1/articles",
    "gate": null,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "getArticle",
    "method": "GET",
    "path": "/v1/articles/:article_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "checkAppVersion",
    "method": "GET",
    "path": "/v1/app-versions/check",
    "gate": null,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "getPage",
    "method": "GET",
    "path": "/v1/pages/:page_key",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "previewPage",
    "method": "GET",
    "path": "/v1/pages/:page_key/preview",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "listPageSectionItems",
    "method": "GET",
    "path": "/v1/pages/:page_key/sections/:section_id/items",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getMessage",
    "method": "GET",
    "path": "/v1/messages/:message_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "listMessages",
    "method": "GET",
    "path": "/v1/messages",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "markMessagesRead",
    "method": "POST",
    "path": "/v1/messages/read",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getUnreadMessageCount",
    "method": "GET",
    "path": "/v1/messages/unread-count",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getWalletSummary",
    "method": "GET",
    "path": "/v1/wallet/summary",
    "gate": null,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "getEarningsSummary",
    "method": "GET",
    "path": "/v1/earnings/summary",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "listWalletLedger",
    "method": "GET",
    "path": "/v1/wallet/ledger",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getWithdrawRules",
    "method": "GET",
    "path": "/v1/withdrawals/rules",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "listWithdrawals",
    "method": "GET",
    "path": "/v1/withdrawals",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "createWithdrawal",
    "method": "POST",
    "path": "/v1/withdrawals",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "getWithdrawal",
    "method": "GET",
    "path": "/v1/withdrawals/:withdrawal_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "createPayOrder",
    "method": "POST",
    "path": "/v1/pay/orders",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "getPayOrder",
    "method": "GET",
    "path": "/v1/pay/orders/:pay_order_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "payOrderReturned",
    "method": "POST",
    "path": "/v1/pay/orders/:pay_order_id/returned",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "cancelPayOrder",
    "method": "POST",
    "path": "/v1/pay/orders/:pay_order_id/cancel",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getMe",
    "method": "GET",
    "path": "/v1/me",
    "gate": null,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "updateMe",
    "method": "PATCH",
    "path": "/v1/me",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "bindPhone",
    "method": "POST",
    "path": "/v1/me/phone",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "bindInviter",
    "method": "POST",
    "path": "/v1/me/inviter",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "getMyInvite",
    "method": "GET",
    "path": "/v1/invites/me",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "sendLandingSmsCode",
    "method": "POST",
    "path": "/v1/landing/sms-codes",
    "gate": false,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "landingRegister",
    "method": "POST",
    "path": "/v1/invites/landing-register",
    "gate": false,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "getReverify",
    "method": "GET",
    "path": "/v1/me/reverify",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "reverifyByIdNumber",
    "method": "POST",
    "path": "/v1/me/reverify/id-number",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "reverifyByOauth",
    "method": "POST",
    "path": "/v1/me/reverify/oauth",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "bindOauthIdentity",
    "method": "POST",
    "path": "/v1/me/oauth-bindings",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "getPayoutAccount",
    "method": "GET",
    "path": "/v1/me/payout-account",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "savePayoutAccount",
    "method": "PUT",
    "path": "/v1/me/payout-account",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "submitRealname",
    "method": "POST",
    "path": "/v1/me/realname",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "getLaborAgreement",
    "method": "GET",
    "path": "/v1/me/labor-agreement",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "signLaborAgreement",
    "method": "POST",
    "path": "/v1/me/labor-agreement/sign",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "getTips",
    "method": "GET",
    "path": "/v1/me/tips",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "markTipRead",
    "method": "POST",
    "path": "/v1/me/tips/:tip_key/read",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "resetTip",
    "method": "DELETE",
    "path": "/v1/me/tips/:tip_key",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getNotificationSettings",
    "method": "GET",
    "path": "/v1/me/notification-settings",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "updateNotificationSettings",
    "method": "PUT",
    "path": "/v1/me/notification-settings",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getDeletion",
    "method": "GET",
    "path": "/v1/me/deletion",
    "gate": null,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "requestDeletion",
    "method": "POST",
    "path": "/v1/me/deletion",
    "gate": false,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": true
  },
  {
    "operationId": "cancelDeletion",
    "method": "POST",
    "path": "/v1/me/deletion/cancel",
    "gate": false,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "listMyDataCopies",
    "method": "GET",
    "path": "/v1/me/data-copies",
    "gate": null,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "getMyDataCopyDownload",
    "method": "GET",
    "path": "/v1/me/data-copies/:id/download",
    "gate": null,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "listAppeals",
    "method": "GET",
    "path": "/v1/me/appeals",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "submitAppeal",
    "method": "POST",
    "path": "/v1/me/appeals",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "abandonIdempotencyKey",
    "method": "POST",
    "path": "/v1/idempotency-keys/abandon",
    "gate": "conditional",
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "getConfig",
    "method": "GET",
    "path": "/v1/config",
    "gate": null,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "getDict",
    "method": "GET",
    "path": "/v1/dict",
    "gate": null,
    "sessionScopes": [
      "full",
      "deletion_only"
    ],
    "idempotent": false
  },
  {
    "operationId": "searchProducts",
    "method": "GET",
    "path": "/v1/products/search",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getProduct",
    "method": "GET",
    "path": "/v1/products/:product_key",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getProductPriceTrend",
    "method": "GET",
    "path": "/v1/products/:product_key/price-trend",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "submitProductFeedback",
    "method": "POST",
    "path": "/v1/products/:product_key/feedback",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "openProductShop",
    "method": "POST",
    "path": "/v1/products/:product_key/shop/open",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "getHotRank",
    "method": "GET",
    "path": "/v1/rank/hot",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getSearchHotWords",
    "method": "GET",
    "path": "/v1/search/hot-words",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "listFavorites",
    "method": "GET",
    "path": "/v1/me/favorites",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "addFavorite",
    "method": "PUT",
    "path": "/v1/me/favorites/:platform/:product_key",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "removeFavorite",
    "method": "DELETE",
    "path": "/v1/me/favorites/:platform/:product_key",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "batchDeleteFavorites",
    "method": "POST",
    "path": "/v1/me/favorites/batch-delete",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "parseInput",
    "method": "POST",
    "path": "/v1/inputs/parse",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "openLink",
    "method": "POST",
    "path": "/v1/links/:link_id/open",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "convertLink",
    "method": "POST",
    "path": "/v1/links/convert",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "getLink",
    "method": "GET",
    "path": "/v1/links/:link_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getSharePage",
    "method": "GET",
    "path": "/v1/share-pages/:link_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getShareTpwd",
    "method": "POST",
    "path": "/v1/share-pages/:link_id/tpwd",
    "gate": false,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "createShare",
    "method": "POST",
    "path": "/v1/shares",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "adminLogin",
    "method": "POST",
    "path": "/admin/v1/auth/login",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminChangeInitialPassword",
    "method": "POST",
    "path": "/admin/v1/auth/password",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetTotpBindingSecret",
    "method": "POST",
    "path": "/admin/v1/auth/totp/secret",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminBindTotp",
    "method": "POST",
    "path": "/admin/v1/auth/totp/bind",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminVerifyTotp",
    "method": "POST",
    "path": "/admin/v1/auth/totp",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminLogout",
    "method": "POST",
    "path": "/admin/v1/auth/logout",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminSendStepUpSms",
    "method": "POST",
    "path": "/admin/v1/auth/step-up/sms-codes",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminStepUp",
    "method": "POST",
    "path": "/admin/v1/auth/step-up",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetMyPermissions",
    "method": "GET",
    "path": "/admin/v1/me/permissions",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminSendMyVerifyPhoneCode",
    "method": "POST",
    "path": "/admin/v1/me/verify-phone/sms-codes",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminChangeMyVerifyPhone",
    "method": "PUT",
    "path": "/admin/v1/me/verify-phone",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetDashboard",
    "method": "GET",
    "path": "/admin/v1/dashboard",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListAdmins",
    "method": "GET",
    "path": "/admin/v1/admins",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminCreateAdmin",
    "method": "POST",
    "path": "/admin/v1/admins",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetAdmin",
    "method": "GET",
    "path": "/admin/v1/admins/:admin_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminRegenerateAdminInitialPassword",
    "method": "POST",
    "path": "/admin/v1/admins/:admin_id/initial-password",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminDisableAdmin",
    "method": "POST",
    "path": "/admin/v1/admins/:admin_id/disable",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminEnableAdmin",
    "method": "POST",
    "path": "/admin/v1/admins/:admin_id/enable",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminSaveAdminPermissions",
    "method": "PUT",
    "path": "/admin/v1/admins/:admin_id/permissions",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminResetAdminTotp",
    "method": "POST",
    "path": "/admin/v1/admins/:admin_id/totp/reset",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminUpdateAdminDisplayName",
    "method": "PUT",
    "path": "/admin/v1/admins/:admin_id/display-name",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminSendAdminVerifyPhoneCode",
    "method": "POST",
    "path": "/admin/v1/admins/:admin_id/verify-phone/sms-codes",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminChangeAdminVerifyPhone",
    "method": "PUT",
    "path": "/admin/v1/admins/:admin_id/verify-phone",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListAuditLogs",
    "method": "GET",
    "path": "/admin/v1/audit-logs",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetAuditLog",
    "method": "GET",
    "path": "/admin/v1/audit-logs/:id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListExports",
    "method": "GET",
    "path": "/admin/v1/exports",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminCreateExport",
    "method": "POST",
    "path": "/admin/v1/exports",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminDownloadExport",
    "method": "GET",
    "path": "/admin/v1/exports/:id/download",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminRetryExport",
    "method": "POST",
    "path": "/admin/v1/exports/:id/retry",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListUsers",
    "method": "GET",
    "path": "/admin/v1/users",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListInviteRewards",
    "method": "GET",
    "path": "/admin/v1/invite-rewards",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetInviteReward",
    "method": "GET",
    "path": "/admin/v1/invite-rewards/:invitee_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminSearch",
    "method": "GET",
    "path": "/admin/v1/search",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminLookupUser",
    "method": "GET",
    "path": "/admin/v1/users/lookup",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetUser",
    "method": "GET",
    "path": "/admin/v1/users/:user_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminRevealUserField",
    "method": "POST",
    "path": "/admin/v1/users/:user_id/reveal",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminUpdateUserRiskState",
    "method": "PUT",
    "path": "/admin/v1/users/:user_id/risk-state",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminResetUserUnionBinding",
    "method": "POST",
    "path": "/admin/v1/users/:user_id/union-bindings/:platform/reset",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminDisableUserUnionBinding",
    "method": "POST",
    "path": "/admin/v1/users/:user_id/union-bindings/:platform/disable",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminEnableUserUnionBinding",
    "method": "POST",
    "path": "/admin/v1/users/:user_id/union-bindings/:platform/enable",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListInvitees",
    "method": "GET",
    "path": "/admin/v1/users/:user_id/invitees",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminChangeUserLevel",
    "method": "POST",
    "path": "/admin/v1/users/:user_id/level",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminChangeInviter",
    "method": "POST",
    "path": "/admin/v1/users/:user_id/inviter",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminEditUserProfile",
    "method": "PATCH",
    "path": "/admin/v1/users/:user_id/profile",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListUserDevices",
    "method": "GET",
    "path": "/admin/v1/users/:user_id/devices",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminAddUserReverifiedDevice",
    "method": "POST",
    "path": "/admin/v1/users/:user_id/reverified-devices",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminCorrectUserRealname",
    "method": "POST",
    "path": "/admin/v1/users/:user_id/realname-correction",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListUserDataExports",
    "method": "GET",
    "path": "/admin/v1/users/:user_id/data-exports",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminCreateUserDataExport",
    "method": "POST",
    "path": "/admin/v1/users/:user_id/data-exports",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminDownloadUserDataExport",
    "method": "POST",
    "path": "/admin/v1/users/:user_id/data-exports/:export_id/download",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListOrders",
    "method": "GET",
    "path": "/admin/v1/orders",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetOrder",
    "method": "GET",
    "path": "/admin/v1/orders/:order_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminHoldOrder",
    "method": "POST",
    "path": "/admin/v1/orders/:order_id/hold",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminUnholdOrder",
    "method": "POST",
    "path": "/admin/v1/orders/:order_id/unhold",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminReassignOrder",
    "method": "POST",
    "path": "/admin/v1/orders/:order_id/reassign",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListOrderSyncs",
    "method": "GET",
    "path": "/admin/v1/order-syncs",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminCreateOrderSync",
    "method": "POST",
    "path": "/admin/v1/order-syncs",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetOrderSyncLimits",
    "method": "GET",
    "path": "/admin/v1/order-syncs/limits",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListRightsImports",
    "method": "GET",
    "path": "/admin/v1/rights-imports",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminCreateRightsImport",
    "method": "POST",
    "path": "/admin/v1/rights-imports",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetRightsImport",
    "method": "GET",
    "path": "/admin/v1/rights-imports/:import_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListClaims",
    "method": "GET",
    "path": "/admin/v1/claims",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetClaim",
    "method": "GET",
    "path": "/admin/v1/claims/:claim_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminApproveClaimItem",
    "method": "POST",
    "path": "/admin/v1/claims/:claim_id/items/:item_id/approve",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminRejectClaimItem",
    "method": "POST",
    "path": "/admin/v1/claims/:claim_id/items/:item_id/reject",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListUnionAccounts",
    "method": "GET",
    "path": "/admin/v1/union-accounts",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminStartUnionReauthorization",
    "method": "POST",
    "path": "/admin/v1/union-accounts/:union_account_id/reauthorize",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetUnionReauthorization",
    "method": "GET",
    "path": "/admin/v1/union-accounts/:union_account_id/reauthorize/:session_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminCompleteUnionReauthorization",
    "method": "POST",
    "path": "/admin/v1/union-accounts/oauth/callback",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminPutUnionCredential",
    "method": "PUT",
    "path": "/admin/v1/union-accounts/:union_account_id/credential",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListUnionAlertPhones",
    "method": "GET",
    "path": "/admin/v1/union-accounts/alert-phones",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminAddUnionAlertPhone",
    "method": "POST",
    "path": "/admin/v1/union-accounts/alert-phones",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminRemoveUnionAlertPhone",
    "method": "DELETE",
    "path": "/admin/v1/union-accounts/alert-phones",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListUnionAccountOptions",
    "method": "GET",
    "path": "/admin/v1/union/account-options",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListUnionPids",
    "method": "GET",
    "path": "/admin/v1/union-pids",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminCreateUnionPid",
    "method": "POST",
    "path": "/admin/v1/union-pids",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminUpdateUnionPid",
    "method": "PATCH",
    "path": "/admin/v1/union-pids/:pid_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminActivateUnionPid",
    "method": "POST",
    "path": "/admin/v1/union-pids/:pid_id/activate",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminRetireUnionPid",
    "method": "POST",
    "path": "/admin/v1/union-pids/:pid_id/retire",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListPlatformIcons",
    "method": "GET",
    "path": "/admin/v1/platform-icons",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListPlatformIconVersions",
    "method": "GET",
    "path": "/admin/v1/platform-icons/:key/versions",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminCreatePlatformIconVersion",
    "method": "POST",
    "path": "/admin/v1/platform-icons/:key/versions",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminUploadPlatformIcon",
    "method": "POST",
    "path": "/admin/v1/platform-icons/:key/uploads",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminUpdatePlatformIconVersion",
    "method": "PATCH",
    "path": "/admin/v1/platform-icons/:key/versions/:version",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminPublishPlatformIcon",
    "method": "POST",
    "path": "/admin/v1/platform-icons/:key/publish",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminRestoreBuiltinPlatformIcon",
    "method": "POST",
    "path": "/admin/v1/platform-icons/:key/restore-builtin",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListPageConfigs",
    "method": "GET",
    "path": "/admin/v1/pages",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminUploadPopupAsset",
    "method": "POST",
    "path": "/admin/v1/pages/popup-assets",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetPageConfig",
    "method": "GET",
    "path": "/admin/v1/pages/:page_key",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListPageConfigVersions",
    "method": "GET",
    "path": "/admin/v1/pages/:page_key/versions",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminCreatePageConfigVersion",
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/versions",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetPageConfigVersion",
    "method": "GET",
    "path": "/admin/v1/pages/:page_key/versions/:version",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminPublishPageConfig",
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/publish",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminCancelPageConfigSchedule",
    "method": "DELETE",
    "path": "/admin/v1/pages/:page_key/schedule",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminUpdatePageConfigGray",
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/gray",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminRollbackPageConfig",
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/rollback",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminCreatePagePreviewToken",
    "method": "POST",
    "path": "/admin/v1/pages/:page_key/preview-tokens",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListAgreements",
    "method": "GET",
    "path": "/admin/v1/agreements",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminPublishAgreementVersion",
    "method": "POST",
    "path": "/admin/v1/agreements/:type/versions",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetAgreementVersion",
    "method": "GET",
    "path": "/admin/v1/agreements/:type/versions/:version",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListProductPools",
    "method": "GET",
    "path": "/admin/v1/product-pools",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminCreateProductPool",
    "method": "POST",
    "path": "/admin/v1/product-pools",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminSearchPoolCandidates",
    "method": "GET",
    "path": "/admin/v1/product-pools/candidates",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetProductPool",
    "method": "GET",
    "path": "/admin/v1/product-pools/:pool_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminUpdateProductPool",
    "method": "PATCH",
    "path": "/admin/v1/product-pools/:pool_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListPoolItems",
    "method": "GET",
    "path": "/admin/v1/product-pools/:pool_id/items",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminAddPoolItem",
    "method": "POST",
    "path": "/admin/v1/product-pools/:pool_id/items",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminRemovePoolItem",
    "method": "DELETE",
    "path": "/admin/v1/product-pools/:pool_id/items/:product_key",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminUpdatePoolItem",
    "method": "PATCH",
    "path": "/admin/v1/product-pools/:pool_id/items/:product_key",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListArticles",
    "method": "GET",
    "path": "/admin/v1/articles",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminCreateArticle",
    "method": "POST",
    "path": "/admin/v1/articles",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetArticle",
    "method": "GET",
    "path": "/admin/v1/articles/:article_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminSaveArticleDraft",
    "method": "PUT",
    "path": "/admin/v1/articles/:article_id/draft",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminPublishArticle",
    "method": "POST",
    "path": "/admin/v1/articles/:article_id/publish",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminOfflineArticle",
    "method": "POST",
    "path": "/admin/v1/articles/:article_id/offline",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListDictItems",
    "method": "GET",
    "path": "/admin/v1/dict-items",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminSaveDictItems",
    "method": "PUT",
    "path": "/admin/v1/dict-items",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListDictItemVersions",
    "method": "GET",
    "path": "/admin/v1/dict-items/versions",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminRollbackDictItems",
    "method": "POST",
    "path": "/admin/v1/dict-items/rollback",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetDict",
    "method": "GET",
    "path": "/admin/v1/dict",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListNotifyChannels",
    "method": "GET",
    "path": "/admin/v1/notify-channels",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminSwitchNotifyChannels",
    "method": "PATCH",
    "path": "/admin/v1/notify-channels/:code",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminRegisterNotifySms",
    "method": "PUT",
    "path": "/admin/v1/notify-channels/:code/sms",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminDiscardNotifySms",
    "method": "DELETE",
    "path": "/admin/v1/notify-channels/:code/sms/pending",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminRetestNotifySms",
    "method": "POST",
    "path": "/admin/v1/notify-channels/:code/sms/pending/test",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminEnableNotifySms",
    "method": "POST",
    "path": "/admin/v1/notify-channels/:code/sms/pending/enable",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListAppVersions",
    "method": "GET",
    "path": "/admin/v1/app-versions",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetAppVersion",
    "method": "GET",
    "path": "/admin/v1/app-versions/:platform/:channel",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminSaveAppVersion",
    "method": "PUT",
    "path": "/admin/v1/app-versions/:platform/:channel",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListRiskRules",
    "method": "GET",
    "path": "/admin/v1/risk-rules",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminEnableRiskRule",
    "method": "POST",
    "path": "/admin/v1/risk-rules/:rule_id/enable",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminDisableRiskRule",
    "method": "POST",
    "path": "/admin/v1/risk-rules/:rule_id/disable",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListAppeals",
    "method": "GET",
    "path": "/admin/v1/appeals",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminRegisterAppeal",
    "method": "POST",
    "path": "/admin/v1/appeals",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetAppeal",
    "method": "GET",
    "path": "/admin/v1/appeals/:appeal_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminClaimAppeal",
    "method": "POST",
    "path": "/admin/v1/appeals/:appeal_id/claim",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminResolveAppeal",
    "method": "POST",
    "path": "/admin/v1/appeals/:appeal_id/resolve",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListBlockedRequests",
    "method": "GET",
    "path": "/admin/v1/blocked-requests",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "listAdminPayOrders",
    "method": "GET",
    "path": "/admin/v1/pay-orders",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getAdminPayOrder",
    "method": "GET",
    "path": "/admin/v1/pay-orders/:pay_order_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "resolveAdminPayOrder",
    "method": "POST",
    "path": "/admin/v1/pay-orders/:pay_order_id/resolve",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "createAdminPayRefund",
    "method": "POST",
    "path": "/admin/v1/pay-orders/:pay_order_id/refunds",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "listAdminPayRefunds",
    "method": "GET",
    "path": "/admin/v1/pay-refunds",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getAdminPayRefund",
    "method": "GET",
    "path": "/admin/v1/pay-refunds/:pay_refund_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "listAdminPayAnomalies",
    "method": "GET",
    "path": "/admin/v1/pay-anomalies",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "createAdminPayAnomalyRefund",
    "method": "POST",
    "path": "/admin/v1/pay-anomalies/:pay_anomaly_id/refunds",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "listAdminPayReconDiffs",
    "method": "GET",
    "path": "/admin/v1/pay-recon-diffs",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "listAdminReconDiffs",
    "method": "GET",
    "path": "/admin/v1/recon-diffs",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getAdminReconDiff",
    "method": "GET",
    "path": "/admin/v1/recon-diffs/:recon_diff_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "closeAdminReconDiff",
    "method": "POST",
    "path": "/admin/v1/recon-diffs/:recon_diff_id/close",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "writeOffAdminReconDiff",
    "method": "POST",
    "path": "/admin/v1/recon-diffs/:recon_diff_id/write-off",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "restoreAdminReconDiff",
    "method": "POST",
    "path": "/admin/v1/recon-diffs/:recon_diff_id/restore",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "adminListAdjustments",
    "method": "GET",
    "path": "/admin/v1/adjustments",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminCreateAdjustment",
    "method": "POST",
    "path": "/admin/v1/adjustments",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "adminGetAdjustment",
    "method": "GET",
    "path": "/admin/v1/adjustments/:adjust_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminApproveAdjustment",
    "method": "POST",
    "path": "/admin/v1/adjustments/:adjust_id/approve",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "adminRejectAdjustment",
    "method": "POST",
    "path": "/admin/v1/adjustments/:adjust_id/reject",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "adminListBadDebtWriteoffs",
    "method": "GET",
    "path": "/admin/v1/bad-debt-writeoffs",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminApproveBadDebtWriteoff",
    "method": "POST",
    "path": "/admin/v1/bad-debt-writeoffs/:id/approve",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "adminListSettleAdjustments",
    "method": "GET",
    "path": "/admin/v1/settle-adjustments",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminApproveSettleAdjustBatch",
    "method": "POST",
    "path": "/admin/v1/settle-adjust-batches/:batch_id/approve",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "adminRejectSettleAdjustBatch",
    "method": "POST",
    "path": "/admin/v1/settle-adjust-batches/:batch_id/reject",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "adminRunSettleAdjust",
    "method": "POST",
    "path": "/admin/v1/settle-adjust-runs",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "listAdminWithdrawals",
    "method": "GET",
    "path": "/admin/v1/withdrawals",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getAdminWithdrawal",
    "method": "GET",
    "path": "/admin/v1/withdrawals/:withdrawal_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminBatchApproveWithdrawals",
    "method": "POST",
    "path": "/admin/v1/withdrawals/batch-approve",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "adminBatchManualPaid",
    "method": "POST",
    "path": "/admin/v1/withdrawals/batch-manual-paid",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "adminListUnknownPayouts",
    "method": "GET",
    "path": "/admin/v1/unknown-payouts",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminQueryPayoutResult",
    "method": "POST",
    "path": "/admin/v1/withdrawals/:withdrawal_id/query",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "adminResolveUnknownPayout",
    "method": "POST",
    "path": "/admin/v1/withdrawals/:withdrawal_id/resolve",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "adminRejectWithdrawal",
    "method": "POST",
    "path": "/admin/v1/withdrawals/:withdrawal_id/reject",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "listAdminSettleBills",
    "method": "GET",
    "path": "/admin/v1/settle-bills",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getAdminSettleBill",
    "method": "GET",
    "path": "/admin/v1/settle-bills/:bill_id",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "confirmAdminSettleBill",
    "method": "POST",
    "path": "/admin/v1/settle-bills/:bill_id/confirm",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "createAdminSettleSupplementBatches",
    "method": "POST",
    "path": "/admin/v1/settle-bills/:bill_id/supplement-batches",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "listAdminSettleBatchItems",
    "method": "GET",
    "path": "/admin/v1/settle-batches/:batch_id/items",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "cancelAdminSettleBatchSchedule",
    "method": "POST",
    "path": "/admin/v1/settle-batches/:batch_id/cancel-schedule",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "rejectAdminSettleBatch",
    "method": "POST",
    "path": "/admin/v1/settle-batches/:batch_id/reject",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "resumeAdminSettleBatch",
    "method": "POST",
    "path": "/admin/v1/settle-batches/:batch_id/resume",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "listAdminAssetSnapshots",
    "method": "GET",
    "path": "/admin/v1/asset-snapshots",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListUnionReceipts",
    "method": "GET",
    "path": "/admin/v1/union-receipts",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminCreateUnionReceipt",
    "method": "POST",
    "path": "/admin/v1/union-receipts",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "adminReverseUnionReceipt",
    "method": "POST",
    "path": "/admin/v1/union-receipts/:receipt_id/reverse",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "adminCreatePayoutWatermark",
    "method": "POST",
    "path": "/admin/v1/payout-watermarks",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "adminCreatePayoutBatch",
    "method": "POST",
    "path": "/admin/v1/payout-batches",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": true
  },
  {
    "operationId": "adminGetPayoutOverview",
    "method": "GET",
    "path": "/admin/v1/payout-overview",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetFundLedger",
    "method": "GET",
    "path": "/admin/v1/fund-ledger",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListKillSwitches",
    "method": "GET",
    "path": "/admin/v1/kill-switches",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminUpdateKillSwitch",
    "method": "PUT",
    "path": "/admin/v1/kill-switches/:key",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListConfigItems",
    "method": "GET",
    "path": "/admin/v1/config-items",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminBatchUpdateConfigItems",
    "method": "POST",
    "path": "/admin/v1/config-items/batch",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminGetConfigItem",
    "method": "GET",
    "path": "/admin/v1/config-items/:key",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminUpdateConfigItem",
    "method": "PUT",
    "path": "/admin/v1/config-items/:key",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListConfigItemVersions",
    "method": "GET",
    "path": "/admin/v1/config-items/:key/versions",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminRollbackConfigItem",
    "method": "POST",
    "path": "/admin/v1/config-items/:key/rollback",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "createAgentSession",
    "method": "POST",
    "path": "/v1/agent/sessions",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "getCurrentAgentSession",
    "method": "GET",
    "path": "/v1/agent/sessions/current",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "listAgentSessionMessages",
    "method": "GET",
    "path": "/v1/agent/sessions/:id/messages",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "sendAgentMessage",
    "method": "POST",
    "path": "/v1/agent/sessions/:id/messages",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "cancelAgentRun",
    "method": "POST",
    "path": "/v1/agent/runs/:run_id/cancel",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "setAgentMessageFeedback",
    "method": "POST",
    "path": "/v1/agent/messages/:message_id/feedback",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "reportAgentMessage",
    "method": "POST",
    "path": "/v1/agent/messages/:message_id/report",
    "gate": true,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  },
  {
    "operationId": "adminListProductFeedbacks",
    "method": "GET",
    "path": "/admin/v1/product-feedbacks",
    "gate": null,
    "sessionScopes": [
      "full"
    ],
    "idempotent": false
  }
] as const;
