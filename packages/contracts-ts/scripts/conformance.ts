// Cross-file checks of contracts/: the OpenAPI document against contracts/enums and
// contracts/error-codes.yaml, and the operation conventions of 规划/04 §5 (x-auth, x-signed,
// x-idempotent, examples, amounts). Run by codegen.ts in both modes, so `pnpm contracts:check`
// fails on a violation. Returns the list of problems; empty means conforming.
import { readFileSync } from 'node:fs';
import { parseYamlLite } from '../../../tools/lib/yaml-lite.ts';
import type { EnumDef, ErrorCodeDef } from './catalog.ts';
import { openapiFile, routesFile } from './paths.ts';

type Obj = Record<string, unknown>;

const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;
const SIGN_HEADERS = ['Timestamp', 'Nonce', 'Sign'];

/**
 * OpenAPI enums that mirror an enum of contracts/enums: JSON pointer inside
 * components.schemas → enum name. A new enum-typed schema must be added here.
 */
export const ENUM_BINDINGS: Readonly<Record<string, string>> = {
  PlatformCode: 'platform',
  ClientPlatformCode: 'client_platform',
  InstallChannelCode: 'install_channel',
  SortCode: 'sort',
  RebateBasis: 'rebate_basis',
  Availability: 'availability',
  InstalledState: 'installed_state',
  'JumpStep/properties/type': 'jump_type',
  'SendSmsCodeRequest/properties/purpose': 'sms_purpose',
  'UnionBindingState/properties/status': 'union_binding_status',
  'RiskInfo/properties/state': 'risk_state',
  'Me/properties/identity_level': 'identity_level',
  'Me/properties/realname_status': 'realname_status',
  'ProductTlj/properties/kind': 'tlj_kind',
  'ProductCard/properties/match_tag': 'match_tag',
  'InputHit/properties/kind': 'input_kind',
  StepUpAction: 'step_up_action',
  PlatformSearchStatus: 'platform_search_status',
  LinkPatternCategory: 'link_pattern_category',
  IdempotencyAbandonOutcome: 'idempotency_abandon_outcome',
  DeviceIdSource: 'device_id_source',
  SessionScope: 'session_scope',
  AuthMethod: 'auth_method',
  NoRebateCause: 'no_rebate_cause',
  TipKey: 'tip_key',
  WithdrawalStatus: 'withdrawal_status',
  WithdrawalReviewMode: 'withdrawal_review_mode',
  WithdrawalChannelState: 'withdrawal_channel_state',
  WithdrawalSubTextBranch: 'withdrawal_sub_text_branch',
  DeletionStatus: 'deletion_status',
  DeletionCancelReason: 'deletion_cancel_reason',
  OrderStatusGroup: 'order_status_group',
  OrderDisplayStatus: 'display_status',
  OrderReasonCode: 'order_reason',
  OrderReasonSub: 'order_reason_sub',
  OrderTimelineNode: 'order_timeline_node',
  H5TokenScope: 'h5_token_scope',
  LoginProvider: 'login_provider',
  OauthAttemptPurpose: 'oauth_attempt_purpose',
  ReverifyMethod: 'reverify_method',
  LinkKind: 'link_kind',
  AppealStatus: 'appeal_status',
  AdminStepUpTier: 'admin_step_up_tier',
  AdminLoginStep: 'admin_login_step',
  AdminAccountStatus: 'admin_account_status',
  PlatformIconKey: 'platform_icon_key',
  AgentFinishReason: 'agent_finish_reason',
  AdminUserRiskStateCode: 'risk_state',
  AdminRiskReasonCategory: 'risk_reason_category',
  AdminUserLevel: 'user_level',
  AdminUnionBindingStatus: 'union_binding_status',
  AdminUnionBindingBlockedReason: 'union_binding_blocked_reason',
  ClaimStatus: 'claim_status',
  ClaimItemDecision: 'claim_item_decision',
  ClaimRejectReason: 'claim_reject_reason',
  AdminDashboardTodoKey: 'admin_dashboard_todo_key',
  AdminPayoutChannelCode: 'payout_method',
  PayChannelCode: 'pay_channel',
  PayOrderStatus: 'pay_order_status',
  AdminSearchHitType: 'admin_search_hit_type',
  AdminExportStatus: 'export_status',
  AdminExportResource: 'export_resource',
  AdminClaimEvidenceLevel: 'claim_evidence_level',
  AdminClaimMatchField: 'admin_claim_match_field',
  AdminClaimEvidenceScene: 'scene',
  AdminOrderPlatformStatus: 'platform_status',
  AdminOrderRebateStatus: 'rebate_status',
  AdminOrderHoldReason: 'order_hold_reason',
  AdminOrderFlag: 'admin_order_flag',
  AdminOrderHistoryField: 'admin_order_history_field',
  AdminOrderHistorySource: 'admin_order_history_source',
  AdminOrderBuyType: 'buy_type',
  AdminOrderSceneBasis: 'scene_basis',
  AdminOrderUserBasis: 'user_basis',
  AdminOrderLinkEvent: 'link_event',
  AdminOrderLinkScene: 'scene',
  AdminOrderBeneficiaryRole: 'beneficiary_role',
  AdminOrderForfeitReason: 'forfeit_reason',
  AdminRiskRuleStatus: 'risk_rule_status',
  AdminRiskAction: 'risk_action',
  AdminInviteRewardStatus: 'invite_reward_status',
  AdminInviteRewardPartyResult: 'invite_reward_party_result',
  AdminInviteRewardSkipReason: 'invite_reward_skip_reason',
  AdminInviteRewardVoidReason: 'invite_reward_void_reason',
  AdminInviteRewardBindSource: 'invite_reward_bind_source',
  AdminUnionAuthStatus: 'union_auth_status',
  AdminUnionReauthMode: 'union_reauth_mode',
  AdminUnionAuthSessionStatus: 'admin_union_auth_session_status',
  AdminUnionPidStatus: 'union_pid_status',
  AdminUnionPidScene: 'pid_scene',
  AdminProductPoolStatus: 'product_pool_status',
  AdminPoolItemStatus: 'pool_item_status',
  AdminOrderSyncMode: 'order_sync_mode',
  AdminOrderSyncStatus: 'order_sync_status',
  AdminRightsImportKind: 'rights_import_kind',
  AdminRightsImportTimeBasis: 'rights_import_time_basis',
  AdminRightsImportStatus: 'rights_import_status',
  AdminRightsImportFailureReason: 'rights_import_failure_reason',
  AdminPayChannel: 'pay_channel',
  AdminPayOrderStatus: 'pay_order_status',
  AdminPayRefundStatus: 'pay_refund_status',
  AdminPayRefundTargetType: 'pay_refund_target_type',
  AdminPayRefundReason: 'pay_refund_reason',
  AdminPayQueryAttemptKind: 'pay_query_attempt_kind',
  AdminReconDiffStatus: 'recon_diff_status',
  AdminReconDiffOutcome: 'admin_recon_diff_outcome',
  // CT-24zg: adjustments and bad-debt write-offs (BR-FUND-24, BR-FUND-12). The request's
  // reason_code and contra_subject are the choosable subsets, so they stay unregistered.
  AdminAdjustmentStatus: 'admin_adjustment_status',
  AdminAdjustmentDirection: 'admin_adjustment_direction',
  AdminAdjustmentReasonCode: 'admin_adjust_sub_type',
  AdminAdjustmentRefType: 'admin_adjustment_ref_type',
  AdminAdjustmentContraSubject: 'admin_adjustment_contra_subject',
  AdminBadDebtWriteoffStatus: 'bad_debt_writeoff_status',
  // CT-24zh: union collections and the fund ledger overview (BR-FUND-20, BR-WDR-18).
  AdminUnionReceiptMethod: 'union_receipt_method',
  AdminUnionReceiptCashAccount: 'union_receipt_cash_account',
  AdminFundWaterLevel: 'admin_fund_water_level',
  // CT-24r: admin appeal console (04 §6.6 appeals, BR-ID-36). AdminBlockedRequestType stays
  // unregistered on purpose: CT-02d keeps blocked_request_type out of both tables; the
  // admin-appeals test checks it against the enum instead.
  AdminAppealTargetType: 'appeal_target_type',
  AdminAppealSource: 'appeal_source',
  AdminBlockedRequestCause: 'blocked_request_cause',
  AdminBlocklistDimension: 'blocklist_dimension',
  AdminRiskHitRefType: 'risk_hit_ref_type',
  PersonalDataCopyDelivery: 'personal_data_copy_delivery',
  PersonalDataCopyStatus: 'personal_data_copy_status',
  // CT-24t: admin notification channels and SMS registration (04 §3, BR-TEXT-20 细则).
  AdminNotifyCategory: 'notify_category',
  AdminNotifyChannel: 'notify_channel',
  AdminSmsTemplateType: 'sms_template_type',
  AdminNotifySmsState: 'notify_sms_state',
  AdminNotifySmsTestStatus: 'notify_sms_test_status',
  // CT-24y: admin withdrawal console, read only (04 §3.2 withdrawals, BR-WDR-08 细则).
  AdminWithdrawalDisplayStatus: 'admin_withdrawal_display_status',
  AdminWithdrawalHoldReason: 'withdrawal_hold_reason',
  AdminWithdrawalBlockedReason: 'withdrawal_blocked_reason',
  AdminWithdrawalRejectReason: 'withdraw_reject_reason',
  AdminWithdrawalManualResolution: 'withdrawal_manual_resolution',
  AdminWithdrawHoldKind: 'withdraw_hold_kind',
  AdminPayoutBatchKind: 'payout_batch_kind',
  AdminPayoutBatchItemResult: 'payout_batch_item_result',
  AdminPayoutAttemptKind: 'payout_attempt_kind',
  // CT-24z: admin monthly settlement bills, read only (04 §3.2 settle_bills, settle_batches,
  // settle_batch_items; BR-FUND-04 细则). AdminSettleBatchKind (main / supplement) and the
  // result filter AdminSettleBatchItemResultFilterValue (adds pending) have no catalog enum.
  AdminSettleBillStatus: 'admin_settle_bill_status',
  AdminSettleBatchStatus: 'settle_batch_status',
  AdminSettleMode: 'settle_mode',
  AdminSettleBatchItemType: 'settle_batch_item_type',
  AdminSettleBatchItemResult: 'settle_batch_item_result',
  AdminSettleBatchItemRole: 'beneficiary_role',
  // CT-24zd: the supplement launch of the monthly settlement console (BR-FUND-04 ⑧).
  AdminSettleSupplementOutcome: 'admin_settle_supplement_outcome',
  // CT-24zj: the system identity on an audit row (D10-552).
  AdminAuditActorKind: 'audit_actor_kind',
  AdminAuditSystemActor: 'audit_system_actor',
};

