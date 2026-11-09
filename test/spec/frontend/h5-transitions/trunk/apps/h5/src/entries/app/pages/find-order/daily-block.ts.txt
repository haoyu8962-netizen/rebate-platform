import type { QueryClient } from '@tanstack/react-query';
import type { DailyBlock } from './model.ts';

/**
 * 30203 / 30206 当天置灰的存放处：壳层的 QueryClient（一个 WebView 壳一个，离开本页再进来仍在），
 * 记录带上海日期，读的时候按注入时钟比对，跨日即失效。不写浏览器存储（本页冻结测试禁止
 * localStorage / sessionStorage，桥也没有存储方法）；登录状态变化（桥事件 auth.changed）时由壳层
 * 连同整份缓存一起清掉（F1-01s），不让上一个账号的置灰落到下一个账号上。读写都包 try/catch，失败时按没有记录处理。
 */
const KEY = ['find-order', 'daily-block'] as const;

function isBlock(value: unknown): value is DailyBlock {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['day'] === 'string' && typeof record['message'] === 'string';
}

export function readDailyBlock(client: QueryClient): DailyBlock | null {
  try {
    const value = client.getQueryData<unknown>(KEY);
    return isBlock(value) ? value : null;
  } catch {
    return null;
  }
}

export function clearDailyBlock(client: QueryClient): void {
  try {
    client.removeQueries({ queryKey: KEY, exact: true });
  } catch {
    // 清不掉时下次读到的也只会是过期或同一账号的记录，服务端仍会按规则拒绝。
  }
}

export function writeDailyBlock(client: QueryClient, block: DailyBlock): void {
  try {
    // 没有观察者的缓存项默认几分钟后被回收；置灰要留到当天结束，所以不回收、不过期。
    client.setQueryDefaults(KEY, { gcTime: Infinity, staleTime: Infinity });
    client.setQueryData(KEY, block);
  } catch {
    // 写不进时只在本次挂载内置灰（组件状态），服务端仍会再次返回同一错误码。
  }
}
