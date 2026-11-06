import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo, type ReactElement } from 'react';
import { EmptyState, ErrorState, Skeleton } from '../../../../components/base/index.ts';
import type { H5ApiClient } from '../../../../shared/api/index.ts';
import { helpTexts } from '../../../../texts/help.ts';
import {
  AlertIcon,
  CARD,
  CenteredState,
  ChatIcon,
  ChevronIcon,
  DocumentIcon,
  FOCUS,
  Page,
} from './parts.tsx';
import { useNavigate } from './router.ts';

/** Help questions change rarely; going back from an article reuses the loaded list. */
const STALE_MS = 5 * 60 * 1000;
/** Page size of the question list (contract maximum 50). */
const PAGE_LIMIT = 20;

function SupportCard({ onOpen }: { onOpen: () => void }): ReactElement {
  return (
    <section
      className={`${CARD} flex flex-wrap items-center justify-between gap-couli-3 p-couli-4`}
    >
      <p className="flex flex-col">
        <span className="text-couli-footnote leading-couli-footnote font-couli-semibold">
          {helpTexts.supportTitle}
        </span>
        <span className="text-couli-caption leading-couli-caption text-couli-text-secondary">
          {helpTexts.supportDescription}
        </span>
      </p>
      <button
        type="button"
        className={`flex min-h-11 cursor-pointer items-center gap-couli-2 rounded-couli-button border border-couli-border-control bg-couli-background-surface px-couli-4 py-couli-2 text-couli-footnote leading-couli-footnote font-couli-medium text-couli-text-primary active:bg-couli-background-muted ${FOCUS}`}
        onClick={onOpen}
      >
        <ChatIcon className="size-5 flex-none" />
        {helpTexts.contactSupport}
      </button>
    </section>
  );
}

function ListSkeleton(): ReactElement {
  return (
    <div className={`${CARD} flex flex-col gap-couli-4 px-couli-4 py-couli-4`}>
      <Skeleton width="80%" height="1.0625rem" />
      <Skeleton width="65%" height="1.0625rem" />
      <Skeleton width="75%" height="1.0625rem" />
    </div>
  );
}

/**
 * Help home: the `help` articles in server order as a question list (title + chevron), a
 * "load more" that appends the next page with the server cursor only when tapped, and the support
 * card. Loading, empty (support stays) and error states; a retry resends the failed request once.
 */
export function HelpHome({
  api,
  openSupport,
}: {
  api: H5ApiClient;
  openSupport: (() => void) | null;
}): ReactElement {
  const navigate = useNavigate();
  const list = useInfiniteQuery({
    queryKey: ['articles', 'help'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.request('GET', '/v1/articles', {
        params: {
          query: {
            category: 'help',
            limit: PAGE_LIMIT,
            ...(pageParam === null ? {} : { cursor: pageParam }),
          },
        },
      }),
    getNextPageParam: (last, _pages, lastCursor) =>
      last.next_cursor === null || last.next_cursor === '' || last.next_cursor === lastCursor
        ? undefined
        : last.next_cursor,
    staleTime: STALE_MS,
  });
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = list;

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

  const loadMore = (): void => {
    // In flight: a second tap neither cancels nor repeats the request.
    if (isFetchingNextPage) return;
    fetchNextPage({ cancelRefetch: false }).catch(() => undefined);
  };

  let content: ReactElement;
  if (list.data === undefined && list.isError && !list.isFetching) {
    content = (
      <CenteredState>
        <ErrorState
          icon={<AlertIcon />}
          title={helpTexts.loadFailedTitle}
          description={helpTexts.loadFailedDescription}
          action={{ label: helpTexts.retry, onClick: () => void list.refetch() }}
        />
      </CenteredState>
    );
  } else if (list.data === undefined) {
    content = <ListSkeleton />;
  } else if (items.length === 0) {
    content = (
      <div className={`${CARD} py-couli-8`}>
        <EmptyState
          icon={<DocumentIcon />}
          title={helpTexts.emptyTitle}
          description={helpTexts.emptyDescription}
        />
      </div>
    );
  } else {
    content = (
      <div className={`${CARD} px-couli-4 py-couli-1`}>
        <ul className="flex flex-col divide-y divide-couli-border-subtle">
          {items.map((item) => (
            <li key={item.article_id}>
              <button
                type="button"
                className={`flex min-h-11 w-full cursor-pointer items-center justify-between gap-couli-3 py-couli-2 text-left text-couli-footnote leading-couli-footnote text-couli-text-primary ${FOCUS}`}
                onClick={() => {
                  void navigate({
                    search: `?${new URLSearchParams({ article_id: item.article_id })}`,
                  });
                }}
              >
                <span className="min-w-0 break-words">{item.title}</span>
                <ChevronIcon />
              </button>
            </li>
          ))}
        </ul>
        {hasNextPage ? (
          <div className="flex flex-col items-center border-t border-couli-border-subtle py-couli-1">
            {isFetchNextPageError && !isFetchingNextPage ? (
              <p
                role="alert"
                className="pt-couli-2 text-couli-caption leading-couli-caption text-couli-text-secondary"
              >
                {helpTexts.moreFailed}
              </p>
            ) : null}
            <button
              type="button"
              disabled={isFetchingNextPage}
              className={`min-h-11 w-full cursor-pointer text-couli-footnote leading-couli-footnote font-couli-medium text-couli-text-link disabled:cursor-default disabled:text-couli-text-secondary ${FOCUS}`}
              onClick={loadMore}
            >
              {helpTexts.loadMore}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <Page>
      <h1 className="sr-only">{helpTexts.title}</h1>
      <section className="flex flex-col gap-couli-2">
        <h2 className="px-couli-1 text-couli-body leading-couli-body font-couli-semibold">
          {helpTexts.faq}
        </h2>
        {content}
      </section>
      {openSupport === null ? null : <SupportCard onOpen={openSupport} />}
    </Page>
  );
}
