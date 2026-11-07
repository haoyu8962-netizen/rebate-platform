import { expect, it } from 'vitest';
import { notify_template_code } from '../../../../packages/contracts-ts/src/enums.gen.ts';
import { code, codeLabel, expectInserted, previousCodes, templateValues } from './kit.ts';

// 本单之前各编码的中文名（SPEC_REF 时点的 contracts/enums/ops.yaml），本单不改。
const previousLabels: Record<string, string> = {
  ORDER_TRACKED: '订单已跟单',
  ORDER_INVALID: '订单失效',
  CREDITED: '月结批次入账（按受益人汇总）',
  CLAWBACK: '扣回',
  WD_SUCCESS: '提现成功',
  WD_REJECTED: '提现驳回',
  WD_FAILED: '提现失败',
  WD_OVERDUE: '提现审核超时',
  CLAIM_RESULT: '找回结果',
  RISK_STATE_CHANGED: '风控状态变化（只发站内信）',
  APPEAL_RESULT: '申诉结果（只发站内信）',
  DELETION_PROGRESS: '注销进度（只发站内信）',
  BALANCE_ADJUSTED: '人工调账调减（只发站内信）',
  SMS_CODE: '短信验证码',
  UNION_AUTH_EXPIRING: '站长授权即将到期（短信）',
  UNION_AUTH_EXPIRED: '站长授权已过期（短信）',
  DATA_COPY_READY: '个人信息副本已生成（推送 + 站内信）',
  DATA_COPY_CODE: '个人信息副本提取码（短信，发到绑定手机号）',
};

it('[AC-CT-26za#1] ops.yaml notify_template_code 新增 SETTLE_ADJUSTED，紧随 CLAWBACK，原有值一个不少', () => {
  const values = templateValues();
  expectInserted(Object.keys(values), previousCodes);
  expect(values[code]).toBe(codeLabel);
});

it('[AC-CT-26za#2] 新增 SETTLE_ADJUSTED 后原有编码的中文名一个不改', () => {
  const values = templateValues();
  expect(Object.hasOwn(values, code), `notify_template_code 缺少 ${code}`).toBe(true);
  for (const [name, label] of Object.entries(previousLabels)) {
    expect(values[name], name).toBe(label);
  }
});

it('[AC-CT-26za#3] 生成的 notify_template_code 与 ops.yaml 同步含 SETTLE_ADJUSTED', () => {
  const generated = notify_template_code as readonly string[];
  expectInserted(generated, previousCodes);
  expect([...generated]).toEqual(Object.keys(templateValues()));
});
