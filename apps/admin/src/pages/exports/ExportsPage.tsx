// Export tasks (导出记录, 04 §6.6 exports, BR-ID-34 细则「后台导出任务」, F1-10j): GET
// /admin/v1/exports page by page, optionally by status. Rows never carry a link: 【下载】 (done and
// not yet past expires_at) asks GET …/{id}/download for a freshly signed link on every click and
// opens it (never cached, the file is never fetched here); 【重试】 (failed only) sends POST
// …/{id}/retry, for an unmasked task after a new reason and a totp step-up. 30417 means the task
// moved on meanwhile: the current status is told and the list read again. Without the `export`
// point the page says so and sends nothing.
import type { Schema } from '@couli/contracts-ts';
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Empty,
  Flex,
  Form,
  Result,
  Select,
  Table,
  Tag,
  Typography,
  theme,
  type TableColumnsType,
  type TablePaginationConfig,
} from 'antd';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { StepUpModal, type StepUpResult } from '../../components/step-up/index.ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { exportsTexts as t } from '../../texts/exports.ts';
import {
  PAGE_SIZE,
  STATUSES,
  beijingTime,
  nextExpiry,
  rejectedStatus,
  resourceLabel,
  shownStatus,
  statusLabel,
  statusTagColor,
  type ExportRow,
  type ExportStatus,
} from './model.ts';
import { ReasonModal } from './ReasonModal.tsx';
import { delayedLoading, useLoadingClock } from '../../motion.ts';

const EXPORTS_URL = '/admin/v1/exports';
const STEP_UP_URL = '/admin/v1/auth/step-up';

type StatusFilter = ExportStatus | 'all';

interface ListQuery {
  readonly page: number;
  readonly status: StatusFilter;
}

type ListStatus = 'loading' | 'ready' | 'failed' | 'forbidden';

interface ListData {
  readonly items: readonly ExportRow[];
  readonly total: number;
}

/** Time source of the page (AGENTS.md §4 rule 5): the console's injected clock, in epoch ms. */
export interface ExportsClock {
  now(): number;
}

const SYSTEM_CLOCK: ExportsClock = { now: () => Date.now() };

/** setTimeout keeps a 32-bit delay; a later expiry is checked again after this long. */
const MAX_TIMER_MS = 2_147_483_647;

type Notice = { readonly type: 'success' | 'error'; readonly text: string };

/** Unmasked retry under way: reason first, then the totp step-up, then one POST. */
type RetryFlow =
  | { readonly phase: 'idle' }
  | { readonly phase: 'reason'; readonly id: string }
  | {
      readonly phase: 'verify';
      readonly id: string;
      readonly reason: string;
      readonly again: boolean;
    };

const IDLE: RetryFlow = { phase: 'idle' };

export interface ExportsPageProps {
  readonly access: AccessControl;
  /** Injected clock (App options); expiry is judged against it at render and before a download. */
  readonly clock?: ExportsClock | undefined;
}

export function ExportsPage({ access, clock = SYSTEM_CLOCK }: ExportsPageProps): ReactElement {
  if (!access.can('export')) {
    return (
      <Flex vertical gap={16}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t.title}
        </Typography.Title>
        <Card>
          <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
        </Card>
      </Flex>
    );
  }
  return <ExportsContent clock={clock} />;
}

