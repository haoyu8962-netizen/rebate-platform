import { expect, it } from 'vitest';
import { parseTaobaoItemLink } from './resolve-link.ts';

it.each([
  ['https://item.taobao.com/item.htm?id=123456789', '123456789'],
  ['https://detail.tmall.com/item.htm?id=123456789', '123456789'],
  ['https://detail.tmall.com/item.htm?spm=x&id=42#frag', '42'],
  ['https://ITEM.TaoBao.com/item.htm?id=1', '1'],
  ['https://item.taobao.com./item.htm?id=1', '1'],
  ['https://item.taobao.com/item.htm?id=12345678901234567890', '12345678901234567890'],
  ['https://item.taobao.com/item.htm?id=007', '007'],
])('parseTaobaoItemLink 认 %s', (raw, id) => {
  expect(parseTaobaoItemLink(raw)).toBe(id);
});

it.each([
  '',
  '合成淘口令',
  'item.taobao.com/item.htm?id=1',
  'http://item.taobao.com/item.htm?id=1',
  'ftp://item.taobao.com/item.htm?id=1',
  'https://user@item.taobao.com/item.htm?id=1',
  'https://user:pw@item.taobao.com/item.htm?id=1',
  'https://item.taobao.com:8443/item.htm?id=1',
  'https://item.taobao.com../item.htm?id=1',
  'https://a.item.taobao.com/item.htm?id=1',
  'https://item.taobao.com.example.invalid/item.htm?id=1',
  'https://detail.m.tmall.com/item.htm?id=1',
  'https://eviltmall.com/item.htm?id=1',
  'https://s.click.taobao.com/abc',
  'https://m.tb.cn/abc',
  'https://item.taobao.com/item.htm',
  'https://item.taobao.com/item.htm?id=',
  'https://item.taobao.com/item.htm?id=abc',
  'https://item.taobao.com/item.htm?id=12a',
  'https://item.taobao.com/item.htm?id=-1',
  'https://item.taobao.com/item.htm?id=%201',
  'https://item.taobao.com/item.htm?id=123456789012345678901',
  'https://item.taobao.com/item.htm?id=1&id=2',
  'https://item.taobao.com/item.htm/?id=1',
  'https://item.taobao.com/x/item.htm?id=1',
  'https://item.taobao.com/ITEM.htm?id=1',
  'https://item.taobao.com/other.htm?id=1',
  'https://item.taobao.com/item.htm#id=1',
])('parseTaobaoItemLink 不认 %j', (raw) => {
  expect(parseTaobaoItemLink(raw)).toBeNull();
});
