import { expect, it } from 'vitest';
import { createTextClassifier, guideTargets, intentTextPatterns } from './classify.ts';

// Synthetic questions only. BR-AI-01 细则「判定顺序」②: a measure word (这笔 / 那笔) is no evidence
// of an order; account wording wins over order nouns; generic wording is a rule question unless
// it points at the user's own data or one specific item.
const classifier = createTextClassifier(intentTextPatterns(), guideTargets());

it.each([
  ['我这笔提现到账了吗', { kind: 'earnings', withdrawal: true }],
  ['那笔提现到哪了', { kind: 'earnings', withdrawal: true }],
  ['这笔提现怎么还没到', { kind: 'earnings', withdrawal: true }],
  ['那单的提现到账了吗', { kind: 'earnings', withdrawal: true }],
  ['这笔余额什么时候能提', { kind: 'earnings', withdrawal: false }],
  ['这笔收益多少', { kind: 'earnings', withdrawal: false }],
  ['这笔返了吗', { kind: 'personal', withdrawal: false }],
])('[B3-05f][BR-AI-01] 量词不算订单证据，账户类词优先判收益：%s', (text, expected) => {
  expect(classifier.classify(text)).toEqual(expected);
});

it.each([
  '那单返了吗',
  '这笔订单返了吗',
  '这单到账了吗',
  '昨天买的牛奶返利什么时候结算',
  '订单号123456789012返了没',
  '刚下单的怎么还没显示',
  '上一单的返利呢',
  '查一下我的订单',
  '我的订单',
  '我那单',
])('[B3-05f][BR-AI-01] 有订单类名词仍判订单：%s', (text) => {
  expect(classifier.classify(text)).toEqual({ kind: 'order' });
});

it.each(['查一下我的订单', '帮我查查我的订单', '看看我的订单呢', '我的订单', '我那单', '我这单'])(
  '[AC-B3-08t#1][BR-AI-01] 没有进度词时，整句是查本人订单或简短指代才判订单：%s',
  (text) => {
    expect(classifier.classify(text)).toEqual({ kind: 'order' });
  },
);

it.each([
  '订单返利规则是什么？别查我的订单',
  '别查我的订单',
  '不用查我的订单，返利规则是什么',
  '不是查我的订单',
  '我的订单返利规则是什么',
  '我的订单是怎么来的',
])(
  '[AC-B3-08t#1][BR-AI-01] 否定或问规则时，提到「我的订单」不判订单（保留模型标签）：%s',
  (text) => {
    expect(classifier.classify(text)).toEqual({ kind: 'unknown' });
  },
);

it.each([
  '提现最低多少',
  '返利一般什么时候结算',
  '提现手续费是多少',
  '订单一般多久返利',
  '提现一般多久到账',
  '返利规则是什么',
])('[B3-05f][BR-AI-01] 不指向本人的泛规则问法判规则：%s', (text) => {
  expect(classifier.classify(text)).toEqual({ kind: 'rule' });
});

it.each([
  ['我的提现一般多久到账', { kind: 'earnings', withdrawal: true }],
  ['这笔提现一般多久到账', { kind: 'earnings', withdrawal: true }],
  ['那单一般多久返', { kind: 'order' }],
  ['我的订单最低返多少', { kind: 'order' }],
  ['我余额还有多少', { kind: 'earnings', withdrawal: false }],
  ['提现到哪了', { kind: 'earnings', withdrawal: true }],
])('[B3-05f][BR-AI-01] 指向本人数据或具体某笔时不判规则：%s', (text, expected) => {
  expect(classifier.classify(text)).toEqual(expected);
});

it.each([
  ['提现记录在哪看呢', 'WithdrawRecords'],
  ['订单列表在哪呢', 'OrderList'],
  ['钱包在哪里啊', 'Wallet'],
  ['提现记录在哪个页面呀', 'WithdrawRecords'],
  ['我的订单怎么找呢', 'OrderList'],
  ['余额入口在哪儿呢', 'Wallet'],
])('[B3-05f][BR-AI-01] 位置与入口问法优先判页面，语气词不算进度：%s', (text, route) => {
  expect(classifier.classify(text)).toEqual({ kind: 'page', route });
});

it.each([
  ['钱包呢', { kind: 'unknown' }],
  ['提现记录呢', { kind: 'unknown' }],
  ['订单吧', { kind: 'unknown' }],
  ['余额呢', { kind: 'earnings', withdrawal: false }],
  ['提现到哪里了啊', { kind: 'earnings', withdrawal: true }],
  ['我的提现卡在哪一步了', { kind: 'earnings', withdrawal: true }],
])('[B3-05f][BR-AI-01] 只有语气词不算进度，数额名词或进度词才算：%s', (text, expected) => {
  expect(classifier.classify(text)).toEqual(expected);
});
