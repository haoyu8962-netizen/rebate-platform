import { call, has } from '@couli/bridge-sdk';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type TouchEvent,
} from 'react';
import { Button, Card, EmptyState, ListRow, Skeleton } from '../../../../components/base/index.ts';
import { ChevronIcon } from '../../../../components/icons/index.tsx';
import { RetryPage } from '../../../../components/retry/index.ts';
import { useApi } from '../../../../shared/api/app-api.ts';
import { ApiError, type H5ApiClient } from '../../../../shared/api/index.ts';
import { ledgerText, ledgerTexts } from '../../../../texts/ledger.ts';
import { Component as PagePending } from '../page-pending.tsx';
import {
  groupByMonth,
  isVisible,
  type LedgerLink,
  type LedgerListData,
  type LedgerRow,
} from './format.ts';

export type LedgerPageProps = Record<string, never>;

/** 每页条数（契约默认 20，上限 50）。 */
const PAGE_LIMIT = 20;
/** 下拉超过这个距离（px）松手才刷新。 */
const PULL_THRESHOLD = 64;
const QUERY_KEY = ['wallet', 'ledger'] as const;

const CAPTION = 'text-couli-caption leading-couli-caption text-couli-text-secondary';

/**
 * 余额流水（F1-04a，路由 Ledger）：经应用级 API 客户端（内部经桥取 H5 令牌）读 listWalletLedger，
 * 按会计月分组；下拉刷新只重取第一页，滚到底按 next_cursor 取下一页。没有 API 客户端（App 外或
 * 未配置）时显示共用占位页，不发请求。
 */
export function LedgerPage(props: LedgerPageProps): ReactElement {
  void props;
  const api = useApi();
  if (api === null) return <PagePending />;
  return <LedgerList api={api} />;
}

function Page({
  children,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
}: {
  children: ReactNode;
  onTouchStart?: (event: TouchEvent) => void;
  onTouchMove?: (event: TouchEvent) => void;
  onTouchEnd?: () => void;
}): ReactElement {
  return (
    <main
      className="flex min-h-dvh min-w-0 flex-col gap-couli-3 bg-couli-background-canvas px-couli-4 pt-couli-2 pb-couli-6 font-couli-system text-couli-text-primary"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      {children}
    </main>
  );
}

