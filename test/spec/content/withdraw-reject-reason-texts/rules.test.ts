import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { withdrawRejectReasonText } from '../../../../apps/api/src/modules/notification/application/withdraw-reject-texts.ts';
import { renderWithdrawalResultMessage } from '../../../../apps/api/src/modules/notification/application/withdrawal-result-message.ts';
import {
  segmentsOfKey,
  type FundTermKeys,
} from '../../../../packages/contracts-ts/scripts/fund-term-keys.ts';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

// CT-26zo：SPEC_REF 009592348c33b9fd5a32c6b37137ed3e99ebc52c，BR-TEXT-08 驳回原因表。
// 期望逐字取任务书 §2；推送整句按 §9（D10-1525）固定，不从实现或字典生成期望。
const reasons = [
  {
    code: 'RISK_SUSPECT',
    text: '账户存在异常，需要核实，请联系客服',
    body: '提现未通过：账户存在异常，需要核实，请联系客服，¥10 已退回余额',
    variant: 'default',
  },
  {
    code: 'ORDER_ABNORMAL',
    text: '部分订单状态待核实，请稍后重新申请',
    body: '提现未通过：部分订单状态待核实，请稍后重新申请，¥10 已退回余额',
    variant: 'default',
  },
  {
    code: 'PAYEE_INFO_INVALID',
    text: '收款信息有误，请核对后重新申请',
    body: '提现未通过：收款信息有误，请核对后重新申请，¥10 已退回余额',
    variant: 'default',
  },
  {
    code: 'USER_REQUEST',
    text: '已按你的要求取消本次提现',
    body: '提现未通过：已按你的要求取消本次提现，¥10 已退回余额',
    variant: 'default',
  },
  {
    code: 'OTHER',
    text: '其他原因，请联系客服',
    body: '提现未通过：其他原因，请联系客服，¥10 已退回余额',
    variant: 'default',
  },
  {
    code: 'NEGATIVE_BALANCE',
    text: '有订单被扣回，冻结金额已用于抵扣',
    body: '提现未通过：有订单被扣回，冻结金额已用于抵扣；抵扣后的余额以钱包显示为准',
    variant: 'negative_balance',
  },
] as const;

const prefix = 'withdraw_reject_reason.';
const root = new URL('../../../../', import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, root), 'utf8');
}

function dictionary(): { version: number; texts: Record<string, string> } {
  return JSON.parse(read('contracts/texts.default.json')) as {
    version: number;
    texts: Record<string, string>;
  };
}

function render(code: string | null) {
  return renderWithdrawalResultMessage(
    {
      status: 'REJECTED',
      reject_reason_code: code,
      amount_fen: 1000n,
      net_fen: 920n,
      fail_code: null,
      payout_channel: 'alipay',
    },
    null,
  );
}

it('[AC-CT-26zo#1] 字典恰含六个驳回原因键、逐字原句且与契约编码集合一致，版本不变', () => {
  const doc = dictionary();
  const actual = Object.fromEntries(
    Object.entries(doc.texts).filter(([key]) => key.startsWith(prefix)),
  );
  expect(actual).toEqual(
    Object.fromEntries(reasons.map(({ code, text }) => [`${prefix}${code}.title`, text])),
  );
  const fund = parseYamlLite(read('contracts/enums/fund.yaml')) as {
    enums: { withdraw_reject_reason: { values: Record<string, string> } };
  };
  expect(Object.keys(actual).sort()).toEqual(
    Object.keys(fund.enums.withdraw_reject_reason.values)
      .map((code) => `${prefix}${code}.title`)
      .sort(),
  );
  expect(doc.version).toBe(1);
});

it('[AC-CT-26zo#2] 六个实际登记的文案键均由已有前缀唯一归为资金术语', () => {
  const texts = dictionary().texts;
  // 先要求实际键存在：不能只测试已经存在的前缀而在主干上变绿。
  for (const { code } of reasons) expect(texts).toHaveProperty([`${prefix}${code}.title`]);
  const terms = parseYamlLite(read('specs/fund-term-keys.yaml')) as FundTermKeys;
  expect(terms.fund_terms.prefixes).toContain(prefix);
  for (const { code } of reasons) {
    expect(segmentsOfKey(terms, `${prefix}${code}.title`)).toEqual(['fund_terms']);
  }
});

it.each(reasons)(
  '[AC-CT-26zo#3] $code 取字典原句，WD_REJECTED 完整推送逐字不变',
  ({ code, text, body, variant }) => {
    // 新入口在同一用例里先调用，确保骨架以 NotImplemented 变红。
    expect(withdrawRejectReasonText(code)).toBe(text);
    expect(render(code)).toEqual({
      code: 'WD_REJECTED',
      variant,
      category: 'service',
      title: '提现未通过',
      body,
    });
  },
);

it.each(['UNKNOWN_REASON', '', 'toString', 'constructor', '__proto__', null])(
  '[AC-CT-26zo#4] 未知或缺失编码 %s 使用 OTHER 原句及默认推送',
  (code) => {
    expect(withdrawRejectReasonText(code)).toBe('其他原因，请联系客服');
    expect(render(code)).toEqual({
      code: 'WD_REJECTED',
      variant: 'default',
      category: 'service',
      title: '提现未通过',
      body: '提现未通过：其他原因，请联系客服，¥10 已退回余额',
    });
  },
);

it('[AC-CT-26zo#5] 通知渲染及字典读取入口不再另存六句驳回文案（含 OTHER 兜底）', () => {
  for (const file of ['withdrawal-result-message.ts', 'withdraw-reject-texts.ts']) {
    const source = read(`apps/api/src/modules/notification/application/${file}`);
    for (const { text } of reasons) expect(source, file).not.toContain(text);
  }
});
