// 「会话留痕」页签：GET /admin/v1/agent-traces/sessions（user_id / session_id / badcase / reported /
// 开始时间 from–to 以 AND 一次提交，回第一页；页码分页带着当前筛选）。行显示会话、用户（null 为访客）、
// 开始 / 最近活跃（北京时间）、是否过期与 run / badcase / 举报数，不显示对话文本；【查看留痕】由页面
// 读明细（每次打开一次）。
import { ReloadOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
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
import { useEffect, useId, useState, type ReactElement } from 'react';
import { plannedButtonProps } from '../../components/planned/index.ts';
import { agentTracesTexts } from '../../texts/agent-traces.ts';
import { delayedLoading, useLoadingClock } from '../../motion.ts';
import {
  EMPTY_SESSION_DRAFT,
  PAGE_SIZE,
  SESSIONS_URL,
  beijingTime,
  checkSessionDraft,
  codeOf,
  listQuery,
  rejectedFields,
  type Flag,
  type SessionDraft,
  type SessionFilters,
  type SessionItem,
  type SessionPage,
  type WindowErrors,
} from './model.ts';

const t = agentTracesTexts.sessions;
const f = agentTracesTexts.filter;

type ListStatus = 'loading' | 'ready' | 'failed' | 'invalid' | 'forbidden';

interface ListData {
  readonly items: readonly SessionItem[];
  readonly total: number;
}

export interface SessionsTabProps {
  readonly tracePlanned: boolean;
  readonly onOpenTrace: (sessionId: string) => void;
}

const code = { wordBreak: 'break-all' } as const;
const numberStyle = { whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } as const;

function windowMessage(kind: 'format' | 'range' | undefined): string | undefined {
  if (kind === undefined) return undefined;
  return kind === 'format' ? f.timeInvalid : f.timeRange;
}

export function SessionsTab({ tracePlanned, onOpenTrace }: SessionsTabProps): ReactElement {
  const loadingClock = useLoadingClock();
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const ids = {
    user: useId(),
    session: useId(),
    badcase: useId(),
    reported: useId(),
    from: useId(),
    to: useId(),
  };
  const [draft, setDraft] = useState<SessionDraft>(EMPTY_SESSION_DRAFT);
  const [windowErrors, setWindowErrors] = useState<WindowErrors>({});
  const [serverInvalid, setServerInvalid] = useState(false);
  const [filters, setFilters] = useState<SessionFilters>({});
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [data, setData] = useState<ListData>();

  // The list: page `page` under the applied `filters`; `attempt` reads the same again.
  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<SessionPage>({ url: SESSIONS_URL, method: 'get', query: listQuery(filters, page) }).then(
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
    const checked = checkSessionDraft(draft);
    if ('errors' in checked) {
      setWindowErrors(checked.errors);
      return;
    }
    setWindowErrors({});
    setServerInvalid(false);
    setFilters(checked.filters);
    setPage(1);
    reload();
  };

  const reset = () => {
    setDraft(EMPTY_SESSION_DRAFT);
    setWindowErrors({});
    setServerInvalid(false);
    setFilters({});
    setPage(1);
    reload();
  };

  const changePage = (pagination: TablePaginationConfig) => {
    if (pagination.current === undefined || pagination.current === page) return;
    setStatus('loading');
    setPage(pagination.current);
  };

  const columns: TableColumnsType<SessionItem> = [
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
      key: 'started',
      title: t.columns.startedAt,
      render: (_, row) => <span style={numberStyle}>{beijingTime(row.started_at)}</span>,
    },
    {
      key: 'active',
      title: t.columns.lastActiveAt,
      render: (_, row) => <span style={numberStyle}>{beijingTime(row.last_active_at)}</span>,
    },
    {
      key: 'expired',
      title: t.columns.expired,
      render: (_, row) =>
        row.expired ? <Tag>{t.expired}</Tag> : <Tag color="processing">{t.live}</Tag>,
    },
    {
      key: 'runs',
      title: t.columns.runs,
      align: 'right',
      render: (_, row) => <span style={numberStyle}>{row.run_count}</span>,
    },
    {
      key: 'badcase',
      title: t.columns.badcase,
      align: 'right',
      render: (_, row) => <span style={numberStyle}>{row.badcase_count}</span>,
    },
    {
      key: 'reports',
      title: t.columns.reports,
      align: 'right',
      render: (_, row) => <span style={numberStyle}>{row.report_count}</span>,
    },
    {
      key: 'actions',
      title: t.columns.actions,
      render: (_, row) => (
        <Button
          type="link"
          size="small"
          style={{ paddingInline: 0 }}
          {...plannedButtonProps(tracePlanned)}
          onClick={() => onOpenTrace(row.session_id)}
        >
          {t.openTrace}
        </Button>
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
        <Table<SessionItem>
          rowKey="session_id"
          columns={columns}
          dataSource={data.items as SessionItem[]}
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

  const flagOptions = [
    { value: 'true', label: t.filter.yes },
    { value: 'false', label: t.filter.no },
  ];

  const flagItem = (which: 'badcase' | 'reported') => (
    <Form.Item
      label={which === 'badcase' ? t.filter.badcase : t.filter.reported}
      htmlFor={ids[which]}
      style={{ marginBottom: 0 }}
    >
      <Select<Exclude<Flag, undefined>>
        id={ids[which]}
        value={draft[which] ?? null}
        allowClear
        virtual={false}
        placeholder={f.all}
        style={{ width: 120 }}
        options={flagOptions}
        onChange={(value: Flag | null) =>
          setDraft((previous) => ({ ...previous, [which]: value ?? undefined }))
        }
      />
    </Form.Item>
  );

  const textItem = (which: 'user' | 'session') => (
    <Form.Item
      label={which === 'user' ? t.filter.user : t.filter.session}
      htmlFor={ids[which]}
      style={{ marginBottom: 0 }}
    >
      <Input
        id={ids[which]}
        value={draft[which]}
        style={{ width: 300 }}
        onChange={(event) => {
          const value = event.target.value;
          setDraft((previous) => ({ ...previous, [which]: value }));
        }}
      />
    </Form.Item>
  );

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
            {textItem('user')}
            {textItem('session')}
            {flagItem('badcase')}
            {flagItem('reported')}
            {timeItem('from')}
            {timeItem('to')}
            <Form.Item label=" " style={{ marginBottom: 0 }}>
              <Flex gap={8}>
                <Button onClick={reset}>{f.reset}</Button>
                <Button type="primary" onClick={runQuery}>
                  {f.query}
                </Button>
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
      {body}
    </Flex>
  );
}