/**
 * The four operations that need step-up and the step_up_action each one's X-Step-Up-Token must
 * carry (规划/04 §5 step-up row; enum step_up_action). An operation in this table must carry
 * `x-step-up` with exactly this value once it is declared; no other operation may carry it.
 * Until the four are declared the check has nothing to match (orchestrator decision D-18).
 */
export const STEP_UP_OPERATIONS: Readonly<Record<string, string>> = {
  withdraw: 'POST /v1/withdrawals',
  payout_account_change: 'PUT /v1/me/payout-account',
  phone_change: 'POST /v1/me/phone',
  account_deletion: 'POST /v1/me/deletion',
};

/**
 * Version gate exceptions (规划/08 BR-ID-01 细则「最低支持版本的接口层拦截」, the only place they
 * are kept; this copy is checked against the contract and follows 08 on any difference). Every
 * other /v1 write operation is gated (true). 「不判定」 operations are written false with the reason
 * in the description (orchestrator decision D-12).
 */
export const GATE_EXCEPTIONS: Readonly<Record<string, 'false' | 'conditional'>> = {
  'POST /v1/devices': 'false',
  'POST /v1/auth/sms-codes': 'conditional',
  'POST /v1/auth/login/sms': 'false',
  'POST /v1/auth/login/wechat': 'false',
  'POST /v1/auth/login/apple': 'false',
  'POST /v1/auth/login/huawei': 'false',
  'POST /v1/auth/refresh': 'false',
  'POST /v1/auth/oauth-attempts': 'conditional',
  'POST /v1/auth/step-up': 'conditional',
  'POST /v1/auth/logout': 'false',
  'POST /v1/consents': 'conditional',
  'POST /v1/me/deletion': 'false',
  'POST /v1/me/deletion/cancel': 'false',
  'POST /v1/idempotency-keys/abandon': 'conditional',
  'POST /v1/landing/sms-codes': 'false',
  'POST /v1/invites/landing-register': 'false',
  'POST /v1/share-pages/{link_id}/tpwd': 'false',
};

