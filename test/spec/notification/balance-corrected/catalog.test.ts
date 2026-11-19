// B2-02z channel catalog of BALANCE_CORRECTED (claude-independent; D10-2092: inbox only — no push,
// no SMS; contracts/openapi.yaml adminListNotifyChannels: the codes 08 sends as inbox messages only,
// BALANCE_CORRECTED among them, have push_switchable and sms_switchable false). Unit test, no
// database: the catalog entry (admin-channels/catalog.ts) and the list item the console gets for
// the code's notify_templates row (admin-channels/view.ts, the application layer of
// adminListNotifyChannels), imported directly from their files.
import { expect, it } from 'vitest';
import { definitionOf } from '../../../../apps/api/src/modules/notification/admin-channels/catalog.ts';
import {
  itemOf,
  type TemplateRow,
} from '../../../../apps/api/src/modules/notification/admin-channels/view.ts';

const AT = new Date('2026-11-19T02:00:00.000Z');

/** The code's single notify_templates row (variant default, service, inbox), no SMS columns. */
function row(patch: Partial<TemplateRow> = {}): TemplateRow {
  return {
    code: 'BALANCE_CORRECTED',
    variant: 'default',
    category: 'service',
    channels: ['inbox'],
    row_version: 0,
    updated_at: AT,
    sms_sign_name: null,
    sms_template_code: null,
    sms_template_type: null,
    sms_preview_text: null,
    sms_pending_sign_name: null,
    sms_pending_template_code: null,
    sms_pending_template_type: null,
    sms_pending_preview_text: null,
    sms_test_status: null,
    sms_tested_at: null,
    sms_pending_saved_at: null,
    ...patch,
  };
}

it('[AC-B2-02z#6] 目录登记 BALANCE_CORRECTED：只发站内信（inboxOnly），默认渠道只有站内信，不是短信固定的编码', () => {
  const definition = definitionOf('BALANCE_CORRECTED');
  expect(definition, 'BALANCE_CORRECTED is in the channel catalog').toBeDefined();
  expect(definition?.inboxOnly).toBe(true);
  expect(definition?.smsFixed).not.toBe(true);
  expect([...(definition?.defaultChannels ?? [])]).toEqual(['inbox']);
}, 900_000);

it('[AC-B2-02z#6] 后台渠道列表项：BALANCE_CORRECTED 推送与短信两个开关都不能开（push_switchable、sms_switchable 为 false），没有短信登记行，短信 disabled', () => {
  for (const fundTerms of [true, false]) {
    expect(itemOf('BALANCE_CORRECTED', [row()], { fundTerms, codeTtlSec: 300 })).toEqual({
      code: 'BALANCE_CORRECTED',
      category: 'service',
      default_channels: ['inbox'],
      channels: ['inbox'],
      push_switchable: false,
      sms_switchable: false,
      sms_fixed: false,
      sms_billing_confirm: false,
      fund_terms: fundTerms,
      sms_ready: false,
      sms_state: 'disabled',
      sms_deploy_fallback: false,
      sms_code_ttl_sec: null,
      sms_registrations: [],
      row_version: 0,
    });
  }
}, 900_000);
