import { call, has } from '@couli/bridge-sdk';
import { formatYuan } from '@couli/money';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactElement, type ReactNode } from 'react';
import { ErrorState, Skeleton } from '../../../../components/base/index.ts';
import { FOCUS_RING, SECONDARY_BUTTON } from '../../../../components/base/styles.ts';
import { RetryPage } from '../../../../components/retry/index.ts';
import { useApi } from '../../../../shared/api/app-api.ts';
import { ApiError, type H5ApiClient } from '../../../../shared/api/index.ts';
import { t } from '../../../../shared/texts.ts';
import { inviteRewardRules, inviteRuleSummary, inviteTexts } from '../../../../texts/invite.ts';
import { Component as PagePending } from '../page-pending.tsx';
import {
  CONFIG_KEYS,
  NO_LINKS,
  SUPPORT_ENTRY,
  parseInviteLinks,
  parseInviteReward,
  type HelpTarget,
  type InviteLinks,
  type InviteReward,
} from './model.ts';

export type InvitePageProps = Record<string, never>;

const INVITE_KEY = ['invite', 'me'] as const;
const CONFIG_KEY = ['invite', 'config'] as const;

/** 请求只来自进页与用户点重试：逐项关掉自动重取（10405 等错误不得被自动重放），不依赖共享默认值。 */
const NO_AUTO_FETCH = {
  staleTime: Infinity,
  retry: false,
  refetchOnMount: false,
  refetchOnReconnect: false,
  refetchOnWindowFocus: false,
  refetchInterval: false,
  refetchIntervalInBackground: false,
} as const;

const CARD = 'rounded-couli-card bg-couli-background-surface p-couli-4 shadow-couli-card';
const CAPTION = 'text-couli-caption leading-couli-caption text-couli-text-secondary';
const FOOTNOTE = 'text-couli-footnote leading-couli-footnote';
const LINK = `${FOCUS_RING} inline-flex min-h-11 flex-none cursor-pointer items-center gap-couli-1 ${FOOTNOTE} font-couli-medium text-couli-text-link`;
/** 邀请码卡底部并排的两个按钮：内边距比通用按钮窄，375 宽下一行放得下「复制邀请链接」，大字号时换行。 */
const ACTION = `${FOCUS_RING} inline-flex min-h-couli-component-button-min-height min-w-0 flex-1 basis-32 cursor-pointer items-center justify-center gap-couli-1 rounded-couli-button px-couli-2 py-couli-2 text-couli-body leading-couli-body`;
const ACTION_SECONDARY = `${ACTION} border border-couli-border-control bg-couli-background-surface font-couli-medium text-couli-text-primary active:bg-couli-background-muted`;
const ACTION_PRIMARY = `${ACTION} bg-couli-button-primary-default-background font-couli-semibold text-couli-button-primary-default-text active:bg-couli-button-primary-pressed-background active:text-couli-button-primary-pressed-text disabled:cursor-not-allowed disabled:bg-couli-button-primary-disabled-background disabled:text-couli-button-primary-disabled-text`;

/**
 * 邀请好友（F1-05a，路由 InviteShare，h5 `/invite`）：经应用级 API 客户端（内部经桥取 H5 令牌）读 getMyInvite，
 * 经桥 app.getConfig 读 invite 段决定奖励活动卡（D36；读取失败按活动无效），读 help_links 决定【完整规则】
 * 【活动规则】入口（CT-16n；键未配置或读取失败时入口不显示）。没有 API 客户端（App 外或未配置）
 * 时在任何钩子之前返回共用占位页，不发请求。
 */
export function InvitePage(props: InvitePageProps): ReactElement {
  void props;
  const api = useApi();
  if (api === null) return <PagePending />;
  return <InviteContent api={api} />;
}

interface InviteConfig {
  reward: InviteReward | null;
  links: InviteLinks;
}

const NO_CONFIG: InviteConfig = { reward: null, links: NO_LINKS };

/** 经桥读奖励活动与帮助入口配置；桥没有该能力或调用失败都按活动无效、入口不显示，不让整页失败。 */
async function loadConfig(): Promise<InviteConfig> {
  const getConfig = has('app.getConfig');
  if (getConfig === null) return NO_CONFIG;
  try {
    const result = await call(getConfig, { keys: CONFIG_KEYS });
    return { reward: parseInviteReward(result.values), links: parseInviteLinks(result.values) };
  } catch {
    return NO_CONFIG;
  }
}

/** 请求没能发出或没有回应（fetch 抛出的 TypeError）：显示断网态（StateNetworkError）。 */
function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

