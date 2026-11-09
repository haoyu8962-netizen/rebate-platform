import { t } from '../../../../shared/texts.ts';
import type { Claim } from './model.ts';

// 「申请找回」提交结果的落位。单独成块、不依赖页面块（表单发出请求后再取，进页时已预取）。

/** 普通对象（非数组）；与 model.ts 的同名小工具相同，这里不从页面块引用。 */
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 提交结果落在哪里：订单号框下、日期框下、按钮上方（当天置灰或通用错误）、或跳到记录页签。 */
export type SubmitOutcome =
  | { kind: 'created'; claim: Claim }
  | { kind: 'inline'; order: string | null; date: string | null }
  | { kind: 'blocked'; message: string }
  | { kind: 'duplicate'; message: string }
  | { kind: 'general'; message: string };

const REASONS_30202 = new Set([
  'FACTOR_MISMATCH',
  'CLAIM_EXPIRED',
  'ORDER_INVALID',
  'ALREADY_YOURS',
]);

function reasonOf(data: unknown): string | null {
  const reason = record(data)?.['reason'];
  return typeof reason === 'string' ? reason : null;
}

function fieldsOf(data: unknown): string[] {
  const fields = record(data)?.['fields'];
  return Array.isArray(fields) ? fields.filter((item) => typeof item === 'string') : [];
}

/** 未知码按契约通用码 50001 的文字（服务端 msg 一律不显示）。 */
function generalText(code: number): string {
  return t(`error.${code}`) || t('error.50001');
}

/**
 * 按错误码决定文案与位置（BR-TEXT-14 表 A / 表 B；编排裁定 3）。服务端 msg 与 data 里的其他内容一律不显示。
 */
export function outcomeFor(code: number, data: unknown): SubmitOutcome {
  switch (code) {
    case 0:
      return { kind: 'created', claim: data as Claim };
    case 20001: {
      const fields = fieldsOf(data);
      const message = t('error.20001');
      const date = fields.includes('paid_date');
      const order = fields.includes('order_no') || !date;
      return { kind: 'inline', order: order ? message : null, date: date ? message : null };
    }
    case 30201:
    case 30204:
      return { kind: 'inline', order: t(`error.${code}`), date: null };
    case 30202: {
      const reason = reasonOf(data);
      const known = reason !== null && REASONS_30202.has(reason);
      const message = known ? t(`error.30202.${reason}`) : t('error.30202');
      return reason === 'FACTOR_MISMATCH'
        ? { kind: 'inline', order: null, date: message }
        : { kind: 'inline', order: message, date: null };
    }
    case 30203:
      return {
        kind: 'blocked',
        message:
          reasonOf(data) === 'RISK_BLOCKED' ? t('error.30203.RISK_BLOCKED') : t('error.30203'),
      };
    case 30206:
      return { kind: 'blocked', message: t('error.30206') };
    case 30205:
      return { kind: 'duplicate', message: t('error.30205') };
    case 10405:
      return { kind: 'general', message: t('error.10405') };
    default:
      return { kind: 'general', message: generalText(code) };
  }
}

/** net.signedRequest 返回的 body 解析成业务信封；不是信封时按通用错误。 */
export function outcomeOfResponse(body: unknown): SubmitOutcome {
  const envelope = record(body);
  const code = envelope?.['code'];
  if (typeof code !== 'number' || !Number.isInteger(code)) {
    return { kind: 'general', message: generalText(50001) };
  }
  if (code === 0 && record(envelope?.['data']) === null) {
    return { kind: 'general', message: generalText(50001) };
  }
  return outcomeFor(code, envelope?.['data']);
}