function ExportsContent({ clock }: { readonly clock: ExportsClock }): ReactElement {
  const loadingClock = useLoadingClock();
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const statusId = useId();
  const [query, setQuery] = useState<ListQuery>({ page: 1, status: 'all' });
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [data, setData] = useState<ListData>();
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusyState] = useState<ReadonlySet<string>>(new Set());
  const [flow, setFlowState] = useState<RetryFlow>(IDLE);
  const busyRef = useRef(new Set<string>());
  const flowRef = useRef<RetryFlow>(IDLE);
  const alive = useRef(true);
  // Bumped when the earliest expires_at comes: the rows are judged again against the clock.
  const [expiryTick, setExpiryTick] = useState(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const setFlow = (next: RetryFlow) => {
    flowRef.current = next;
    setFlowState(next);
  };

  const flowOwnedBy = (id: string): boolean => {
    const current = flowRef.current;
    return current.phase !== 'idle' && current.id === id;
  };

  /** Closes the dialog of `id` only: one task's answer never touches another task's dialog. */
  const endFlowOf = (id: string) => {
    if (flowOwnedBy(id)) setFlow(IDLE);
  };

  const claim = (id: string): boolean => {
    if (busyRef.current.has(id)) return false;
    busyRef.current.add(id);
    setBusyState(new Set(busyRef.current));
    return true;
  };

  const release = (id: string) => {
    busyRef.current.delete(id);
    if (alive.current) setBusyState(new Set(busyRef.current));
  };

  const customOf = () => {
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    return custom;
  };

  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<Schema<'AdminExportPage'>>({
      url: EXPORTS_URL,
      method: 'get',
      query: {
        page: query.page,
        page_size: PAGE_SIZE,
        ...(query.status === 'all' ? {} : { status: query.status }),
      },
    }).then(
      (response) => {
        if (!current) return;
        setData({ items: response.data.items, total: response.data.total });
        setStatus('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        // A failed read never keeps the rows of an earlier answer on screen.
        setData(undefined);
        setStatus(cause instanceof AdminApiError && cause.code === 10403 ? 'forbidden' : 'failed');
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, query, attempt]);

  // Judged at every render against the injected clock (never frozen at the time of the read).
  const now = clock.now();

  // A done row turns 已过期 (and loses 【下载】) once its expires_at comes, without a new read.
  // The next expiry is picked against the time this render judged the rows at, not the time the
  // effect runs: the clock may pass an expires_at between the commit and the effect, and that row
  // (still shown as 已完成) must then be judged again at once instead of never.
  useEffect(() => {
    if (data === undefined) return;
    const next = nextExpiry(data.items, now);
    if (next === undefined) return;
    const timer = setTimeout(
      () => setExpiryTick((value) => value + 1),
      Math.min(Math.max(next - clock.now(), 0), MAX_TIMER_MS),
    );
    return () => clearTimeout(timer);
  }, [data, clock, now, expiryTick]);

  const reload = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  const changeStatus = (next: StatusFilter) => {
    if (next === query.status) return;
    setStatus('loading');
    setQuery({ page: 1, status: next });
  };

  const changePage = (pagination: TablePaginationConfig) => {
    if (pagination.current === undefined || pagination.current === query.page) return;
    setStatus('loading');
    setQuery({ ...query, page: pagination.current });
  };

  /** 30417: tell the task's current status and read the list again (never resend). */
  const handleRejected = (cause: unknown): boolean => {
    if (!(cause instanceof AdminApiError) || cause.code !== 30417) return false;
    const current = rejectedStatus(cause.data);
    setNotice({
      type: 'error',
      text: t.statusChanged(current === undefined ? t.dash : statusLabel(current)),
    });
    reload();
    return true;
  };

  const download = async (row: ExportRow) => {
    // Judged again at the click: a task that expired since the last render is never requested.
    if (shownStatus(row, clock.now()) !== 'done') {
      setNotice({ type: 'error', text: t.downloadExpired });
      reload();
      return;
    }
    if (!claim(row.id)) return;
    setNotice(undefined);
    try {
      const response = await customOf()<Schema<'AdminExportDownload'>>({
        url: `${EXPORTS_URL}/${encodeURIComponent(row.id)}/download`,
        method: 'get',
      });
      if (!alive.current) return;
      // A new short-lived link per click; opened, never stored.
      window.open(response.data.url, '_blank', 'noopener,noreferrer');
    } catch (cause) {
      if (!alive.current || handleRejected(cause)) return;
      let text: string = t.downloadFailed;
      if (cause instanceof AdminApiError && cause.code === 10403) text = t.downloadForbidden;
      else if (cause instanceof AdminApiError && cause.code === 20001) text = t.downloadMissing;
      setNotice({ type: 'error', text });
    } finally {
      release(row.id);
    }
  };

  const sendRetry = async (id: string, reason?: string, stepUpToken?: string) => {
    const payload: Schema<'AdminExportRetryRequest'> = reason === undefined ? {} : { reason };
    try {
      const response = await customOf()<ExportRow>({
        url: `${EXPORTS_URL}/${encodeURIComponent(id)}/retry`,
        method: 'post',
        payload,
        ...(stepUpToken === undefined ? {} : { meta: { stepUpToken } }),
      });
      if (!alive.current) return;
      const task = response.data;
      setData((previous) =>
        previous === undefined
          ? previous
          : {
              ...previous,
              items: previous.items.map((item) => (item.id === task.id ? task : item)),
            },
      );
      setNotice({ type: 'success', text: t.retried });
      endFlowOf(id);
    } catch (cause) {
      if (!alive.current) return;
      let text: string = t.retryFailed;
      if (
        stepUpToken !== undefined &&
        reason !== undefined &&
        cause instanceof AdminApiError &&
        cause.code === 10003
      ) {
        if (flowRef.current.phase === 'idle') {
          // The token was not accepted: verify again (never resend the old token).
          setFlow({ phase: 'verify', id, reason, again: true });
          return;
        }
        // Another task's dialog is open meanwhile: it is left alone; this retry starts over.
        text = t.retryVerifyAgain;
      } else {
        endFlowOf(id);
        if (handleRejected(cause)) return;
        if (cause instanceof AdminApiError && cause.code === 10403) text = t.retryForbidden;
        else if (cause instanceof AdminApiError && cause.code === 20001) text = t.retryMissing;
      }
      setNotice({ type: 'error', text });
    } finally {
      // The row stays busy only while its own dialog is open (verify again).
      if (!flowOwnedBy(id)) release(id);
    }
  };

  const retry = (row: ExportRow) => {
    if (!claim(row.id)) return;
    setNotice(undefined);
    if (row.masked) {
      void sendRetry(row.id);
      return;
    }
    setFlow({ phase: 'reason', id: row.id });
  };

  const cancelFlow = () => {
    const current = flowRef.current;
    if (current.phase === 'idle') return;
    setFlow(IDLE);
    release(current.id);
  };

  const verifyCode = async (code: string): Promise<StepUpResult> => {
    const request: Schema<'AdminStepUpRequest'> = { tier: 'totp', code };
    try {
      const response = await customOf()<Schema<'AdminStepUpResponse'>['data']>({
        url: STEP_UP_URL,
        method: 'post',
        payload: request,
      });
      return { ok: true, stepUpToken: response.data.step_up_token };
    } catch (cause) {
      if (cause instanceof AdminApiError)
        return cause.retryAfterSeconds === undefined
          ? { ok: false, code: cause.code }
          : { ok: false, code: cause.code, retryAfterSeconds: cause.retryAfterSeconds };
      return { ok: false, code: 0 };
    }
  };

  const onVerified = (stepUpToken: string) => {
    const current = flowRef.current;
    if (current.phase !== 'verify') return;
    // Leaves the dialog; the row stays busy until the answer.
    flowRef.current = { phase: 'idle' };
    setFlowState(IDLE);
    void sendRetry(current.id, current.reason, stepUpToken);
  };

  const code = { fontFamily: token.fontFamilyCode } as const;
  const secondary = { fontSize: token.fontSizeSM, color: token.colorTextSecondary } as const;

  const columns: TableColumnsType<ExportRow> = [
    {
      key: 'id',
      title: t.columns.id,
      render: (_, row) => <span style={{ ...code, wordBreak: 'break-all' }}>{row.id}</span>,
    },
    {
      key: 'resource',
      title: t.columns.resource,
      width: 110,
      render: (_, row) => resourceLabel(row.resource),
    },
    {
      key: 'filters',
      title: t.columns.filters,
      render: (_, row) => (
        <Flex vertical gap={4} align="flex-start">
          <span>{row.filters_summary}</span>
          {row.masked ? null : <Tag style={{ marginInlineEnd: 0 }}>{t.unmasked}</Tag>}
        </Flex>
      ),
    },
    {
      key: 'status',
      title: t.columns.status,
      render: (_, row) => {
        const shown = shownStatus(row, now);
        return (
          <Flex vertical gap={4} align="flex-start">
            <Tag color={statusTagColor(shown)} style={{ marginInlineEnd: 0 }}>
              {statusLabel(shown)}
            </Tag>
            {shown === 'running' && row.progress !== null ? (
              <span style={secondary}>{t.progress(row.progress)}</span>
            ) : null}
            {shown === 'done' && row.row_count !== null ? (
              <span style={secondary}>{t.rows(row.row_count)}</span>
            ) : null}
            {shown === 'failed' && row.failure_reason !== null ? (
              <Typography.Text type="danger" style={{ fontSize: token.fontSizeSM }}>
                {row.failure_reason}
              </Typography.Text>
            ) : null}
          </Flex>
        );
      },
    },
    {
      key: 'createdBy',
      title: t.columns.createdBy,
      render: (_, row) => row.created_by_name ?? t.dash,
    },
    {
      key: 'createdAt',
      title: t.columns.createdAt,
      width: 150,
      render: (_, row) => (
        <span style={{ whiteSpace: 'nowrap' }}>{beijingTime(row.created_at)}</span>
      ),
    },
    {
      key: 'expiresAt',
      title: t.columns.expiresAt,
      width: 150,
      render: (_, row) => (
        <span style={{ whiteSpace: 'nowrap' }}>{beijingTime(row.expires_at)}</span>
      ),
    },
    {
      key: 'actions',
      title: t.columns.actions,
      width: 100,
      render: (_, row) => {
        const shown = shownStatus(row, now);
        const inFlight = busy.has(row.id);
        if (shown === 'done')
          return (
            <Button
              size="small"
              icon={<DownloadOutlined aria-hidden />}
              disabled={inFlight}
              onClick={() => void download(row)}
            >
              {t.download}
            </Button>
          );
        if (shown === 'failed')
          return (
            <Button
              size="small"
              icon={<ReloadOutlined aria-hidden />}
              disabled={inFlight}
              onClick={() => retry(row)}
            >
              {t.retry}
            </Button>
          );
        return t.dash;
      },
    },
  ];

  const loadingLine =
    status === 'loading' ? (
      <Flex
        align="center"
        gap={8}
        style={{ padding: '12px 16px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}
      >
        <Typography.Text type="secondary" role="status">
          {t.loading}
        </Typography.Text>
      </Flex>
    ) : null;

  let body: ReactElement;
  if (status === 'forbidden') {
    body = (
      <Card title={t.listTitle}>
        <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
      </Card>
    );
  } else if (status === 'failed') {
    body = (
      <Card title={t.listTitle}>
        <Result
          status="error"
          title={t.loadFailedTitle}
          subTitle={t.loadFailedDescription}
          extra={
            <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={reload}>
              {t.retryLoad}
            </Button>
          }
        />
      </Card>
    );
  } else if (data === undefined) {
    body = (
      <Card title={t.listTitle} styles={{ body: { padding: 0 } }}>
        {loadingLine}
      </Card>
    );
  } else {
    body = (
      <Card title={t.listTitle} styles={{ body: { padding: 0 } }}>
        {loadingLine}
        <Table<ExportRow>
          rowKey="id"
          columns={columns}
          dataSource={data.items as ExportRow[]}
          loading={delayedLoading(status === 'loading', loadingClock)}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <Flex vertical align="center" gap={4}>
                    <Typography.Text strong>{t.empty}</Typography.Text>
                    <Typography.Text type="secondary">{t.emptyHint}</Typography.Text>
                  </Flex>
                }
              />
            ),
          }}
          pagination={{
            current: query.page,
            pageSize: PAGE_SIZE,
            total: data.total,
            showSizeChanger: false,
            showTotal: (total) => t.total(total),
            style: { paddingInline: 16 },
          }}
          onChange={changePage}
        />
      </Card>
    );
  }

  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t.title}
      </Typography.Title>
      {notice === undefined ? null : (
        <Alert
          type={notice.type}
          showIcon
          closable
          message={notice.text}
          onClose={() => setNotice(undefined)}
        />
      )}
      <Card>
        <Form layout="vertical" component="div">
          <Form.Item label={t.columns.status} htmlFor={statusId} style={{ marginBottom: 0 }}>
            <Select<StatusFilter>
              id={statusId}
              value={query.status}
              onChange={changeStatus}
              style={{ width: 200 }}
              options={[
                { value: 'all', label: t.statusAll },
                ...STATUSES.map((item) => ({ value: item, label: statusLabel(item) })),
              ]}
            />
          </Form.Item>
        </Form>
      </Card>
      {body}
      {flow.phase === 'reason' ? (
        <ReasonModal
          onCancel={cancelFlow}
          onConfirm={(reason) => {
            const current = flowRef.current;
            if (current.phase !== 'reason') return;
            setFlow({ phase: 'verify', id: current.id, reason, again: false });
          }}
        />
      ) : null}
      <StepUpModal
        open={flow.phase === 'verify'}
        tier="totp"
        operation={t.reason.operation}
        details={
          flow.phase === 'verify'
            ? [t.reason.stepUpDetail(flow.id), ...(flow.again ? [t.reason.stepUpAgain] : [])]
            : []
        }
        onSubmit={verifyCode}
        onClose={cancelFlow}
        onVerified={onVerified}
      />
    </Flex>
  );
}
