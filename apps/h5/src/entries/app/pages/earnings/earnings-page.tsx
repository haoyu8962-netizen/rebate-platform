import { call, has } from '@couli/bridge-sdk';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState, type ReactElement, type ReactNode, type TouchEvent } from 'react';
import { ErrorState, Sheet, Skeleton } from '../../../../components/base/index.ts';
import { FOCUS_RING } from '../../../../components/base/styles.ts';
import jdIcon from '../../../../components/platform/assets/jd.png?no-inline';
import pinduoduoIcon from '../../../../components/platform/assets/pinduoduo.png?no-inline';
import taobaoIcon from '../../../../components/platform/assets/taobao.png?no-inline';
import { RetryPage } from '../../../../components/retry/index.ts';
import { useApi } from '../../../../shared/api/app-api.ts';
import { ApiError, type H5ApiClient } from '../../../../shared/api/index.ts';
import { t } from '../../../../shared/texts.ts';
import { earningsText, earningsTexts } from '../../../../texts/earnings.ts';
import { getPlatformName } from '../../../../texts/platform.ts';
import { useSearchParams } from '../help/router.ts';
import { Component as PagePending } from '../page-pending.tsx';
import {
  CONFIG_KEYS,
  DEFAULT_PERIOD,
  MONTHS,
  PERIODS,
  asPlatform,
  formatAsOf,
  formatFen,
  isEmptyPeriod,
  parsePlatforms,
  type EarningsPlatform,
  type EarningsSummary,
  type PeriodKey,
} from './model.ts';

export type EarningsPageProps = Record<string, never>;

const SUMMARY_PATH = '/v1/earnings/summary';
/** 下拉超过这个距离（px）松手才刷新。 */
const PULL_THRESHOLD = 64;

/**
 * 请求只来自进页、切平台、下拉刷新与用户点重试：逐项关掉自动重取（10405 等错误不得被自动重放），
 * 不依赖共享默认值。切平台换查询键：没取过的平台发一次请求，取过的先显示缓存再按该平台重取一次。
 */
const NO_AUTO_FETCH = {
  retry: false,
  refetchOnMount: false,
  refetchOnReconnect: false,
  refetchOnWindowFocus: false,
  refetchInterval: false,
  refetchIntervalInBackground: false,
} as const;

/** 平台胶囊里的 16px 官方平台图标（与 PlatformBadge 同一组内置图，装饰用，读屏读平台名）。 */
const PLATFORM_ICONS: Readonly<Record<EarningsPlatform, string>> = {
  taobao: taobaoIcon,
  jd: jdIcon,
  pdd: pinduoduoIcon,
};

const CARD = 'rounded-couli-card bg-couli-background-surface p-couli-4 shadow-couli-card';
const CAPTION = 'text-couli-caption leading-couli-caption text-couli-text-secondary';
const AMOUNT =
  'text-couli-title leading-couli-title font-couli-semibold tabular-nums [overflow-wrap:anywhere]';

/**
 * 收益看板（F1-12a，路由 Earnings）：经应用级 API 客户端（内部经桥取 H5 令牌）读 getEarningsSummary，
 * 自购 / 分享 / 邀请三栏 × 四期间（切期间只换显示）、平台筛选（只筛自购与分享）与指标说明。
 * 没有 API 客户端（App 外或未配置）时显示共用占位页，不发请求。
 */
export function EarningsPage(props: EarningsPageProps): ReactElement {
  void props;
  const api = useApi();
  if (api === null) return <PagePending />;
  return <Dashboard api={api} />;
}

/** 经桥读平台状态；桥没有该能力或调用失败时只显示「全部」，不让整页失败。 */
async function loadPlatforms(): Promise<EarningsPlatform[]> {
  const getConfig = has('app.getConfig');
  if (getConfig === null) return [];
  try {
    const result = await call(getConfig, { keys: CONFIG_KEYS });
    return parsePlatforms(result.values);
  } catch {
    return [];
  }
}

