// 「AI 举报」页签：GET /admin/v1/agent-traces/reports（状态 / 只看超时 / 举报时间 from–to 一次提交，
// 回第一页；行按服务端顺序，不在页面重排）。行显示会话、用户（null 为访客）、举报时间、理由、状态、
// 截止时间与处理记录（北京时间）；超时标识只看行里的 overdue，不用本机时钟另算。【标记已处理】只给
// agent.report、只在待处理行（超时与否）：POST …/reports/{message_id}/handle，请求体只有 note（去首尾
// 空白）与 expected_row_version（行上的 row_version）；20902 说明已被处理或已变化并刷新列表。
import { ReloadOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Flex,
  Form,
  Input,
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
import { plannedButtonProps } from '../../components/planned/index.ts';
import { agentTracesTexts } from '../../texts/agent-traces.ts';
import { delayedLoading, useLoadingClock } from '../../motion.ts';
import { HandleModal } from './HandleModal.tsx';
import {
  EMPTY_REPORT_DRAFT,
  PAGE_SIZE,
  REPORTS_URL,
  REPORT_STATUSES,
  beijingTime,
  checkReportDraft,
  codeOf,
  handleUrl,
  listQuery,
  rejectedFields,
  type HandleBody,
  type Report,
  type ReportDraft,
  type ReportFilters,
  type ReportPage,
  type ReportStatus,
  type WindowErrors,
} from './model.ts';

const t = agentTracesTexts.reports;
const f = agentTracesTexts.filter;
const d = agentTracesTexts.handleDialog;

type ListStatus = 'loading' | 'ready' | 'failed' | 'invalid' | 'forbidden';

interface ListData {
  readonly items: readonly Report[];
  readonly total: number;
}

type Notice = { readonly type: 'success' | 'warning' | 'error'; readonly text: string };

/** One handle dialog for one pending report (its row_version as the row showed it). */
interface HandleFlow {
  readonly report: Report;
  readonly sending: boolean;
  readonly fieldError?: string;
  readonly error?: string;
}

export interface ReportsTabProps {
  readonly initialOverdue: boolean;
  /** The account holds agent.report. */
  readonly canHandle: boolean;
  readonly handlePlanned: boolean;
  readonly tracePlanned: boolean;
  readonly onOpenTrace: (sessionId: string) => void;
}

const code = { wordBreak: 'break-all' } as const;
const timeStyle = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;

function windowMessage(kind: 'format' | 'range' | undefined): string | undefined {
  if (kind === undefined) return undefined;
  return kind === 'format' ? f.timeInvalid : f.timeRange;
}

export function ReportsTab({
  initialOverdue,
  canHandle,
  handlePlanned,
  tracePlanned,
  onOpenTrace,
}: ReportsTabProps): ReactElement {
  const loadingClock = useLoadingClock();
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const ids = { status: useId(), from: useId(), to: useId() };
  const startDraft: ReportDraft = { ...EMPTY_REPORT_DRAFT, overdue: initialOverdue };
  const [draft, setDraft] = useState<ReportDraft>(startDraft);
  const [windowErrors, setWindowErrors] = useState<WindowErrors>({});
  const [serverInvalid, setServerInvalid] = useState(false);
  const [filters, setFilters] = useState<ReportFilters>(initialOverdue ? { overdue: 'true' } : {});
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [data, setData] = useState<ListData>();
  const [flow, setFlow] = useState<HandleFlow>();
  const [notice, setNotice] = useState<Notice>();
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The list: page `page` under the applied `filters`; `attempt` reads the same again.
  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<ReportPage>({ url: REPORTS_URL, method: 'get', query: listQuery(filters, page) }).then(
      (response) => {
        if (!current) return;
        setData({ items: response.data.items, total: response.data.total });
        setStatus('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        // A failed read never keeps the rows of an earlier answer on screen.
        setData(undefined);
        const code = codeOf(cause);
        if (code === 10403) {
          setStatus('forbidden');
        } else if (code === 20001) {
          const fields = rejectedFields(cause);
          if (fields.includes('from') || fields.includes('to'))
            setWindowErrors({
              ...(fields.includes('from') ? { from: 'range' as const } : {}),
              ...(fields.includes('to') ? { to: 'range' as const } : {}),
            });
          setServerInvalid(true);
          setStatus('invalid');
        } else {
          setStatus('failed');
        }
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, filters, page, attempt]);

  const reload = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  const runQuery = () => {
    const checked = checkReportDraft(draft);
    if ('errors' in checked) {
      setWindowErrors(checked.errors);
      return;
    }
    setWindowErrors({});
    setServerInvalid(false);
    setNotice(undefined);
    setFilters(checked.filters);
    setPage(1);
    reload();
  };

  const reset = () => {
    setDraft(EMPTY_REPORT_DRAFT);
    setWindowErrors({});
    setServerInvalid(false);
    setNotice(undefined);
    setFilters({});
    setPage(1);
    reload();
  };

  const changePage = (pagination: TablePaginationConfig) => {
    if (pagination.current === undefined || pagination.current === page) return;
    setStatus('loading');
    setPage(pagination.current);
  };

  const submitHandle = async (note: string) => {
    if (flow === undefined || flow.sending) return;
    const { report } = flow;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    setFlow({ report, sending: true });
    const payload: HandleBody = { note, expected_row_version: report.row_version };
    try {
      const response = await custom<Report>({
        url: handleUrl(report.message_id),
        method: 'post',
        payload,
      });
      if (!alive.current) return;
      const updated = response.data;
      setFlow(undefined);
      setData((previous) =>
        previous === undefined
          ? previous
          : {
              ...previous,
              items: previous.items.map((row) =>
                row.message_id === updated.message_id ? updated : row,
              ),
            },
      );
      setNotice({ type: 'success', text: t.handled });
    } catch (cause) {
      if (!alive.current) return;
      const failed = codeOf(cause);
      if (failed === 20902) {
        // Handled by someone else, or changed meanwhile: the list shows the server's state again.
        setFlow(undefined);
        setNotice({ type: 'warning', text: t.conflict });
        reload();
        return;
      }
      if (failed === 20001) {
        const fields = rejectedFields(cause);
        if (fields.length === 0 || fields.includes('note')) {
          setFlow({ report, sending: false, fieldError: d.serverInvalid });
        } else {
          setFlow({ report, sending: false, error: d.missing });
        }
        return;
      }
      setFlow({ report, sending: false, error: failed === 10403 ? d.forbidden : d.failed });
    }
  };

  const statusTag = (value: ReportStatus) => (
    <Tag color={value === 'pending' ? 'processing' : 'default'}>{t.statuses[value]}</Tag>
  );

  const columns: TableColumnsType<Report> = [
    {
      key: 'session',
      title: t.columns.session,
      render: (_, row) => <span style={code}>{row.session_id}</span>,
    },
    {
      key: 'user',
      title: t.columns.user,
      render: (_, row) =>
        row.user_id === null ? (
          <Typography.Text type="secondary">{agentTracesTexts.guest}</Typography.Text>
        ) : (
          <span style={code}>{row.user_id}</span>
        ),
    },
    {
      key: 'reported',
      title: t.columns.reportedAt,
      render: (_, row) => <span style={timeStyle}>{beijingTime(row.reported_at)}</span>,
    },
    {
      key: 'reason',
      title: t.columns.reason,
      render: (_, row) =>
        row.report_reason === null ? (
          <Typography.Text type="secondary">{t.reasonMissing}</Typography.Text>
        ) : (
          <span style={{ wordBreak: 'break-word' }}>{row.report_reason}</span>
        ),
    },
    {
      key: 'status',
      title: t.columns.status,
      render: (_, row) => (
        <Flex gap={4} wrap={false} align="center">
          {statusTag(row.report_status)}
          {row.overdue ? (
            <Tag color="error" title={t.overdueHint} style={{ marginInlineEnd: 0 }}>
              {t.overdue}
            </Tag>
          ) : null}
        </Flex>
      ),
    },
    {
      key: 'deadline',
      title: t.columns.deadlineAt,
      render: (_, row) => <span style={timeStyle}>{beijingTime(row.deadline_at)}</span>,
    },
    {
      key: 'handled',
      title: t.columns.handled,
      render: (_, row) =>
        row.report_status !== 'handled' ? (
          <span>{agentTracesTexts.dash}</span>
        ) : (
          <Flex vertical gap={2}>
            {row.handled_at === null ? null : (
              <span style={timeStyle}>{t.handledAt(beijingTime(row.handled_at))}</span>
            )}
            <span>{t.handledBy(row.handler_name ?? t.handlerMissing)}</span>
            {row.report_note === null ? null : (
              <span style={{ wordBreak: 'break-word' }}>{row.report_note}</span>
            )}
          </Flex>
        ),
    },
    {
      key: 'actions',
      title: t.columns.actions,
      render: (_, row) => (
        <Flex gap={8} wrap={false}>
          <Button
            type="link"
            size="small"
            style={{ paddingInline: 0 }}
            {...plannedButtonProps(tracePlanned)}
            onClick={() => onOpenTrace(row.session_id)}
          >
            {t.openTrace}
          </Button>
          {canHandle && row.report_status === 'pending' ? (
            <Button
              type="link"
              size="small"
              style={{ paddingInline: 0 }}
              {...plannedButtonProps(handlePlanned)}
              onClick={() => {
                setNotice(undefined);
                setFlow({ report: row, sending: false });
              }}
            >
              {t.handle}
            </Button>
          ) : null}
        </Flex>
      ),
    },
  ];

  const loadingLine =
    status === 'loading' ? (
      <Flex
        align="center"
        gap={8}
        style={{
          padding: `${token.paddingSM}px ${token.padding}px`,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Typography.Text type="secondary" role="status">
          {t.loading}
        </Typography.Text>
      </Flex>
    ) : null;

  let body: ReactElement;
  if (status === 'forbidden') {
    body = (
      <Card>
        <Result
          status="403"
          title={agentTracesTexts.forbiddenTitle}
          subTitle={agentTracesTexts.forbiddenDescription}
        />
      </Card>
    );
  } else if (status === 'invalid') {
    body = (
      <Card>
        <Result
          status="warning"
          title={agentTracesTexts.invalidTitle}
          subTitle={agentTracesTexts.invalidDescription}
        />
      </Card>
    );
  } else if (status === 'failed') {
    body = (
      <Card>
        <Result
          status="error"
          title={t.loadFailedTitle}
          subTitle={agentTracesTexts.loadFailedDescription}
          extra={
            <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={reload}>
              {agentTracesTexts.retryLoad}
            </Button>
          }
        />
      </Card>
    );
  } else if (data === undefined) {
    body = <Card styles={{ body: { padding: 0 } }}>{loadingLine}</Card>;
  } else {
    body = (
      <Card styles={{ body: { padding: 0 } }}>
        {loadingLine}
        <Table<Report>
          rowKey="message_id"
          columns={columns}
          dataSource={data.items as Report[]}
          loading={delayedLoading(status === 'loading', loadingClock)}
          scroll={{ x: 'max-content' }}
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
            current: page,
            pageSize: PAGE_SIZE,
            total: data.total,
            showSizeChanger: false,
            showTotal: (total) => agentTracesTexts.total(total),
            style: { paddingInline: token.padding },
          }}
          onChange={changePage}
        />
      </Card>
    );
  }

  const timeItem = (which: 'from' | 'to') => {
    const message = windowMessage(windowErrors[which]);
    return (
      <Form.Item
        label={which === 'from' ? t.filter.from : t.filter.to}
        htmlFor={ids[which]}
        validateStatus={message === undefined ? '' : 'error'}
        help={message}
        style={{ marginBottom: 0 }}
      >
        <Input
          id={ids[which]}
          value={draft[which]}
          placeholder={f.timePlaceholder}
          aria-invalid={message === undefined ? undefined : true}
          style={{ width: 200 }}
          onChange={(event) => {
            const value = event.target.value;
            setDraft((previous) => ({ ...previous, [which]: value }));
          }}
        />
      </Form.Item>
    );
  };

  return (
    <Flex vertical gap={16}>
      <Card>
        <Form layout="vertical" component="div">
          <Flex wrap gap={16} align="flex-start">
            <Form.Item label={t.filter.status} htmlFor={ids.status} style={{ marginBottom: 0 }}>
              <Select<ReportStatus>
                id={ids.status}
                value={draft.status ?? null}
                allowClear
                virtual={false}
                placeholder={f.all}
                style={{ width: 140 }}
                options={REPORT_STATUSES.map((value) => ({
                  value,
                  label: t.statuses[value],
                }))}
                onChange={(value: ReportStatus | null | undefined) =>
                  setDraft((previous) => ({ ...previous, status: value ?? undefined }))
                }
              />
            </Form.Item>
            {timeItem('from')}
            {timeItem('to')}
            <Form.Item label=" " style={{ marginBottom: 0 }}>
              <Flex gap={16} align="center">
                <Checkbox
                  checked={draft.overdue}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setDraft((previous) => ({ ...previous, overdue: checked }));
                  }}
                >
                  {t.filter.overdue}
                </Checkbox>
                <Flex gap={8}>
                  <Button onClick={reset}>{f.reset}</Button>
                  <Button type="primary" onClick={runQuery}>
                    {f.query}
                  </Button>
                </Flex>
              </Flex>
            </Form.Item>
          </Flex>
        </Form>
        {serverInvalid ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: token.marginSM }}
            message={f.serverInvalid}
          />
        ) : null}
      </Card>
      <Alert type="info" role="note" message={t.listNote} />
      {notice === undefined ? null : (
        <Alert
          type={notice.type}
          showIcon
          closable
          role="alert"
          message={notice.text}
          onClose={() => setNotice(undefined)}
        />
      )}
      {body}
      {flow === undefined ? null : (
        <HandleModal
          report={flow.report}
          sending={flow.sending}
          fieldError={flow.fieldError}
          error={flow.error}
          onCancel={() => {
            if (!flow.sending) setFlow(undefined);
          }}
          onSubmit={(note) => void submitHandle(note)}
        />
      )}
    </Flex>
  );
}
