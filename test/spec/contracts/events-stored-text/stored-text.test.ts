// CT-13n（FU-EVENTS-CONTRACT-STORED-TEXT，D10-1626）ingestEvents 说明照实改：合规事件落库并按
// (app_id, event_type, event_id) 去重，只有带本人令牌的 link_jump 写外跳上报时刻；只动描述不动形状。
// 只用稳定关键词与短语断言，不逐字钉整段原文；「受理只表示已收到并校验，不承诺已保存」这层意思不在此处要求删除。
// 每条先核对形状未变（任务书第 9 节第 4 条，附带断言），再核对说明文字。静态读 contracts，不连库、不 listen。
import { expect, it } from 'vitest';
import { contract, description, shapeUnchanged, windows } from './kit.ts';

// 「只收不存」的说法：其余事件只受理不保存、只有 link_jump 会被保存。
const acceptedNotStored = [
  /accepted and not (?:stored|saved|persisted)/iu,
  /\b(?:other|remaining|rest of the)\b[^.。;；]{0,60}\bnot (?:be )?(?:stored|saved|persisted)\b/iu,
  /\bonly (?:the )?link_jump\b[^.。;；]{0,40}\b(?:stored|saved|persisted)\b/iu,
  /只收不存|只有\s*link_jump[^。；;]{0,20}(?:保存|落库|存储)|其[余他]的?事件[^。；;]{0,20}不(?:保存|落库|存储)/u,
];

// 新的去重键与「去重」放在一起说。
const newKey = /\(\s*app_id\s*,\s*event_type\s*,\s*event_id\s*\)/u;
const dedupByNewKey = new RegExp(
  `(?:去重|deduplicat|dedup)[^.。;；]{0,80}${newKey.source}|${newKey.source}[^.。;；]{0,40}(?:去重|deduplicat|dedup)`,
  'iu',
);
// 旧的两元去重说法。
const oldKey = [
  /\(\s*event_type\s*[,，]\s*event_id\s*\)/u,
  /按\s*event_type\s*[,，+和与]\s*event_id/u,
  /\bby\s+event_type\s*(?:,|\+|and)\s*event_id/iu,
];
// 合规事件会落库：「合规 / conforming」（排除 non-conforming、does not conform、不合规）后面同一句里
// 跟着保存一类的词；中间夹着否定或丢弃的不算。
const storedClaim =
  /(?<!not |non-|non |un|不)(?:conforming|conformant|conforms?|合规)(?:[^.。;；]|\.(?=\S)){0,100}?(?:stored|saved|persisted|落库|保存|入库|存储)/giu;
const negated = /\bnot\b|\bnever\b|不承诺|不保证|不会?(?:保存|落库|存储|入库)|丢弃|\bdrop/iu;

// 外跳上报时刻（link_open_attempts.jump_reported_at）。
const jumpReportTime =
  /jump_reported_at|外跳上报时[刻间]|上报时[刻间]|外跳时[刻间]|\b(?:jump|report)(?:ed)?[- ](?:report[- ])?(?:time|timestamp|moment)\b|\btime of the (?:jump )?report\b|\breported[- ]at\b/iu;
const ownToken = /本人令牌|本人的?(?:访问)?令牌|带本人|\bown (?:access )?token\b/iu;
const onlyWord = /\bonly\b|只有|仅|唯有/iu;

it('[AC-CT-13n#1] ingestEvents 说明不再有「其余事件只受理不保存」「只有 link_jump 被保存」这类只收不存的说法', () => {
  const doc = contract();
  shapeUnchanged(doc);
  const value = description(doc);
  for (const pattern of acceptedNotStored) {
    expect(value, `只收不存的说法 ${pattern.source}`).not.toMatch(pattern);
  }
});

it('[AC-CT-13n#2] ingestEvents 说明写明合规事件落库，按 (app_id, event_type, event_id) 去重，旧的 (event_type, event_id) 说法不再出现', () => {
  const doc = contract();
  shapeUnchanged(doc);
  const value = description(doc);
  expect(value, '去重键 (app_id, event_type, event_id)').toMatch(dedupByNewKey);
  for (const pattern of oldKey) {
    expect(value, `旧去重键 ${pattern.source}`).not.toMatch(pattern);
  }
  const claims = [...value.matchAll(storedClaim)]
    .map((match) => match[0] ?? '')
    .filter((claim) => !negated.test(claim));
  expect(claims, '写明合规事件会落库（保存）').not.toEqual([]);
});

it('[AC-CT-13n#3] ingestEvents 说明写明只有带本人令牌的 link_jump 会写外跳上报时刻', () => {
  const doc = contract();
  shapeUnchanged(doc);
  const value = description(doc);
  const nearby = windows(value, jumpReportTime, 200);
  expect(nearby, '说明里提到外跳上报时刻').not.toEqual([]);
  const matching = nearby.filter(
    (part) => /link_jump/u.test(part) && ownToken.test(part) && onlyWord.test(part),
  );
  expect(matching, '外跳上报时刻附近写明只有带本人令牌的 link_jump').not.toEqual([]);
});