/**
 * Operations a deletion_only session may call (BR-ID-01 细则「受限会话」 table; 08 wins on any
 * difference): marked x-session-scopes [full, deletion_only]. The conditional ones accept it for
 * some request bodies only and say which in the description.
 */
export const DELETION_ONLY_SCOPE: Readonly<Record<string, 'always' | 'conditional'>> = {
  'POST /v1/me/deletion': 'always',
  'POST /v1/me/deletion/cancel': 'always',
  'GET /v1/me/deletion': 'always',
  'POST /v1/auth/sms-codes': 'conditional',
  'POST /v1/auth/oauth-attempts': 'conditional',
  'POST /v1/auth/step-up': 'conditional',
  'POST /v1/idempotency-keys/abandon': 'conditional',
  'POST /v1/consents': 'conditional',
  'POST /v1/auth/refresh': 'always',
  'POST /v1/auth/logout': 'always',
  'POST /v1/devices': 'always',
  'POST /v1/auth/login/sms': 'always',
  'POST /v1/auth/login/wechat': 'always',
  'POST /v1/auth/login/apple': 'always',
  'POST /v1/auth/login/huawei': 'always',
  'GET /v1/articles': 'always',
  'GET /v1/app-versions/check': 'always',
  'GET /v1/config': 'always',
  'GET /v1/dict': 'always',
  'GET /v1/me': 'always',
  'GET /v1/wallet/summary': 'always',
  // Personal information copies (BR-ID-40 细则「在 App 内下载」; D10-181 ⑦, D10-185 ⑥; CT-24q).
  'GET /v1/me/data-copies': 'always',
  'GET /v1/me/data-copies/{id}/download': 'always',
};

/**
 * Operations whose 200 is a text/event-stream (frames in contracts/agent-stream.schema.json, 04 §8);
 * no other operation may answer text/event-stream.
 */
export const STREAM_OPERATIONS: readonly string[] = ['POST /v1/agent/sessions/{id}/messages'];

/** Logins that answer a client below the minimum version with a restricted login (10405 no_account). */
const RESTRICTED_LOGINS = [
  'POST /v1/auth/login/sms',
  'POST /v1/auth/login/wechat',
  'POST /v1/auth/login/apple',
  'POST /v1/auth/login/huawei',
];

/** Codes every x-step-up operation lists in x-error-codes (04 §5 step-up and 幂等 rows). */
const STEP_UP_CODES = [10003, 20903];

