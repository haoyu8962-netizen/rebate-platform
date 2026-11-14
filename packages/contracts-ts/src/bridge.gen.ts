// GENERATED FILE. Do not edit by hand.
// Source: contracts/bridge.schema.json, contracts/routes.json, contracts/apps.json
// Regenerate: pnpm contracts:codegen (drift is checked by pnpm contracts:check)

export type paths = Record<string, never>;
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /**
         * @description contracts/enums platform
         * @enum {string}
         */
        Platform: "taobao" | "jd" | "pdd" | "meituan" | "vip" | "douyin" | "eleme" | "kuaishou" | "suning";
        /** @description Opaque product key (BR-PROD-02) */
        ProductKey: string;
        /** @description Opaque signed reference, passed through unchanged (BR-PROD-11) */
        ItemRef: string;
        /**
         * @description contracts/enums union_binding_status
         * @enum {string}
         */
        UnionBindingStatus: "unbound" | "pending_auth" | "active" | "invalid" | "released" | "blocked";
        /**
         * @description Keys of contracts/apps.json
         * @enum {string}
         */
        AppTarget: "taobao" | "jd" | "pdd";
        AppGetEnvParams: Record<string, never>;
        AppGetEnvResult: {
            /** @enum {string} */
            platform: "ios" | "android" | "harmony";
            /** @description SemVer, same number on all apps (拍板第二批 TECH-07) */
            app_version: string;
            build: string;
            os_version: string;
            bridge_version: number;
            /** @description Insets in points */
            safe_area: {
                top: number;
                bottom: number;
                left: number;
                right: number;
            };
            /**
             * @description contracts/enums install_channel
             * @enum {string}
             */
            channel: "appstore" | "official" | "huawei" | "agc";
        };
        AppGetConfigParams: {
            keys: string[];
        };
        AppGetConfigResult: {
            /** @description Subset of /v1/config limited to the keys whitelisted for H5 */
            values: {
                [key: string]: unknown;
            };
        };
        AuthGetUserParams: Record<string, never>;
        /** @description No token of any kind is returned (04 §9, BR-ID-32) */
        AuthGetUserResult: {
            uid: string;
            nickname: string;
            avatar: string;
            phone_bound: boolean;
            /** @enum {string} */
            realname_status: "none" | "verified" | "failed";
            bindings: {
                taobao: components["schemas"]["UnionBindingStatus"];
                pdd: components["schemas"]["UnionBindingStatus"];
            };
        };
        AuthLoginParams: Record<string, never>;
        AuthLoginResult: {
            logged_in: boolean;
        };
        AuthGetH5TokenParams: Record<string, never>;
        /** @description aud=h5; lifetime and scope per BR-ID-32 (no withdrawal, payout account, real name, deletion, phone change) */
        AuthGetH5TokenResult: {
            token: string;
            /** Format: date-time */
            expire_at: string;
            /**
             * @description contracts/enums h5_token_scope
             * @enum {string}
             */
            scope: "standard" | "read_only";
        };
        NetSignedRequestParams: {
            /**
             * @description Methods present in signed_paths
             * @enum {string}
             */
            method: "POST";
            /** @description Path plus raw query, without host. Native compares the path part (query removed) exactly with signed_paths; '.', '%' and empty segments are rejected by the pattern */
            path: string;
            /** @description JSON request body, sent as is */
            body?: unknown;
        };
        NetSignedRequestResult: {
            status: number;
            /** @description Parsed JSON response envelope of the API */
            body: unknown;
        };
        UiToastParams: {
            text: string;
            /** @enum {string} */
            duration?: "short" | "long";
        };
        UiToastResult: Record<string, never>;
        UiShowLoadingParams: {
            text?: string;
        };
        UiShowLoadingResult: Record<string, never>;
        UiHideLoadingParams: Record<string, never>;
        UiHideLoadingResult: Record<string, never>;
        UiSetNavBarParams: {
            visible?: boolean;
            title?: string;
            bg_color?: string;
            bg_gradient?: string[];
            bg_image?: string;
            text_color?: string;
            /** @enum {string} */
            status_bar_style?: "light" | "dark";
            immersive?: boolean;
            hide_close?: boolean;
            hide_bottom_safe_area?: boolean;
            bounce?: boolean;
        };
        UiSetNavBarResult: Record<string, never>;
        NavOpenParams: {
            /** @description Route name from routes.json; unknown or newer than this app → upgrade page (03 §4.4) */
            route: string;
            /** @description Route params, validated against routes.json */
            params?: {
                [key: string]: unknown;
            };
        };
        NavOpenResult: {
            opened: boolean;
        };
        NavCloseParams: Record<string, never>;
        NavCloseResult: Record<string, never>;
        TradeOpenProductParams: {
            platform: components["schemas"]["Platform"];
            product_key: components["schemas"]["ProductKey"];
            item_ref?: components["schemas"]["ItemRef"];
        };
        TradeOpenProductResult: {
            opened: boolean;
        };
        /** @description product_key (with item_ref) or url, exactly one (04 §9); platform is optional and derived by native when absent */
        TradeConvertAndOpenParams: {
            platform?: components["schemas"]["Platform"];
            product_key?: components["schemas"]["ProductKey"];
            item_ref?: components["schemas"]["ItemRef"];
            url?: string;
            spm?: string;
        } & ({
            product_key: components["schemas"]["ProductKey"];
        } | {
            url: string;
        });
        TradeConvertAndOpenResult: {
            jumped: boolean;
            /** @description Step at which the flow ended; values are fixed by specs/client-behavior.md (CT-09) */
            step: string;
        };
        TradeAuthorizeParams: {
            platform: components["schemas"]["Platform"];
        };
        TradeAuthorizeResult: {
            status: components["schemas"]["UnionBindingStatus"];
        };
        TradeOpenUnionActivityParams: {
            platform: components["schemas"]["Platform"];
            activity_id: string;
        };
        TradeOpenUnionActivityResult: {
            jumped: boolean;
        };
        ShareOpenParams: {
            /** @enum {string} */
            channel?: "wechat_session" | "wechat_timeline" | "system";
            content: {
                /** @enum {string} */
                type: "link";
                url: string;
                title: string;
                desc?: string;
                thumb?: string;
            } | {
                /** @enum {string} */
                type: "image";
                images: string[];
            };
            show_panel?: boolean;
        };
        ShareOpenResult: {
            shared: boolean;
        };
        MediaSaveImageParams: {
            urls: string[];
        };
        MediaSaveImageResult: {
            saved: boolean;
        };
        MediaPreviewImageParams: {
            urls: string[];
            index?: number;
        };
        MediaPreviewImageResult: Record<string, never>;
        ClipboardWriteParams: {
            text: string;
        };
        ClipboardWriteResult: Record<string, never>;
        ClipboardReadParams: Record<string, never>;
        ClipboardReadResult: {
            text: string;
        };
        ClipboardSetAutoDetectParams: {
            enabled: boolean;
        };
        ClipboardSetAutoDetectResult: Record<string, never>;
        ExtOpenAppParams: {
            target: components["schemas"]["AppTarget"];
            url: string;
        };
        ExtOpenAppResult: {
            opened: boolean;
            /**
             * @description contracts/enums installed_state; unknown when detection fails or the target is not declared (BR-ATTR-27 ①)
             * @enum {string}
             */
            installed: "true" | "false" | "unknown";
        };
        ExtOpenBrowserParams: {
            url: string;
        };
        ExtOpenBrowserResult: Record<string, never>;
        ExtOpenMiniProgramParams: {
            app_id: string;
            path?: string;
        };
        ExtOpenMiniProgramResult: {
            opened: boolean;
        };
        CsOpenParams: {
            entry: string;
            /** @description Page-side context kept by native; never put into the support link (BR-ID-33 细则) */
            context?: {
                [key: string]: unknown;
            };
        };
        CsOpenResult: {
            opened: boolean;
        };
        PermGetPushStatusParams: Record<string, never>;
        PermGetPushStatusResult: {
            enabled: boolean;
        };
        PermRequestParams: {
            /** @enum {string} */
            type: "push" | "photos";
        };
        PermRequestResult: {
            granted: boolean;
        };
        TrackEventParams: {
            name: string;
            /** @description Event properties per specs/events.yaml (CT-13) */
            props?: {
                [key: string]: unknown;
            };
        };
        TrackEventResult: Record<string, never>;
        MediaScanParams: Record<string, never>;
        MediaScanResult: Record<string, never>;
        MediaUploadImageParams: Record<string, never>;
        MediaUploadImageResult: Record<string, never>;
        AppResumeEvent: Record<string, never>;
        AppPauseEvent: Record<string, never>;
        AuthChangedEvent: {
            logged_in: boolean;
        };
        PageVisibleEvent: {
            visible: boolean;
        };
        RouteLaunchParams: Record<string, never>;
        RouteBasicModeParams: Record<string, never>;
        RouteLoginParams: Record<string, never>;
        RouteBindPhoneParams: Record<string, never>;
        RouteHomeParams: Record<string, never>;
        RouteSearchParams: {
            q?: string;
            /** @enum {string} */
            platform?: "taobao" | "jd" | "pdd" | "meituan" | "vip" | "douyin" | "eleme" | "kuaishou" | "suning";
        };
        RouteHotRankListParams: {
            /** @enum {string} */
            platform?: "taobao" | "jd" | "pdd" | "meituan" | "vip" | "douyin" | "eleme" | "kuaishou" | "suning";
        };
        RouteProductDetailParams: {
            /** @enum {string} */
            platform: "taobao" | "jd" | "pdd" | "meituan" | "vip" | "douyin" | "eleme" | "kuaishou" | "suning";
            product_key: string;
            item_ref?: string;
        };
        RouteProductShareParams: {
            /** @enum {string} */
            platform: "taobao" | "jd" | "pdd" | "meituan" | "vip" | "douyin" | "eleme" | "kuaishou" | "suning";
            product_key: string;
            link_id?: string;
        };
        RouteShareHubParams: Record<string, never>;
        RouteFavoritesParams: Record<string, never>;
        RouteAuthSheetParams: {
            /** @enum {string} */
            platform: "taobao" | "jd" | "pdd" | "meituan" | "vip" | "douyin" | "eleme" | "kuaishou" | "suning";
        };
        RouteJumpTipParams: {
            /** @enum {string} */
            platform: "taobao" | "jd" | "pdd" | "meituan" | "vip" | "douyin" | "eleme" | "kuaishou" | "suning";
        };
        RouteAgentChatParams: {
            context?: {
                [key: string]: unknown;
            };
        };
        RouteAgentConsentParams: Record<string, never>;
        RouteOrderListParams: {
            /** @enum {string} */
            scope?: "self" | "share";
        };
        RouteOrderDetailParams: {
            order_id: string;
        };
        RouteFindOrderParams: Record<string, never>;
        RouteMeParams: Record<string, never>;
        RouteWalletParams: Record<string, never>;
        RouteWithdrawParams: Record<string, never>;
        RouteWithdrawRecordsParams: {
            /** @description 定位本人的一张提现单并展开详情；不是本人的按不存在处理，只显示列表 */
            withdrawal_id?: string;
        };
        RouteLedgerParams: Record<string, never>;
        RouteRealNameParams: Record<string, never>;
        RouteReverifyParams: Record<string, never>;
        RoutePayoutAccountParams: Record<string, never>;
        RouteLaborAgreementParams: Record<string, never>;
        RouteSettingsParams: Record<string, never>;
        RoutePrivacyCenterParams: Record<string, never>;
        RouteDeleteAccountParams: Record<string, never>;
        RouteRiskNoticeParams: Record<string, never>;
        RouteAppealParams: {
            /** @description 带 order_id 为该订单的订单申诉，不带为账户申诉；不另设申诉类型参数 */
            order_id?: string;
        };
        RouteDataCopyParams: Record<string, never>;
        RouteForceUpdateParams: Record<string, never>;
        RouteHomePreviewParams: {
            page_key: string;
            token: string;
        };
        RouteAboutParams: Record<string, never>;
        RouteMessagesParams: Record<string, never>;
        RouteInviteShareParams: Record<string, never>;
        RouteInviteBackfillParams: {
            /**
             * @description me =「我的」补填入口（缺省同 me）；login = 登录成功后的新号步骤；预填码来自本机待绑定码，不进参数
             * @enum {string}
             */
            source?: "me" | "login";
        };
        RouteInviteLinkParams: {
            code: string;
        };
        RouteRulesParams: Record<string, never>;
        RouteHelpParams: {
            article_id?: string;
        };
        RouteNoticeParams: {
            article_id?: string;
        };
        RouteAgreementParams: {
            /** @enum {string} */
            type?: "agreement" | "privacy" | "sdk_list" | "labor_agreement" | "collect_list";
            version?: number;
        };
        RouteWebPageParams: {
            /** @description 只接受 bridge_origins 白名单内的 https 地址，不接受外部传入 */
            url: string;
        };
        RouteExternalPageParams: {
            /** @description 从深链进入时主机必须在 /v1/config.external_hosts 里（完整主机名匹配，BR-ID-10 细则） */
            url: string;
            /** @description 主机名下方的副标题（后台保存时过禁用词）；不能隐藏标题栏、主机名、返回与关闭按钮 */
            title?: string;
            /**
             * @description 标题栏配色，缺省 light；不能隐藏标题栏、主机名、返回与关闭按钮
             * @enum {string}
             */
            nav_style?: "light" | "dark";
        };
        RouteInvitedFriendsParams: Record<string, never>;
        RouteLevelUpgradeParams: Record<string, never>;
        RouteLinkLandingParams: {
            link_id: string;
        };
        RouteEarningsParams: {
            /** @enum {string} */
            platform?: "taobao" | "jd" | "pdd" | "meituan" | "vip" | "douyin" | "eleme" | "kuaishou" | "suning";
        };
        RouteAuthManageParams: Record<string, never>;
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;

