import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { enums, errorCodeRanges, errorCodes, ledger_type, platform, scene } from './index.ts';

const codes = Object.keys(errorCodes).map(Number);

it('error codes are 5-digit, unique and outside the reserved ranges', () => {
  expect(codes.length).toBeGreaterThan(0);
  expect(new Set(codes).size).toBe(codes.length);
  for (const code of codes) {
    expect(code).toBeGreaterThanOrEqual(10000);
    expect(code).toBeLessThanOrEqual(59999);
    for (const r of errorCodeRanges) expect(code < r.from || code > r.to).toBe(true);
  }
  expect(errorCodeRanges).toEqual([{ from: 90001, to: 90500, meaning: 'JSBridge 专用码段' }]);
});

it('HTTP status follows the code segment (04 §7 码段)', () => {
  const allowed = (code: number): number[] => {
    if (code >= 44000 && code < 45000) return [403];
    if (code >= 42900 && code < 43000) return [429];
    if (code >= 40900 && code < 41000) return [409];
    if (code < 20000) return [401, 403];
    if (code < 30000) return [400, 409];
    if (code < 40000) return [404, 409, 422];
    return [500, 503, 504];
  };
  for (const code of codes) {
    const entry = errorCodes[code as keyof typeof errorCodes];
    expect(allowed(code)).toContain(entry.http);
  }
  // The only statuses 04 §7 fixes explicitly.
  expect(errorCodes[30803].http).toBe(409);
  expect(errorCodes[30804].http).toBe(409);
});

it('only 20001 has extra statuses: request-body errors keep 413 / 415 (CT-01d)', () => {
  const withExtra = codes.filter(
    (c) => errorCodes[c as keyof typeof errorCodes].http_also.length > 0,
  );
  expect(withExtra).toEqual([20001]);
  expect(errorCodes[20001].http).toBe(400);
  expect(errorCodes[20001].http_also).toEqual([413, 415]);
});

it('deprecated codes stay allocated and are marked (废弃码不回收)', () => {
  const deprecated = codes.filter((c) => errorCodes[c as keyof typeof errorCodes].deprecated);
  expect(deprecated).toEqual([30142, 30152]);
  expect(errorCodes[30310 as keyof typeof errorCodes]).toBeUndefined();
});

it('data shapes of the link and search path match 04 §7', () => {
  expect(errorCodes[30101].data).toEqual({
    auth_url: null,
    state: null,
    auth_methods: ['web_code', 'sdk_token'],
    reason: ['auth_unavailable'],
  });
  expect(errorCodes[30102].data).toEqual({
    auth_url: null,
    state: null,
    auth_methods: ['web_code', 'sdk_token'],
    reason: ['auth_unavailable', 'sharer_auth_invalid'],
  });
  expect(errorCodes[30104].data).toEqual({ reason: ['credential_invalid', 'method_not_allowed'] });
  expect(errorCodes[30111].data).toEqual({ auth_jump: null, reason: ['sharer_auth_invalid'] });
  expect(errorCodes[30101].data.reason).not.toContain('sharer_auth_invalid');
  expect(errorCodes[50301].data).toEqual({
    platform: null,
    reason: ['maintenance', 'not_launched'],
  });
  expect(errorCodes[50304].data).toEqual({
    platform: null,
    reason: ['search_disabled', 'rank_unavailable'],
  });
  expect(errorCodes[50304].retry_kind_by_reason).toEqual({
    search_disabled: 'never',
    rank_unavailable: 'never',
  });
  expect(errorCodes[42901].headers).toEqual(['Retry-After']);
});

it('retry policy splits by data.reason where 08 §13.11 does', () => {
  expect(errorCodes[50301].retry_kind_by_reason).toEqual({
    maintenance: 'later',
    not_launched: 'never',
  });
  expect(errorCodes[30101].retry_kind_by_reason).toEqual({ auth_unavailable: 'later' });
  expect(errorCodes[30102].retry_kind_by_reason).toEqual({
    auth_unavailable: 'later',
    sharer_auth_invalid: 'never',
  });
  expect(errorCodes[30111].retry_kind_by_reason).toEqual({ sharer_auth_invalid: 'never' });
  expect(errorCodes[30102].sources).toContain('BR-ATTR-05');
  expect(errorCodes[30111].sources).toContain('BR-ATTR-05');
  expect(errorCodes[10001].retry_kind_by_reason).toEqual({});
});