/** 当前文档是否滚在顶部（下拉刷新只在顶部起手时生效）。 */
function atTop(): boolean {
  const scrolled = document.scrollingElement?.scrollTop ?? 0;
  return scrolled <= 0 && window.scrollY <= 0;
}

function Dashboard({ api }: { api: H5ApiClient }): ReactElement {
  const [params] = useSearchParams();
  // 路由参数 platform（可选）：在胶囊列表里时预选，首个请求即带它；否则按「全部」。
  const wanted = asPlatform(params.get('platform'));
  const [chosen, setChosen] = useState<EarningsPlatform | null | undefined>(
    wanted === null ? null : undefined,
  );
  const [period, setPeriod] = useState<PeriodKey>(DEFAULT_PERIOD);
  const [note, setNote] = useState<{ name: string; hint: string } | null>(null);

  const config = useQuery({
    queryKey: ['earnings', 'config'],
    queryFn: loadPlatforms,
    staleTime: Infinity,
    ...NO_AUTO_FETCH,
  });
  const platforms = config.data ?? [];
  const platform: EarningsPlatform | null | undefined =
    chosen !== undefined
      ? chosen
      : config.isPending
        ? undefined
        : wanted !== null && platforms.includes(wanted)
          ? wanted
          : null;

  const summary = useQuery({
    queryKey: ['earnings', 'summary', platform ?? 'all'],
    queryFn: () =>
      api.request('GET', SUMMARY_PATH, {
        params: { query: platform === null || platform === undefined ? {} : { platform } },
      }),
    enabled: platform !== undefined,
    staleTime: 0,
    ...NO_AUTO_FETCH,
  });

  // 下拉刷新：按当前平台重取一次；在途时不再发起。
  const busy = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  function refresh(): void {
    if (busy.current || summary.isFetching || platform === undefined) return;
    busy.current = true;
    setRefreshing(true);
    summary
      .refetch()
      .catch(() => undefined)
      .finally(() => {
        busy.current = false;
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

  const data = summary.data;
  const settledError = summary.isError && !summary.isFetching ? summary.error : null;
  const errorCode = settledError instanceof ApiError ? settledError.code : null;
  // 30701（看板关闭）：无论有没有旧数据（下拉刷新、切回取过的平台）都整页换成关闭提示，不显示旧数字。
  // 10405（版本过低）：没有可显示的数据时整页提示；有旧数据时走下方的刷新失败横条。两者都不重试。
  if (errorCode === 30701 || (data === undefined && errorCode === 10405)) {
    return (
      <Page>
        <div className="flex flex-1 items-center justify-center py-couli-16">
          <ErrorState
            title={errorCode === 30701 ? t('error.30701') : t('error.10405')}
            description=""
            icon={<ChartIcon />}
          />
        </div>
      </Page>
    );
  }
  // 「全部」首次加载失败：整页重试。选了具体平台时失败只在内容区显示重试，保留胶囊与期间切换以便切回。
  const loadFailed = data === undefined && settledError !== null;
  if (loadFailed && platform === null) {
    return <RetryPage onRetry={() => void summary.refetch()} />;
  }

  function choose(next: EarningsPlatform | null): void {
    setChosen(next);
  }

  const refreshFailed = data !== undefined && summary.isRefetchError && !summary.isFetching;
  const refreshError = refreshFailed
    ? summary.error instanceof ApiError && summary.error.code === 10405
      ? t('error.10405')
      : t('h5.load_failed')
    : null;

  return (
    <Page
      inert={note !== null}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {refreshing ? (
        <p role="status" className={`${CAPTION} text-center`}>
          {earningsTexts.refreshing}
        </p>
      ) : null}
      {refreshError === null ? null : (
        <div className="flex min-h-11 items-center justify-center gap-couli-3 rounded-couli-button bg-couli-background-muted px-couli-3">
          <p role="alert" className={`${CAPTION} min-w-0 [overflow-wrap:anywhere]`}>
            {refreshError}
          </p>
          <button
            type="button"
            className={`${FOCUS_RING} min-h-11 flex-none cursor-pointer px-couli-2 text-couli-footnote leading-couli-footnote font-couli-medium text-couli-text-link`}
            onClick={refresh}
          >
            {t('h5.retry')}
          </button>
        </div>
      )}
      <PlatformPills
        platforms={platforms}
        selected={platform ?? null}
        onSelect={choose}
        disabled={platform === undefined}
      />
      <PeriodSwitch selected={period} onSelect={setPeriod} />
      {loadFailed ? (
        <div className="flex flex-1 items-center justify-center py-couli-16">
          <ErrorState
            title={t('h5.load_failed')}
            description=""
            icon={<ChartIcon />}
            action={{ label: t('h5.retry'), onClick: () => void summary.refetch() }}
          />
        </div>
      ) : data === undefined ? (
        <LoadingCards />
      ) : (
        <Figures
          summary={data}
          nowMs={summary.dataUpdatedAt}
          period={period}
          filtered={platform !== null && platform !== undefined}
          onNote={(name, hint) => setNote({ name, hint })}
        />
      )}
      <Sheet
        open={note !== null}
        title={note?.name ?? ''}
        description={note?.hint ?? ''}
        closeLabel={earningsTexts.close}
        onClose={() => setNote(null)}
        primaryAction={{ label: earningsTexts.confirm, onClick: () => setNote(null) }}
      />
    </Page>
  );
}

function Page({
  children,
  inert,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
}: {
  children: ReactNode;
  inert?: boolean;
  onTouchStart?: (event: TouchEvent) => void;
  onTouchMove?: (event: TouchEvent) => void;
  onTouchEnd?: () => void;
}): ReactElement {
  return (
    <main
      inert={inert === true}
      className="flex min-h-dvh min-w-0 flex-col gap-couli-3 bg-couli-background-canvas px-couli-4 pt-couli-2 pb-couli-6 font-couli-system text-couli-text-primary"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <h1 className="sr-only">{earningsText('earnings.title')}</h1>
      {children}
    </main>
  );
}

const PILL_BUTTON = `${FOCUS_RING} flex min-h-11 flex-none cursor-pointer items-center rounded-couli-pill disabled:cursor-default`;
const PILL =
  'flex h-8 items-center gap-couli-1 whitespace-nowrap rounded-couli-pill border px-couli-4 text-couli-footnote leading-couli-footnote';
const PILL_ON =
  'border-couli-brand-subtle bg-couli-brand-subtle font-couli-medium text-couli-brand-emphasis';
const PILL_OFF = 'border-couli-border-subtle bg-couli-background-surface text-couli-text-primary';

/** 平台筛选：「全部」加开放中的平台；32 高胶囊，按钮命中区 44（规格 §2、§6），选中项以 aria-pressed 播报。 */
function PlatformPills({
  platforms,
  selected,
  onSelect,
  disabled,
}: {
  platforms: readonly EarningsPlatform[];
  selected: EarningsPlatform | null;
  onSelect: (platform: EarningsPlatform | null) => void;
  disabled: boolean;
}): ReactElement {
  const items: (EarningsPlatform | null)[] = [null, ...platforms];
  return (
    <div
      role="group"
      aria-label={earningsText('earnings.platform.label')}
      className="-mx-couli-4 flex flex-none gap-couli-2 overflow-x-auto px-couli-4 [scrollbar-width:none]"
    >
      {items.map((item) => {
        const on = item === selected;
        return (
          <button
            key={item ?? 'all'}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            className={PILL_BUTTON}
            onClick={() => {
              if (!on) onSelect(item);
            }}
          >
            <span className={`${PILL} ${on ? PILL_ON : PILL_OFF}`}>
              {item === null ? null : (
                <img
                  src={PLATFORM_ICONS[item]}
                  alt=""
                  aria-hidden="true"
                  className="block size-4 flex-none"
                />
              )}
              {item === null ? earningsText('earnings.platform.all') : getPlatformName(item)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** 期间分段控件：只换显示，不重新请求。 */
function PeriodSwitch({
  selected,
  onSelect,
}: {
  selected: PeriodKey;
  onSelect: (period: PeriodKey) => void;
}): ReactElement {
  return (
    <div
      role="group"
      aria-label={earningsText('earnings.period.label')}
      className="flex gap-couli-1 rounded-couli-button border border-couli-border-subtle bg-couli-background-surface p-couli-1"
    >
      {PERIODS.map((key) => {
        const on = key === selected;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={on}
            className={`${FOCUS_RING} min-h-11 min-w-0 flex-1 basis-0 cursor-pointer rounded-couli-small px-couli-1 text-couli-footnote leading-couli-footnote ${
              on
                ? 'bg-couli-brand-subtle font-couli-semibold text-couli-brand-emphasis'
                : 'text-couli-text-secondary'
            }`}
            onClick={() => onSelect(key)}
          >
            {earningsText(`earnings.period.${key}`)}
          </button>
        );
      })}
    </div>
  );
}

function LoadingCards(): ReactElement {
  return (
    <>
      <Skeleton width="40%" height="1.125rem" />
      {[0, 1, 2].map((index) => (
        <div key={index} className={`${CARD} flex flex-col gap-couli-3`}>
          <Skeleton width="35%" height="1.5rem" />
          <div className="grid grid-cols-2 gap-couli-3">
            <Skeleton width="70%" height="2.75rem" />
            <Skeleton width="70%" height="2.75rem" />
          </div>
        </div>
      ))}
    </>
  );
}

type OnNote = (name: string, hint: string) => void;

function Figures({
  summary,
  nowMs,
  period,
  filtered,
  onNote,
}: {
  summary: EarningsSummary;
  /** 「今天 / 昨天」按取到数据时的上海日期判断（BR-TEXT-11）。 */
  nowMs: number;
  period: PeriodKey;
  filtered: boolean;
  onNote: OnNote;
}): ReactElement {
  const asOf = earningsText('earnings.as_of', { time: formatAsOf(summary.as_of, nowMs) });
  const empty = isEmptyPeriod(summary, period);
  const estHint = earningsText('earnings.metric.est.hint');
  const creditedName = earningsText('earnings.metric.credited.name');
  const creditedHint = earningsText('earnings.metric.credited.hint');
  const countName = earningsText('earnings.metric.paid_count.name');
  const countHint = earningsText('earnings.metric.paid_count.hint');
  return (
    <>
      <p className={`${CAPTION} flex flex-wrap gap-x-couli-2 px-couli-1`}>
        <span>{asOf}</span>
        {empty ? (
          <span>
            {earningsText('earnings.empty_hint', {
              period: earningsText(`earnings.period.${period}`),
            })}
          </span>
        ) : null}
      </p>
      {(['self', 'share'] as const).map((column) => {
        const figures = summary[column][period];
        const estName =
          column === 'self'
            ? earningsText('earnings.metric.est.name_self')
            : earningsText('earnings.metric.est.name_promo');
        return (
          <section key={column} className={`${CARD} flex flex-col gap-couli-3`}>
            <CardTitle
              title={
                column === 'self'
                  ? earningsText('earnings.section.self')
                  : earningsText('earnings.section.share')
              }
            />
            <div className="grid grid-cols-2 gap-x-couli-3 gap-y-couli-4">
              <Metric
                name={estName}
                hint={estHint}
                value={formatFen(figures.est_fen)}
                accent
                onNote={onNote}
              />
              <Metric
                name={creditedName}
                hint={creditedHint}
                value={formatFen(figures.credited_fen)}
                accent
                onNote={onNote}
              />
              <Metric
                name={countName}
                hint={countHint}
                value={String(figures.paid_count)}
                accent={false}
                onNote={onNote}
              />
            </div>
          </section>
        );
      })}
      {summary.referral === null ? null : (
        <Referral
          referral={summary.referral}
          filtered={filtered}
          estHint={estHint}
          creditedName={creditedName}
          creditedHint={creditedHint}
          onNote={onNote}
        />
      )}
    </>
  );
}

function CardTitle({ title, tag }: { title: string; tag?: string | undefined }): ReactElement {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-couli-2">
        <h2 className="text-couli-body leading-couli-body font-couli-semibold">{title}</h2>
        {tag === undefined ? null : (
          <span className="rounded-couli-pill bg-couli-background-muted px-couli-2 text-couli-caption leading-couli-caption text-couli-text-secondary">
            {tag}
          </span>
        )}
      </div>
      <div aria-hidden="true" className="h-px bg-couli-border-subtle" />
    </>
  );
}

function Metric({
  name,
  hint,
  value,
  accent,
  onNote,
}: {
  name: string;
  /** 有说明时名称旁带问号按钮；邀请栏上月一列不重复问号（画板）。 */
  hint: string | null;
  value: string;
  accent: boolean;
  onNote: OnNote;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-couli-1">
      <span
        className={`flex min-h-[1.125rem] items-center gap-couli-1 text-couli-caption leading-couli-caption ${
          accent ? 'text-couli-rebate-text' : 'text-couli-text-secondary'
        }`}
      >
        <span className="min-w-0 [overflow-wrap:anywhere]">{name}</span>
        {hint === null ? null : (
          <button
            type="button"
            aria-label={earningsText('earnings.metric.note_label', { name })}
            aria-haspopup="dialog"
            className={`${FOCUS_RING} -mx-[0.9375rem] -my-[0.8125rem] flex size-11 flex-none cursor-pointer items-center justify-center text-couli-text-secondary`}
            onClick={() => onNote(name, hint)}
          >
            <QuestionIcon />
          </button>
        )}
      </span>
      <span
        className={`${AMOUNT} ${accent ? 'text-couli-rebate-text' : 'text-couli-text-primary'}`}
      >
        {value}
      </span>
    </div>
  );
}

/** 邀请栏：只有本月、上月的金额合计，没有笔数、日期与好友信息；不受平台筛选（BR-FUND-25）。 */
function Referral({
  referral,
  filtered,
  estHint,
  creditedName,
  creditedHint,
  onNote,
}: {
  referral: NonNullable<EarningsSummary['referral']>;
  filtered: boolean;
  estHint: string;
  creditedName: string;
  creditedHint: string;
  onNote: OnNote;
}): ReactElement {
  const estName = earningsText('earnings.metric.est.name_promo');
  return (
    <section className={`${CARD} flex flex-col gap-couli-3`}>
      <CardTitle
        title={earningsText('earnings.section.referral')}
        tag={filtered ? earningsText('earnings.referral.platform_note') : undefined}
      />
      <div className="grid grid-cols-2 gap-couli-3">
        {MONTHS.map((month) => (
          <span
            key={month}
            className="text-couli-footnote leading-couli-footnote font-couli-semibold"
          >
            {earningsText(`earnings.period.${month}`)}
          </span>
        ))}
        {MONTHS.map((month, index) => (
          <Metric
            key={`est-${month}`}
            name={estName}
            hint={index === 0 ? estHint : null}
            value={formatFen(referral[month].est_fen)}
            accent
            onNote={onNote}
          />
        ))}
        {MONTHS.map((month, index) => (
          <Metric
            key={`credited-${month}`}
            name={creditedName}
            hint={index === 0 ? creditedHint : null}
            value={formatFen(referral[month].credited_fen)}
            accent
            onNote={onNote}
          />
        ))}
      </div>
      <p className={CAPTION}>{earningsText('earnings.referral.note')}</p>
    </section>
  );
}

const ICON = {
  'aria-hidden': true,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function QuestionIcon(): ReactElement {
  return (
    <svg {...ICON} className="size-3.5">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.4v.6" />
      <path d="M12 16.8v.2" />
    </svg>
  );
}

function ChartIcon(): ReactElement {
  return (
    <svg {...ICON}>
      <path d="M4.5 19.5h15" />
      <path d="M7.5 16v-5M12 16V7M16.5 16v-3" />
    </svg>
  );
}
