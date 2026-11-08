// Audit log list (01 F-ADM-03, 04 §6.6 audit-logs, F1-10j): GET /admin/v1/audit-logs page by page
// with the contract's AND filters (blank ones left out). Any signed-in account opens it; which
// records it sees is the server's decision (audit.view_all), so nothing is filtered or injected
// here. With the `export` point the header offers 【导出】 (POST /admin/v1/exports with the filters
// of the last query) and the link to 导出记录. 【查看 <id>】 opens the detail subpage.
import { admin_permission, type Schema } from '@couli/contracts-ts';
import { ExportOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  ConfigProvider,
  Empty,
  Flex,
  Form,
  Input,
  Result,
  Select,
  Table,
  Typography,
  theme,
  type TableColumnsType,
  type TablePaginationConfig,
  type ThemeConfig,
} from 'antd';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { auditLogsTexts as t } from '../../texts/audit-logs.ts';
import {
  EMPTY_DRAFT,
  PAGE_SIZE,
  beijingTime,
  filtersOf,
  type AuditFilters,
  type AuditRow,
  type FilterDraft,
} from './model.ts';
import { delayedLoading, useLoadingClock } from '../../motion.ts';

const LOGS_URL = '/admin/v1/audit-logs';
const EXPORTS_URL = '/admin/v1/exports';

interface ListQuery {
  readonly page: number;
  readonly filters: AuditFilters;
}

type ListStatus = 'loading' | 'ready' | 'failed' | 'forbidden';

interface ListData {
  readonly items: readonly AuditRow[];
  readonly total: number;
}

type Notice = { readonly type: 'success' | 'error'; readonly text: string };

// Filter card: inputs and the select share one control height.
const FILTER_THEME: ThemeConfig = {
  components: { Input: { controlHeight: 36 }, Select: { controlHeight: 36 } },
};

const PERMISSION_OPTIONS = admin_permission.map((key) => ({ value: key, label: key }));

function fieldsOf(error: AdminApiError): readonly unknown[] {
  const data = error.data;
  if (typeof data === 'object' && data !== null && 'fields' in data && Array.isArray(data.fields))
    return data.fields as unknown[];
  return [];
}

