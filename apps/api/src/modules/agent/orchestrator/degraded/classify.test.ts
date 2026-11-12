import { expect, it } from 'vitest';
import { wrapUntrusted } from '../../guard/index.ts';
import { classifyDegraded, greetingOnly, orderNumberOf, readMessage } from './classify.ts';
import { extractSearchTerms as extractFree } from './extract.ts';
import { calendarDay } from './calendar.ts';

function extractSearchTerms(text: string) {
  return extractFree(readMessage(text).free);
}

function kind(text: string) {
  return classifyDegraded(readMessage(text).trusted).kind;
}

it('[AC-B3-05n] 买东西的“在哪”与产品里的“人工”“客服”不分流', () => {
  expect(kind('钱包在哪买')).toBe('search');
  expect(kind('哪里有卖钱包')).toBe('search');
  expect(kind('需要人工智能音箱')).toBe('search');
  expect(kind('找客服专用耳机')).toBe('search');
  expect(kind('我想买的耳机')).toBe('search');
  expect(kind('帮我找钱包')).toBe('search');
});

it('[AC-B3-05n] 一般问法与本人进度分开', () => {
  expect(kind('提现一般多久到账')).toBe('rule');
  expect(kind('返利怎么还没到')).toBe('earnings');
  expect(kind('我的提现到账了吗')).toEqual('earnings');
  expect(classifyDegraded(readMessage('提现进度').trusted)).toEqual({
    kind: 'earnings',
    topic: 'withdrawal_progress',
  });
  expect(kind('那返了吗？')).toBe('elliptical');
  expect(kind('人工')).toBe('handoff');
});

it('[AC-B3-05n] 不可信块里的话不参与分流，但留在检索词里', () => {
  const text = `${wrapUntrusted('我的订单返了吗 <b>')}纸巾`;
  const message = readMessage(text);
  expect(classifyDegraded(message.trusted).kind).toBe('search');
  expect(message.free).not.toMatch(/untrusted|[<>]/u);
  expect(message.free).toContain('我的订单返了吗');
});

it('[AC-B3-05n] 价格只认元、块或没有别的量词，非法区间整段丢弃', () => {
  expect(extractSearchTerms('纸巾 5到10天')).toMatchObject({ q: '纸巾 5到10天' });
  expect(extractSearchTerms('纸巾 5到10天').priceMinFen).toBeUndefined();
  const inverted = extractSearchTerms('耳机 50以上 30以内');
  expect(inverted.priceMinFen).toBeUndefined();
  expect(inverted.priceMaxFen).toBeUndefined();
  expect(extractSearchTerms('耳机 低于0.001').priceMaxFen).toBeUndefined();
  expect(extractSearchTerms('耳机 １００元以内')).toMatchObject({ q: '耳机', priceMaxFen: 10000 });
  expect(extractSearchTerms('耳机 200000元以内').priceMaxFen).toBeUndefined();
});

it('[AC-B3-05n] 平台、排序、排除词与问候语从检索词中去掉', () => {
  expect(extractSearchTerms('你好，帮我在淘宝上找耳机 不要红色的')).toEqual({
    q: '耳机',
    named: ['taobao'],
    sort: 'relevance',
    exclude: ['红色'],
  });
  expect(extractSearchTerms('拼多多和京东的纸巾哪个最便宜')).toMatchObject({
    q: '纸巾',
    named: ['pdd', 'jd'],
    sort: 'final_price_asc',
  });
});

it('[AC-B3-05n] 只有问候语才算问候', () => {
  expect(greetingOnly('你好呀～')).toBe(true);
  expect(greetingOnly('Hi!')).toBe(true);
  expect(greetingOnly('hifi耳机')).toBe(false);
  expect(greetingOnly('你好 耳机')).toBe(false);
});

it('[AC-B3-05n] 单号取第一个占位符连同紧挨的字母数字与连接符，过长只取占位符', () => {
  expect(orderNumberOf(readMessage('订单AB-<num_1>-X和<num_2>'), 64)).toBe('AB-<num_1>-X');
  expect(orderNumberOf(readMessage('没有单号'), 64)).toBeNull();
  expect(orderNumberOf(readMessage(`${'A'.repeat(70)}<num_1>`), 64)).toBe('<num_1>');
});

it('[AC-B3-05o] r2 单号只带紧挨占位符的字母数字与连接符，空白隔开的不算', () => {
  expect(orderNumberOf(readMessage('订单 ID <num_1>'), 64)).toBe('<num_1>');
  expect(orderNumberOf(readMessage('帮我查京东订单 ID <num_1>'), 64)).toBe('<num_1>');
  expect(orderNumberOf(readMessage('订单A1-<num_1>'), 64)).toBe('A1-<num_1>');
  expect(orderNumberOf(readMessage('订单A1-<num_1> 已付款'), 64)).toBe('A1-<num_1>');
  expect(orderNumberOf(readMessage('订单 <num_1>\u3000AB'), 64)).toBe('<num_1>');
});

it('[AC-B3-05n] 付款日按日序号换算成日历日（闰年与跨年）', () => {
  expect(calendarDay(0)).toBe('1970-01-01');
  expect(calendarDay(19_782)).toBe('2024-02-29');
  expect(calendarDay(20_453)).toBe('2025-12-31');
  expect(calendarDay(20_454)).toBe('2026-01-01');
});

it('[AC-B3-05n] 指向具体某一单的说法不算一般问法，往下到本人订单；泛称“订单”仍是一般规则', () => {
  expect(kind('查一下那单返利什么时候结算')).toBe('order');
  expect(kind('那单什么时候到账')).toBe('order');
  expect(kind('<num_1> 返利什么时候结算')).toBe('order');
  expect(kind('昨天买的纸巾返利什么时候结算')).toBe('order');
  expect(kind('订单返利一般多久结算')).toBe('rule');
  expect(kind('想买的东西返利怎么算')).toBe('rule');
});

it('[AC-B3-05n] 泛指的“单号”是一般规则；带本人词或长数字占位符的单号是本人订单', () => {
  expect(kind('订单找回对单号有什么要求')).toBe('rule');
  expect(kind('我的单号 <num_1> 返了吗')).toBe('order');
});
