import { useMemo, type ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArticleBody } from '../../../../components/article-body/index.ts';
import { Card, EmptyState, ErrorState, Skeleton } from '../../../../components/base/index.ts';
import { AlertIcon, DocumentIcon } from '../../../../components/icons/index.tsx';
import { useApi } from '../../../../shared/api/app-api.ts';
import type { H5ApiClient } from '../../../../shared/api/index.ts';
import { mediaOrigins } from '../../../../shared/env.ts';
import { agreementsTexts } from '../../../../texts/agreements.ts';
import { Component as PagePending } from '../page-pending.tsx';
import {
  ARTICLE_STALE_MS,
  beijingDate,
  CenteredState,
  isArticleNotFound,
  Page,
  TITLE,
} from '../notices/common.tsx';
import { useSearchParams } from '../notices/router.ts';

/** Agreement types of the route (routes.json `type`); each one's article_id equals the type. */
const AGREEMENT_TYPES = ['agreement', 'privacy', 'sdk_list'] as const;
type AgreementType = (typeof AGREEMENT_TYPES)[number];

/** A missing or unknown type falls back to the user agreement; the raw value never reaches a URL. */
function agreementType(value: string | null): AgreementType {
  return AGREEMENT_TYPES.find((type) => type === value) ?? 'agreement';
}

const CHIP =
  'inline-flex h-5.5 items-center rounded-couli-pill bg-couli-background-muted px-couli-2 text-couli-caption leading-couli-caption whitespace-nowrap text-couli-text-secondary tabular-nums';
/** Agreement text is set smaller than notices: 14 body, 12 between paragraphs (design board). */
const BODY = '[&_p]:text-couli-footnote [&_p]:leading-couli-footnote [&>div]:gap-couli-3';

/**
 * Agreement route (F1-03c): `/agreement?type=agreement|privacy|sdk_list` shows the current
 * published version of that agreement (anonymous). Any other query parameter is ignored.
 */
export function AgreementPage(): ReactElement {
  const api = useApi();
  // Outside the App or without build configuration there is no API client: the route keeps the
  // shared "page not open yet" placeholder and sends no request (router hooks are not needed).
  if (api === null) return <PagePending />;
  return <AgreementRoute api={api} />;
}

function AgreementRoute({ api }: { api: H5ApiClient }): ReactElement {
  const [params] = useSearchParams();
  return <AgreementContent api={api} type={agreementType(params.get('type'))} />;
}

function AgreementContent({ api, type }: { api: H5ApiClient; type: AgreementType }): ReactElement {
  const configuredOrigins = useMemo(() => mediaOrigins(), []);
  const query = useQuery({
    queryKey: ['articles', 'detail', type],
    queryFn: () =>
      api.request('GET', '/v1/articles/{article_id}', { params: { path: { article_id: type } } }),
    staleTime: ARTICLE_STALE_MS,
  });

  const failed = query.isError && !query.isFetching;
  // A settled 30701 wins over cached data: an agreement withdrawn after it was read once must not
  // keep showing its old text (React Query keeps the previous data when a refetch fails).
  if (failed && (query.data === undefined || isArticleNotFound(query.error))) {
    return (
      <Page>
        <CenteredState>
          {isArticleNotFound(query.error) ? (
            <EmptyState
              icon={<DocumentIcon />}
              title={agreementsTexts.unpublishedTitle}
              description={agreementsTexts.unpublishedDescription}
            />
          ) : (
            <ErrorState
              icon={<AlertIcon />}
              title={agreementsTexts.loadFailedTitle}
              description={agreementsTexts.loadFailedDescription}
              action={{ label: agreementsTexts.retry, onClick: () => void query.refetch() }}
            />
          )}
        </CenteredState>
      </Page>
    );
  }

  const article = query.data;
  if (article === undefined) {
    return (
      <Page>
        <div className="flex flex-col gap-couli-2 px-couli-1 pt-couli-2">
          <Skeleton width="50%" height="1.75rem" />
          <Skeleton width="40%" height="1.375rem" />
        </div>
        <Card className="flex flex-col gap-couli-2">
          <Skeleton width="100%" height="0.75rem" />
          <Skeleton width="92%" height="0.75rem" />
          <Skeleton width="64%" height="0.75rem" />
        </Card>
      </Page>
    );
  }

  const date = beijingDate(article.published_at);
  return (
    <Page>
      <header className="flex flex-col gap-couli-2 px-couli-1 pt-couli-2">
        <h1 className={TITLE}>{article.title}</h1>
        <p className="flex flex-wrap gap-couli-2">
          <span className={CHIP}>{agreementsTexts.version(article.version)}</span>
          {date === null ? null : <span className={CHIP}>{agreementsTexts.updatedAt(date)}</span>}
        </p>
      </header>
      <Card className={BODY}>
        <ArticleBody body={article.body} mediaOrigins={configuredOrigins} />
      </Card>
    </Page>
  );
}
