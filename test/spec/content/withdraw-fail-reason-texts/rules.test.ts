import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { withdrawFailReasonText } from '../../../../apps/api/src/modules/notification/application/withdraw-fail-texts.ts';
import { renderWithdrawalResultMessage } from '../../../../apps/api/src/modules/notification/application/withdrawal-result-message.ts';
import {
  segmentsOfKey,
  type FundTermKeys,
} from '../../../../packages/contracts-ts/scripts/fund-term-keys.ts';
import { parseYamlLite } from '../../../../tools/lib/yaml-lite.ts';

// CT-26zp：SPEC_REF 009592348c33b9fd5a32c6b37137ed3e99ebc52c，BR-TEXT-08 失败原因映射与兜底句
// （D10-228）、BR-WDR-33 ⑥ 微信两项。期望逐字取任务书 §2 / §9；推送整句按 D10-1525 固定为现行
// 输出（账号类码现行带「，可修改收款账号后重试」，本单不改该判定），不从实现或字典生成期望。
const reasons = [
  {
    code: 'PAYEE_NOT_EXIST',
    text: '收款支付宝账号不存在',
    body: '提现打款未成功：收款支付宝账号不存在，¥10 已退回余额，可修改收款账号后重试',
  },
  {
    code: 'PAYEE_USER_INFO_ERROR',
    text: '收款账号姓名与实名信息不一致',
    body: '提现打款未成功：收款账号姓名与实名信息不一致，¥10 已退回余额，可修改收款账号后重试',
  },
  {
    code: 'PAYEE_ACCOUNT_STATUS_ERROR',
    text: '收款支付宝账号状态异常',
    body: '提现打款未成功：收款支付宝账号状态异常，¥10 已退回余额，可修改收款账号后重试',
  },
  {
    code: 'USER_CONFIRM_TIMEOUT',
    text: '没有在规定时间内到微信确认收款',
    body: '提现打款未成功：没有在规定时间内到微信确认收款，¥10 已退回余额',
  },
  {
    code: 'USER_REQUEST_CANCEL',
    text: '已按你的要求取消',
    body: '提现打款未成功：已按你的要求取消，¥10 已退回余额',
  },
] as const;

const fallback = '收款渠道未能完成这笔转账';
const fallbackBody = '提现打款未成功：收款渠道未能完成这笔转账，¥10 已退回余额';

const prefix = 'withdraw_fail_reason.';
const expectedKeys: Record<string, string> = {
  ...Object.fromEntries(reasons.map(({ code, text }) => [`${prefix}${code}.title`, text])),
  [`${prefix}default.title`]: fallback,
};
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

function facts(status: string, failCode: string | null, rejectCode: string | null = null) {
  return {
    status,
    reject_reason_code: rejectCode,
    amount_fen: 1000n,
    net_fen: 920n,
    fail_code: failCode,
    payout_channel: 'alipay' as const,
  };
}

function renderFailed(code: string | null) {
  return renderWithdrawalResultMessage(facts('FAILED', code), null);
}

it('[AC-CT-26zp#1] 字典恰含六个失败原因键（五个码 + 兜底），值逐字原句，版本不变', () => {
  const doc = dictionary();
  const actual = Object.fromEntries(
    Object.entries(doc.texts).filter(([key]) => key.startsWith(prefix)),
  );
  expect(actual).toEqual(expectedKeys);
  expect(doc.version).toBe(1);
});

it('[AC-CT-26zp#2] 六个实际登记的失败原因键均由已有前缀唯一归为资金术语', () => {
  const texts = dictionary().texts;
  // 先要求实际键存在：不能只测试已经存在的前缀而在主干上变绿。
  for (const key of Object.keys(expectedKeys)) expect(texts).toHaveProperty([key]);
  const terms = parseYamlLite(read('specs/fund-term-keys.yaml')) as FundTermKeys;
  expect(terms.fund_terms.prefixes).toContain(prefix);
  for (const key of Object.keys(expectedKeys)) {
    expect(segmentsOfKey(terms, key)).toEqual(['fund_terms']);
  }
});

it.each(reasons)(
  '[AC-CT-26zp#3] $code 取字典原句，WD_FAILED 完整推送逐字不变',
  ({ code, text, body }) => {
    // 新入口在同一用例里先调用，确保骨架以 NotImplemented 变红。
    expect(withdrawFailReasonText(code)).toBe(text);
    expect(renderFailed(code)).toEqual({
      code: 'WD_FAILED',
      variant: 'default',
      category: 'service',
      title: '提现打款未成功',
      body,
    });
  },
);

it.each(['UNKNOWN_FAIL_CODE', 'SYSTEM_ERROR', '', 'toString', 'constructor', '__proto__', null])(
  '[AC-CT-26zp#4] 未知或缺失失败码 %s 使用兜底句及默认推送',
  (code) => {
    expect(withdrawFailReasonText(code)).toBe(fallback);
    expect(renderFailed(code)).toEqual({
      code: 'WD_FAILED',
      variant: 'default',
      category: 'service',
      title: '提现打款未成功',
      body: fallbackBody,
    });
  },
);

it('[AC-CT-26zp#5] 其余变体 WD_SUCCESS、WD_REJECTED 推送不受影响', () => {
  // 新入口先调用，确保骨架以 NotImplemented 变红。
  expect(withdrawFailReasonText('PAYEE_NOT_EXIST')).toBe('收款支付宝账号不存在');
  expect(renderWithdrawalResultMessage(facts('PAID_API', null), null)).toEqual({
    code: 'WD_SUCCESS',
    variant: 'default',
    category: 'service',
    title: '提现到账',
    body: '提现已到账：¥9.2 已转入支付宝',
  });
  expect(renderWithdrawalResultMessage(facts('REJECTED', null, 'OTHER'), null)).toEqual({
    code: 'WD_REJECTED',
    variant: 'default',
    category: 'service',
    title: '提现未通过',
    body: '提现未通过：其他原因，请联系客服，¥10 已退回余额',
  });
  expect(renderWithdrawalResultMessage(facts('REJECTED', null, 'NEGATIVE_BALANCE'), null)).toEqual({
    code: 'WD_REJECTED',
    variant: 'negative_balance',
    category: 'service',
    title: '提现未通过',
    body: '提现未通过：有订单被扣回，冻结金额已用于抵扣；抵扣后的余额以钱包显示为准',
  });
});

it('[AC-CT-26zp#6] 通知渲染及字典读取入口不再另存六句失败原因文案（含兜底句）', () => {
  for (const file of ['withdrawal-result-message.ts', 'withdraw-fail-texts.ts']) {
    const source = read(`apps/api/src/modules/notification/application/${file}`);
    for (const text of Object.values(expectedKeys)) expect(source, file).not.toContain(text);
  }
});