const ICON = {
  'aria-hidden': true,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function ListIcon(): ReactElement {
  return (
    <svg {...ICON}>
      <rect x="5.5" y="3.5" width="13" height="17" rx="2" />
      <path d="M9 8.5h6M9 12h6M9 15.5h6" />
    </svg>
  );
}

function RowSkeleton(): ReactElement {
  return (
    <div className="flex items-center gap-couli-3 py-couli-3">
      <div className="flex min-w-0 flex-1 flex-col gap-couli-1">
        <Skeleton width="45%" height="1.3125rem" />
        <Skeleton width="30%" height="1.125rem" />
      </div>
      <Skeleton width="3.5rem" height="1.3125rem" />
    </div>
  );
}

/** 当前文档是否滚在顶部（下拉刷新只在顶部起手时生效）。 */
function atTop(): boolean {
  const scrolled = document.scrollingElement?.scrollTop ?? 0;
  return scrolled <= 0 && window.scrollY <= 0;
}

function LedgerList({ api }: { api: H5ApiClient }): ReactElement {
  const queryClient = useQueryClient();
  const list = useInfiniteQuery({
    queryKey: QUERY_KEY,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.request('GET', '/v1/wallet/ledger', {
        params: {
          query: { limit: PAGE_LIMIT, ...(pageParam === null ? {} : { cursor: pageParam }) },
        },
      }),
    // 游标原样回传；空串或与上一页相同的游标视为到底，避免死循环。
    getNextPageParam: (last, _pages, lastCursor) =>
      last.next_cursor === null || last.next_cursor === '' || last.next_cursor === lastCursor
        ? undefined
        : last.next_cursor,
    // 请求只来自进页、下拉刷新、用户点重试与翻页：关掉一切自动重取（10405 等错误不得被自动重放）。
    // 共用 QueryClient 只关了 retry 与窗口聚焦，这里逐项显式关闭，不依赖默认值。
    retry: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    refetchInterval: false,
    refetchIntervalInBackground: false,
  });
  const { data, hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError } = list;

  // 点按跳转：桥没有 nav.open 时行不可点（不猜路由，不自己拼 URL）。
  const navOpen = useMemo(() => has('nav.open'), []);
  const open = useMemo(() => {
    if (navOpen === null) return null;
    return (link: LedgerLink) => {
      call(navOpen, link).catch(() => undefined);
    };
  }, [navOpen]);

  // 会计日的「同年」按取到数据时的上海日期判断（BR-TEXT-11）。
  const { dataUpdatedAt } = list;
  const groups = useMemo(
    () => groupByMonth(data?.pages.flatMap((page) => page.items) ?? [], dataUpdatedAt),
    [data, dataUpdatedAt],
  );
  const pageCount = data?.pages.length ?? 0;

  // 同一时间只有一个请求在途：翻页与下拉刷新共用这把锁，另以查询缓存的实时状态兜底
  // （API 客户端不接收取消信号，取消查询并不会真的中止 HTTP 请求，所以只能不重叠发起）。
  const busy = useRef<'more' | 'refresh' | null>(null);
  // 翻页在途时的下拉刷新先记下，等这一页回来再刷新（只刷新一次）。
  const refreshQueued = useRef(false);
  function inFlight(): boolean {
    return busy.current !== null || queryClient.isFetching({ queryKey: QUERY_KEY }) > 0;
  }

  // 翻页：到底后不再请求。
  function loadMore(): void {
    if (!hasNextPage || inFlight()) return;
    busy.current = 'more';
    list
      .fetchNextPage({ cancelRefetch: false })
      .catch(() => undefined)
      .finally(() => {
        busy.current = null;
        if (refreshQueued.current) {
          refreshQueued.current = false;
          refresh();
        }
      });
  }
  const onReachBottom = useEffectEvent(loadMore);

  // 已有数据时刷新失败（含 10405）：保留已显示的流水，顶部显示错误提示与手动重试；
  // 不自动重放。重试进行中只显示刷新提示。
  const refreshFailed = list.isRefetchError && !isFetching;
  const refreshError = refreshFailed
    ? list.error instanceof ApiError && list.error.code === 10405
      ? ledgerText('error.10405')
      : ledgerTexts.refreshFailed
    : null;

  // 滚到底：列表末尾的哨兵进入视口时取下一页；每加载一页重建观察器，短列表也能继续触发。
  // 刷新失败时不翻页（旧游标对应的是刷新前的首页）。
  const sentinel = useRef<HTMLDivElement>(null);
  const showSentinel = hasNextPage && !isFetchNextPageError && !refreshFailed;
  useEffect(() => {
    const target = sentinel.current;
    if (!showSentinel || target === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) onReachBottom();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [showSentinel, pageCount]);

  // 下拉刷新：丢掉第一页以后的页，只重取第一页一次；刷新在途时不再发起，翻页在途时排到其后。
  const [isRefreshing, setRefreshing] = useState(false);
  function refresh(): void {
    if (busy.current === 'more') {
      refreshQueued.current = true;
      return;
    }
    if (inFlight()) return;
    busy.current = 'refresh';
    setRefreshing(true);
    queryClient.setQueryData<InfiniteData<LedgerListData, string | null>>(QUERY_KEY, (old) =>
      old === undefined || old.pages.length <= 1
        ? old
        : { pages: old.pages.slice(0, 1), pageParams: old.pageParams.slice(0, 1) },
    );
    list
      .refetch()
      .catch(() => undefined)
      .finally(() => {
        busy.current = null;
        setRefreshing(false);
      });
  }
  const pull = useRef<{ startY: number; distance: number } | null>(null);
  function onTouchStart(event: TouchEvent): void {
    const touch = event.touches[0];
    pull.current = touch !== undefined && atTop() ? { startY: touch.clientY, distance: 0 } : null;
  }
  function onTouchMove(event: TouchEvent): void {
    const touch = event.touches[0];
    if (pull.current !== null && touch !== undefined) {
      pull.current.distance = touch.clientY - pull.current.startY;
    }
  }
  function onTouchEnd(): void {
    const gesture = pull.current;
    pull.current = null;
    if (gesture !== null && gesture.distance >= PULL_THRESHOLD) refresh();
  }

  // 首屏失败：H5 加载失败重试页；重试进行中回到骨架。
  if (data === undefined && list.isError && !isFetching) {
    return <RetryPage onRetry={() => void list.refetch()} />;
  }

  if (data === undefined) {
    return (
      <Page>
        <Card padding="inline">
          <RowSkeleton />
          <RowSkeleton />
          <RowSkeleton />
        </Card>
      </Page>
    );
  }

  const touch = { onTouchStart, onTouchMove, onTouchEnd };
  const banner = isRefreshing ? (
    <Refreshing />
  ) : refreshError === null ? null : (
    <RefreshFailed message={refreshError} onRetry={refresh} />
  );
  const empty = !data.pages.some((page) => page.items.some(isVisible));
  if (empty && !hasNextPage) {
    return (
      <Page {...touch}>
        {banner}
        <div className="flex justify-center pt-couli-12">
          <EmptyState
            icon={<ListIcon />}
            title={ledgerText('ledger.empty')}
            description={ledgerText('ledger.empty.hint')}
          />
        </div>
      </Page>
    );
  }

  let footer: ReactElement | null = null;
  if (isFetchingNextPage) {
    footer = (
      <Card padding="inline">
        <RowSkeleton />
      </Card>
    );
  } else if (isFetchNextPageError) {
    footer = (
      <div className="flex min-h-11 items-center justify-center gap-couli-3">
        <p role="alert" className={CAPTION}>
          {ledgerTexts.moreFailed}
        </p>
        <Button variant="text" onClick={loadMore}>
          {ledgerTexts.retry}
        </Button>
      </div>
    );
  } else if (!hasNextPage) {
    footer = <p className={`${CAPTION} px-couli-1 text-center`}>{ledgerTexts.end}</p>;
  }

  return (
    <Page {...touch}>
      {banner}
      {groups.map((group) => (
        <section key={group.key} className="flex flex-col gap-couli-2">
          <h2 className={`${CAPTION} px-couli-1`}>{group.title}</h2>
          <Card as="ul" padding="none" className="flex flex-col overflow-hidden">
            {group.rows.map(({ key, row }) => (
              <LedgerItem key={key} row={row} open={open} />
            ))}
          </Card>
        </section>
      ))}
      {footer}
      {showSentinel ? <div ref={sentinel} aria-hidden="true" className="h-px" /> : null}
    </Page>
  );
}

function Refreshing(): ReactElement {
  return (
    <p role="status" className={`${CAPTION} text-center`}>
      {ledgerTexts.refreshing}
    </p>
  );
}

function RefreshFailed({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): ReactElement {
  return (
    <div className="flex min-h-11 items-center justify-center gap-couli-3 rounded-couli-button bg-couli-background-muted px-couli-3">
      <p role="alert" className={`${CAPTION} min-w-0 [overflow-wrap:anywhere]`}>
        {message}
      </p>
      <Button variant="text" onClick={onRetry}>
        {ledgerTexts.retry}
      </Button>
    </div>
  );
}

const ROW = 'flex min-h-11 w-full items-center gap-couli-2 px-couli-4 py-couli-3 text-left';
const TITLE = 'text-couli-body leading-couli-body font-couli-medium [overflow-wrap:anywhere]';

/** Second line of a row: the hint (if any) and the accounting date. */
function secondLine(row: LedgerRow): string {
  return row.hint === null ? row.date : `${row.hint} · ${row.date}`;
}

/** Signed amount and, below it, the balance after the entry. */
function Figures({ row }: { row: LedgerRow }): ReactElement {
  return (
    <span className="flex max-w-[55%] flex-none flex-col items-end gap-couli-1 text-right">
      <span
        className={`text-couli-body leading-couli-body font-couli-semibold tabular-nums [overflow-wrap:anywhere] ${
          row.accent ? 'text-couli-rebate-text' : 'text-couli-text-primary'
        }`}
      >
        {row.amount}
      </span>
      {row.balance === null ? null : (
        <span className={`${CAPTION} tabular-nums [overflow-wrap:anywhere]`}>{row.balance}</span>
      )}
    </span>
  );
}

function RowContent({ row }: { row: LedgerRow }): ReactElement {
  return (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-couli-1">
        <span className={TITLE}>{row.name}</span>
        <span className={`${CAPTION} tabular-nums [overflow-wrap:anywhere]`}>
          {secondLine(row)}
        </span>
      </span>
      <Figures row={row} />
    </>
  );
}

function Details({ row }: { row: LedgerRow }): ReactElement | null {
  if (row.details === null) return null;
  return (
    <div className="px-couli-4">
      <dl className="mb-couli-3 flex flex-col gap-couli-1 rounded-couli-button bg-couli-background-muted p-couli-3 text-couli-footnote leading-couli-footnote text-couli-text-secondary">
        {row.details.map((item) => (
          <div key={item.label} className="flex items-start justify-between gap-couli-3">
            <dt className="min-w-0 [overflow-wrap:anywhere]">{item.label}</dt>
            <dd className="flex-none text-right tabular-nums">{item.amount}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function LedgerItem({
  row,
  open,
}: {
  row: LedgerRow;
  open: ((link: LedgerLink) => void) | null;
}): ReactElement {
  const labelId = useId();
  const item = 'border-b border-couli-border-subtle last:border-b-0';
  const link = row.link;
  if (link !== null && open !== null) {
    // 可点的行：整行一个按钮，以行内容为可访问名（名称、日期、带符号金额）。
    return (
      <li className={item}>
        <ListRow
          labelFrom="content"
          title={<span className={TITLE}>{row.name}</span>}
          subtitle={
            <span className="tabular-nums [overflow-wrap:anywhere]">{secondLine(row)}</span>
          }
          trailing={
            <span className="flex min-w-0 items-center gap-couli-2">
              <Figures row={row} />
              <ChevronIcon />
            </span>
          }
          onClick={() => open(link)}
        />
        <Details row={row} />
      </li>
    );
  }
  // 不可点的行：列表项以行内容为可访问名（名称、带符号金额、日期）。
  return (
    <li className={item} aria-labelledby={labelId}>
      <div id={labelId} className={ROW}>
        <RowContent row={row} />
      </div>
      <Details row={row} />
    </li>
  );
}
