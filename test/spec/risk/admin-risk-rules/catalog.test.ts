// B1-03zg: risk's rule catalog (risk-rule-catalog.ts; orchestrator ruling #2078): the code list
// that gives each seeded rule_id its display name and threshold configuration keys, since
// app.risk_rules has neither column (04 §3.2 risk_rules; CT-24f AdminRiskRule). The keys must
// be configuration items registered under config.risk (CT-24f adminListRiskRules: read and
// changed only through /admin/v1/config-items).
import { expect, it } from 'vitest';
import { configItemSpecOf } from '../../../../apps/api/src/modules/content/domain/config-registry.ts';
import {
  riskRuleCatalog,
  riskRuleCatalogEntry,
} from '../../../../apps/api/src/modules/risk/application/risk-rule-catalog.ts';

/**
 * The rule codes risk's writers register in app.risk_rules today (blocklist.ts BLACKLIST_<DIMENSION>
 * for its seven dimensions, order-blocklist.ts, identity's risk ports SMS_BLOCKED_PREFIX /
 * DEVICE_REGISTER_LIMIT, same-device-accounts.ts, invite-relation-hits.ts).
 */
const SEEDED = [
  'BLACKLIST_PHONE',
  'BLACKLIST_ID_NO',
  'BLACKLIST_ALIPAY',
  'BLACKLIST_BANK_CARD',
  'BLACKLIST_WECHAT_OPENID',
  'BLACKLIST_DEVICE',
  'BLACKLIST_RELATION_ID',
  'BLACKLIST_HIT',
  'SMS_BLOCKED_PREFIX',
  'DEVICE_REGISTER_LIMIT',
  'SAME_DEVICE_MULTI_ACCOUNT',
  'inv_08_self',
  'inv_08_descendant',
  'inv_08_same_device',
  'inv_09_same_device',
] as const;

/** AdminRiskRuleId. */
const RULE_ID = /^[A-Za-z][A-Za-z0-9_]*$/;
const codePoints = (text: string) => Array.from(text).length;

it('[AC-B1-03zg#3] 目录每项 rule_id 唯一且合契约格式，name 是 1–64 字、不同于代码的展示名', () => {
  const catalog = riskRuleCatalog();
  expect(catalog.length).toBeGreaterThan(0);
  const ids = catalog.map((entry) => entry.ruleId);
  expect(new Set(ids).size).toBe(ids.length);
  for (const entry of catalog) {
    expect(entry.ruleId, entry.ruleId).toMatch(RULE_ID);
    expect(codePoints(entry.ruleId), entry.ruleId).toBeLessThanOrEqual(64);
    expect(entry.name.trim(), entry.ruleId).not.toBe('');
    expect(codePoints(entry.name), entry.ruleId).toBeGreaterThanOrEqual(1);
    expect(codePoints(entry.name), entry.ruleId).toBeLessThanOrEqual(64);
    expect(entry.name, entry.ruleId).not.toBe(entry.ruleId);
  }
});

it('[AC-B1-03zg#4] threshold_keys 不重复，且每个键都是登记在 config.risk 下的配置项', () => {
  for (const entry of riskRuleCatalog()) {
    expect(new Set(entry.thresholdKeys).size, entry.ruleId).toBe(entry.thresholdKeys.length);
    for (const key of entry.thresholdKeys) {
      expect(configItemSpecOf(key)?.permission, `${entry.ruleId} → ${key}`).toBe('config.risk');
    }
  }
});

it.each(SEEDED)('[AC-B1-03zg#5] 风控写入方登记的规则 %s 在目录里', (ruleId) => {
  const ids = riskRuleCatalog().map((entry) => entry.ruleId);
  expect(ids).toContain(ruleId);
});

it('[AC-B1-03zg#6] 按 rule_id 取目录项；未登记的代码（含大小写不同）返回 null', () => {
  const catalog = riskRuleCatalog();
  for (const entry of catalog) {
    expect(riskRuleCatalogEntry(entry.ruleId)).toEqual(entry);
  }
  const ids = new Set(catalog.map((entry) => entry.ruleId));
  for (const code of ['ZZ_NOT_A_RULE', 'blacklist_phone', 'Blacklist_Phone', 'INV_08_SELF']) {
    if (!ids.has(code)) expect(riskRuleCatalogEntry(code), code).toBeNull();
  }
  expect(ids.has('ZZ_NOT_A_RULE')).toBe(false);
});
