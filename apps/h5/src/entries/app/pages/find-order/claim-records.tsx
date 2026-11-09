import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useRef, type ReactElement } from 'react';
import { Button, Card, EmptyState, Skeleton } from '../../../../components/base/index.ts';
import { RetryPage } from '../../../../components/retry/index.ts';
import type { H5ApiClient } from '../../../../shared/api/index.ts';
import { findOrderText, findOrderTexts } from '../../../../texts/find-order.ts';
import { RECORDS_KEY, type LocateTarget } from './model.ts';
import { CAPTION, FOCUS, FOOTNOTE } from './parts.tsx';
import {
  claimMatches,
  locateStep,
  recordView,
  stateLabel,
  type RecordView,
} from './records-model.ts';
import type { RecordParts } from './records-parts.tsx';

/**
 * 数据到手后替换骨架的内容只淡入（shared/styles/index.css `h5-content-fade`，DSX-48d）。
 * 内容放在新挂载的容器里，接口晚于面板返回时也有进场；提示条留在外层不重挂，不重复播报。
 */
const CONTENT_FADE = 'h5-content-fade';

/** 每页条数（契约上限 50）。 */
const PAGE_LIMIT = 20;

export interface ClaimRecordsProps {
  api: H5ApiClient;
  target: LocateTarget | null;
  /** 30205 的轻提示（页内文字）。 */
  notice: string | null;
  onLocated: () => void;
  /** 记录行部件（平台标识 PlatformBadge、状态标签、空态插图；见 records-parts.tsx）。 */
  parts: RecordParts;
}

function RecordSkeleton(): ReactElement {
  return (
    <Card className="flex flex-col gap-couli-2">
      <Skeleton width="40%" height="1.25rem" />
      <Skeleton width="70%" height="1.3125rem" />
      <Skeleton width="50%" height="1.125rem" />
    </Card>
  );
}

/**
 * 找回记录（编排裁定 4）：经应用级 API 客户端（带 H5 令牌的 GET）读 listOrderClaims，按服务端顺序显示；
 * 每行 PlatformBadge + 状态标签 + 订单号 + 付款日期与提交时间 + 说明句，多个子订单分行显示各自的决定；
 * 不显示认领方。请求只来自进页签、重试与翻页，关掉一切自动重取（10405 等不自动重放）。
 */
