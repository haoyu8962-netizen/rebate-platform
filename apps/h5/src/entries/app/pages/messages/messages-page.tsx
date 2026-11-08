import { call, has } from '@couli/bridge-sdk';
import { useInfiniteQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type TouchEvent,
} from 'react';
import { Button, Card, EmptyState, ListRow, Skeleton } from '../../../../components/base/index.ts';
import { RetryPage } from '../../../../components/retry/index.ts';
import { useApi } from '../../../../shared/api/app-api.ts';
import { ApiError, type H5ApiClient } from '../../../../shared/api/index.ts';
import { messagesText, messagesTexts } from '../../../../texts/messages.ts';
import { Component as PagePending } from '../page-pending.tsx';
import {
  formatMessageTime,
  isUnread,
  markLoadedRead,
  shortTitle,
  targetOf,
  type InboxMessage,
  type MessageTarget,
  type MessagesListData,
} from './format.ts';

export type MessagesPageProps = Record<string, never>;

/** 每页条数（契约默认 20，上限 50）。 */
const PAGE_LIMIT = 20;
/** 下拉超过这个距离（px）松手才刷新。 */
const PULL_THRESHOLD = 64;
const LIST_KEY = ['messages', 'list'] as const;

const CAPTION = 'text-couli-caption leading-couli-caption text-couli-text-secondary';

/** 注销冷静期内标已读的回包错误码（编排裁定 D10-542）。 */
const COOLING_OFF = 10007;

/**
 * 消息中心（F1-04c，路由 Messages）：经应用级 API 客户端（内部经桥取 H5 令牌）读 listMessages，
 * 游标翻页、下拉刷新。有 route 的行经 nav.open 跳转并对该条标已读，「全部已读」以 {all:true}
 * 标已读。H5 令牌读不了注销状态（BR-ID-32），不预判冷静期：标已读回 10007 后本页隐藏「全部已读」、
 * 不再标已读、不提示（编排裁定 D10-542，BR-ID-27 细则 W-20）。没有 API 客户端（App 外或未配置）时显示共用占位页，不发请求。
 */
export function MessagesPage(props: MessagesPageProps): ReactElement {
  void props;
  const api = useApi();
  if (api === null) return <PagePending />;
  return <MessagesList api={api} />;
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

/** 页标题由原生导航栏显示，这里只给读屏一个页面标题；「全部已读」在右侧。 */
function Header({ action }: { action: ReactNode }): ReactElement {
  return (
    <header className="flex min-h-11 items-center justify-end">
      <h1 className="sr-only">{messagesTexts.title}</h1>
      {action}
    </header>
  );
}

function BellIcon(): ReactElement {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </svg>
  );
}

function RowSkeleton(): ReactElement {
  return (
    <div className="flex flex-col gap-couli-1 py-couli-3">
      <div className="flex items-center justify-between gap-couli-3">
        <Skeleton width="40%" height="1.3125rem" />
        <Skeleton width="3.5rem" height="1.125rem" />
      </div>
      <Skeleton width="80%" height="1.125rem" />
    </div>
  );
}

/** 当前文档是否滚在顶部（下拉刷新只在顶部起手时生效）。 */
function atTop(): boolean {
  const scrolled = document.scrollingElement?.scrollTop ?? 0;
  return scrolled <= 0 && window.scrollY <= 0;
}