function Page({ children }: { children: ReactNode }): ReactElement {
  return (
    <main className="flex min-h-dvh min-w-0 flex-col gap-couli-3 bg-couli-background-canvas px-couli-4 pt-couli-2 pb-couli-6 font-couli-system text-couli-text-primary">
      {children}
    </main>
  );
}

function CenteredState({ children }: { children: ReactNode }): ReactElement {
  return (
    <Page>
      <div className="flex flex-1 items-center justify-center py-couli-16">{children}</div>
    </Page>
  );
}

function InviteContent({ api }: { api: H5ApiClient }): ReactElement {
  const invite = useQuery({
    queryKey: INVITE_KEY,
    queryFn: () => api.request('GET', '/v1/invites/me', {}),
    ...NO_AUTO_FETCH,
  });
  const config = useQuery({ queryKey: CONFIG_KEY, queryFn: loadConfig, ...NO_AUTO_FETCH });
  const [notice, setNotice] = useState<string | null>(null);

  /** 轻提示：有 ui.toast 走原生，否则页内播报。 */
  function notify(text: string): void {
    const toast = has('ui.toast');
    if (toast === null) {
      setNotice(text);
      return;
    }
    call(toast, { text }).catch(() => setNotice(text));
  }

  const data = invite.data;
  if (data === undefined && invite.isError && !invite.isFetching) {
    const error = invite.error;
    if (error instanceof ApiError && (error.code === 30413 || error.code === 10005)) {
      // 30413（未成年）与 10005（未绑手机，本页只兜底）：只显示错误文案，不给邀请、分享与奖励入口，不重试。
      return (
        <CenteredState>
          <ErrorState
            title={error.code === 30413 ? t('error.30413') : t('error.10005')}
            description=""
            icon={<PeopleIcon />}
          />
        </CenteredState>
      );
    }
    const retry = (): void => void invite.refetch();
    if (isNetworkError(error)) {
      return (
        <CenteredState>
          <ErrorState
            title={t('net.unavailable')}
            description={t('net.unavailable.desc')}
            icon={<OfflineIcon />}
            action={{ label: t('h5.retry'), onClick: retry }}
          />
        </CenteredState>
      );
    }
    return <RetryPage onRetry={retry} />;
  }

  if (data === undefined || config.isPending) {
    return (
      <Page>
        <div className={`${CARD} flex flex-col items-center gap-couli-3`}>
          <Skeleton width="30%" height="1.125rem" />
          <Skeleton width="60%" height="2.5rem" />
          <Skeleton width="100%" height="2.75rem" />
        </div>
        <div className={CARD}>
          <Skeleton width="40%" height="1.3125rem" />
        </div>
      </Page>
    );
  }

  const canInvite =
    data.can_invite &&
    data.invite_code !== null &&
    data.invite_code !== '' &&
    data.landing_url !== null &&
    data.landing_url !== '';
  // 暂不可邀请时不显示奖励活动卡（规格 §7 保守默认）。
  const reward = canInvite ? (config.data?.reward ?? null) : null;
  const links = config.data?.links ?? NO_LINKS;

  return (
    <Page>
      {canInvite ? (
        <CodeCard
          code={data.invite_code ?? ''}
          link={data.landing_url ?? ''}
          poster={data.poster_url}
          notify={notify}
        />
      ) : (
        <UnavailableCard />
      )}
      <CountCard count={data.direct_count} />
      {reward === null ? null : <RewardCard reward={reward} link={links.rewardRules} />}
      <RulesCard rewardOn={reward !== null} link={links.rules} />
      {notice === null ? null : (
        <p role="status" className={`${CAPTION} text-center`}>
          {notice}
        </p>
      )}
    </Page>
  );
}

/** 经桥 nav.open 打开别的页面；没有该能力时不响应。 */
function openLedger(): void {
  const navOpen = has('nav.open');
  if (navOpen === null) return;
  call(navOpen, { route: 'Ledger' }).catch(() => undefined);
}

/** 按 help_links 的跳转目标原样经桥打开帮助文章。 */
function openArticle(target: HelpTarget): void {
  const navOpen = has('nav.open');
  if (navOpen === null) return;
  call(navOpen, target).catch(() => undefined);
}