export function ClaimRecords({
  api,
  target,
  notice,
  onLocated,
  parts,
}: ClaimRecordsProps): ReactElement {
  const list = useInfiniteQuery({
    queryKey: RECORDS_KEY,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.request('GET', '/v1/orders/claims', {
        params: {
          query: { limit: PAGE_LIMIT, ...(pageParam === null ? {} : { cursor: pageParam }) },
        },
      }),
    getNextPageParam: (last, _pages, lastCursor) =>
      last.next_cursor === null || last.next_cursor === '' || last.next_cursor === lastCursor
        ? undefined
        : last.next_cursor,
    // 逐项写明，不依赖共享 QueryClient 的默认值：只有进页签（挂载，属用户操作）才重取；
    // 失败（含 10405）后断网恢复、回前台、定时都不重取。
    retry: false,
    refetchOnMount: true,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    refetchInterval: false,
    refetchIntervalInBackground: false,
  });
  const { data, isFetching, hasNextPage, isFetchingNextPage, isFetchNextPageError } = list;
  const claims = data?.pages.flatMap((page) => page.items) ?? [];

  // 定位：数据取完后找目标申请（按 claim_id，或按规范化后的平台与订单号），滚到可见并聚焦。
  // 当前已取的页里没有且还有下一页时自动再取（至多 LOCATE_MAX_PAGES 页）；到上限或下一页失败时保留目标，
  // 用户手动加载到那一页时仍会定位；列表取完仍没有才结束定位。
  const cards = useRef(new Map<string, HTMLElement>());
  const located = useEffectEvent(onLocated);
  const fetchMore = useEffectEvent(() => {
    void list.fetchNextPage({ cancelRefetch: false });
  });
  useEffect(() => {
    if (target === null || data === undefined || isFetching) return;
    const claim = data.pages
      .flatMap((page) => page.items)
      .find((item) => claimMatches(item, target));
    const element = claim === undefined ? undefined : cards.current.get(claim.claim_id);
    const step = locateStep({
      found: claim !== undefined,
      hasNextPage,
      pagesLoaded: data.pages.length,
      nextPageFailed: isFetchNextPageError,
    });
    if (step === 'found') {
      if (element !== undefined) {
        if (typeof element.scrollIntoView === 'function') {
          element.scrollIntoView({ block: 'center' });
        }
        element.focus({ preventScroll: true });
      }
      located();
    } else if (step === 'load') {
      fetchMore();
    } else if (step === 'done') {
      located();
    }
  }, [target, data, isFetching, hasNextPage, isFetchNextPageError]);

  const banner =
    notice === null ? null : (
      <p
        role="status"
        className={`flex items-center gap-couli-2 rounded-couli-button bg-couli-background-surface px-couli-3 py-couli-3 ${FOOTNOTE} text-couli-text-primary`}
      >
        <parts.InfoIcon className="size-couli-4 flex-none text-couli-text-secondary" />
        <span className="min-w-0">{notice}</span>
      </p>
    );

  // 首屏失败：H5 加载失败重试页，重试只再请求一次。
  if (data === undefined && list.isError && !isFetching) {
    return <RetryPage onRetry={() => void list.refetch()} />;
  }
  if (data === undefined) {
    return (
      <div className="flex flex-col gap-couli-3">
        {banner}
        <RecordSkeleton />
        <RecordSkeleton />
      </div>
    );
  }
  if (claims.length === 0 && !hasNextPage) {
    return (
      <div className="flex flex-col gap-couli-3">
        {banner}
        <div key="empty" className={`flex justify-center pt-couli-12 ${CONTENT_FADE}`}>
          <EmptyState
            icon={<parts.SearchDocIcon />}
            title={findOrderText('claim.records.empty')}
            description=""
          />
        </div>
      </div>
    );
  }

  // 「同年 / 今天」按取到数据时的上海时间判断（BR-TEXT-11）。
  const now = list.dataUpdatedAt;
  return (
    <div className="flex flex-col gap-couli-3">
      {banner}
      <div key="list" className={`flex flex-col gap-couli-3 ${CONTENT_FADE}`}>
        <ul className="flex flex-col gap-couli-3">
          {claims.map((claim) => (
            <li key={claim.claim_id}>
              <RecordCard
                view={recordView(claim, now)}
                register={(element) => {
                  if (element === null) cards.current.delete(claim.claim_id);
                  else cards.current.set(claim.claim_id, element);
                }}
                parts={parts}
              />
            </li>
          ))}
        </ul>
        {isFetchingNextPage ? <RecordSkeleton /> : null}
        {isFetchNextPageError ? (
          <p role="alert" className={`${CAPTION} text-center`}>
            {findOrderTexts.moreFailed}
          </p>
        ) : null}
        {hasNextPage && !isFetchingNextPage ? (
          <span className="flex self-center">
            <Button
              variant="text"
              onClick={() => void list.fetchNextPage({ cancelRefetch: false })}
            >
              {findOrderTexts.more}
            </Button>
          </span>
        ) : null}
        <p className={`${CAPTION} pt-couli-1 text-center`}>
          {findOrderText('claim.records.footer')}
        </p>
      </div>
    </div>
  );
}

function RecordCard({
  view,
  register,
  parts: { Badge, StatusTag },
}: {
  view: RecordView;
  register: (element: HTMLElement | null) => void;
  parts: RecordParts;
}): ReactElement {
  const single = view.lines.length === 1 && view.lines[0]?.subOrderId === null;
  return (
    // 卡片面来自基础件 Card；定位用的焦点落在卡内整块（tabIndex -1，焦点环随卡片圆角）。
    <Card padding="none">
      <article
        ref={register}
        tabIndex={-1}
        data-claim-id={view.claimId}
        className={`${FOCUS} flex flex-col gap-couli-1 rounded-couli-card p-couli-4`}
      >
        <div className="flex items-center justify-between gap-couli-2">
          {view.platform === null ? <span /> : <Badge platform={view.platform} />}
          <StatusTag state={view.state} label={stateLabel(view.state)} />
        </div>
        <p className="mt-couli-2 text-couli-footnote leading-couli-footnote font-couli-semibold tabular-nums [overflow-wrap:anywhere]">
          {findOrderTexts.orderNo} {view.orderNo}
        </p>
        <p className={`${CAPTION} tabular-nums`}>
          {findOrderTexts.paidDate} {view.paidDate} · {findOrderTexts.submittedAt} {view.createdAt}
        </p>
        <div className="mt-couli-2 border-t border-couli-border-subtle pt-couli-3">
          {single ? (
            <p className={`${FOOTNOTE} [overflow-wrap:anywhere]`}>{view.lines[0]?.text}</p>
          ) : (
            <ul className="flex flex-col gap-couli-3">
              {view.lines.map((line) => (
                <li key={line.subOrderId} className="flex flex-col gap-couli-1">
                  <div className="flex items-center justify-between gap-couli-2">
                    <span className={`${CAPTION} min-w-0 tabular-nums [overflow-wrap:anywhere]`}>
                      {findOrderTexts.subOrder} {line.subOrderId}
                    </span>
                    <StatusTag state={line.state} label={stateLabel(line.state)} />
                  </div>
                  <p className={`${FOOTNOTE} [overflow-wrap:anywhere]`}>{line.text}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </article>
    </Card>
  );
}