function MessagesList({ api }: { api: H5ApiClient }): ReactElement {
  const queryClient = useQueryClient();
  const list = useInfiniteQuery({
    queryKey: LIST_KEY,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.request('GET', '/v1/messages', {
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
    retry: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    refetchInterval: false,
    refetchIntervalInBackground: false,
  });
  const { data, hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError } = list;

  // 标已读回过 10007（注销冷静期）：本页此后不再标已读、不显示「全部已读」。ref 供同步判断，
  // state 驱动重渲染。其他失败不影响之后的标已读。
  const coolingRef = useRef(false);
  const [cooling, setCooling] = useState(false);
  function markReadRequest(body: { message_ids: string[] } | { all: true }): Promise<boolean> {
    if (coolingRef.current) return Promise.resolve(false);
    return api.request('POST', '/v1/messages/read', { body }).then(
      () => !coolingRef.current,
      (error: unknown) => {
        if (error instanceof ApiError && error.code === COOLING_OFF) {
          coolingRef.current = true;
          setCooling(true);
        }
        return false;
      },
    );
  }

  // 标已读成功后把已加载的消息记为已读（ids 为 null 时全部）；不重取列表。
  function markRead(ids: ReadonlySet<string> | null): void {
    const readAt = new Date().toISOString();
    queryClient.setQueryData<InfiniteData<MessagesListData, string | null>>(LIST_KEY, (old) => {
      if (old === undefined) return old;
      let changed = false;
      const pages = old.pages.map((page) => {
        const items = markLoadedRead(page.items, ids, readAt);
        if (items === null) return page;
        changed = true;
        return { ...page, items };
      });
      return changed ? { ...old, pages } : old;
    });
  }

  // 点开：先经 nav.open 跳转（不等标已读），再对这一条标已读；回过 10007 后不再标。
  // 标已读失败（含 10007、10403 只读令牌、20001、10405、50001）不提示，未读状态保留。
  const navOpen = useMemo(() => has('nav.open'), []);
  const open =
    navOpen === null
      ? null
      : (message: InboxMessage, target: MessageTarget): void => {
          call(navOpen, target).catch(() => undefined);
          if (!isUnread(message)) return;
          void markReadRequest({ message_ids: [message.message_id] }).then((ok) => {
            if (ok) markRead(new Set([message.message_id]));
          });
        };

  // 「全部已读」：{all:true} 一次标完（含未加载的消息）；失败不提示，可再点。
  const [readingAll, setReadingAll] = useState(false);
  function readAll(): void {
    if (readingAll || coolingRef.current) return;
    setReadingAll(true);
    void markReadRequest({ all: true })
      .then((ok) => {
        if (ok) markRead(null);
      })
      .finally(() => setReadingAll(false));
  }

  const items = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  const pageCount = data?.pages.length ?? 0;
  // 「今天 / 昨天 / 同年」按取到数据时的上海日期判断（BR-TEXT-11）。
  const { dataUpdatedAt } = list;

  // 同一时间只有一个列表请求在途：翻页与下拉刷新共用这把锁，另以查询缓存的实时状态兜底。
  const busy = useRef<'more' | 'refresh' | null>(null);
  // 翻页在途时的下拉刷新先记下，等这一页回来再刷新（只刷新一次）。
  const refreshQueued = useRef(false);
  // 页面仍挂着、且这份查询仍在缓存里且有观察者：退出登录或换号时壳层清空查询并重挂页面树，
  // 之后旧页面里排队或在途的刷新一律作废（不取令牌、不发请求、不把旧账号的数据写回缓存）。
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refreshQueued.current = false;
    };
  }, []);
  function alive(): boolean {
    const query = queryClient.getQueryCache().find({ queryKey: LIST_KEY, exact: true });
    return mounted.current && query !== undefined && query.isActive();
  }
  function inFlight(): boolean {
    return busy.current !== null || queryClient.isFetching({ queryKey: LIST_KEY }) > 0;
  }

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
          if (alive()) refresh();
        }
      });
  }
  const onReachBottom = useEffectEvent(loadMore);

  // 已有数据时刷新失败：保留已加载的全部消息，顶部显示错误提示与手动重试；不自动重放。
  const [refreshFailure, setRefreshFailure] = useState<unknown>(null);
  const refreshFailed = refreshFailure !== null;
  const refreshError = refreshFailed
    ? refreshFailure instanceof ApiError && refreshFailure.code === 10405
      ? messagesText('error.10405')
      : messagesTexts.refreshFailed
    : null;

  // 滚到底：列表末尾的哨兵进入视口时取下一页；每加载一页重建观察器，短列表也能继续触发。
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

  // 下拉刷新：只重取第一页一次，成功后才以它替换已加载的全部页（丢掉旧的后续页与游标）；
  // 失败时缓存不动，已加载的消息全部保留。刷新在途时不再发起，翻页在途时排到其后。
  const [isRefreshing, setRefreshing] = useState(false);
  function refresh(): void {
    if (!alive()) return;
    if (busy.current === 'more') {
      refreshQueued.current = true;
      return;
    }
    if (inFlight()) return;
    busy.current = 'refresh';
    setRefreshing(true);
    api
      .request('GET', '/v1/messages', { params: { query: { limit: PAGE_LIMIT } } })
      .then(
        (first) => {
          if (!alive()) return;
          queryClient.setQueryData<InfiniteData<MessagesListData, string | null>>(LIST_KEY, {
            pages: [first],
            pageParams: [null],
          });
          setRefreshFailure(null);
        },
        (error: unknown) => {
          if (alive()) setRefreshFailure(error ?? new Error('refresh failed'));
        },
      )
      .finally(() => {
        busy.current = null;
        if (mounted.current) setRefreshing(false);
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
        <Header action={null} />
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
    <p role="status" className={`${CAPTION} text-center`}>
      {messagesTexts.refreshing}
    </p>
  ) : refreshError === null ? null : (
    <div className="flex min-h-11 items-center justify-center gap-couli-3 rounded-couli-button bg-couli-background-muted px-couli-3">
      <p role="alert" className={`${CAPTION} min-w-0 [overflow-wrap:anywhere]`}>
        {refreshError}
      </p>
      <Button variant="text" onClick={refresh}>
        {messagesTexts.retry}
      </Button>
    </div>
  );

  if (items.length === 0 && !hasNextPage) {
    return (
      <Page {...touch}>
        <Header action={null} />
        {banner}
        <div className="flex justify-center pt-couli-12">
          <EmptyState
            icon={<BellIcon />}
            title={messagesText('messages.empty')}
            description={messagesText('messages.empty_hint')}
          />
        </div>
      </Page>
    );
  }

  // 标已读回过 10007（注销冷静期）后不显示「全部已读」（D10-542，BR-ID-27 细则 W-20）。
  const readAllButton = !cooling ? (
    <Button variant="text" disabled={readingAll} onClick={readAll}>
      {messagesText('messages.read_all')}
    </Button>
  ) : null;

  let footer: ReactElement | null = null;
  if (isFetchingNextPage) {
    footer = (
      <Card padding="inline">
        <p role="status" className="sr-only">
          {messagesTexts.loadingMore}
        </p>
        <RowSkeleton />
      </Card>
    );
  } else if (isFetchNextPageError) {
    footer = (
      <div className="flex min-h-11 items-center justify-center gap-couli-3">
        <p role="alert" className={CAPTION}>
          {messagesTexts.moreFailed}
        </p>
        <Button variant="text" onClick={loadMore}>
          {messagesTexts.retry}
        </Button>
      </div>
    );
  } else if (hasNextPage) {
    footer = (
      <p className={`${CAPTION} px-couli-1 text-center`}>{messagesText('messages.load_more')}</p>
    );
  } else {
    footer = <p className={`${CAPTION} px-couli-1 text-center`}>{messagesTexts.end}</p>;
  }

  return (
    <Page {...touch}>
      <Header action={readAllButton} />
      {banner}
      <Card as="ul" padding="none" className="flex flex-col overflow-hidden">
        {items.map((message) => (
          <MessageItem
            key={message.message_id}
            message={message}
            time={formatMessageTime(message.created_at, dataUpdatedAt)}
            open={open}
          />
        ))}
      </Card>
      {footer}
      {showSentinel ? <div ref={sentinel} aria-hidden="true" className="h-px" /> : null}
    </Page>
  );
}

const ROW = 'flex min-h-11 w-full min-w-0 flex-col gap-couli-1 px-couli-4 py-couli-3 text-left';

/** First line: unread mark, title and time. */
function RowHead({ message, time }: { message: InboxMessage; time: string }): ReactElement {
  const unread = isUnread(message);
  return (
    <span className="flex w-full min-w-0 items-center gap-couli-2">
      {unread ? (
        <>
          <span
            aria-hidden="true"
            className="size-2 flex-none rounded-full bg-couli-badge-background"
          />
          <span className="sr-only">{messagesText('messages.unread')}</span>
        </>
      ) : null}
      <span className="min-w-0 flex-1 text-couli-body leading-couli-body font-couli-medium text-couli-text-primary [overflow-wrap:anywhere]">
        {shortTitle(message.title)}
      </span>
      <time className={`${CAPTION} flex-none tabular-nums`} dateTime={message.created_at}>
        {time}
      </time>
    </span>
  );
}

const BODY =
  'w-full text-couli-footnote leading-couli-footnote text-couli-text-secondary [overflow-wrap:anywhere]';

function MessageItem({
  message,
  time,
  open,
}: {
  message: InboxMessage;
  time: string;
  open: ((message: InboxMessage, target: MessageTarget) => void) | null;
}): ReactElement {
  // 长列表：屏幕外的行跳过布局与绘制（规格 §6「长列表虚拟化」的轻量做法）。
  const item =
    'border-b border-couli-border-subtle last:border-b-0 [content-visibility:auto] [contain-intrinsic-size:auto_4.5rem]';
  const target = targetOf(message);
  if (target !== null && open !== null) {
    // 可点的行：整行一个按钮，以行内容为可访问名（未读、标题、时间、正文）。
    return (
      <li className={item}>
        <ListRow
          labelFrom="content"
          title={<RowHead message={message} time={time} />}
          subtitle={<span className="[overflow-wrap:anywhere]">{message.body}</span>}
          onClick={() => open(message, target)}
        />
      </li>
    );
  }
  // 没有 route 的消息不可点：普通列表项。
  return (
    <li className={item}>
      <div className={ROW}>
        <RowHead message={message} time={time} />
        <span className={BODY}>{message.body}</span>
      </div>
    </li>
  );
}
