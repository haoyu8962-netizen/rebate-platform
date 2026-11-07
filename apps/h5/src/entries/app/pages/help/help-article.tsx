import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, type ReactElement } from 'react';
import { ArticleBody } from '../../../../components/article-body/index.ts';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Skeleton,
} from '../../../../components/base/index.ts';
import { AlertIcon, DocumentIcon } from '../../../../components/icons/index.tsx';
import { ApiError, type H5ApiClient } from '../../../../shared/api/index.ts';
import { mediaOrigins } from '../../../../shared/env.ts';
import { helpTexts } from '../../../../texts/help.ts';
import { beijingDate, CenteredState, ChatIcon, Page } from './parts.tsx';
import { useNavigate } from './router.ts';

const STALE_MS = 5 * 60 * 1000;
/** Contract error: the article is unknown, unpublished or outside the visible range. */
const ARTICLE_NOT_FOUND = 30701;

function ArticleSkeleton(): ReactElement {
  return (
    <Card as="article" className="flex flex-col gap-couli-4">
      <Skeleton width="70%" height="1.375rem" />
      <Skeleton width="40%" height="0.875rem" />
      <div className="flex flex-col gap-couli-3">
        <Skeleton width="100%" height="1.0625rem" />
        <Skeleton width="100%" height="1.0625rem" />
        <Skeleton width="60%" height="1.0625rem" />
      </div>
    </Card>
  );
}

/**
 * Help article (`/help?article_id=`): title, help tag, Beijing "updated on" date and the shared
 * article body, then the support entry. 30701 shows the "gone" state with a way back to the help
 * home; other failures show the error state, whose retry resends this article request once.
 */
export function HelpArticle({
  api,
  articleId,
  openSupport,
}: {
  api: H5ApiClient;
  articleId: string;
  openSupport: (() => void) | null;
}): ReactElement {
  const navigate = useNavigate();
  const origins = useMemo(() => mediaOrigins(), []);
  const detail = useQuery({
    queryKey: ['articles', 'detail', articleId],
    queryFn: () =>
      api.request('GET', '/v1/articles/{article_id}', {
        params: { path: { article_id: articleId } },
      }),
    staleTime: STALE_MS,
  });

  // A new article starts reading from the top (in-app navigation keeps the scroll position).
  useEffect(() => {
    // jsdom and some older WebViews have no scrollingElement.
    const scroller = document.scrollingElement as Element | null | undefined;
    if (scroller != null) scroller.scrollTop = 0;
  }, [articleId]);

  // A finished request answering 30701 wins over cached data: an article taken offline after it
  // was cached (a stale refetch fails, React Query keeps the old data) must not stay readable.
  const gone =
    detail.isError &&
    !detail.isFetching &&
    detail.error instanceof ApiError &&
    detail.error.code === ARTICLE_NOT_FOUND;
  if (gone) {
    return (
      <Page>
        <CenteredState>
          <EmptyState
            icon={<DocumentIcon />}
            title={helpTexts.notFoundTitle}
            description={helpTexts.notFoundDescription}
            action={{
              label: helpTexts.backHome,
              onClick: () => void navigate({ search: '' }, { replace: true }),
            }}
          />
        </CenteredState>
      </Page>
    );
  }

  // Any other failure keeps an article already loaded (stale beats nothing); without one the
  // error state offers a retry of this article request.
  const article = detail.data;
  if (article === undefined) {
    if (detail.isError && !detail.isFetching) {
      return (
        <Page>
          <CenteredState>
            <ErrorState
              icon={<AlertIcon />}
              title={helpTexts.loadFailedTitle}
              description={helpTexts.loadFailedDescription}
              action={{ label: helpTexts.retry, onClick: () => void detail.refetch() }}
            />
          </CenteredState>
        </Page>
      );
    }
    return (
      <Page>
        <ArticleSkeleton />
      </Page>
    );
  }

  const updated = beijingDate(article.published_at);
  return (
    <Page>
      <Card as="article" className="flex flex-col gap-couli-4">
        <header className="flex flex-col gap-couli-4">
          <h1 className="text-couli-title leading-couli-title font-couli-semibold break-words">
            {article.title}
          </h1>
          <div className="flex items-center gap-couli-2 text-couli-caption leading-couli-caption text-couli-text-secondary">
            <span className="inline-flex h-5.5 items-center rounded-couli-pill bg-couli-background-muted px-couli-2 whitespace-nowrap">
              {helpTexts.articleTag}
            </span>
            {updated === null ? null : (
              <span className="tabular-nums">{helpTexts.updatedAt(updated)}</span>
            )}
          </div>
        </header>
        <ArticleBody body={article.body} mediaOrigins={origins} />
      </Card>
      {openSupport === null ? null : (
        <Button variant="text" onClick={openSupport}>
          <ChatIcon className="size-4 flex-none" />
          {helpTexts.articleSupport}
        </Button>
      )}
    </Page>
  );
}