function CodeCard({
  code,
  link,
  poster,
  notify,
}: {
  code: string;
  link: string;
  poster: string | null;
  notify: (text: string) => void;
}): ReactElement {
  const [posterBroken, setPosterBroken] = useState(false);
  const posterUrl = poster === null || poster === '' ? null : poster;

  // clipboard.write 要求一秒内的用户点击：在点击处理里直接调用。
  function copy(text: string, done: string): void {
    const clipboard = has('clipboard.write');
    if (clipboard === null) return;
    call(clipboard, { text })
      .then(() => notify(done))
      .catch(() => undefined);
  }

  function preview(): void {
    if (posterUrl === null) return;
    const handle = has('media.previewImage');
    if (handle === null) return;
    call(handle, { urls: [posterUrl] }).catch(() => undefined);
  }

  // 保存服务端出图（TECH-13）；相册权限说明由原生在首次保存前给出，被拒（saved=false）时提示（BR-ID-13）。
  function save(): void {
    if (posterUrl === null) return;
    const handle = has('media.saveImage');
    if (handle === null) return;
    call(handle, { urls: [posterUrl] })
      .then((result) => {
        if (!result.saved) notify(t('perm.photos.denied_forever'));
      })
      .catch(() => undefined);
  }

  return (
    <section className={`${CARD} flex flex-col gap-couli-4`}>
      <div className="flex flex-col items-center gap-couli-1 text-center">
        <p className={`${FOOTNOTE} text-couli-text-secondary`}>{inviteTexts.codeLabel}</p>
        {/* eslint-disable-next-line couli-style/no-arbitrary-value -- invite code display size and spacing from the design board (no ui-tokens step yet) */}
        <p className="text-[2rem] leading-tight font-couli-semibold tracking-[0.2em] tabular-nums [overflow-wrap:anywhere]">
          {code}
        </p>
        <button
          type="button"
          className={LINK}
          onClick={() => copy(code, t('invite.copy_code.done'))}
        >
          <CopyIcon />
          {t('invite.share.copy_code')}
        </button>
      </div>
      {posterUrl === null || posterBroken ? null : (
        <button
          type="button"
          aria-label={inviteTexts.posterPreview}
          className={`${FOCUS_RING} mx-auto block w-3/5 max-w-60 cursor-pointer overflow-hidden rounded-couli-card bg-couli-background-muted`}
          onClick={preview}
        >
          <img
            src={posterUrl}
            alt=""
            className="block aspect-[750/1334] w-full object-cover"
            onError={() => setPosterBroken(true)}
          />
        </button>
      )}
      <div className="flex flex-wrap gap-couli-3">
        <button
          type="button"
          className={ACTION_SECONDARY}
          onClick={() => copy(link, t('invite.copy_link.done'))}
        >
          <LinkIcon />
          {t('invite.share.copy_link')}
        </button>
        <button
          type="button"
          disabled={posterUrl === null}
          className={ACTION_PRIMARY}
          onClick={save}
        >
          <DownloadIcon />
          {t('invite.share.save_poster')}
        </button>
      </div>
    </section>
  );
}

function UnavailableCard(): ReactElement {
  const support = has('cs.open');
  return (
    <section className={`${CARD} flex flex-col items-center gap-couli-3 py-couli-6 text-center`}>
      <div
        aria-hidden="true"
        className="flex size-24 items-center justify-center rounded-couli-card bg-couli-background-muted text-couli-text-secondary"
      >
        <PeopleIcon />
      </div>
      <h2 className="text-couli-body leading-couli-body font-couli-semibold">
        {t('invite.share.unavailable')}
      </h2>
      <p className={`${FOOTNOTE} text-couli-text-secondary`}>
        {t('invite.share.unavailable_hint')}
      </p>
      {support === null ? null : (
        <button
          type="button"
          className={SECONDARY_BUTTON}
          onClick={() => {
            call(support, { entry: SUPPORT_ENTRY }).catch(() => undefined);
          }}
        >
          {inviteTexts.contactSupport}
        </button>
      )}
    </section>
  );
}

function CountCard({ count }: { count: number }): ReactElement {
  // 人数只显示 direct_count，不可点；说明进余额流水（BR-INV-16、BR-INV-20）。
  return (
    <section className={`${CARD} flex flex-wrap items-center gap-couli-3`}>
      <div className="flex min-w-0 flex-1 items-center gap-couli-3">
        <span
          aria-hidden="true"
          className="flex size-10 flex-none items-center justify-center rounded-couli-button bg-couli-background-muted text-couli-text-secondary"
        >
          <PeopleIcon />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className={CAPTION}>{t('invite.share.invited_count')}</span>
          <span className="text-couli-title leading-couli-title font-couli-semibold tabular-nums [overflow-wrap:anywhere]">
            {t('invite.share.invited_unit', { n: String(count) })}
          </span>
        </span>
      </div>
      <button
        type="button"
        className={`${FOCUS_RING} ml-auto flex min-h-11 min-w-0 cursor-pointer flex-col items-end text-right ${CAPTION}`}
        onClick={openLedger}
      >
        <span>{t('invite.share.promo_label')}</span>
        <span>{t('invite.share.promo_where')}</span>
      </button>
    </section>
  );
}

