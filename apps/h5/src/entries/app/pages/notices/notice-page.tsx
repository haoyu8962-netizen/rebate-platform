import { useMemo, useRef, type ReactElement } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArticleBody } from '../../../../components/article-body/index.ts';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Skeleton,
} from '../../../../components/base/index.ts';
import { AlertIcon, ChevronIcon, DocumentIcon } from '../../../../components/icons/index.tsx';
import { useApi } from '../../../../shared/api/app-api.ts';
import type { ApiData, H5ApiClient } from '../../../../shared/api/index.ts';
import { mediaOrigins } from '../../../../shared/env.ts';
import { noticesTexts } from '../../../../texts/notices.ts';
import { Component as PagePending } from '../page-pending.tsx';
import {
  ARTICLE_STALE_MS,
  beijingDate,
  beijingDateTime,
  CenteredState,
  isArticleNotFound,
  Page,
  TITLE,
} from './common.tsx';
import { useNavigate, useSearchParams } from './router.ts';

type NoticeListItem = ApiData<'GET', '/v1/articles'>['items'][number];

/** Notices per page (contract maximum 50). */
const PAGE_LIMIT = 20;
/** Contract bounds of article_id (path parameter, 1–64 characters). */
const MAX_ID_LENGTH = 64;

function validArticleId(id: string): boolean {
  const length = [...id].length;
  return length >= 1 && length <= MAX_ID_LENGTH;
}

/**
 * Notice route (F1-03c): `/notice` lists the notices, `/notice?article_id=<id>` shows one notice.
 * An empty article_id shows the list; an id outside the contract bounds is never requested.
 */
export function NoticePage(): ReactElement {
  const api = useApi();
  // Outside the App or without build configuration there is no API client: the route keeps the
  // shared "page not open yet" placeholder and sends no request (router hooks are not needed).
  if (api === null) return <PagePending />;
  return <NoticeRoute api={api} />;
}

function NoticeRoute({ api }: { api: H5ApiClient }): ReactElement {
  const [params] = useSearchParams();
  const id = params.get('article_id');
  if (id === null || id === '') return <NoticeList api={api} />;
  if (!validArticleId(id)) return <NoticeGone />;
  return <NoticeDetail api={api} articleId={id} />;
}

function ListSkeleton(): ReactElement {
  return (
    <Card className="flex flex-col gap-couli-2">
      <Skeleton width="50%" height="1.3125rem" />
      <Skeleton width="100%" height="1.3125rem" />
      <Skeleton width="30%" height="1.125rem" />
    </Card>
  );
}

function NoticeCard({
  item,
  onOpen,
}: {
  item: NoticeListItem;
  onOpen: (id: string) => void;
}): ReactElement {
  const date = beijingDate(item.published_at);
  const summary = item.category === 'notice' ? item.notice.text : '';
  return (
    <Card onClick={() => onOpen(item.article_id)}>
      <span className="flex flex-col gap-couli-2">
        <span className="flex w-full items-center justify-between gap-couli-3">
          <span className="min-w-0 truncate text-couli-footnote leading-couli-footnote font-couli-semibold">
            {item.title}
          </span>
          <ChevronIcon />
        </span>
        {summary === '' ? null : (
          <span className="line-clamp-2 text-couli-footnote leading-couli-footnote break-words text-couli-text-secondary">
            {summary}
          </span>
        )}
        {date === null ? null : (
          <span className="text-couli-caption leading-couli-caption text-couli-text-secondary tabular-nums">
            {date}
          </span>
        )}
      </span>
    </Card>
  );
}

const FOOTER = 'p-couli-1 text-center text-couli-caption leading-couli-caption';

