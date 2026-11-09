import * as bridgeSdk from '@couli/bridge-sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Card, Skeleton, Tabs } from '../../../../components/base/index.ts';
import { RetryPage } from '../../../../components/retry/index.ts';
import { useApi, type AppApiBridge } from '../../../../shared/api/app-api.ts';
import type { H5ApiClient } from '../../../../shared/api/index.ts';
import { findOrderTexts } from '../../../../texts/find-order.ts';
import { Component as PagePending } from '../page-pending.tsx';
import type { ClaimRecordsProps } from './claim-records.tsx';
import {
  CONFIG_KEYS,
  RECORDS_KEY,
  type Claim,
  type ClaimPlatform,
  type LocateTarget,
} from './model.ts';

export interface FindOrderPageProps {
  /** Injectable SDK facade; production uses @couli/bridge-sdk. */
  bridge?: AppApiBridge;
}

const DEFAULT_BRIDGE: AppApiBridge = {
  isInApp: bridgeSdk.isInApp,
  has: bridgeSdk.has,
  call: bridgeSdk.call,
  createH5TokenManager: bridgeSdk.createH5TokenManager,
};

/**
 * 新显示的页签面板、替换骨架的表单与记录内容只淡入（shared/styles/index.css `h5-content-fade`，DSX-48d）。
 * 记录页签的加载完成态在 claim-records.tsx 里带同一个类。
 */
const CONTENT_FADE = 'h5-content-fade';

/** 本页启动配置的缓存键（账号切换时由壳层连同整份缓存清掉）。 */
const BOOT_KEY = ['find-order', 'boot'] as const;

type Tab = 'apply' | 'records';

// 按块加载（路由块连同依赖的体积上限）：两个页签各自成块，每块连同依赖只带自己的页签；进页就开始预取，
// 配置到手时通常已经就绪，还没到时先显示与该页签加载态相同的骨架。块加载失败与其他渲染错误一样交给路由的错误处理。

const ClaimForm = lazy(() =>
  import('./claim-form.tsx').then((module) => ({ default: module.ClaimForm })),
);
/**
 * 记录块与记录行部件块（平台标识 PlatformBadge、状态标签、空态插图）都到了才渲染记录，
 * 行与标识同时出现。部件块不依赖页面块，所以不计入记录块的依赖体积。
 */
const ClaimRecords = lazy(async () => {
  const [{ ClaimRecords: Records }, { recordParts }] = await Promise.all([
    import('./claim-records.tsx'),
    import('./records-parts.tsx'),
  ]);
  return {
    default: (props: Omit<ClaimRecordsProps, 'parts'>) => (
      <Records {...props} parts={recordParts} />
    ),
  };
});

/** 进页即预取两个页签的块（同一模块只取一次，lazy 渲染时直接用上）。 */
function preloadTabs(): void {
  for (const load of [
    () => import('./claim-form.tsx'),
    () => import('./claim-records.tsx'),
    () => import('./records-parts.tsx'),
  ])
    load().catch(() => undefined);
}

/** 表单的加载态（配置未到、表单块未到时共用）。 */
function FormSkeleton(): ReactElement {
  return (
    <Card className="flex flex-col gap-couli-3">
      <Skeleton width="30%" height="1.3125rem" />
      <Skeleton width="100%" height="2.75rem" />
      <Skeleton width="30%" height="1.3125rem" />
      <Skeleton width="100%" height="2.75rem" />
    </Card>
  );
}

function RecordCardSkeleton(): ReactElement {
  return (
    <Card className="flex flex-col gap-couli-2">
      <Skeleton width="40%" height="1.25rem" />
      <Skeleton width="70%" height="1.3125rem" />
      <Skeleton width="50%" height="1.125rem" />
    </Card>
  );
}

function RecordsFallback(): ReactElement {
  return (
    <div className="flex flex-col gap-couli-3">
      <RecordCardSkeleton />
      <RecordCardSkeleton />
    </div>
  );
}

/**
 * 订单找回（F1-04b，路由 FindOrder）：进页经桥取 H5 令牌与 /v1/config（找回期限、按平台的指引链接、平台开关），
 * 「申请找回」经桥 net.signedRequest 提交 createOrderClaim，「找回记录」读 listOrderClaims。
 * 没有 API 客户端（App 外或未配置）时显示共用占位页，不发请求。
 * 账号切换（auth.changed）由壳层统一处理（F1-01s）：作废令牌、取消并清空缓存、整棵页面树重新挂载，
 * 本页的令牌管理器、页签、表单与记录状态随之重建；本页不再自己订阅该事件。
 */
export function FindOrderPage({ bridge = DEFAULT_BRIDGE }: FindOrderPageProps): ReactElement {
  const api = useApi();
  if (api === null) return <PagePending />;
  return <FindOrderContent api={api} bridge={bridge} />;
}

