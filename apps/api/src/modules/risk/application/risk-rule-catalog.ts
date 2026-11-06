// B1-03zg: the display catalog of the risk rules (CT-24f adminListRiskRules; 规划/04 §3.2
// risk_rules name / threshold_keys). app.risk_rules has no name or threshold_keys column, so this
// code list, kept with the rule codes the risk writers register (B1-03 rule seed, BR-ID-36), gives
// each rule_id its display name and the keys of the configuration items (registered under
// config.risk, read and changed only through /admin/v1/config-items) that hold its thresholds.
// No migration. A rule_id the catalog lacks is listed with name = rule_id and threshold_keys = []
// and logged as a warn, never refused (admin-risk-rules.ts).
//
// The codes, as their writers register them:
// - blocklist.ts: BLACKLIST_<DIMENSION> for its seven dimensions;
// - order-blocklist.ts: BLACKLIST_HIT;
// - identity's risk ports (risk-ports.ts): SMS_BLOCKED_PREFIX, DEVICE_REGISTER_LIMIT;
// - same-device-accounts.ts: SAME_DEVICE_MULTI_ACCOUNT;
// - invite-relation-hits.ts: inv_08_self, inv_08_descendant, inv_08_same_device,
//   inv_09_same_device.
// threshold_keys only names keys that content's configuration registry (config-registry.ts)
// holds under config.risk. The thresholds these rules read today (sms.blocked_prefixes,
// risk.device_register_limit, risk.device_login_accounts_limit) are not registered there as
// configuration items, so the list leaves them out until they are.
// TODO(规划/11 §2.3): 阈值键登记为 config.risk 配置项后补进 thresholdKeys — blocked on config-registry 不在本任务路径内

/** One catalogued rule. */
export interface RiskRuleCatalogEntry {
  /** risk_rules.rule_id as the rule's writer registers it. */
  readonly ruleId: string;
  /** Display name (AdminRiskRule.name, 1–64 characters). */
  readonly name: string;
  /** Configuration item keys holding the rule's thresholds; empty for a rule without one. */
  readonly thresholdKeys: readonly string[];
}

function entry(ruleId: string, name: string, thresholdKeys: readonly string[] = []) {
  return Object.freeze({ ruleId, name, thresholdKeys: Object.freeze([...thresholdKeys]) });
}

const CATALOG: readonly RiskRuleCatalogEntry[] = Object.freeze([
  entry('BLACKLIST_PHONE', '手机号黑名单'),
  entry('BLACKLIST_ID_NO', '身份证号黑名单'),
  entry('BLACKLIST_ALIPAY', '支付宝账号黑名单'),
  entry('BLACKLIST_BANK_CARD', '银行卡黑名单'),
  entry('BLACKLIST_WECHAT_OPENID', '微信账号黑名单'),
  entry('BLACKLIST_DEVICE', '设备黑名单'),
  entry('BLACKLIST_RELATION_ID', '渠道关系 ID 黑名单'),
  entry('BLACKLIST_HIT', '订单命中黑名单'),
  entry('SMS_BLOCKED_PREFIX', '短信号段拦截'),
  entry('DEVICE_REGISTER_LIMIT', '同设备注册上限'),
  entry('SAME_DEVICE_MULTI_ACCOUNT', '同设备多账号'),
  entry('inv_08_self', '邀请绑定：邀请自己'),
  entry('inv_08_descendant', '邀请绑定：邀请人是自己的下级'),
  entry('inv_08_same_device', '邀请绑定：与邀请人同设备'),
  entry('inv_09_same_device', '邀请解绑：首次登录与邀请人同设备'),
]);

const BY_ID: ReadonlyMap<string, RiskRuleCatalogEntry> = new Map(
  CATALOG.map((item) => [item.ruleId, item]),
);

/** Every catalogued rule, one entry per rule_id. */
export function riskRuleCatalog(): readonly RiskRuleCatalogEntry[] {
  return CATALOG;
}

/** The catalog entry of `ruleId` (exact, case-sensitive), or null when the catalog has none. */
export function riskRuleCatalogEntry(ruleId: string): RiskRuleCatalogEntry | null {
  return BY_ID.get(ruleId) ?? null;
}