export function AuditLogsPage({ access }: { readonly access: AccessControl }): ReactElement {
  const loadingClock = useLoadingClock();
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const ids = {
    actor: useId(),
    targetType: useId(),
    targetId: useId(),
    permission: useId(),
    from: useId(),
    to: useId(),
  };
  const canExport = access.can('export');
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_DRAFT);
  const [draftError, setDraftError] = useState<{ field: 'from' | 'to'; text: string }>();
  const [query, setQuery] = useState<ListQuery>({ page: 1, filters: {} });
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [data, setData] = useState<ListData>();
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const creatingRef = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const customOf = () => {
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    return custom;
  };

  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<Schema<'AdminAuditLogPage'>>({
      url: LOGS_URL,
      method: 'get',
      query: { page: query.page, page_size: PAGE_SIZE, ...query.filters },
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

  const update = (patch: Partial<FilterDraft>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
    if (draftError !== undefined && ('from' in patch || 'to' in patch)) setDraftError(undefined);
  };

  const submit = () => {
    const result = filtersOf(draft);
    if (!result.ok) {
      setDraftError({
        field: result.field,
        text: result.kind === 'range' ? t.filters.rangeInvalid : t.filters.timeInvalid,
      });
      return;
    }
    setDraftError(undefined);
    setStatus('loading');
    setQuery({ page: 1, filters: result.filters });
  };

  const reset = () => {
    setDraft(EMPTY_DRAFT);
    setDraftError(undefined);
    setStatus('loading');
    setQuery({ page: 1, filters: {} });
  };

  const retry = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  const changePage = (pagination: TablePaginationConfig) => {
    if (pagination.current === undefined || pagination.current === query.page) return;
    setStatus('loading');
    setQuery({ ...query, page: pagination.current });
  };

  const createExport = async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setNotice(undefined);
    const payload: Schema<'AdminExportCreateAuditLogsRequest'> = {
      resource: 'audit_logs',
      filters: query.filters,
    };
    let result: Notice;
    try {
      await customOf()<Schema<'AdminExport'>>({ url: EXPORTS_URL, method: 'post', payload });
      result = { type: 'success', text: t.exportCreated };
    } catch (cause) {
      if (cause instanceof AdminApiError && cause.kind === 'http' && cause.httpStatus === 202) {
        // 202 Accepted with the new task: the provider only treats 200 as success.
        result = { type: 'success', text: t.exportCreated };
      } else if (cause instanceof AdminApiError && cause.code === 10403) {
        result = { type: 'error', text: t.exportForbidden };
      } else if (
        cause instanceof AdminApiError &&
        cause.code === 20001 &&
        fieldsOf(cause).includes('from')
      ) {
        result = { type: 'error', text: t.exportRangeInvalid };
      } else {
        result = { type: 'error', text: t.exportFailed };
      }
    }
    creatingRef.current = false;
    if (!alive.current) return;
    setCreating(false);
    setNotice(result);
  };

  const code = { fontFamily: token.fontFamilyCode } as const;
  const secondary = {
    fontSize: token.fontSizeSM,
    color: token.colorTextSecondary,
    wordBreak: 'break-all',
  } as const;

  const columns: TableColumnsType<AuditRow> = [
    {
      key: 'at',
      title: t.columns.at,
      width: 180,
      render: (_, row) => <span style={{ whiteSpace: 'nowrap' }}>{beijingTime(row.at)}</span>,
    },
    {
      key: 'actor',
      title: t.columns.actor,
      render: (_, row) => (
        <Flex vertical>
          <span>{row.actor_name ?? t.dash}</span>
          <span style={{ ...code, ...secondary }}>{row.actor_id}</span>
        </Flex>
      ),
    },
    {
      key: 'action',
      title: t.columns.action,
      render: (_, row) => <span style={code}>{row.action}</span>,
    },
    {
      key: 'target',
      title: t.columns.target,
      render: (_, row) =>
        row.target_type === null && row.target_id === null ? (
          t.dash
        ) : (
          <Flex vertical>
            <span>{row.target_type ?? t.dash}</span>
            <span style={{ ...code, ...secondary }}>{row.target_id ?? t.dash}</span>
          </Flex>
        ),
    },
    {
      key: 'permission',
      title: t.columns.permission,
      render: (_, row) => <span style={code}>{row.permission ?? t.dash}</span>,
    },
    {
      key: 'ip',
      title: t.columns.ip,
      render: (_, row) => <span style={code}>{row.ip ?? t.dash}</span>,
    },
    {
      key: 'actions',
      title: t.columns.actions,
      width: 80,
      render: (_, row) => (
        <Link to={`/audit-logs/${encodeURIComponent(row.id)}`} aria-label={t.viewName(row.id)}>
          {t.view}
        </Link>
      ),
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
            <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={retry}>
              {t.retry}
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
        <Table<AuditRow>
          rowKey="id"
          columns={columns}
          dataSource={data.items as AuditRow[]}
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
            hideOnSinglePage: false,
            showTotal: (total) => t.total(total),
            style: { paddingInline: 16 },
          }}
          onChange={changePage}
        />
      </Card>
    );
  }

  const timeError = (field: 'from' | 'to') =>
    draftError?.field === field ? (
      <Typography.Text type="danger">{draftError.text}</Typography.Text>
    ) : undefined;

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center" wrap gap={8}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t.title}
        </Typography.Title>
        {canExport ? (
          <Flex align="center" gap={12}>
            <Link to="/exports">{t.exportRecords}</Link>
            <Button
              icon={<ExportOutlined aria-hidden />}
              disabled={creating}
              loading={creating}
              onClick={() => void createExport()}
            >
              {t.exportAction}
            </Button>
          </Flex>
        ) : null}
      </Flex>
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
        <ConfigProvider theme={FILTER_THEME}>
          <Form layout="vertical" component="div">
            <Flex align="flex-start" gap={16} wrap>
              <Form.Item label={t.filters.actor} htmlFor={ids.actor} style={{ marginBottom: 0 }}>
                <Input
                  id={ids.actor}
                  allowClear
                  placeholder={t.filters.actorPlaceholder}
                  value={draft.actor}
                  onChange={(event) => update({ actor: event.target.value })}
                  style={{ width: 280 }}
                />
              </Form.Item>
              <Form.Item
                label={t.filters.targetType}
                htmlFor={ids.targetType}
                style={{ marginBottom: 0 }}
              >
                <Input
                  id={ids.targetType}
                  allowClear
                  placeholder={t.filters.targetTypePlaceholder}
                  value={draft.targetType}
                  onChange={(event) => update({ targetType: event.target.value })}
                  style={{ width: 160 }}
                />
              </Form.Item>
              <Form.Item
                label={t.filters.targetId}
                htmlFor={ids.targetId}
                style={{ marginBottom: 0 }}
              >
                <Input
                  id={ids.targetId}
                  allowClear
                  placeholder={t.filters.targetIdPlaceholder}
                  value={draft.targetId}
                  onChange={(event) => update({ targetId: event.target.value })}
                  style={{ width: 280 }}
                />
              </Form.Item>
              <Form.Item
                label={t.filters.permission}
                htmlFor={ids.permission}
                style={{ marginBottom: 0 }}
              >
                <Select<string | undefined>
                  id={ids.permission}
                  allowClear
                  showSearch
                  virtual={false}
                  placeholder={t.filters.permissionPlaceholder}
                  value={draft.permission}
                  options={PERMISSION_OPTIONS}
                  onChange={(value) => update({ permission: value })}
                  style={{ width: 220 }}
                />
              </Form.Item>
              <Form.Item
                label={t.filters.from}
                htmlFor={ids.from}
                style={{ marginBottom: 0 }}
                validateStatus={draftError?.field === 'from' ? 'error' : ''}
                help={timeError('from')}
              >
                <Input
                  id={ids.from}
                  allowClear
                  placeholder={t.filters.timePlaceholder}
                  value={draft.from}
                  onChange={(event) => update({ from: event.target.value })}
                  style={{ width: 230 }}
                />
              </Form.Item>
              <Form.Item
                label={t.filters.to}
                htmlFor={ids.to}
                style={{ marginBottom: 0 }}
                validateStatus={draftError?.field === 'to' ? 'error' : ''}
                help={timeError('to')}
              >
                <Input
                  id={ids.to}
                  allowClear
                  placeholder={t.filters.timePlaceholder}
                  value={draft.to}
                  onChange={(event) => update({ to: event.target.value })}
                  style={{ width: 230 }}
                />
              </Form.Item>
            </Flex>
            <Flex gap={8} style={{ marginTop: 16 }}>
              <Button type="primary" icon={<SearchOutlined aria-hidden />} onClick={submit}>
                {t.filters.submit}
              </Button>
              <Button onClick={reset}>{t.filters.reset}</Button>
            </Flex>
          </Form>
        </ConfigProvider>
      </Card>
      {body}
    </Flex>
  );
}
