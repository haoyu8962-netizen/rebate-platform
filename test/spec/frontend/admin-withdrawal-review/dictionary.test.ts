// @vitest-environment jsdom
import { within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { REASONS, mount, open, serverFor } from './helpers.ts';

// BR-TEXT-08 names the dictionary withdraw_reject_reason and its five human codes.
// The pinned planning text has the default copy, but texts.default.json currently lacks these
// entries. Inject deliberately different values to test dictionary consumption independently
// of that outstanding contract asset; this does not claim the production entries exist.
vi.mock('../../../../contracts/texts.default.json', async (original) => {
  const source = await original<{ default: { version: number; texts: Record<string, string> } }>();
  return {
    default: {
      ...source.default,
      texts: {
        ...source.default.texts,
        'withdraw_reject_reason.RISK_SUSPECT': '字典试验甲：请联系客服核实账户',
        'withdraw_reject_reason.ORDER_ABNORMAL': '字典试验乙：请稍后核实订单',
        'withdraw_reject_reason.PAYEE_INFO_INVALID': '字典试验丙：请核对收款信息',
        'withdraw_reject_reason.USER_REQUEST': '字典试验丁：已取消本次申请',
        'withdraw_reject_reason.OTHER': '字典试验戊：请联系客服了解原因',
        'withdraw_reject_reason.NEGATIVE_BALANCE': '系统专用字典试验：不可供人工选择',
      },
    },
  };
});

it(
  '[AC-F1-08ah-DICT#1] 每个人工原因下方读取相应用户字典文案，不能硬编码默认文案或把内部备注当用户文案',
  { timeout: 60_000 },
  async () => {
    const server = serverFor();
    await mount(server);
    const modal = await open('reject');
    const radios = within(modal).queryAllByRole('radio');
    expect(radios).toHaveLength(5);
    const previews = [
      '字典试验甲：请联系客服核实账户',
      '字典试验乙：请稍后核实订单',
      '字典试验丙：请核对收款信息',
      '字典试验丁：已取消本次申请',
      '字典试验戊：请联系客服了解原因',
    ];
    for (const [index, row] of REASONS.entries()) {
      const radio = radios.find(
        (node) =>
          (node instanceof HTMLInputElement && node.value === row.code) ||
          row.name.test(
            node.closest('label')?.textContent ?? node.getAttribute('aria-label') ?? '',
          ),
      );
      expect(radio, row.code).toBeDefined();
      let area = radio!;
      // Permit label-wrapped previews or siblings of the label, but not a detached list of all
      // previews: the option's area must contain just its own radio.
      while (
        area.parentElement !== null &&
        area.parentElement !== modal &&
        within(area.parentElement).queryAllByRole('radio').length === 1
      )
        area = area.parentElement;
      expect(area.textContent, row.code).toContain(previews[index]);
      expect(area.textContent, 'no hardcoded default').not.toContain(row.text);
      for (const [other, preview] of previews.entries())
        if (other !== index) expect(area.textContent).not.toContain(preview);
    }
    expect(modal.textContent).not.toContain('系统专用字典试验');
    expect(server.writes()).toEqual([]);
  },
);
