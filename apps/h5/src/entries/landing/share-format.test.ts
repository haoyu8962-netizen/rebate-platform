import { expect, it } from 'vitest';
import {
  formatQuoteTime,
  isAllowedMedia,
  isWebUrl,
  isWeChat,
  linkIdFromPath,
  parseMediaOrigins,
} from './share-format.ts';

it('[AC-F1-11a-UNIT#1] linkIdFromPath 只认单段 link_id', () => {
  expect(linkIdFromPath('/0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a70')).toBe(
    '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a70',
  );
  expect(linkIdFromPath('/abc/')).toBe('abc');
  expect(linkIdFromPath('/')).toBeNull();
  expect(linkIdFromPath('/a/b')).toBeNull();
  expect(linkIdFromPath('/%E0%A4%A')).toBeNull();
  expect(linkIdFromPath('/a%20b')).toBeNull();
});

it('[AC-F1-11a-UNIT#2] formatQuoteTime 按 +08:00，跨日带 MM-DD', () => {
  const now = Date.parse('2026-11-10T02:00:00Z');
  expect(formatQuoteTime('2026-11-10T01:30:00Z', now)).toBe('09:30');
  expect(formatQuoteTime('2026-11-09T15:59:00Z', now)).toBe('11-09 23:59');
  expect(formatQuoteTime('2026-11-09T16:05:00Z', now)).toBe('00:05');
  expect(formatQuoteTime('not-a-date', now)).toBeNull();
});

it('[AC-F1-11a-UNIT#3] 只跟随 http(s) 地址，图片只取白名单来源', () => {
  expect(isWebUrl('https://a.example.test/x')).toBe(true);
  expect(isWebUrl('javascript:alert(1)')).toBe(false);
  expect(isWebUrl(null)).toBe(false);
  const origins = parseMediaOrigins(' https://img.example.test , https://bad.example.test/path ,');
  expect(origins).toEqual(['https://img.example.test']);
  expect(isAllowedMedia('https://img.example.test/p.jpg', origins)).toBe(true);
  expect(isAllowedMedia('https://other.example.test/p.jpg', origins)).toBe(false);
  expect(isAllowedMedia(null, origins)).toBe(false);
  expect(parseMediaOrigins(null)).toEqual([]);
});

it('[AC-F1-11a-UNIT#4] isWeChat 按 UA 判断', () => {
  expect(isWeChat('Mozilla/5.0 MicroMessenger/8.0.50')).toBe(true);
  expect(isWeChat('Mozilla/5.0 Safari/604.1')).toBe(false);
});
