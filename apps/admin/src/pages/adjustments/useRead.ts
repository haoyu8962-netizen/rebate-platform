// 一次 GET 读（经 admin data provider 的 custom）：`url` 为 undefined 时不读；`attempt` 变了就按同样的
// 条件再读一次。读的过程中保留上一次成功的结果（翻页时表格不跳动）；失败时不留结果。
import { useDataProvider, type BaseRecord } from '@refinedev/core';
import { useEffect, useState } from 'react';

export type ReadState<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly data?: T }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'failed'; readonly cause: unknown };

type Answer<T> =
  | { readonly key: string; readonly ok: true; readonly data: T }
  | { readonly key: string; readonly ok: false; readonly cause: unknown };

export function useRead<T extends BaseRecord>(
  url: string | undefined,
  query: Readonly<Record<string, string | number>> | undefined,
  attempt: number,
): ReadState<T> {
  const getProvider = useDataProvider();
  const [answer, setAnswer] = useState<Answer<T>>();
  // The query is compared by value: a new object with the same parameters is not a new read.
  const queryKey = query === undefined ? '' : JSON.stringify(query);
  const key = url === undefined ? '' : JSON.stringify([url, queryKey, attempt]);

  useEffect(() => {
    if (url === undefined) return;
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    const params = queryKey === '' ? undefined : (JSON.parse(queryKey) as Record<string, unknown>);
    const readKey = JSON.stringify([url, queryKey, attempt]);
    custom<T>({ url, method: 'get', ...(params === undefined ? {} : { query: params }) }).then(
      (response) => {
        if (current) setAnswer({ key: readKey, ok: true, data: response.data });
      },
      (cause: unknown) => {
        if (current) setAnswer({ key: readKey, ok: false, cause });
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, url, queryKey, attempt]);

  if (url === undefined) return { status: 'idle' };
  if (answer === undefined) return { status: 'loading' };
  if (answer.key !== key)
    return answer.ok ? { status: 'loading', data: answer.data } : { status: 'loading' };
  return answer.ok
    ? { status: 'ready', data: answer.data }
    : { status: 'failed', cause: answer.cause };
}