/** Inline enums that may only use a subset of an enum of contracts/enums. */
export const ENUM_SUBSETS: Readonly<Record<string, string>> = {
  'ParseInputRequest/properties/scene': 'scene',
  'ConvertLinkRequest/properties/scene': 'scene',
  'StepUpByWechatRequest/properties/provider': 'login_provider',
  'AuthJumpStep/properties/type': 'jump_type',
  'BindUnionByWebCode/properties/auth_method': 'auth_method',
  'BindUnionBySdkToken/properties/auth_method': 'auth_method',
  'StepUpByAppleRequest/properties/provider': 'login_provider',
  'StepUpByHuaweiRequest/properties/provider': 'login_provider',
  ResettableTipKey: 'tip_key',
  'WithdrawalSummary/properties/payout_channel': 'payout_method',
  'Withdrawal/properties/payout_channel': 'payout_method',
  'LedgerPostingEntry/properties/ledger_type': 'ledger_type',
  'LedgerWithdrawPaidEntry/properties/ledger_type': 'ledger_type',
  'SavePayoutAccountByAlipay/properties/payout_method': 'payout_method',
  'SavePayoutAccountByBankCard/properties/payout_method': 'payout_method',
  'PayoutAccountAlipay/properties/payout_method': 'payout_method',
  'PayoutAccountBankCard/properties/payout_method': 'payout_method',
  'RecordConsentRequest/properties/type': 'consent_type',
  'RecordConsentRequest/properties/channel': 'consent_channel',
  // blocked_request is registered in the admin console only (04 §3.2 appeals, §6.1).
  AppealTargetType: 'appeal_target_type',
  // One request branch per export source (CT-24k): each fixes its own resource.
  'AdminExportCreateUsersRequest/properties/resource': 'export_resource',
  'AdminExportCreateAuditLogsRequest/properties/resource': 'export_resource',
  'AdminExportCreateTaxWithdrawalsRequest/properties/resource': 'export_resource',
  // A reviewer rejects with the first six codes only; NOT_IN_POOL and ORDER_INVALID are system
  // only (BR-ATTR-18, CT-24l). A subset, not a binding: ENUM_BINDINGS keeps the full enum.
  AdminClaimStaffRejectReason: 'claim_reject_reason',
  // Operators hold / unhold with RISK or CS only; UNMAPPED_STATUS is set by the system alone
  // (BR-FUND-02, BR-FUND-06 细则「后台 hold / unhold」, CT-24n).
  AdminOrderStaffHoldReason: 'order_hold_reason',
  // A punish import picks one of the 12 PUNISH sub-reasons (08 BR-TEXT-05, D10-819, CT-24zw); the
  // 「无」 choice is AdminOrderReasonSubNone (`none`), not a value of order_reason_sub.
  AdminOrderPunishReasonSub: 'order_reason_sub',
  // One multipart branch per import form (CT-24n): rights / punish by sub-order, channel alone.
  'AdminRightsImportByOrder/properties/kind': 'rights_import_kind',
  'AdminRightsImportChannel/properties/kind': 'rights_import_kind',
  // A new import task is always queued (CT-24n).
  'AdminRightsImportCreated/properties/status': 'rights_import_status',
  // The R4 (收款对账) types only (BR-PAY-07, CT-21e); R1–R3 differences are not listed there.
  AdminPayReconDiffType: 'recon_diff_type',
  // Manual settlement only starts from PENDING (BR-PAY-05 ③, CT-21e).
  'AdminPayOrderResolveRequest/properties/expected_status': 'pay_order_status',
  // CT-24r: an account appeal is against frozen or banned only; closing is upheld or revoked;
  // revoking needs one of three extra points (04 §11.2 risk.appeal, BR-ID-36).
  AdminAppealPrevRiskState: 'risk_state',
  AdminAppealDecision: 'appeal_status',
  AdminAppealRevokePermission: 'admin_permission',
  // The App lists only downloadable copies; a download always leaves the request delivered (CT-24q).
  'DataCopyItem/properties/status': 'personal_data_copy_status',
  'AdminUserDataExportDownload/properties/status': 'personal_data_copy_status',
};

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function at(root: Obj, pointer: string): unknown {
  let cur: unknown = root;
  for (const part of pointer.split('/')) {
    if (!isObj(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function refName(v: unknown, kind: string): string | null {
  if (!isObj(v) || typeof v['$ref'] !== 'string') return null;
  const prefix = `#/components/${kind}/`;
  return v['$ref'].startsWith(prefix) ? v['$ref'].slice(prefix.length) : null;
}

/**
 * Follows local `$ref`s (`#/…` JSON pointers, `~1` / `~0` unescaped) until a node without one, so a
 * response or header declared in components is checked like an inline one. Undefined for a
 * missing target, a remote reference or a cycle.
 */
function deref(doc: Obj, value: unknown): unknown {
  let node = value;
  const seen = new Set<string>();
  while (isObj(node) && typeof node['$ref'] === 'string') {
    const ref = node['$ref'];
    if (!ref.startsWith('#/') || seen.has(ref)) return undefined;
    seen.add(ref);
    let cur: unknown = doc;
    for (const raw of ref.slice(2).split('/')) {
      const part = raw.replaceAll('~1', '/').replaceAll('~0', '~');
      if (!isObj(cur)) return undefined;
      cur = cur[part];
    }
    node = cur;
  }
  return node;
}

/** The content map of a response (inline or `$ref`), or undefined. */
function responseContent(doc: Obj, response: unknown): Obj | undefined {
  const resolved = deref(doc, response);
  const content = isObj(resolved) ? resolved['content'] : undefined;
  return isObj(content) ? content : undefined;
}

function sameSet(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** Every `*_fen` property is an int64 integer, directly or through Fen / NullableFen. */
function checkAmounts(schemas: Obj, problems: string[]): void {
  const visit = (node: unknown, where: string): void => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => visit(n, `${where}/${i}`));
      return;
    }
    if (!isObj(node)) return;
    const props = node['properties'];
    if (isObj(props)) {
      for (const [name, prop] of Object.entries(props)) {
        if (!name.endsWith('_fen')) continue;
        const target = refName(prop, 'schemas');
        let resolved = target === null ? prop : schemas[target];
        let type = isObj(resolved) ? resolved['type'] : undefined;
        let types = Array.isArray(type) ? type : [type];
        // A list of amounts (e.g. quick_amounts_fen): every item is an int64 amount.
        if (isObj(resolved) && types.includes('array')) {
          const item = resolved['items'];
          const itemTarget = refName(item, 'schemas');
          resolved = itemTarget === null ? item : schemas[itemTarget];
          type = isObj(resolved) ? resolved['type'] : undefined;
          types = Array.isArray(type) ? type : [type];
        }
        if (!isObj(resolved) || !types.includes('integer') || resolved['format'] !== 'int64') {
          problems.push(`${where}/properties/${name}: amounts must be int64 integers (04 §5)`);
        }
      }
    }
    for (const [key, child] of Object.entries(node)) visit(child, `${where}/${key}`);
  };
  visit(schemas, 'components/schemas');
}

/**
 * `x-step-up` (04 §5 step-up row): the value is a step_up_action and is the one the table maps
 * this operation to; the operation is idempotent, lists the X-Step-Up-Token parameter and the
 * codes 10003 and 20903. Without `x-step-up` an operation lists neither the parameter nor 20903
 * (20903 only answers a key abandoned on one of these operations).
 */
function checkStepUp(
  op: Obj,
  where: string,
  actions: readonly string[],
  expected: string | undefined,
  problems: string[],
): void {
  const value = op['x-step-up'];
  const params = Array.isArray(op['parameters'])
    ? op['parameters'].map((p) => refName(p, 'parameters'))
    : [];
  const listed = Array.isArray(op['x-error-codes']) ? op['x-error-codes'] : [];
  if (value === undefined) {
    if (expected !== undefined) {
      problems.push(`${where}: needs x-step-up ${expected} (04 §5 step-up row)`);
    }
    if (params.includes('StepUpToken')) {
      problems.push(`${where}: X-Step-Up-Token is listed only on x-step-up operations`);
    }
    if (listed.includes(20903)) {
      problems.push(`${where}: 20903 is listed only on x-step-up operations`);
    }
    return;
  }
  if (typeof value !== 'string' || !actions.includes(value)) {
    problems.push(`${where}: x-step-up must be one of ${actions.join(', ')}`);
  } else if (value !== expected) {
    problems.push(
      `${where}: x-step-up ${value} does not match 04 §5 (expected ${expected ?? 'none'})`,
    );
  }
  if (op['x-idempotent'] !== true) problems.push(`${where}: x-step-up operations are x-idempotent`);
  if (!params.includes('StepUpToken')) {
    problems.push(`${where}: x-step-up operations list the X-Step-Up-Token parameter`);
  }
  for (const code of STEP_UP_CODES) {
    if (!listed.includes(code)) {
      problems.push(`${where}: x-step-up operations list ${code} in x-error-codes`);
    }
  }
}

/**
 * help_links targets (04 §10.1) are routes of contracts/routes.json: every route the
 * HelpLinkTarget schema allows exists there, and each declared param has exactly that route's
 * param schema (a subset of the route's params, so a valid target is a valid RouteTarget).
 */
function checkHelpLinkTarget(schemas: Obj, problems: string[], routes: string = routesFile): void {
  const target = schemas['HelpLinkTarget'];
  if (!isObj(target)) return;
  const doc: unknown = JSON.parse(readFileSync(routes, 'utf8'));
  const table = isObj(doc) && isObj(doc['routes']) ? doc['routes'] : {};
  const allowed = at(target, 'properties/route/enum');
  const params = at(target, 'properties/params/properties');
  if (!Array.isArray(allowed) || allowed.length === 0) {
    problems.push('components/schemas/HelpLinkTarget: route must be an enum of routes.json names');
    return;
  }
  for (const name of allowed) {
    const route = typeof name === 'string' ? table[name] : undefined;
    const routeParams = isObj(route) ? at(route, 'params/properties') : undefined;
    if (!isObj(route) || !isObj(routeParams)) {
      problems.push(
        `components/schemas/HelpLinkTarget: route ${String(name)} is not in routes.json`,
      );
      continue;
    }
    for (const [param, schema] of Object.entries(isObj(params) ? params : {})) {
      if (JSON.stringify(routeParams[param]) !== JSON.stringify(schema)) {
        problems.push(
          `components/schemas/HelpLinkTarget: param ${param} differs from routes.json ${String(name)}`,
        );
      }
    }
  }
}

/**
 * x-min-version-gate and x-session-scopes (04 §5; BR-ID-01 细则 two tables, copied above).
 */
function checkGateAndScopes(
  op: Obj,
  where: string,
  method: string,
  scopes: readonly string[],
  problems: string[],
): void {
  const gate = op['x-min-version-gate'];
  const listed = Array.isArray(op['x-error-codes']) ? op['x-error-codes'] : [];
  const description =
    typeof op['description'] === 'string' ? op['description'].replace(/\s+/g, ' ') : '';
  if (method === 'get') {
    if (gate !== undefined) problems.push(`${where}: GET operations carry no x-min-version-gate`);
  } else {
    const expected = GATE_EXCEPTIONS[where] ?? 'true';
    const actual = gate === true ? 'true' : gate === false ? 'false' : gate;
    if (gate === undefined) {
      problems.push(`${where}: write operations carry x-min-version-gate (04 §5)`);
    } else if (gate !== true && gate !== false && gate !== 'conditional') {
      problems.push(
        `${where}: x-min-version-gate is the boolean true / false or the string conditional`,
      );
    } else if (actual !== expected) {
      problems.push(
        `${where}: x-min-version-gate ${String(actual)} differs from BR-ID-01 细则 (${expected})`,
      );
    }
    if ((actual === 'true' || actual === 'conditional') && !listed.includes(10405)) {
      problems.push(`${where}: a gated operation lists 10405 in x-error-codes`);
    }
    if (actual === 'conditional' && !/Version gate \(conditional/.test(description)) {
      problems.push(`${where}: a conditional version gate states its condition in the description`);
    }
  }
  if (RESTRICTED_LOGINS.includes(where) && !listed.includes(10405)) {
    problems.push(`${where}: a restricted login lists 10405 (data.reason=no_account)`);
  }
  const marked = op['x-session-scopes'];
  const expectedScope = DELETION_ONLY_SCOPE[where];
  if (marked === undefined) {
    if (expectedScope !== undefined) {
      problems.push(
        `${where}: needs x-session-scopes [full, deletion_only] (BR-ID-01 细则「受限会话」)`,
      );
    }
    return;
  }
  if (!Array.isArray(marked) || marked.some((s) => typeof s !== 'string' || !scopes.includes(s))) {
    problems.push(`${where}: x-session-scopes is a list of session_scope values`);
    return;
  }
  const set = [...new Set(marked)].sort().join(',');
  if (expectedScope === undefined) {
    if (set !== 'full')
      problems.push(
        `${where}: only the operations of BR-ID-01 细则「受限会话」 accept deletion_only`,
      );
  } else if (set !== 'deletion_only,full') {
    problems.push(`${where}: x-session-scopes must be [full, deletion_only]`);
  } else if (
    expectedScope === 'conditional' &&
    !/deletion_only session is accepted only/.test(description)
  ) {
    problems.push(`${where}: a conditional session scope states its condition in the description`);
  }
}

/**
 * /v1/config platform_icons (ConfigPlatformIcons) lists exactly the keys of enum
 * platform_icon_key, the same list as the {key} of /admin/v1/platform-icons (BR-TEXT-24).
 */
function checkPlatformIconKeys(schemas: Obj, keys: readonly string[], problems: string[]): void {
  const properties = at(schemas, 'ConfigPlatformIcons/properties');
  const actual = isObj(properties) ? Object.keys(properties) : [];
  if (keys.length === 0 || !sameSet(actual, keys)) {
    problems.push(
      `components/schemas/ConfigPlatformIcons: keys differ from contracts/enums platform_icon_key ` +
        `(${JSON.stringify(actual)} vs ${JSON.stringify(keys)})`,
    );
  }
}

/** Admin console operations (04 §6.6); x-auth takes enum admin_auth_level there. */
export const ADMIN_PREFIX = '/admin/v1/';

/** Parameters of app requests (04 §5, 03 §4.2) that admin console operations never list. */
const APP_ONLY_PARAMETERS = [
  'AppId',
  'Platform',
  'AppVersion',
  'Build',
  'Channel',
  'DeviceId',
  'OptionalDeviceId',
  'StepUpToken',
  ...SIGN_HEADERS,
];

/**
 * /admin/v1 operations that answer 202 instead of 200: they accept an asynchronous job and
 * return it (CT-24k export tasks). Every other admin operation answers 200.
 */
export const ADMIN_ACCEPTED_OPERATIONS: readonly string[] = ['POST /admin/v1/exports'];

/**
 * /admin/v1 operations (CT-02f): no app headers, signature, version gate or session scopes;
 * 429 → TooManyRequests; x-error-codes are live codes; the success response (200, or 202 for
 * ADMIN_ACCEPTED_OPERATIONS) has an example.
 */
function checkAdminOperation(
  doc: Obj,
  op: Obj,
  where: string,
  live: ReadonlyMap<number, ErrorCodeDef>,
  problems: string[],
): void {
  const params = Array.isArray(op['parameters'])
    ? op['parameters'].map((p) => refName(p, 'parameters'))
    : [];
  for (const name of APP_ONLY_PARAMETERS) {
    if (params.includes(name)) problems.push(`${where}: admin operations do not list ${name}`);
  }
  for (const key of ['x-min-version-gate', 'x-session-scopes']) {
    if (op[key] !== undefined) problems.push(`${where}: admin operations carry no ${key}`);
  }
  if (op['x-signed'] !== undefined && op['x-signed'] !== false) {
    problems.push(`${where}: admin operations are not signed (x-signed false or absent)`);
  }
  if (refName(at(op, 'responses/429'), 'responses') !== 'TooManyRequests') {
    problems.push(`${where}: admin operations declare 429 → TooManyRequests (42901, Retry-After)`);
  }
  const listed = op['x-error-codes'];
  if (!Array.isArray(listed)) problems.push(`${where}: x-error-codes must be a list`);
  else {
    for (const c of listed) {
      if (typeof c !== 'number' || !live.has(c)) {
        problems.push(`${where}: x-error-codes ${String(c)} is not an allocated, live code`);
      }
    }
  }
  const accepted = ADMIN_ACCEPTED_OPERATIONS.includes(where);
  const success = accepted ? '202' : '200';
  const other = accepted ? '200' : '202';
  if (at(op, `responses/${other}`) !== undefined) {
    problems.push(`${where}: an admin operation answers ${success}, not ${other}`);
  }
  const media = responseContent(doc, at(op, `responses/${success}`));
  const json = media?.['application/json'];
  if (!isObj(json) || (json['example'] === undefined && !isObj(json['examples']))) {
    problems.push(`${where}: the ${success} response needs at least one example`);
  }
}

/**
 * Only STREAM_OPERATIONS answer text/event-stream, on any response of any path (/healthz and
 * /admin/v1 included; shared responses are followed through `$ref`). Their 200 declares
 * text/event-stream and nothing else, with a required `Cache-Control: no-cache` header
 * (contracts/README.md rule 16).
 */
function checkStream(doc: Obj, op: Obj, where: string, problems: string[]): void {
  const stream = STREAM_OPERATIONS.includes(where);
  const responses = op['responses'];
  if (isObj(responses)) {
    for (const [status, response] of Object.entries(responses)) {
      const content = responseContent(doc, response);
      const sse = content !== undefined && content['text/event-stream'] !== undefined;
      if (sse && !(stream && status === '200')) {
        problems.push(
          `${where}: only the 200 of STREAM_OPERATIONS may answer text/event-stream (${status})`,
        );
      }
    }
  }
  if (!stream) return;
  const ok = deref(doc, at(op, 'responses/200'));
  const media = responseContent(doc, ok);
  if (media === undefined || media['text/event-stream'] === undefined) {
    problems.push(`${where}: a STREAM_OPERATIONS 200 answers text/event-stream`);
  }
  const others = Object.keys(media ?? {}).filter((type) => type !== 'text/event-stream');
  if (others.length > 0) {
    problems.push(
      `${where}: a STREAM_OPERATIONS 200 declares only text/event-stream content (also ${others.join(', ')})`,
    );
  }
  const headers = isObj(ok) ? ok['headers'] : undefined;
  const cache = deref(doc, isObj(headers) ? headers['Cache-Control'] : undefined);
  const values = isObj(cache) ? at(cache, 'schema/enum') : undefined;
  if (
    !isObj(cache) ||
    cache['required'] !== true ||
    !Array.isArray(values) ||
    !sameSet(values, ['no-cache'])
  ) {
    problems.push(
      `${where}: a STREAM_OPERATIONS 200 declares the required header Cache-Control: no-cache`,
    );
  }
}

export function checkConformance(
  enums: readonly EnumDef[],
  codes: readonly ErrorCodeDef[],
  file: string = openapiFile,
): string[] {
  const problems: string[] = [];
  const doc = parseYamlLite(readFileSync(file, 'utf8'));
  if (!isObj(doc) || !isObj(doc['paths']) || !isObj(doc['components'])) {
    return ['openapi.yaml: paths and components are required'];
  }
  const components = doc['components'];
  const schemas = isObj(components['schemas']) ? components['schemas'] : {};
  const enumValues = new Map(enums.map((e) => [e.name, e.values.map((v) => v.value)]));
  const authLevels = enumValues.get('auth_level') ?? [];
  const adminAuthLevels = enumValues.get('admin_auth_level') ?? [];
  const live = new Map(codes.filter((c) => !c.deprecated).map((c) => [c.code, c]));
  const stepUpActions = enumValues.get('step_up_action') ?? [];
  if (!sameSet(Object.keys(STEP_UP_OPERATIONS), stepUpActions)) {
    problems.push(
      `conformance.ts STEP_UP_OPERATIONS: actions differ from contracts/enums step_up_action ` +
        `(${JSON.stringify(Object.keys(STEP_UP_OPERATIONS))} vs ${JSON.stringify(stepUpActions)})`,
    );
  }
  const stepUpByOperation = new Map(
    Object.entries(STEP_UP_OPERATIONS).map(([action, where]) => [where, action]),
  );

  for (const [pointer, enumName] of Object.entries(ENUM_BINDINGS)) {
    const node = at(schemas, pointer);
    const expected = enumValues.get(enumName);
    const actual = isObj(node) ? node['enum'] : undefined;
    if (expected === undefined) problems.push(`${pointer}: unknown enum ${enumName}`);
    else if (!Array.isArray(actual)) problems.push(`components/schemas/${pointer}: no enum`);
    else if (!sameSet(actual, expected)) {
      problems.push(
        `components/schemas/${pointer}: enum differs from contracts/enums ${enumName} ` +
          `(${JSON.stringify(actual)} vs ${JSON.stringify(expected)})`,
      );
    }
  }

  for (const [pointer, enumName] of Object.entries(ENUM_SUBSETS)) {
    const node = at(schemas, pointer);
    const expected = enumValues.get(enumName) ?? [];
    const actual = isObj(node) ? node['enum'] : undefined;
    if (
      !Array.isArray(actual) ||
      actual.length === 0 ||
      actual.some((v) => !expected.includes(v))
    ) {
      problems.push(
        `components/schemas/${pointer}: enum must be a subset of contracts/enums ${enumName}`,
      );
    }
  }

  for (const [path, item] of Object.entries(doc['paths'])) {
    if (!isObj(item)) continue;
    for (const method of METHODS) {
      const op = item[method];
      if (!isObj(op)) continue;
      const where = `${method.toUpperCase()} ${path}`;
      const admin = path.startsWith(ADMIN_PREFIX);
      const auth = op['x-auth'];
      const levels = admin ? adminAuthLevels : authLevels;
      if (typeof auth !== 'string' || !levels.includes(auth)) {
        problems.push(`${where}: x-auth must be one of ${levels.join(', ')}`);
      }
      const security = op['security'];
      const schemes = Array.isArray(security)
        ? security.map((s) => (isObj(s) ? Object.keys(s).join('+') : '?'))
        : null;
      const expectSecurity = admin
        ? auth === 'none'
          ? []
          : ['adminBearerAuth']
        : auth === 'none'
          ? []
          : auth === 'optional'
            ? ['', 'bearerAuth']
            : ['bearerAuth'];
      if (schemes === null || !sameSet(schemes, expectSecurity)) {
        problems.push(`${where}: security does not match x-auth ${String(auth)}`);
      }
      const impl = op['x-implementation'];
      if (impl !== undefined && impl !== 'planned') {
        problems.push(`${where}: x-implementation may only be "planned"`);
      }
      checkStepUp(op, where, stepUpActions, stepUpByOperation.get(where), problems);
      checkStream(doc, op, where, problems);
      if (admin) {
        checkAdminOperation(doc, op, where, live, problems);
        continue;
      }
      if (!path.startsWith('/v1/')) continue;
      checkGateAndScopes(op, where, method, enumValues.get('session_scope') ?? [], problems);
      // NoStoreTooManyRequests is the same response with Cache-Control: no-store (share pages).
      const r429 = refName(at(op, 'responses/429'), 'responses');
      if (r429 !== 'TooManyRequests' && r429 !== 'NoStoreTooManyRequests') {
        problems.push(
          `${where}: /v1 operations declare 429 → TooManyRequests (42901, Retry-After)`,
        );
      }
      const params = Array.isArray(op['parameters'])
        ? op['parameters'].map((p) => refName(p, 'parameters'))
        : [];
      const signed = op['x-signed'];
      const idem = op['x-idempotent'];
      if (typeof signed !== 'boolean') problems.push(`${where}: x-signed must be true or false`);
      if (typeof idem !== 'boolean') problems.push(`${where}: x-idempotent must be true or false`);
      for (const h of SIGN_HEADERS) {
        if (params.includes(h) !== (signed === true)) {
          problems.push(`${where}: ${h} header must be present exactly when x-signed is true`);
        }
      }
      if (params.includes('IdempotencyKey') !== (idem === true)) {
        problems.push(`${where}: Idempotency-Key must be present exactly when x-idempotent`);
      }
      const listed = op['x-error-codes'];
      if (!Array.isArray(listed)) problems.push(`${where}: x-error-codes must be a list`);
      else {
        for (const c of listed) {
          if (typeof c !== 'number' || !live.has(c)) {
            problems.push(`${where}: x-error-codes ${String(c)} is not an allocated, live code`);
          }
        }
      }
      const media = responseContent(doc, at(op, 'responses/200'));
      const type = STREAM_OPERATIONS.includes(where) ? 'text/event-stream' : 'application/json';
      const json = media?.[type];
      if (!isObj(json) || (json['example'] === undefined && !isObj(json['examples']))) {
        problems.push(`${where}: the 200 response needs at least one example`);
      }
    }
  }
  checkAmounts(schemas, problems);
  checkHelpLinkTarget(schemas, problems);
  checkPlatformIconKeys(schemas, enumValues.get('platform_icon_key') ?? [], problems);
  return problems;
}