function Page({ children }: { children: ReactNode }): ReactElement {
  return (
    <main className="flex min-h-dvh min-w-0 flex-col gap-couli-3 bg-couli-background-canvas px-couli-4 pt-couli-2 font-couli-system text-couli-text-primary">
      {children}
    </main>
  );
}

function FindOrderContent({
  api,
  bridge,
}: {
  api: H5ApiClient;
  bridge: AppApiBridge;
}): ReactElement {
  const queryClient = useQueryClient();
  // 本页自己的令牌管理器只在内存里（BR-ID-32），随页面挂载新建；进页先取一次，取不到就显示加载失败，不自动重放。
  const [tokens] = useState(() => bridge.createH5TokenManager());
  const boot = useQuery({
    queryKey: BOOT_KEY,
    queryFn: async () => {
      const getConfig = bridge.has('app.getConfig');
      if (getConfig === null) throw new Error('app.getConfig is not supported');
      const [, result, { parseClaimConfig }] = await Promise.all([
        tokens.getToken({ forWrite: false }),
        bridge.call(getConfig, { keys: CONFIG_KEYS }),
        import('./config.ts'),
      ]);
      return parseClaimConfig(result.values);
    },
    // 永不过期，且逐项关掉自动重取（不依赖共享 QueryClient 的默认值）：失败（含 10405）后没有数据也算过期，
    // 重挂、回前台、断网恢复都不得再取令牌或配置；没有定时重取，失败只由用户点重试。
    staleTime: Infinity,
    retry: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    refetchInterval: false,
    refetchIntervalInBackground: false,
  });

  const [tab, setTab] = useState<Tab>('apply');
  const [target, setTarget] = useState<LocateTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(preloadTabs, []);

  const ids = { apply: useId(), records: useId(), applyPanel: useId(), recordsPanel: useId() };

  function select(next: Tab): void {
    if (next === tab) return;
    setTab(next);
    setTarget(null);
    setNotice(null);
  }

  function showRecords(next: LocateTarget, message: string | null): void {
    void queryClient.invalidateQueries({ queryKey: RECORDS_KEY, refetchType: 'none' });
    setTarget(next);
    setNotice(message);
    setTab('records');
  }

  // 切换账号前提交、切换后才返回的结果：旧表单已随页面树卸载，不再回调（见 ClaimForm 的 alive）。
  function onCreated(claim: Claim): void {
    showRecords({ claimId: claim.claim_id }, null);
  }

  function onDuplicate(platform: ClaimPlatform, orderNo: string, message: string): void {
    showRecords({ platform, orderNo }, message);
  }

  const config = boot.data;
  if (config === undefined && boot.isError && !boot.isFetching) {
    return <RetryPage onRetry={() => void boot.refetch()} />;
  }
  if (config === undefined) {
    return (
      <Page>
        <FormSkeleton />
      </Page>
    );
  }

  const tabs: { key: Tab; id: string; panel: string; label: string }[] = [
    { key: 'apply', id: ids.apply, panel: ids.applyPanel, label: findOrderTexts.tabApply },
    { key: 'records', id: ids.records, panel: ids.recordsPanel, label: findOrderTexts.tabRecords },
  ];

  return (
    <Page>
      <Tabs
        aria-label={findOrderTexts.tabsLabel}
        items={tabs.map((item) => ({
          value: item.key,
          label: item.label,
          id: item.id,
          panelId: item.panel,
        }))}
        value={tab}
        onChange={(value) => {
          const next = tabs.find((item) => item.key === value);
          if (next !== undefined) select(next.key);
        }}
      />
      <section
        id={ids.applyPanel}
        role="tabpanel"
        aria-labelledby={ids.apply}
        hidden={tab !== 'apply'}
        className={`flex flex-1 flex-col ${CONTENT_FADE}`}
      >
        <Suspense fallback={<FormSkeleton />}>
          {/* 表单块晚于面板到达时，骨架换成的是这层新挂载的容器，由它自己淡入。 */}
          <div className={`flex flex-1 flex-col ${CONTENT_FADE}`}>
            <ClaimForm
              bridge={bridge}
              config={config}
              onCreated={onCreated}
              onDuplicate={onDuplicate}
            />
          </div>
        </Suspense>
      </section>
      {tab === 'records' ? (
        <section
          id={ids.recordsPanel}
          role="tabpanel"
          aria-labelledby={ids.records}
          className={`flex flex-1 flex-col pb-couli-6 ${CONTENT_FADE}`}
        >
          <Suspense fallback={<RecordsFallback />}>
            <ClaimRecords
              api={api}
              target={target}
              notice={notice}
              onLocated={() => setTarget(null)}
            />
          </Suspense>
        </section>
      ) : null}
    </Page>
  );
}