/** 卡片标题行；入口的跳转目标为 null（help_links 未配置该键）时不显示入口（契约 help_links 约定）。 */
function CardHeader({
  title,
  entry,
  target,
}: {
  title: string;
  entry: string;
  target: HelpTarget | null;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-couli-3">
      <h2 className="text-couli-body leading-couli-body font-couli-semibold">{title}</h2>
      {target === null ? null : (
        <button type="button" className={LINK} onClick={() => openArticle(target)}>
          {entry}
          <ChevronIcon />
        </button>
      )}
    </div>
  );
}

function RuleList({ items }: { items: readonly string[] }): ReactElement {
  return (
    <ul className={`flex list-disc flex-col gap-couli-2 ps-couli-4 ${FOOTNOTE}`}>
      {items.map((item) => (
        <li key={item} className="[overflow-wrap:anywhere]">
          {item}
        </li>
      ))}
    </ul>
  );
}

function RewardCard({
  reward,
  link,
}: {
  reward: InviteReward;
  link: HelpTarget | null;
}): ReactElement {
  const rules = [
    inviteRewardRules.settle,
    ...(reward.eligibilityDays === null
      ? []
      : [inviteRewardRules.eligibility(reward.eligibilityDays)]),
    inviteRewardRules.once,
    inviteRewardRules.sameDevice,
    inviteRewardRules.limited,
  ];
  return (
    <section className={`${CARD} flex flex-col gap-couli-3`}>
      <CardHeader
        title={t('invite.share.reward_title')}
        entry={t('invite.share.reward_rules')}
        target={link}
      />
      <p className="flex items-start gap-couli-2 rounded-couli-button border border-couli-brand-subtle bg-couli-brand-subtle px-couli-3 py-couli-2 text-couli-body leading-couli-body font-couli-semibold text-couli-brand-emphasis">
        <GiftIcon />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {t('invite.reward.tip_inviter', { amount: formatYuan(reward.amountFen) })}
        </span>
      </p>
      <RuleList items={rules} />
    </section>
  );
}

function RulesCard({
  rewardOn,
  link,
}: {
  rewardOn: boolean;
  link: HelpTarget | null;
}): ReactElement {
  // 活动无效时末条为「不发放红包或现金奖励」一句；有效时不显示（BR-INV-18 细则、BR-INV-24 ⑨）。
  const items = rewardOn
    ? inviteRuleSummary
    : [...inviteRuleSummary, t('invite.share.rule.no_reward')];
  return (
    <section className={`${CARD} flex flex-col gap-couli-3`}>
      <CardHeader
        title={t('invite.share.rules_title')}
        entry={t('invite.share.rules_full')}
        target={link}
      />
      <RuleList items={items} />
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

function PeopleIcon(): ReactElement {
  return (
    <svg {...ICON} className="size-6 flex-none">
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5" />
      <path d="M15.5 6a3 3 0 0 1 0 5.5M17 14.7c1.9.5 3.1 1.9 3.5 4.3" />
    </svg>
  );
}

function OfflineIcon(): ReactElement {
  return (
    <svg {...ICON}>
      <path d="M2.5 8.5a14 14 0 0 1 19 0M5.5 12a9.5 9.5 0 0 1 13 0M8.5 15.5a5 5 0 0 1 7 0" />
      <circle cx="12" cy="19" r="1" />
      <path d="m4 3 16 18" />
    </svg>
  );
}

function CopyIcon(): ReactElement {
  return (
    <svg {...ICON} className="size-4 flex-none">
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 5.5v-1a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h1" />
    </svg>
  );
}

function LinkIcon(): ReactElement {
  return (
    <svg {...ICON} className="size-5 flex-none">
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </svg>
  );
}

function DownloadIcon(): ReactElement {
  return (
    <svg {...ICON} className="size-5 flex-none">
      <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" />
    </svg>
  );
}

function ChevronIcon(): ReactElement {
  return (
    <svg {...ICON} className="size-4 flex-none">
      <path d="m9.5 6 6 6-6 6" />
    </svg>
  );
}

function GiftIcon(): ReactElement {
  return (
    <svg {...ICON} className="mt-0.5 size-5 flex-none">
      <rect x="4" y="9" width="16" height="11" rx="1.5" />
      <path d="M3.5 9h17M12 9v11M12 9c-1.5-3.5-5-4-5-1.5S10 9 12 9Zm0 0c1.5-3.5 5-4 5-1.5S14 9 12 9Z" />
    </svg>
  );
}