it('every enum is non-empty with unique values', () => {
  for (const [name, values] of Object.entries(enums)) {
    expect(values.length, name).toBeGreaterThan(0);
    expect(new Set(values).size, name).toBe(values.length);
  }
});

it('enums carry the 04 §2 value sets', () => {
  expect(platform).toEqual([
    'taobao',
    'jd',
    'pdd',
    'meituan',
    'vip',
    'douyin',
    'eleme',
    'kuaishou',
    'suning',
  ]);
  expect(ledger_type).toHaveLength(13);
  expect(scene).toContain('watch_alert');
  expect(enums.notify_category).toEqual(['service', 'subscription', 'marketing']);
  expect(enums.admin_permission).toContain('user.list');
  expect(enums.admin_permission).toContain('payout.execute');
  expect(enums.admin_permission).toContain('content.fund_terms');
});

it('identity codes of 08 §13.11 (功能对照补缺 1–3 批) carry their data shapes', () => {
  // 10405 is not a credential failure: 403, so that a 401 interceptor does not clear the session
  // (orchestrator decision j-05; 04 and 08 fix no HTTP status for it).
  expect(errorCodes[10405].http).toBe(403);
  expect(errorCodes[10405].data).toEqual({ min_supported_version: null, reason: ['no_account'] });
  // 08 §13.11 10403 row: h5_read_only (BR-ID-32) plus the admin reasons of BR-ID-34 (2026-10-06).
  expect(errorCodes[10403].data).toEqual({
    reason: ['h5_read_only', 'admin_ip_not_allowed', 'admin_permission_denied'],
  });
  expect(errorCodes[20004].data).toEqual({ reason: ['identity_mismatch'] });
  expect(errorCodes[50305].data).toEqual({ provider: ['wechat', 'apple', 'huawei'] });
  expect(errorCodes[20001].data.reason).toEqual([
    'watch_target_invalid',
    'nickname_sensitive',
    'invalid_device_hash',
    'phone_invalid',
    // CT-17g: admin-only platform mark upload rejections (BR-TEXT-24 细则).
    'icon_format_invalid',
    'icon_too_large',
    'icon_svg_unconvertible',
    // CT-22b: favorites over favorites.max_per_user (规划/01 F-PROD-12).
    'favorites_full',
    // CT-24h: admin-only, a reauth_mode=manual union account cannot start OAuth (D10-176).
    'manual_mode',
    // CT-24n: admin order reassign target cannot own orders (D10-169 K-9, BR-ATTR-31).
    'target_banned',
    'target_deleting',
    'target_deleted',
    // CT-24t: admin-only notification channel and SMS registry rejections (D10-335 ②).
    'notify_channel_locked',
    'notify_preview_vars_mismatch',
    'notify_code_ttl_mismatch',
    // CT-24za: admin-only W11 write-off guard refusals (BR-WDR-08 W11, BR-WDR-23 ③, BR-WDR-17).
    'not_payer_side_case',
    'writeoff_disabled',
    'withdrawal_not_returned',
    'transfer_attempts_mismatch',
    'amount_mismatch',
    // CT-24zd: admin-only settle batch write guards (BR-FUND-04, D10-437, D10-440).
    'bill_not_ready',
    'credit_disabled',
    'pending_draft',
    'snapshot_pending',
    'switches_off',
    // CT-24ze: admin-only appeal restore refusals (BR-FUND-22 ③, D10-468 ①, D10-469 ①).
    'restore_not_supported',
    'restore_user_deleted',
    // CT-24zg: admin-only adjustment and write-off refusals (BR-FUND-24, BR-FUND-12).
    'adjust_ref_invalid',
    'reverse_not_allowed',
    'adjust_user_deleted',
    'adjust_no_balance',
    'writeoff_frozen_pending',
    // CT-24zp: admin-only withdrawal rejection refusals (BR-WDR-10, BR-WDR-17, D10-595).
    'reject_attempt_exists',
    'reject_query_required',
    'reject_query_success',
    // CT-24zs: admin-only unknown payout refusals (BR-WDR-15, D10-625).
    'resolve_query_failed',
    'resolve_too_early',
    'resolve_bill_unverifiable',
    'resolve_query_unverifiable',
    'resolve_paid_at_invalid',
    'resolve_order_id_taken',
    'resolve_identity_missing',
    // CT-24zu: W10 voucher cross-check refusals (BR-WDR-15, BR-TEXT-14, D10-703).
    'resolve_order_id_other_order',
    'resolve_order_id_mismatch',
    'resolve_amount_mismatch',
  ]);
  expect(errorCodes[30701].sources).toEqual(['规划/04 §7', 'BR-ID-10', 'BR-ID-40']);
});

