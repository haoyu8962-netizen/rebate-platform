// Workbench (design-hifi AdmDashboard, AdmDashboardFinance, AdmDashboardStates,
// AdmAdaptDashboard1280; design/specs/admin-dashboard.md; 01 F-ADM-26). One read of GET
// /admin/v1/dashboard through the data provider on entry and on 【刷新】. The server trims the
// answer to the account's permission points: the page draws what comes back (no greyed cards),
// to-do cards with count 0 included, and the system status only when the answer has it. Read
// only; every card is one link to its list page. 10403 (dashboard.view withdrawn) leaves for the
// first other permitted menu.
import './dashboard.css';
import {
  ArrowRightOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useDataProvider, type DataProvider } from '@refinedev/core';
import { Alert, Button, Card, Flex, Result, Skeleton, Statistic, Tag, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { PlannedPage, usePlanned } from '../../components/planned/index.ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { dashboardTexts as t } from '../../texts/dashboard.ts';
import {
  DASHBOARD_URL,
  STATUS_ROUTES,
  beijingYesterday,
  formatCount,
  toView,
  type Dashboard,
  type DashboardStatus,
  type DashboardView,
  type TodoCard,
  type YesterdayView,
} from './model.ts';

/** Time source of the page (AGENTS.md §4 rule 5): the console's injected clock, in epoch ms. */
export interface DashboardClock {
  now(): number;
}

const SYSTEM_CLOCK: DashboardClock = { now: () => Date.now() };

export interface DashboardPageProps {
  readonly access: AccessControl;
  /** Where to go when the server refuses the page (10403): the first other permitted menu. */
  readonly fallback?: string;
  /** Injected clock; tells whether the overview row is yesterday's (+08:00 accounting day). */
  readonly clock?: DashboardClock | undefined;
}

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly view: DashboardView }
  | { readonly status: 'failed' }
  | { readonly status: 'forbidden' };

/** Location state of a card link: the shell shows a placeholder for routes not wired yet. */
export interface DashboardLinkState {
  readonly dashboardTarget: string;
}

/** The placeholder title a card link asked for, if the location came from a card. */
export function dashboardTargetOf(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null || !('dashboardTarget' in state))
    return undefined;
  return typeof state.dashboardTarget === 'string' ? state.dashboardTarget : undefined;
}

// Cards follow the boards: no border, the token shadow (dashboard.css), 20px padding.
const CARD = { variant: 'borderless', styles: { body: { padding: 20 } } } as const;
const VALUE = { fontSize: 28, lineHeight: '35px', fontWeight: 700 } as const;
const TODO_VALUE = { ...VALUE, color: 'var(--color-status-warning-text)' } as const;

function SectionHeading({ title, hint }: { readonly title: string; readonly hint?: string }) {
  return (
    <Flex align="baseline" gap="middle" wrap className="dashboard-section-heading">
      <Typography.Title level={5} className="dashboard-section-title">
        {title}
      </Typography.Title>
      {hint === undefined ? null : (
        <Typography.Text type="secondary" className="dashboard-small">
          {hint}
        </Typography.Text>
      )}
    </Flex>
  );
}

function CardFooter({ destination, permission }: { destination: string; permission: string }) {
  return (
    <Flex justify="space-between" align="center" gap="small" className="dashboard-card-footer">
      <span className="dashboard-enter">
        {t.todo.enter(destination)} <ArrowRightOutlined aria-hidden="true" />
      </span>
      <Typography.Text type="secondary" className="dashboard-code">
        {permission}
      </Typography.Text>
    </Flex>
  );
}

function LinkCard(props: {
  readonly to: string;
  readonly label: string;
  readonly destination: string;
  readonly children: ReactNode;
}) {
  const state: DashboardLinkState = { dashboardTarget: props.destination };
  return (
    <Link to={props.to} state={state} aria-label={props.label} className="dashboard-card-link">
      {/* Whole-card link: hover lifts the card (dashboard.css), beside the :focus-visible ring. */}
      <Card {...CARD} hoverable className="dashboard-card">
        {props.children}
      </Card>
    </Link>
  );
}

function TodoCardView({ card }: { readonly card: TodoCard }) {
  const text = t.todo.cards[card.key];
  const detail = card.detail ?? (card.count === 0 ? t.todo.nothing : undefined);
  return (
    <LinkCard
      to={card.route}
      label={t.todo.linkName(text.title, formatCount(card.count), text.destination)}
      destination={text.destination}
    >
      <Flex vertical gap={4}>
        <Statistic
          title={text.title}
          value={card.count}
          groupSeparator=","
          valueStyle={TODO_VALUE}
        />
        <Typography.Text type="secondary" className="dashboard-small dashboard-detail">
          {detail}
        </Typography.Text>
        <CardFooter destination={text.destination} permission={text.permission} />
      </Flex>
    </LinkCard>
  );
}

