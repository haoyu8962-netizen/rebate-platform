import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArticleBody } from '../../../../components/article-body/index.ts';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  ListRow,
  Skeleton,
  useDelayedVisible,
} from '../../../../components/base/index.ts';
import { AlertIcon, ChevronIcon, DocumentIcon } from '../../../../components/icons/index.tsx';
import { useApi } from '../../../../shared/api/app-api.ts';
import type { H5ApiClient } from '../../../../shared/api/index.ts';
import { mediaOrigins } from '../../../../shared/env.ts';
import { rulesTexts } from '../../../../texts/rules.ts';
import { Component as PagePending } from '../page-pending.tsx';

export interface RulesPageProps {
  /** Injected H5 API client (tests, embedding); wins over the App client from useApi(). */
  api?: H5ApiClient;
  /** Injected media origin for body images; wins over the configured mediaOrigins(). */
  mediaCdnOrigin?: string;
}

/** Rule articles change rarely; switching back and forth reuses what was loaded. */
const STALE_MS = 5 * 60 * 1000;
/** Page size of the rule list (contract maximum 50). */
const PAGE_LIMIT = 50;
/** Safety stop for a server that keeps returning cursors; far beyond any real rule count. */
const MAX_PAGES = 20;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Calendar date in Beijing (UTC+8, no daylight saving) of an RFC 3339 instant; null if invalid. */
export function beijingDate(instant: string): string | null {
  const time = Date.parse(instant);
  if (Number.isNaN(time)) return null;
  return new Date(time + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

function ArticleSkeleton(): ReactElement {
  return (
    <div className="flex flex-col gap-couli-3">
      <Skeleton width="100%" height="1.0625rem" />
      <Skeleton width="100%" height="1.0625rem" />
      <Skeleton width="60%" height="1.0625rem" />
    </div>
  );
}

function Page({ children }: { children: ReactNode }): ReactElement {
  return (
    <main className="flex min-h-dvh flex-col gap-couli-3 bg-couli-background-canvas px-couli-4 pt-couli-2 pb-couli-6 font-couli-system text-couli-text-primary">
      {children}
    </main>
  );
}

function CenteredState({ children }: { children: ReactNode }): ReactElement {
  return <div className="flex flex-1 items-center justify-center py-couli-16">{children}</div>;
}

/**
 * Rules page (F1-03a, route Rules): the first article of category `rule` in server order in
 * full, the others as entries at the bottom that switch the article in place (the URL stays).
 * Loading, empty and error states; a retry resends only the request that failed.
 */
export function RulesPage({ api, mediaCdnOrigin }: RulesPageProps): ReactElement {
  const appApi = useApi();
  const client = api ?? appApi;
  // Outside the App or without build configuration there is no API client: the route keeps the
  // shared "page not open yet" placeholder and sends no request.
  if (client === null) return <PagePending />;
  return (
    <RulesContent api={client} {...(mediaCdnOrigin === undefined ? {} : { mediaCdnOrigin })} />
  );
}

function RulesContent({
  api,
  mediaCdnOrigin,
}: RulesPageProps & { api: H5ApiClient }): ReactElement {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const switched = useRef(false);

  const configuredOrigins = useMemo(() => mediaOrigins(), []);

  // Every page of the rule list, in server order: the first page shows the page, later pages are
  // loaded one after another (each once) until next_cursor is null.
  const list = useInfiniteQuery({
    queryKey: ['articles', 'rule'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.request('GET', '/v1/articles', {
        params: {
          query: {
            category: 'rule',
            limit: PAGE_LIMIT,
            ...(pageParam === null ? {} : { cursor: pageParam }),
          },
        },
      }),
    getNextPageParam: (last, pages, lastCursor) =>
      last.next_cursor === null ||
      last.next_cursor === '' ||
      last.next_cursor === lastCursor ||
      pages.length >= MAX_PAGES
        ? undefined
        : last.next_cursor,
    staleTime: STALE_MS,
  });
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = list;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) {
      fetchNextPage().catch(() => undefined);
    }
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
  const items = useMemo(() => {
    // Server order across pages; an article repeated on a later page keeps its first place.
    const seen = new Set<string>();
    const result = [];
    for (const page of list.data?.pages ?? []) {
      for (const item of page.items) {
        if (seen.has(item.article_id)) continue;
        seen.add(item.article_id);
        result.push(item);
      }
    }
    return result;
  }, [list.data]);
  const selected = items.find((item) => item.article_id === selectedId) ?? items[0];
  const articleId = selected?.article_id;

  const detail = useQuery({
    queryKey: ['articles', 'detail', articleId],
    queryFn: () =>
      api.request('GET', '/v1/articles/{article_id}', {
        params: { path: { article_id: articleId! } },
      }),
    enabled: articleId !== undefined,
    staleTime: STALE_MS,
  });

  // After an in-page switch, start reading the new article from its title.
  useEffect(() => {
    if (!switched.current) return;
    switched.current = false;
    // jsdom and some older WebViews have no scrollingElement.
    const scroller = document.scrollingElement as Element | null | undefined;
    if (scroller != null) scroller.scrollTop = 0;
    titleRef.current?.focus({ preventScroll: true });
  }, [articleId]);

  // First screen with the anti-flash delay (DSX-48): no skeleton for a quick list, and once shown
  // it stays motion.skeleton.min-visible; meanwhile an empty busy region.
  const listPending = list.data === undefined && !(list.isError && !list.isFetching);
  const firstSkeleton = useDelayedVisible(listPending);
  if (firstSkeleton) {
    return (
      <Page>
        <Card as="article" className="flex flex-col gap-couli-4">
          <Skeleton width="40%" height="1.375rem" />
          <ArticleSkeleton />
        </Card>
      </Page>
    );
  }

  // While a retry is in flight the skeleton shows again.
  if (list.data === undefined && list.isError && !list.isFetching) {
    return (
      <Page>
        <CenteredState>
          <ErrorState
            icon={<AlertIcon />}
            title={rulesTexts.loadFailedTitle}
            description={rulesTexts.loadFailedDescription}
            action={{ label: rulesTexts.retry, onClick: () => void list.refetch() }}
          />
        </CenteredState>
      </Page>
    );
  }

  if (list.data === undefined) {
    return (
      <Page>
        <div aria-busy="true" className="flex-1" />
      </Page>
    );
  }

  if (selected === undefined) {
    return (
      <Page>
        <CenteredState>
          <EmptyState
            icon={<DocumentIcon />}
            title={rulesTexts.emptyTitle}
            description={rulesTexts.emptyDescription}
          />
        </CenteredState>
      </Page>
    );
  }

  const article = detail.data?.article_id === selected.article_id ? detail.data : undefined;
  const updated = beijingDate(article?.published_at ?? selected.published_at);
  // A later page failed: offer a retry of that page only (the shown article stays).
  const moreFailed = isFetchNextPageError && !isFetchingNextPage;
  const others = items.filter((item) => item.article_id !== selected.article_id);

  let body: ReactElement;
  if (article !== undefined) {
    body = (
      <ArticleBody
        body={article.body}
        {...(mediaCdnOrigin === undefined
          ? { mediaOrigins: configuredOrigins }
          : { mediaCdnOrigin })}
      />
    );
  } else if (detail.isError && !detail.isFetching) {
    body = (
      <div className="py-couli-6">
        <ErrorState
          icon={<AlertIcon />}
          title={rulesTexts.loadFailedTitle}
          description={rulesTexts.loadFailedDescription}
          action={{ label: rulesTexts.retry, onClick: () => void detail.refetch() }}
        />
      </div>
    );
  } else {
    body = <ArticleSkeleton />;
  }

  return (
    <Page>
      <Card as="article" className="flex flex-col gap-couli-4">
        <header className="flex flex-col gap-couli-4">
          <h1
            ref={titleRef}
            tabIndex={-1}
            className="text-couli-title leading-couli-title font-couli-semibold text-couli-text-primary outline-none"
          >
            {article?.title ?? selected.title}
          </h1>
          {updated === null ? null : (
            <p className="text-couli-caption leading-couli-caption text-couli-text-secondary tabular-nums">
              {rulesTexts.updatedAt(updated)}
            </p>
          )}
        </header>
        {body}
      </Card>
      {others.length === 0 && !hasNextPage ? null : (
        <Card
          as="nav"
          aria-label={rulesTexts.otherRules}
          padding="none"
          className="overflow-hidden py-couli-1"
        >
          <ul className="flex flex-col divide-y divide-couli-border-subtle">
            {others.map((item) => (
              <li key={item.article_id}>
                <ListRow
                  leading={<DocumentIcon />}
                  title={<span className="break-words">{item.title}</span>}
                  trailing={<ChevronIcon />}
                  onClick={() => {
                    switched.current = true;
                    setSelectedId(item.article_id);
                  }}
                />
              </li>
            ))}
          </ul>
          {moreFailed ? (
            <div className="flex min-h-11 items-center justify-between gap-couli-3 border-t border-couli-border-subtle px-couli-4 py-couli-2">
              <p
                role="alert"
                className="text-couli-footnote leading-couli-footnote text-couli-text-secondary"
              >
                {rulesTexts.moreFailed}
              </p>
              <Button
                variant="text"
                onClick={() => {
                  fetchNextPage().catch(() => undefined);
                }}
              >
                {rulesTexts.retry}
              </Button>
            </div>
          ) : hasNextPage ? (
            <div className="border-t border-couli-border-subtle px-couli-4 py-couli-3">
              <Skeleton width="50%" height="0.875rem" />
            </div>
          ) : null}
        </Card>
      )}
    </Page>
  );
}