it('order enums carry the 资金规则对齐 additions (04 §2.3)', () => {
  expect(enums.order_hold_reason).toEqual(['RISK', 'CS', 'UNMAPPED_STATUS']);
  expect(enums.order_rights_type).toEqual([
    'RIGHTS',
    'PUNISH',
    'INVALID_AFTER_SETTLE',
    'REFUND_AFTER_SETTLE',
  ]);
});

it('fund enums carry the 资金规则对齐 additions (04 §2.4, §2.5)', () => {
  expect(enums.recon_diff_type).toContain('estimate_changed_after_credit');
  expect(enums.settle_batch_item_type).toEqual(['order', 'beneficiary']);
  expect(enums.settle_adjustment_status).toEqual([
    'pending',
    'approved',
    'rejected',
    'voided_stale_seq',
    'voided_by_clawback',
  ]);
  expect(enums.beneficiary_credit_kind).toEqual(['first_credit', 'reassign_credit', 'deferred']);
  expect(enums.beneficiary_credit_status).toEqual(['open', 'done', 'forfeited', 'voided']);
  expect(enums.payout_batch_item_result).toEqual(['paying', 'skipped', 'blocked', 'moved_out']);
});

// CT-01c §9 acceptance points; the task has no separate business AC identifiers.
it('[AC-CT-01c#1] removes the cancelled ticket enums (04 §2.5)', () => {
  expect.soft(enums).not.toHaveProperty('ticket_type');
  expect.soft(enums).not.toHaveProperty('ticket_status');
});

it('[AC-CT-01c#2] synchronizes the admin permissions (04 §11.2; 55 since CT-24a, 56 with notify.channels in CT-24t, 57 with tax.export_full in CT-24zi)', () => {
  expect.soft(enums.admin_permission).toHaveLength(57);
  expect.soft(enums.admin_permission).not.toContain('ticket.handle');
  expect.soft(enums.admin_permission).not.toContain('ticket.data_export');
  for (const permission of [
    'content.app_version',
    'union.pid',
    'fund.cash_entry',
    'tax.export_full',
    'user.realname_fix',
    'user.phone_change',
    'user.data_export',
    'notify.channels',
    'agent.report',
    'dashboard.view',
  ]) {
    expect.soft(enums.admin_permission, permission).toContain(permission);
  }
});

it('[AC-CT-01c#3] limits 20902 resources to active contracts (04 §7)', () => {
  expect(errorCodes[20902].data.resource).toEqual([
    'order',
    'order_attribution',
    'withdrawal',
    'settle_batch',
    // CT-17g: admin platform mark publish / restore CAS (04 §6.6, BR-TEXT-24).
    'platform_icon',
    // CT-02i: admin configuration item and emergency switch CAS (04 §6.6, §10.2).
    'config_item',
    'kill_switch',
    // CT-02j: admin user risk state and union binding CAS (04 §6.6, BR-ID-20, BR-ID-31).
    'user_risk_state',
    'union_binding',
    // CT-02l: admin page draft / publish / gray / rollback CAS (04 §6.6 pages).
    'page',
    // CT-02q: admin agreement publish CAS (04 §6.6 agreements, BR-ID-12).
    'agreement',
    // CT-02s: admin article draft / publish / offline CAS (04 §6.6 articles).
    'article',
    // CT-02r: admin dictionary save / rollback CAS (04 §6.6, BR-TEXT-12).
    'dict_item',
    // CT-24l: admin claim child order approve / reject CAS (04 §6.6 claims, BR-ATTR-18, BR-ATTR-20).
    'claim_item',
    // CT-02v: admin app version save CAS (04 §6.6 app-versions, BR-ID-01).
    'app_version',
    // CT-24f: admin risk rule enable / disable CAS (04 §6.6 risk-rules, BR-ID-36).
    'risk_rule',
    // CT-24h: admin PID change / activate / retire CAS (04 §6.6 union-pids, BR-ATTR-02).
    'union_pid',
    // CT-24o: admin account disable / enable / permission save CAS (04 §6.6 admins, BR-ID-34).
    'admin_account',
    // CT-21b: pay order state CAS and refund CAS (04 §4.9, BR-PAY-02, BR-PAY-06).
    'pay_order',
    'pay_refund',
    // CT-24r: admin appeal claim / resolve CAS (04 §6.6 appeals, BR-ID-36).
    'appeal',
    // CT-24w: admin recon diff close CAS (04 §6.6, BR-FUND-19).
    'recon_diff',
    // CT-07d: admin product pool CAS and retried create (F-ADM-10).
    'product_pool',
    // CT-24zg: admin adjustment approve / reject / reversal and write-off approve CAS.
    'admin_adjustment',
    'bad_debt_writeoff',
    // CT-24zh: union collection whole-record reversal, a record is reversed once (D10-538, BR-FUND-16, BR-FUND-20).
    'union_receipt',
  ]);
});