function OverviewCard(props: {
  readonly title: string;
  readonly value: number | string;
  readonly hint: string;
}) {
  return (
    <Card {...CARD} className="dashboard-card">
      <Flex vertical gap={4}>
        <Statistic title={props.title} value={props.value} groupSeparator="," valueStyle={VALUE} />
        <Typography.Text type="secondary" className="dashboard-small">
          {props.hint}
        </Typography.Text>
      </Flex>
    </Card>
  );
}

function StatusTag({ ok, children }: { readonly ok: boolean; readonly children: ReactNode }) {
  return (
    <Tag
      bordered={false}
      className={ok ? 'dashboard-tag dashboard-tag-ok' : 'dashboard-tag dashboard-tag-warn'}
      icon={
        ok ? (
          <CheckCircleOutlined aria-hidden="true" />
        ) : (
          <ExclamationCircleOutlined aria-hidden="true" />
        )
      }
    >
      {children}
    </Tag>
  );
}

function StatusCard(props: {
  readonly title: string;
  readonly state: string;
  readonly destination: string;
  readonly to: string;
  readonly tags: ReactNode;
  readonly hint: string;
}) {
  return (
    <LinkCard
      to={props.to}
      label={t.status.linkName(props.title, props.state, props.destination)}
      destination={props.destination}
    >
      <Flex vertical gap={6}>
        <Typography.Text type="secondary">{props.title}</Typography.Text>
        <Flex gap="small" wrap align="center" className="dashboard-tags">
          {props.tags}
        </Flex>
        <Typography.Text type="secondary" className="dashboard-small">
          {props.hint}
        </Typography.Text>
        <CardFooter destination={props.destination} permission={t.status.permission} />
      </Flex>
    </LinkCard>
  );
}

function StatusSection({ status }: { readonly status: DashboardStatus }) {
  const s = t.status;
  const queueState = status.payout_queue_paused ? s.queue.paused : s.queue.running;
  const channels =
    status.payout_channel_paused.length === 0
      ? s.queue.noChannel
      : status.payout_channel_paused
          .map((channel) => s.channelNames[channel] ?? channel)
          .join(s.queue.channelSeparator);
  const balanceState =
    status.balance_w_expired === null
      ? s.balance.unknown
      : status.balance_w_expired
        ? s.balance.expired
        : s.balance.fresh;
  const settleState = status.settle_auto_enabled ? s.settle.enabled : s.settle.disabled;
  return (
    <section className="dashboard-section">
      <SectionHeading title={s.heading} hint={s.hint} />
      <div className="dashboard-grid dashboard-grid-status">
        <StatusCard
          title={s.queue.title}
          state={queueState}
          destination={s.queue.destination}
          to={STATUS_ROUTES.queue}
          hint={s.queue.hint}
          tags={
            <>
              <StatusTag ok={!status.payout_queue_paused}>{queueState}</StatusTag>
              <Tag
                bordered={false}
                className={
                  status.payout_channel_paused.length === 0
                    ? 'dashboard-tag'
                    : 'dashboard-tag dashboard-tag-warn'
                }
              >
                {s.queue.channels(channels)}
              </Tag>
            </>
          }
        />
        <StatusCard
          title={s.balance.title}
          state={balanceState}
          destination={s.balance.destination}
          to={STATUS_ROUTES.balance}
          hint={s.balance.hint}
          tags={
            status.balance_w_expired === null ? (
              <Tag bordered={false} className="dashboard-tag">
                {balanceState}
              </Tag>
            ) : (
              <StatusTag ok={!status.balance_w_expired}>{balanceState}</StatusTag>
            )
          }
        />
        <StatusCard
          title={s.settle.title}
          state={settleState}
          destination={s.settle.destination}
          to={STATUS_ROUTES.settle}
          hint={s.settle.hint}
          tags={<StatusTag ok={status.settle_auto_enabled}>{settleState}</StatusTag>}
        />
      </div>
    </section>
  );
}

function YesterdaySection(props: {
  readonly yesterday: YesterdayView | null;
  /** Yesterday's accounting day by the page clock (`YYYY-MM-DD`). */
  readonly expected: string;
}) {
  const y = props.yesterday;
  if (y === null)
    return (
      <section className="dashboard-section">
        <SectionHeading title={t.yesterday.heading(props.expected)} hint={t.yesterday.hint} />
        <Typography.Text type="secondary">{t.yesterday.empty}</Typography.Text>
      </section>
    );
  return (
    <section className="dashboard-section">
      <SectionHeading title={t.yesterday.heading(y.date)} hint={t.yesterday.hint} />
      {y.date < props.expected ? (
        <Typography.Text type="secondary" className="dashboard-small">
          {t.yesterday.asOfDay(y.date)}
        </Typography.Text>
      ) : null}
      <div className="dashboard-grid">
        <OverviewCard
          title={t.yesterday.links(y.day)}
          value={y.links}
          hint={t.yesterday.linksHint}
        />
        <OverviewCard title={t.yesterday.orders} value={y.orders} hint={t.yesterday.ordersHint} />
        <OverviewCard title={t.yesterday.rebate} value={y.rebate} hint={t.yesterday.rebateHint} />
        <OverviewCard
          title={t.yesterday.newUsers}
          value={y.newUsers}
          hint={t.yesterday.newUsersHint}
        />
      </div>
    </section>
  );
}