/** JSBridge methods (规划/04 §9): params and result per method. */
export interface BridgeMethods {
  "app.getEnv": { params: components['schemas']["AppGetEnvParams"]; result: components['schemas']["AppGetEnvResult"] };
  "app.getConfig": { params: components['schemas']["AppGetConfigParams"]; result: components['schemas']["AppGetConfigResult"] };
  "auth.getUser": { params: components['schemas']["AuthGetUserParams"]; result: components['schemas']["AuthGetUserResult"] };
  "auth.login": { params: components['schemas']["AuthLoginParams"]; result: components['schemas']["AuthLoginResult"] };
  "auth.getH5Token": { params: components['schemas']["AuthGetH5TokenParams"]; result: components['schemas']["AuthGetH5TokenResult"] };
  "net.signedRequest": { params: components['schemas']["NetSignedRequestParams"]; result: components['schemas']["NetSignedRequestResult"] };
  "ui.toast": { params: components['schemas']["UiToastParams"]; result: components['schemas']["UiToastResult"] };
  "ui.showLoading": { params: components['schemas']["UiShowLoadingParams"]; result: components['schemas']["UiShowLoadingResult"] };
  "ui.hideLoading": { params: components['schemas']["UiHideLoadingParams"]; result: components['schemas']["UiHideLoadingResult"] };
  "ui.setNavBar": { params: components['schemas']["UiSetNavBarParams"]; result: components['schemas']["UiSetNavBarResult"] };
  "nav.open": { params: RouteTarget; result: components['schemas']["NavOpenResult"] };
  "nav.close": { params: components['schemas']["NavCloseParams"]; result: components['schemas']["NavCloseResult"] };
  "trade.openProduct": { params: components['schemas']["TradeOpenProductParams"]; result: components['schemas']["TradeOpenProductResult"] };
  "trade.convertAndOpen": { params: components['schemas']["TradeConvertAndOpenParams"]; result: components['schemas']["TradeConvertAndOpenResult"] };
  "trade.authorize": { params: components['schemas']["TradeAuthorizeParams"]; result: components['schemas']["TradeAuthorizeResult"] };
  "trade.openUnionActivity": { params: components['schemas']["TradeOpenUnionActivityParams"]; result: components['schemas']["TradeOpenUnionActivityResult"] };
  "share.open": { params: components['schemas']["ShareOpenParams"]; result: components['schemas']["ShareOpenResult"] };
  "media.saveImage": { params: components['schemas']["MediaSaveImageParams"]; result: components['schemas']["MediaSaveImageResult"] };
  "media.previewImage": { params: components['schemas']["MediaPreviewImageParams"]; result: components['schemas']["MediaPreviewImageResult"] };
  "clipboard.write": { params: components['schemas']["ClipboardWriteParams"]; result: components['schemas']["ClipboardWriteResult"] };
  "clipboard.read": { params: components['schemas']["ClipboardReadParams"]; result: components['schemas']["ClipboardReadResult"] };
  "clipboard.setAutoDetect": { params: components['schemas']["ClipboardSetAutoDetectParams"]; result: components['schemas']["ClipboardSetAutoDetectResult"] };
  "ext.openApp": { params: components['schemas']["ExtOpenAppParams"]; result: components['schemas']["ExtOpenAppResult"] };
  "ext.openBrowser": { params: components['schemas']["ExtOpenBrowserParams"]; result: components['schemas']["ExtOpenBrowserResult"] };
  "ext.openMiniProgram": { params: components['schemas']["ExtOpenMiniProgramParams"]; result: components['schemas']["ExtOpenMiniProgramResult"] };
  "cs.open": { params: components['schemas']["CsOpenParams"]; result: components['schemas']["CsOpenResult"] };
  "perm.getPushStatus": { params: components['schemas']["PermGetPushStatusParams"]; result: components['schemas']["PermGetPushStatusResult"] };
  "perm.request": { params: components['schemas']["PermRequestParams"]; result: components['schemas']["PermRequestResult"] };
  "track.event": { params: components['schemas']["TrackEventParams"]; result: components['schemas']["TrackEventResult"] };
  "media.scan": { params: components['schemas']["MediaScanParams"]; result: components['schemas']["MediaScanResult"] };
  "media.uploadImage": { params: components['schemas']["MediaUploadImageParams"]; result: components['schemas']["MediaUploadImageResult"] };
}
export type BridgeMethodName = keyof BridgeMethods;