it('[AC-CT-01c#4] includes closed in reconciliation statuses (04 §2.5)', () => {
  expect(enums.recon_diff_status).toEqual([
    'open',
    'processing',
    'adjusted',
    'written_off',
    'closed',
  ]);
});

// Permission notes are comments in the generated TS catalog, so read the YAML source.
// Use the same test-only loader as openapi.test.ts, without adding a runtime dependency.
const testRequire = createRequire(import.meta.url);
const { parseYamlLite } = testRequire('../../../tools/lib/yaml-lite.ts') as {
  parseYamlLite(text: string): unknown;
};
const adminCatalog = parseYamlLite(
  readFileSync(new URL('../../../contracts/enums/admin.yaml', import.meta.url), 'utf8'),
) as { enums: { admin_permission: { values: Record<string, string> } } };
const permissionNotes = adminCatalog.enums.admin_permission.values;

it.each([
  'union.pid',
  'fund.cash_entry',
  'tax.export_full',
  'user.realname_fix',
  'user.phone_change',
  'user.data_export',
  'withdraw.review',
])('[AC-CT-01c#5] %s requires step-up (04 §11.2)', (permission) => {
  expect(permissionNotes[permission]).toBeTypeOf('string');
  expect(permissionNotes[permission]).toContain('（step-up）');
});

it('[AC-CT-01c#5] agent.report does not require step-up (04 §11.2)', () => {
  expect(permissionNotes['agent.report']).toBeTypeOf('string');
  expect(permissionNotes['agent.report']).not.toContain('step-up');
});

// CT-21a: the payments line permissions of 04 §11.2 (2026-10-04).
it('[CT-21a] adds pay.view, pay.refund, pay.resolve and switch.pay (04 §11.2)', () => {
  for (const permission of ['pay.view', 'pay.refund', 'pay.resolve', 'switch.pay']) {
    expect.soft(enums.admin_permission, permission).toContain(permission);
  }
});

it.each(['pay.resolve', 'switch.pay'])('[CT-21a] %s requires step-up (04 §11.2)', (permission) => {
  expect(permissionNotes[permission]).toBeTypeOf('string');
  expect(permissionNotes[permission]).toContain('（step-up）');
});

it.each(['pay.view', 'pay.refund'])(
  '[CT-21a] %s does not require step-up (04 §11.2)',
  (permission) => {
    expect(permissionNotes[permission]).toBeTypeOf('string');
    expect(permissionNotes[permission]).not.toContain('step-up');
  },
);

it('[CT-21a] switch.pay and switch.payout do not cover each other (04 §11.2)', () => {
  expect(permissionNotes['switch.pay']).toContain('pay.enabled');
  expect(permissionNotes['switch.pay']).not.toContain('payout.');
  expect(permissionNotes['switch.payout']).not.toMatch(/(?:^|、|：)pay\./);
});

// CT-17f: platform mark replacement images (04 §11.2, BR-TEXT-24).
it('[CT-17f] adds content.platform_icon without step-up (04 §11.2, BR-TEXT-24)', () => {
  expect(enums.admin_permission).toContain('content.platform_icon');
  expect(permissionNotes['content.platform_icon']).toBeTypeOf('string');
  expect(permissionNotes['content.platform_icon']).toContain('BR-TEXT-24');
  expect(permissionNotes['content.platform_icon']).not.toContain('step-up');
});

it('[AC-CT-01c#5] content.app_version limits step-up to raising the minimum version (04 §11.2)', () => {
  const note = permissionNotes['content.app_version'];
  expect(note).toBeTypeOf('string');
  expect(note).toContain('（step-up）');
  expect(note).toMatch(/(?:仅|只).*提高最低支持版本|提高最低支持版本.*(?:才|仅)/);
});