function Loaded({ view, clock }: { readonly view: DashboardView; readonly clock: DashboardClock }) {
  return (
    <>
      <section className="dashboard-section">
        <SectionHeading title={t.todo.heading} hint={t.todo.hint} />
        {view.todo.length === 0 ? (
          <Typography.Text type="secondary">{t.todo.empty}</Typography.Text>
        ) : (
          <div className="dashboard-grid">
            {view.todo.map((card) => (
              <TodoCardView key={card.key} card={card} />
            ))}
          </div>
        )}
      </section>
      <YesterdaySection yesterday={view.yesterday} expected={beijingYesterday(clock.now())} />
      {view.status === undefined ? null : <StatusSection status={view.status} />}
    </>
  );
}

function LoadingCards() {
  return (
    <section className="dashboard-section">
      <Typography.Text type="secondary" role="status">
        {t.loading}
      </Typography.Text>
      <div className="dashboard-grid">
        {[0, 1, 2, 3].map((index) => (
          <Card key={index} {...CARD} className="dashboard-card">
            <Skeleton active title={false} paragraph={{ rows: 3 }} />
          </Card>
        ))}
      </div>
    </section>
  );
}

/** One read of the workbench through the data provider; rejects on any failure. */
async function fetchDashboard(provider: DataProvider): Promise<DashboardView> {
  const custom = provider.custom;
  if (custom === undefined) throw new Error('Missing custom data provider');
  const response = await custom<Dashboard>({ url: DASHBOARD_URL, method: 'get' });
  return toView(response.data);
}

/** GET /admin/v1/dashboard not live yet (planned): the placeholder, no read (D10-284). */
export function DashboardPage(props: DashboardPageProps): ReactElement {
  const planned = usePlanned('adminGetDashboard');
  return planned ? <PlannedPage title={t.title} /> : <DashboardContent {...props} />;
}

function DashboardContent({
  access,
  fallback = '/',
  clock = SYSTEM_CLOCK,
}: DashboardPageProps): ReactElement {
  void access;
  const getProvider = useDataProvider();
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const sequence = useRef(0);
  const inFlight = useRef(false);

  const read = useCallback((): Promise<void> => {
    const request = ++sequence.current;
    inFlight.current = true;
    return fetchDashboard(getProvider()).then(
      (view) => {
        if (request !== sequence.current) return;
        inFlight.current = false;
        setLoad({ status: 'ready', view });
      },
      (cause: unknown) => {
        if (request !== sequence.current) return;
        inFlight.current = false;
        // A failed read never keeps the old numbers on screen.
        setLoad(
          cause instanceof AdminApiError && cause.code === 10403
            ? { status: 'forbidden' }
            : { status: 'failed' },
        );
      },
    );
  }, [getProvider]);

  useEffect(() => {
    void read();
    return () => {
      sequence.current += 1;
      inFlight.current = false;
    };
  }, [read]);

  // dashboard.view was withdrawn on the server: open the first other permitted menu, once.
  useEffect(() => {
    if (load.status === 'forbidden') void navigate(fallback, { replace: true });
  }, [load.status, fallback, navigate]);

  const again = (clear: boolean) => {
    // One read at a time: clicks while a read is under way send nothing more.
    if (inFlight.current) return;
    if (clear) setLoad({ status: 'loading' });
    void read();
  };

  let body: ReactNode = null;
  if (load.status === 'loading') body = <LoadingCards />;
  else if (load.status === 'ready') body = <Loaded view={load.view} clock={clock} />;
  else if (load.status === 'failed')
    body = (
      <Card {...CARD} className="dashboard-card" role="alert">
        <Result
          status="error"
          icon={<WarningOutlined aria-hidden="true" className="dashboard-failed-icon" />}
          title={t.failedTitle}
          subTitle={t.failedDescription}
          extra={
            <Button
              type="primary"
              icon={<ReloadOutlined aria-hidden="true" />}
              onClick={() => again(true)}
            >
              {t.retry}
            </Button>
          }
        />
      </Card>
    );

  return (
    <Flex vertical gap="middle" className="dashboard-page">
      <Flex justify="space-between" align="center" gap="middle" wrap>
        <Typography.Title level={4} className="admin-page-title dashboard-title">
          {t.title}
        </Typography.Title>
        <Flex align="center" gap="middle">
          <Typography.Text type="secondary" className="dashboard-small">
            {load.status === 'ready' && load.view.yesterday !== null
              ? t.headerNote(load.view.yesterday.asOf)
              : t.readOnly}
          </Typography.Text>
          <Button icon={<ReloadOutlined aria-hidden="true" />} onClick={() => again(false)}>
            {t.refresh}
          </Button>
        </Flex>
      </Flex>
      {body}
      <Alert
        type="info"
        message={t.notice.title}
        description={
          <Flex vertical gap={4}>
            {t.notice.lines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </Flex>
        }
      />
    </Flex>
  );
}
