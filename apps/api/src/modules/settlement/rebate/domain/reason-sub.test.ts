import { expect, it } from 'vitest';
import { loadReasonSubMap } from '../../../orders/index.ts';
import {
  reasonSubOnLaterPunish,
  reasonSubWithReason,
  type ReasonSubMaps,
  type ReasonSubRow,
} from './reason-sub.ts';

const TABLE = loadReasonSubMap(
  'taobao',
  'violation_type,reason_sub,source,verified,note\n合成违规-甲,FAKE_TRADE,doc,false,合成\n',
);
const maps: ReasonSubMaps = (platform) => (platform === 'taobao' ? TABLE : null);

function row(patch: Partial<ReasonSubRow> = {}): ReasonSubRow {
  return { platform: 'taobao', reason: null, reason_sub: null, reason_sub_manual: false, ...patch };
}

it('[AC-B2-04zze-UNIT#1] 写父编码时：PUNISH 按表、对不上兜底并标 unmapped；RIGHTS → AFTER_SALE；其他父编码 null', () => {
  expect(reasonSubWithReason(row(), 'PUNISH', { violationType: '合成违规-甲' }, maps)).toEqual({
    write: true,
    value: 'FAKE_TRADE',
    unmapped: null,
  });
  expect(reasonSubWithReason(row(), 'PUNISH', {}, maps)).toEqual({
    write: true,
    value: 'PUNISH_ORDER',
    unmapped: { raw: null },
  });
  expect(reasonSubWithReason(row(), 'RIGHTS', {}, maps)).toMatchObject({ value: 'AFTER_SALE' });
  expect(reasonSubWithReason(row({ reason_sub: 'FAKE_TRADE' }), 'BLACKLIST', {}, maps)).toEqual({
    write: true,
    value: null,
    unmapped: null,
  });
  expect(reasonSubWithReason(row(), 'COMMISSION_ZERO', {}, maps)).toEqual({ write: false });
});

it('[AC-B2-04zze-UNIT#2] REFUND：结算后记录 / 失效前 SETTLED → AFTER_SETTLE；PAID、DEPOSIT_PAID → IN_SALE；RECEIVED 或未知 → null', () => {
  const sub = (context: Parameters<typeof reasonSubWithReason>[2]) => {
    const d = reasonSubWithReason(row({ reason_sub: 'FAKE_TRADE' }), 'REFUND', context, maps);
    return d.write ? d.value : 'kept';
  };
  expect(sub({ rightsType: 'REFUND_AFTER_SETTLE' })).toBe('AFTER_SETTLE');
  expect(sub({ rightsType: 'INVALID_AFTER_SETTLE' })).toBe('AFTER_SETTLE');
  expect(sub({ fromPlatformStatus: 'SETTLED' })).toBe('AFTER_SETTLE');
  expect(sub({ fromPlatformStatus: 'PAID' })).toBe('IN_SALE');
  expect(sub({ fromPlatformStatus: 'DEPOSIT_PAID' })).toBe('IN_SALE');
  expect(sub({ fromPlatformStatus: 'RECEIVED' })).toBeNull();
  expect(sub({})).toBeNull();
});

it('[AC-B2-04zze-UNIT#3] 人工选过的不写；京东、拼多多一律 null、不告警', () => {
  const manual = row({ reason_sub_manual: true, reason_sub: 'RISK_ORDER' });
  expect(reasonSubWithReason(manual, 'PUNISH', {}, maps)).toEqual({ write: false });
  for (const platform of ['jd', 'pdd']) {
    expect(reasonSubWithReason(row({ platform }), 'PUNISH', {}, maps)).toEqual({ write: false });
    expect(
      reasonSubWithReason(row({ platform, reason_sub: 'AFTER_SALE' }), 'RIGHTS', {}, maps),
    ).toEqual({ write: true, value: null, unmapped: null });
  }
});

it('[AC-B2-04zze-UNIT#4] 父编码不变的后续违规：只细化 PUNISH_ORDER / 空值；具体子原因、人工、别的父编码不动', () => {
  const fallback = row({ reason: 'PUNISH', reason_sub: 'PUNISH_ORDER' });
  expect(reasonSubOnLaterPunish(fallback, '合成违规-甲', maps)).toEqual({
    write: true,
    value: 'FAKE_TRADE',
    unmapped: null,
  });
  expect(reasonSubOnLaterPunish(fallback, '1', maps)).toEqual({ write: false });
  expect(reasonSubOnLaterPunish(row({ reason: 'PUNISH' }), '1', maps)).toEqual({
    write: true,
    value: 'PUNISH_ORDER',
    unmapped: { raw: '1' },
  });
  expect(
    reasonSubOnLaterPunish(
      row({ reason: 'PUNISH', reason_sub: 'RISK_ORDER' }),
      '合成违规-甲',
      maps,
    ),
  ).toEqual({ write: false });
  expect(
    reasonSubOnLaterPunish({ ...fallback, reason_sub_manual: true }, '合成违规-甲', maps),
  ).toEqual({ write: false });
  expect(reasonSubOnLaterPunish(row({ reason: 'REFUND' }), '合成违规-甲', maps)).toEqual({
    write: false,
  });
  expect(reasonSubOnLaterPunish({ ...fallback, platform: 'jd' }, '合成违规-甲', maps)).toEqual({
    write: false,
  });
});

it('[AC-B2-04zze-UNIT#5] 同一处罚重放（mappedOnly）：首次无文本落 PUNISH_ORDER，重放带「能对上的文本」→ 细化；对不上不写、不再告警；具体子原因、人工、别的父编码不动', () => {
  const fallback = row({ reason: 'PUNISH', reason_sub: 'PUNISH_ORDER' });
  const replay = { mappedOnly: true } as const;
  expect(reasonSubOnLaterPunish(fallback, '合成违规-甲', maps, replay)).toEqual({
    write: true,
    value: 'FAKE_TRADE',
    unmapped: null,
  });
  expect(reasonSubOnLaterPunish(row({ reason: 'PUNISH' }), '合成违规-甲', maps, replay)).toEqual({
    write: true,
    value: 'FAKE_TRADE',
    unmapped: null,
  });
  expect(reasonSubOnLaterPunish(fallback, null, maps, replay)).toEqual({ write: false });
  expect(reasonSubOnLaterPunish(row({ reason: 'PUNISH' }), '1', maps, replay)).toEqual({
    write: false,
  });
  expect(
    reasonSubOnLaterPunish({ ...fallback, reason_sub: 'RISK_ORDER' }, '合成违规-甲', maps, replay),
  ).toEqual({ write: false });
  expect(
    reasonSubOnLaterPunish({ ...fallback, reason_sub_manual: true }, '合成违规-甲', maps, replay),
  ).toEqual({ write: false });
  expect(
    reasonSubOnLaterPunish({ ...fallback, reason: 'REFUND' }, '合成违规-甲', maps, replay),
  ).toEqual({ write: false });
});