function NoticeList({ api }: { api: H5ApiClient }): ReactElement {
  const navigate = useNavigate();
  // Set from the click until the next page settles: same-turn double clicks send one request.
  const loadingMore = useRef(false);
  const list = useInfiniteQuery({
    queryKey: ['articles', 'notice'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.request('GET', '/v1/articles', {
        params: {
          query: {
            category: 'notice',
            limit: PAGE_LIMIT,
            ...(pageParam === null ? {} : { cursor: pageParam }),
          },
        },
      }),
    getNextPageParam: (last, _pages, lastCursor) =>
      last.next_cursor === null || last.next_cursor === '' || last.next_cursor === lastCursor
        ? undefined
        : last.next_cursor,
    staleTime: ARTICLE_STALE_MS,
  });
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = list;
  const items = useMemo(() => {
    // Server order across pages; a notice repeated on a later page keeps its first place.
    const seen = new Set<string>();
    const result: NoticeListItem[] = [];
    for (const page of list.data?.pages ?? []) {
      for (const item of page.items) {
        if (seen.has(item.article_id)) continue;
        seen.add(item.article_id);
        result.push(item);
      }
    }
    return result;
  }, [list.data]);

  function loadMore(): void {
    if (loadingMore.current) return;
    loadingMore.current = true;
    fetchNextPage({ cancelRefetch: false })
      .catch(() => undefined)
      .finally(() => {
        loadingMore.current = false;
      });
  }

  function open(id: string): void {
    void navigate({ search: `?${new URLSearchParams({ article_id: id }).toString()}` });
  }

  // While a retry is in flight the skeleton shows again.
  if (list.data === undefined && list.isError && !list.isFetching) {
    return (
      <Page>
        <CenteredState>
          <ErrorState
            icon={<AlertIcon />}
            title={noticesTexts.loadFailedTitle}
            description={noticesTexts.loadFailedDescription}
            action={{ label: noticesTexts.retry, onClick: () => void list.refetch() }}
          />
        </CenteredState>
      </Page>
    );
  }

  if (list.data === undefined) {
    return (
      <Page>
        <ListSkeleton />
        <ListSkeleton />
      </Page>
    );
  }

  if (items.length === 0 && !hasNextPage) {
    return (
      <Page>
        <CenteredState>
          <EmptyState
            icon={<DocumentIcon />}
            title={noticesTexts.emptyTitle}
            description={noticesTexts.emptyDescription}
          />
        </CenteredState>
      </Page>
    );
  }

  let footer: ReactElement;
  if (isFetchNextPageError && !isFetchingNextPage) {
    footer = (
      <div className="flex min-h-11 items-center justify-center gap-couli-3">
        <p role="alert" className={`${FOOTER} text-couli-text-secondary`}>
          {noticesTexts.moreFailed}
        </p>
        <Button variant="text" onClick={loadMore}>
          {noticesTexts.retry}
        </Button>
      </div>
    );
  } else if (hasNextPage) {
    footer = (
      <Button variant="text" fullWidth disabled={isFetchingNextPage} onClick={loadMore}>
        {isFetchingNextPage ? noticesTexts.loadingMore : noticesTexts.loadMore}
      </Button>
    );
  } else {
    footer = <p className={`${FOOTER} text-couli-text-secondary`}>{noticesTexts.noMore}</p>;
  }

  return (
    <Page>
      <ul className="flex flex-col gap-couli-3">
        {items.map((item) => (
          <li key={item.article_id}>
            <NoticeCard item={item} onOpen={open} />
          </li>
        ))}
      </ul>
      {footer}
    </Page>
  );
}

/** Taken-down, unknown or malformed notice: an empty state with the way back to the list. */
function NoticeGone(): ReactElement {
  const navigate = useNavigate();
  return (
    <Page>
      <CenteredState>
        <EmptyState
          icon={<DocumentIcon />}
          title={noticesTexts.goneTitle}
          description={noticesTexts.goneDescription}
          action={{
            label: noticesTexts.backToList,
            onClick: () => void navigate({ search: '' }, { replace: true }),
          }}
        />
      </CenteredState>
    </Page>
  );
}

function NoticeDetail({ api, articleId }: { api: H5ApiClient; articleId: string }): ReactElement {
  const configuredOrigins = useMemo(() => mediaOrigins(), []);
  // Keyed by id: switching the query string never shows the previous notice, and a late response
  // for the previous id only lands in that id's cache entry.
  const detail = useQuery({
    queryKey: ['articles', 'detail', articleId],
    queryFn: () =>
      api.request('GET', '/v1/articles/{article_id}', {
        params: { path: { article_id: articleId } },
      }),
    staleTime: ARTICLE_STALE_MS,
  });

  const failed = detail.isError && !detail.isFetching;
  // A settled 30701 wins over cached data: a notice taken down after it was read once must not
  // keep showing its old text (React Query keeps the previous data when a refetch fails).
  if (failed && isArticleNotFound(detail.error)) return <NoticeGone />;
  if (detail.data === undefined && failed) {
    return (
      <Page>
        <CenteredState>
          <ErrorState
            icon={<AlertIcon />}
            title={noticesTexts.loadFailedTitle}
            description={noticesTexts.loadFailedDescription}
            action={{ label: noticesTexts.retry, onClick: () => void detail.refetch() }}
          />
        </CenteredState>
      </Page>
    );
  }

  const article = detail.data;
  if (article === undefined) {
    return (
      <Page>
        <Card as="article" className="flex flex-col gap-couli-4">
          <Skeleton width="60%" height="1.75rem" />
          <Skeleton width="40%" height="1.125rem" />
          <div className="flex flex-col gap-couli-3">
            <Skeleton width="100%" height="1.0625rem" />
            <Skeleton width="100%" height="1.0625rem" />
            <Skeleton width="60%" height="1.0625rem" />
          </div>
        </Card>
      </Page>
    );
  }

  const time = beijingDateTime(article.published_at);
  return (
    <Page>
      <Card as="article" className="flex flex-col gap-couli-4">
        <h1 className={TITLE}>{article.title}</h1>
        {time === null ? null : (
          <p className="text-couli-caption leading-couli-caption text-couli-text-secondary tabular-nums">
            {noticesTexts.byline(time)}
          </p>
        )}
        <ArticleBody body={article.body} mediaOrigins={configuredOrigins} />
      </Card>
    </Page>
  );
}
