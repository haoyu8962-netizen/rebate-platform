// B2-02z console channel page of BALANCE_CORRECTED (claude-independent; D10-2092: inbox only — no
// push, no SMS; contracts/openapi.yaml adminListNotifyChannels: the codes 08 sends as inbox messages
// only, BALANCE_CORRECTED among them, have both switches false; adminSwitchNotifyChannels: a channel
// that may not be switched → 20001 notify_channel_locked, nothing written). Through the real admin
// entry (Fastify inject) with the admin-channels fixture of B1-12z; the code's notify_templates row
// is seeded as the other inbox-only codes are.
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { LOCKED, itemOf, rejected, seedTemplate, setup, snapshot } from '../admin-channels/kit.ts';

const h = useHarness();

it('[AC-B2-02z#6] 后台渠道列表：BALANCE_CORRECTED 推送与短信两个开关都不能动（false）、没有短信登记行、短信 disabled；开推送或开短信都被拒（notify_channel_locked）、不写', async () => {
  const s = await setup(h);
  await seedTemplate(s, { code: 'BALANCE_CORRECTED', channels: ['inbox'], rowVersion: 1 });

  expect(await itemOf(s, 'BALANCE_CORRECTED')).toMatchObject({
    code: 'BALANCE_CORRECTED',
    category: 'service',
    default_channels: ['inbox'],
    channels: ['inbox'],
    push_switchable: false,
    sms_switchable: false,
    sms_fixed: false,
    sms_billing_confirm: false,
    sms_ready: false,
    sms_state: 'disabled',
    sms_deploy_fallback: false,
    sms_registrations: [],
    row_version: 1,
  });

  const before = await snapshot(s);
  const cases: [Record<string, unknown>, string][] = [
    [{ push: true }, 'push'],
    [{ sms: true, confirm_sms_billing: true }, 'sms'],
  ];
  for (const [body, field] of cases) {
    await rejected(
      await s.switchChannels('BALANCE_CORRECTED', { ...body, row_version: 1 }),
      'switch',
      20001,
      { fields: [field], reason: LOCKED },
    );
    expect(await snapshot(s), JSON.stringify(body)).toEqual(before);
  }
}, 900_000);