/** Level, call model, timeout, per-platform `since`, user gesture and own 90403 whitelist of each method (03 §5.3). */
export const bridgeMethods = {
  "app.getEnv": {
    "level": "L0",
    "model": "sync",
    "timeout_ms": null,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "app.getConfig": {
    "level": "L0",
    "model": "sync",
    "timeout_ms": null,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "auth.getUser": {
    "level": "L1",
    "model": "async",
    "timeout_ms": 10000,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "auth.login": {
    "level": "L0",
    "model": "async",
    "timeout_ms": null,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "auth.getH5Token": {
    "level": "L1",
    "model": "async",
    "timeout_ms": 10000,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "net.signedRequest": {
    "level": "L2",
    "model": "async",
    "timeout_ms": 15000,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": true,
    "whitelist_90403": true
  },
  "ui.toast": {
    "level": "L0",
    "model": "sync",
    "timeout_ms": null,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "ui.showLoading": {
    "level": "L0",
    "model": "sync",
    "timeout_ms": null,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "ui.hideLoading": {
    "level": "L0",
    "model": "sync",
    "timeout_ms": null,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "ui.setNavBar": {
    "level": "L0",
    "model": "sync",
    "timeout_ms": null,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "nav.open": {
    "level": "L0",
    "model": "async",
    "timeout_ms": 10000,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "nav.close": {
    "level": "L0",
    "model": "sync",
    "timeout_ms": null,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "trade.openProduct": {
    "level": "L0",
    "model": "async",
    "timeout_ms": 10000,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "trade.convertAndOpen": {
    "level": "L2",
    "model": "async",
    "timeout_ms": null,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": true,
    "whitelist_90403": false
  },
  "trade.authorize": {
    "level": "L2",
    "model": "async",
    "timeout_ms": null,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": true,
    "whitelist_90403": false
  },
  "trade.openUnionActivity": {
    "level": "L2",
    "model": "async",
    "timeout_ms": null,
    "phase": "P1",
    "since": {
      "ios": null,
      "android": null,
      "harmony": null
    },
    "gesture_required": true,
    "whitelist_90403": false
  },
  "share.open": {
    "level": "L1",
    "model": "async",
    "timeout_ms": null,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": true
  },
  "media.saveImage": {
    "level": "L1",
    "model": "async",
    "timeout_ms": null,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "media.previewImage": {
    "level": "L0",
    "model": "sync",
    "timeout_ms": null,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "clipboard.write": {
    "level": "L0",
    "model": "sync",
    "timeout_ms": null,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": true,
    "whitelist_90403": false
  },
  "clipboard.read": {
    "level": "L2",
    "model": "async",
    "timeout_ms": 5000,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": null
    },
    "gesture_required": true,
    "whitelist_90403": false
  },
  "clipboard.setAutoDetect": {
    "level": "L0",
    "model": "sync",
    "timeout_ms": null,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "ext.openApp": {
    "level": "L1",
    "model": "async",
    "timeout_ms": 10000,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": true
  },
  "ext.openBrowser": {
    "level": "L0",
    "model": "sync",
    "timeout_ms": null,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": true
  },
  "ext.openMiniProgram": {
    "level": "L1",
    "model": "async",
    "timeout_ms": 10000,
    "phase": "P1",
    "since": {
      "ios": null,
      "android": null,
      "harmony": null
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "cs.open": {
    "level": "L0",
    "model": "async",
    "timeout_ms": 10000,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "perm.getPushStatus": {
    "level": "L0",
    "model": "async",
    "timeout_ms": 5000,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "perm.request": {
    "level": "L1",
    "model": "async",
    "timeout_ms": null,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "track.event": {
    "level": "L0",
    "model": "sync",
    "timeout_ms": null,
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "media.scan": {
    "level": "L1",
    "model": "async",
    "timeout_ms": null,
    "phase": "P1",
    "since": {
      "ios": null,
      "android": null,
      "harmony": null
    },
    "gesture_required": false,
    "whitelist_90403": false
  },
  "media.uploadImage": {
    "level": "L1",
    "model": "async",
    "timeout_ms": null,
    "phase": "P1",
    "since": {
      "ios": null,
      "android": null,
      "harmony": null
    },
    "gesture_required": false,
    "whitelist_90403": false
  }
} as const;

export interface BridgeEvents {
  "app.resume": components['schemas']["AppResumeEvent"];
  "app.pause": components['schemas']["AppPauseEvent"];
  "auth.changed": components['schemas']["AuthChangedEvent"];
  "page.visible": components['schemas']["PageVisibleEvent"];
}

/** Method + path pairs net.signedRequest may sign (拍板第二批 TECH-30); others → 90403. */
export const signedPaths = [{"method":"POST","path":"/v1/orders/claims"}] as const;
export const bridgeErrorCodes = [90001,90002,90003,90004,90401,90403,90404,90500] as const;
/** Share page path patterns share.open lets through on share_domains (04 §9; BR-ATTR-29 细则); null = not fixed yet. */
export const sharePagePaths = {
  "product_share": {
    "page": "商品分享中间页 (path carries the server-issued link_id)",
    "path_pattern": "^/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
  },
  "invite_landing": {
    "page": "邀请落地页",
    "path_pattern": "^/i/[2-9A-HJ-NP-Z]{6}$"
  },
  "download_guide": {
    "page": "下载引导页",
    "path_pattern": null
  }
} as const;

/** Route table (contracts/routes.json); jumps are {route, params} (拍板第二批 TECH-04). */
export const routes = {
  "Launch": {
    "kind": "native",
    "h5_path": null,
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "BasicMode": {
    "kind": "native",
    "h5_path": null,
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "Login": {
    "kind": "native",
    "h5_path": null,
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "BindPhone": {
    "kind": "native",
    "h5_path": null,
    "auth": "login",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app"
    ],
    "agent_guide": false,
    "agent_guide_account": "phone"
  },
  "Home": {
    "kind": "native",
    "h5_path": null,
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push",
      "deeplink"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "Search": {
    "kind": "native",
    "h5_path": null,
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push",
      "deeplink"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "HotRankList": {
    "kind": "native",
    "h5_path": null,
    "auth": "none",
    "phase": "M-公开",
    "since": {
      "ios": null,
      "android": null,
      "harmony": null
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push",
      "deeplink"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "ProductDetail": {
    "kind": "native",
    "h5_path": null,
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push",
      "deeplink"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "ProductShare": {
    "kind": "native",
    "h5_path": null,
    "auth": "phone",
    "phase": "M-公开",
    "since": {
      "ios": null,
      "android": null,
      "harmony": null
    },
    "debug_only": false,
    "entry": [
      "in_app"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "ShareHub": {
    "kind": "native",
    "h5_path": null,
    "auth": "phone",
    "phase": "M-公开",
    "since": {
      "ios": null,
      "android": null,
      "harmony": null
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "Favorites": {
    "kind": "native",
    "h5_path": null,
    "auth": "login",
    "phase": "M-公开",
    "since": {
      "ios": null,
      "android": null,
      "harmony": null
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "AuthSheet": {
    "kind": "native",
    "h5_path": null,
    "auth": "login",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "JumpTip": {
    "kind": "native",
    "h5_path": null,
    "auth": "login",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "AgentChat": {
    "kind": "native",
    "h5_path": null,
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "AgentConsent": {
    "kind": "native",
    "h5_path": null,
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "OrderList": {
    "kind": "native",
    "h5_path": null,
    "auth": "login",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": true,
    "agent_guide_account": null
  },
  "OrderDetail": {
    "kind": "native",
    "h5_path": null,
    "auth": "login",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "FindOrder": {
    "kind": "h5",
    "h5_path": "/find-order",
    "auth": "login",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "Me": {
    "kind": "native",
    "h5_path": null,
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "Wallet": {
    "kind": "native",
    "h5_path": null,
    "auth": "login",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": true,
    "agent_guide_account": null
  },
  "Withdraw": {
    "kind": "native",
    "h5_path": null,
    "auth": "realname",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": false,
    "agent_guide_account": "fund"
  },
  "WithdrawRecords": {
    "kind": "native",
    "h5_path": null,
    "auth": "login",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": true,
    "agent_guide_account": null
  },
  "Ledger": {
    "kind": "h5",
    "h5_path": "/ledger",
    "auth": "login",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "RealName": {
    "kind": "native",
    "h5_path": null,
    "auth": "phone",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": false,
    "agent_guide_account": "fund"
  },
  "Reverify": {
    "kind": "native",
    "h5_path": null,
    "auth": "login",
    "phase": "M-内测",
    "since": {
      "ios": null,
      "android": null,
      "harmony": null
    },
    "debug_only": false,
    "entry": [
      "in_app"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "PayoutAccount": {
    "kind": "native",
    "h5_path": null,
    "auth": "realname",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": false,
    "agent_guide_account": "fund"
  },
  "LaborAgreement": {
    "kind": "native",
    "h5_path": null,
    "auth": "realname",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app"
    ],
    "agent_guide": false,
    "agent_guide_account": "fund"
  },
  "Settings": {
    "kind": "native",
    "h5_path": null,
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "PrivacyCenter": {
    "kind": "native",
    "h5_path": null,
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "DeleteAccount": {
    "kind": "native",
    "h5_path": null,
    "auth": "login",
    "phase": "M-公开",
    "since": {
      "ios": null,
      "android": null,
      "harmony": null
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": false,
    "agent_guide_account": "delete"
  },
  "RiskNotice": {
    "kind": "native",
    "h5_path": null,
    "auth": "login",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "Appeal": {
    "kind": "native",
    "h5_path": null,
    "auth": "login",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "DataCopy": {
    "kind": "native",
    "h5_path": null,
    "auth": "login",
    "phase": "M-内测",
    "since": {
      "ios": null,
      "android": null,
      "harmony": null
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "ForceUpdate": {
    "kind": "native",
    "h5_path": null,
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "HomePreview": {
    "kind": "native",
    "h5_path": null,
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": true,
    "entry": [
      "in_app",
      "deeplink"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "About": {
    "kind": "native",
    "h5_path": null,
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "Messages": {
    "kind": "h5",
    "h5_path": "/messages",
    "auth": "login",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": true,
    "agent_guide_account": null
  },
  "InviteShare": {
    "kind": "h5",
    "h5_path": "/invite",
    "auth": "phone",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": true,
    "agent_guide_account": null
  },
  "InviteBackfill": {
    "kind": "native",
    "h5_path": null,
    "auth": "phone",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "InviteLink": {
    "kind": "native",
    "h5_path": null,
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "deeplink"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "Rules": {
    "kind": "h5",
    "h5_path": "/rules",
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push",
      "deeplink"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "Help": {
    "kind": "h5",
    "h5_path": "/help",
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push",
      "deeplink"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "Notice": {
    "kind": "h5",
    "h5_path": "/notice",
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push",
      "deeplink"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "Agreement": {
    "kind": "h5",
    "h5_path": "/agreement",
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push",
      "deeplink"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "WebPage": {
    "kind": "native",
    "h5_path": null,
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "ExternalPage": {
    "kind": "native",
    "h5_path": null,
    "auth": "none",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push",
      "deeplink"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "InvitedFriends": {
    "kind": "native",
    "h5_path": null,
    "auth": "phone",
    "phase": "P1",
    "since": {
      "ios": null,
      "android": null,
      "harmony": null
    },
    "debug_only": false,
    "entry": [
      "in_app"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "LevelUpgrade": {
    "kind": "native",
    "h5_path": null,
    "auth": "phone",
    "phase": "P1",
    "since": {
      "ios": null,
      "android": null,
      "harmony": null
    },
    "debug_only": false,
    "entry": [
      "in_app"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "LinkLanding": {
    "kind": "native",
    "h5_path": null,
    "auth": "none",
    "phase": "M-公开",
    "since": {
      "ios": null,
      "android": null,
      "harmony": null
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push",
      "deeplink"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "Earnings": {
    "kind": "h5",
    "h5_path": "/earnings",
    "auth": "login",
    "phase": "M-公开",
    "since": {
      "ios": null,
      "android": null,
      "harmony": null
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": false,
    "agent_guide_account": null
  },
  "AuthManage": {
    "kind": "native",
    "h5_path": null,
    "auth": "login",
    "phase": "M-内测",
    "since": {
      "ios": "1.0.0",
      "android": "1.0.0",
      "harmony": "1.0.0"
    },
    "debug_only": false,
    "entry": [
      "in_app",
      "push"
    ],
    "agent_guide": true,
    "agent_guide_account": null
  }
} as const;
export type RouteName = keyof typeof routes;
/** Routes kept in release builds (debug_only routes are dropped there, TECH-11). */
export const releaseRouteNames = ["Launch","BasicMode","Login","BindPhone","Home","Search","HotRankList","ProductDetail","ProductShare","ShareHub","Favorites","AuthSheet","JumpTip","AgentChat","AgentConsent","OrderList","OrderDetail","FindOrder","Me","Wallet","Withdraw","WithdrawRecords","Ledger","RealName","Reverify","PayoutAccount","LaborAgreement","Settings","PrivacyCenter","DeleteAccount","RiskNotice","Appeal","DataCopy","ForceUpdate","About","Messages","InviteShare","InviteBackfill","InviteLink","Rules","Help","Notice","Agreement","WebPage","ExternalPage","InvitedFriends","LevelUpgrade","LinkLanding","Earnings","AuthManage"] as const;
/** Routes an Agent page_guide card or earnings_summary button may open (agent_guide, 04 §10, D31); the client checks its bundled list (03 §7.4). */
export const agentGuideRouteNames = ["OrderList","Wallet","WithdrawRecords","Messages","InviteShare","AuthManage"] as const;
export interface RouteParams {
  Launch: components['schemas']["RouteLaunchParams"];
  BasicMode: components['schemas']["RouteBasicModeParams"];
  Login: components['schemas']["RouteLoginParams"];
  BindPhone: components['schemas']["RouteBindPhoneParams"];
  Home: components['schemas']["RouteHomeParams"];
  Search: components['schemas']["RouteSearchParams"];
  HotRankList: components['schemas']["RouteHotRankListParams"];
  ProductDetail: components['schemas']["RouteProductDetailParams"];
  ProductShare: components['schemas']["RouteProductShareParams"];
  ShareHub: components['schemas']["RouteShareHubParams"];
  Favorites: components['schemas']["RouteFavoritesParams"];
  AuthSheet: components['schemas']["RouteAuthSheetParams"];
  JumpTip: components['schemas']["RouteJumpTipParams"];
  AgentChat: components['schemas']["RouteAgentChatParams"];
  AgentConsent: components['schemas']["RouteAgentConsentParams"];
  OrderList: components['schemas']["RouteOrderListParams"];
  OrderDetail: components['schemas']["RouteOrderDetailParams"];
  FindOrder: components['schemas']["RouteFindOrderParams"];
  Me: components['schemas']["RouteMeParams"];
  Wallet: components['schemas']["RouteWalletParams"];
  Withdraw: components['schemas']["RouteWithdrawParams"];
  WithdrawRecords: components['schemas']["RouteWithdrawRecordsParams"];
  Ledger: components['schemas']["RouteLedgerParams"];
  RealName: components['schemas']["RouteRealNameParams"];
  Reverify: components['schemas']["RouteReverifyParams"];
  PayoutAccount: components['schemas']["RoutePayoutAccountParams"];
  LaborAgreement: components['schemas']["RouteLaborAgreementParams"];
  Settings: components['schemas']["RouteSettingsParams"];
  PrivacyCenter: components['schemas']["RoutePrivacyCenterParams"];
  DeleteAccount: components['schemas']["RouteDeleteAccountParams"];
  RiskNotice: components['schemas']["RouteRiskNoticeParams"];
  Appeal: components['schemas']["RouteAppealParams"];
  DataCopy: components['schemas']["RouteDataCopyParams"];
  ForceUpdate: components['schemas']["RouteForceUpdateParams"];
  HomePreview: components['schemas']["RouteHomePreviewParams"];
  About: components['schemas']["RouteAboutParams"];
  Messages: components['schemas']["RouteMessagesParams"];
  InviteShare: components['schemas']["RouteInviteShareParams"];
  InviteBackfill: components['schemas']["RouteInviteBackfillParams"];
  InviteLink: components['schemas']["RouteInviteLinkParams"];
  Rules: components['schemas']["RouteRulesParams"];
  Help: components['schemas']["RouteHelpParams"];
  Notice: components['schemas']["RouteNoticeParams"];
  Agreement: components['schemas']["RouteAgreementParams"];
  WebPage: components['schemas']["RouteWebPageParams"];
  ExternalPage: components['schemas']["RouteExternalPageParams"];
  InvitedFriends: components['schemas']["RouteInvitedFriendsParams"];
  LevelUpgrade: components['schemas']["RouteLevelUpgradeParams"];
  LinkLanding: components['schemas']["RouteLinkLandingParams"];
  Earnings: components['schemas']["RouteEarningsParams"];
  AuthManage: components['schemas']["RouteAuthManageParams"];
}
/** A jump target shared by banners, push, messages, SDUI, Agent cards and nav.open. */
export type RouteWithOptionalParams = "Launch" | "BasicMode" | "Login" | "BindPhone" | "Home" | "Search" | "HotRankList" | "ShareHub" | "Favorites" | "AgentChat" | "AgentConsent" | "OrderList" | "FindOrder" | "Me" | "Wallet" | "Withdraw" | "WithdrawRecords" | "Ledger" | "RealName" | "Reverify" | "PayoutAccount" | "LaborAgreement" | "Settings" | "PrivacyCenter" | "DeleteAccount" | "RiskNotice" | "Appeal" | "DataCopy" | "ForceUpdate" | "About" | "Messages" | "InviteShare" | "InviteBackfill" | "Rules" | "Help" | "Notice" | "Agreement" | "InvitedFriends" | "LevelUpgrade" | "Earnings" | "AuthManage";
export type RouteTarget = { [N in RouteName]: N extends RouteWithOptionalParams ? { route: N; params?: RouteParams[N] } : { route: N; params: RouteParams[N] } }[RouteName];

/** External target apps (contracts/apps.json); the only targets of ext.openApp. */
export const apps = {
  "taobao": {
    "platform": "taobao",
    "status": "candidate",
    "trade_only": true,
    "ios_query_schemes": [
      "taobao",
      "tbopen"
    ],
    "harmony_query_schemes": []
  },
  "jd": {
    "platform": "jd",
    "status": "candidate",
    "trade_only": true,
    "ios_query_schemes": [
      "openApp.jdMobile"
    ],
    "harmony_query_schemes": []
  },
  "pdd": {
    "platform": "pdd",
    "status": "candidate",
    "trade_only": true,
    "ios_query_schemes": [],
    "harmony_query_schemes": []
  }
} as const;
export type AppTarget = keyof typeof apps;
/** SDK query entries and inbound callbacks (contracts/apps.json), input of the CT-05 generators. */
export const sdkQueries = [] as const;
export const inbound = [
  {
    "kind": "custom_scheme",
    "purpose": "自有 scheme：外部回跳本 App 与站外唤起（规划/06 Q-A5）",
    "source_sdk": null,
    "platforms": [
      "ios",
      "android",
      "harmony"
    ],
    "scheme": "couli",
    "template": false
  }
] as const;
