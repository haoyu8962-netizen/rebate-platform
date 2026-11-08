// Users (design-hifi AdmUsers, AdmUserDetail; 规划/04 §11.1, F1-07): the user list (user.list:
// GET /admin/v1/users page by page, optional risk_state filter, non-sensitive fields only), the
// lookup by UID or full phone number (user.lookup: GET /admin/v1/users/lookup, exactly one
// parameter) and the detail view. Without user.list the page shows only the lookup and never
// reads the list; without both it shows no permission and sends nothing. The list query and the
// page read last stay in this component, so 【返回】 from a detail shows the same page and filter.
// With `export` and user.list the list's title row offers 【导出记录】 and 【导出】 (the applied
// filter, see ExportUsers.tsx); the detail view never shows them.
import type { Schema } from '@couli/contracts-ts';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  InboxOutlined,
  ReloadOutlined,
  SearchOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Button,
  Card,
  ConfigProvider,
  Empty,
  Flex,
  Form,
  Input,
  Result,
  Select,
  Skeleton,
  Table,
  Tag,
  Typography,
  theme,
  type TableColumnsType,
  type TablePaginationConfig,
  type ThemeConfig,
} from 'antd';
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { usersTexts as t } from '../../texts/users.ts';
import {
  PAGE_SIZE,
  RISK_STATES,
  beijingTime,
  lookupErrorText,
  lookupQuery,
  riskLabel,
  type RiskState,
  type UserDetail,
  type UserRow,
} from './model.ts';
import { UsersExportEntries } from './ExportUsers.tsx';
import { RiskTag } from './RiskTag.tsx';
import { UserDetailView } from './UserDetailView.tsx';
import { delayedLoading, useLoadingClock } from '../../motion.ts';

export interface UsersPageProps {
  readonly access: AccessControl;
}

type RiskFilter = RiskState | 'all';

interface ListQuery {
  readonly page: number;
  readonly risk: RiskFilter;
}

type ListStatus = 'loading' | 'ready' | 'failed' | 'forbidden';

interface ListData {
  readonly items: readonly UserRow[];
  readonly total: number;
}

type View =
  | { readonly kind: 'list' }
  | {
      readonly kind: 'detail';
      readonly userId: string;
      readonly initial?: UserDetail | undefined;
      /** Distinguishes two openings of the same user (each starts afresh). */
      readonly opening: number;
    };

const USERS_URL = '/admin/v1/users';
const LOOKUP_URL = `${USERS_URL}/lookup`;

// Filter card (AdmUsers): 36 high controls, small labels above them.
const FILTER_THEME: ThemeConfig = {
  components: {
    Input: { controlHeight: 36 },
    Select: { controlHeight: 36 },
    Form: { labelFontSize: 12, verticalLabelPadding: '0 0 4px' },
  },
};

export function UsersPage({ access }: UsersPageProps): ReactElement {
  const canList = access.can('user.list');
  const canLookup = access.can('user.lookup');
  const canReveal = access.can('pii.reveal_phone');
  if (!canList && !canLookup) {
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
  return (
    <UsersContent access={access} canList={canList} canLookup={canLookup} canReveal={canReveal} />
  );
}

interface UsersContentProps {
  readonly access: AccessControl;
  readonly canList: boolean;
  readonly canLookup: boolean;
  readonly canReveal: boolean;
}

function UsersContent({ access, canList, canLookup, canReveal }: UsersContentProps): ReactElement {
  const loadingClock = useLoadingClock();
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const lookupId = useId();
  const riskId = useId();
  const [query, setQuery] = useState<ListQuery>({ page: 1, risk: 'all' });
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [data, setData] = useState<ListData>();
  const [view, setView] = useState<View>({ kind: 'list' });
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [lookupError, setLookupError] = useState<string>();
  const searchingRef = useRef(false);
  const openings = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!canList) return;
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<Schema<'AdminUserPage'>>({
      url: USERS_URL,
      method: 'get',
      query: {
        page: query.page,
        page_size: PAGE_SIZE,
        ...(query.risk === 'all' ? {} : { risk_state: query.risk }),
      },
    }).then(
      (response) => {
        if (!current) return;
        setData({ items: response.data.items, total: response.data.total });
        setStatus('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        setStatus(cause instanceof AdminApiError && cause.code === 10403 ? 'forbidden' : 'failed');
      },
    );
    return () => {
      // A newer query (or leaving the page) drops this answer.
      current = false;
    };
  }, [getProvider, canList, query, attempt]);

  const retry = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  const changeRisk = (risk: RiskFilter) => {
    if (risk === query.risk) return;
    setStatus('loading');
    setQuery({ page: 1, risk });
  };

  const changePage = useCallback(
    (pagination: TablePaginationConfig) => {
      if (pagination.current === undefined || pagination.current === query.page) return;
      setStatus('loading');
      setQuery({ ...query, page: pagination.current });
    },
    [query],
  );

  const open = (userId: string, initial?: UserDetail) => {
    openings.current += 1;
    setView({ kind: 'detail', userId, initial, opening: openings.current });
  };

  const submitLookup = async () => {
    if (searchingRef.current) return;
    const value = search.trim();
    if (value === '') {
      setLookupError(t.lookup.empty);
      return;
    }
    searchingRef.current = true;
    setSearching(true);
    setLookupError(undefined);
    try {
      const custom = getProvider().custom;
      if (custom === undefined) throw new Error('Missing custom data provider');
      const response = await custom<UserDetail>({
        url: LOOKUP_URL,
        method: 'get',
        query: lookupQuery(value),
      });
      if (!alive.current) return;
      open(response.data.user_id, response.data);
    } catch (cause) {
      if (!alive.current) return;
      setLookupError(lookupErrorText(cause));
    } finally {
      searchingRef.current = false;
      if (alive.current) setSearching(false);
    }
  };

  if (view.kind === 'detail') {
    return (
      <UserDetailView
        key={`${view.userId}:${view.opening}`}
        userId={view.userId}
        initial={view.initial}
        canReveal={canReveal}
        access={access}
        onBack={() => setView({ kind: 'list' })}
        onOpenUser={(userId) => open(userId)}
      />
    );
  }

  const reset = () => {
    // Clears the risk filter and reads page 1 once (a fresh query object even when unchanged).
    setStatus('loading');
    setQuery({ page: 1, risk: 'all' });
  };

  const canExport = canList && access.can('export');
  const code = { fontFamily: token.fontFamilyCode } as const;
  const riskText = query.risk === 'all' ? t.riskFilterAll : riskLabel(query.risk);

  const columns: TableColumnsType<UserRow> = [
    {
      key: 'uid',
      title: t.columns.uid,
      render: (_, row) => <span style={{ ...code, whiteSpace: 'nowrap' }}>{row.user_id}</span>,
    },
    { key: 'nickname', title: t.columns.nickname, dataIndex: 'nickname', ellipsis: true },
    {
      key: 'phone',
      title: t.columns.phone,
      width: 140,
      render: (_, row) => <span style={code}>{row.phone_masked ?? t.dash}</span>,
    },
    { key: 'level', title: t.columns.level, dataIndex: 'level', width: 80 },
    {
      key: 'risk',
      title: t.columns.risk,
      width: 140,
      render: (_, row) => <RiskTag state={row.risk_state} />,
    },
    {
      key: 'createdAt',
      title: t.columns.createdAt,
      width: 170,
      render: (_, row) => (
        <span style={{ whiteSpace: 'nowrap' }}>{beijingTime(row.created_at)}</span>
      ),
    },
    {
      key: 'actions',
      title: t.columns.actions,
      width: 80,
      render: (_, row) => (
        <Button
          type="link"
          size="small"
          aria-label={t.detailActionName(row.user_id)}
          style={{ paddingInline: 0 }}
          onClick={() => open(row.user_id)}
        >
          {t.detailAction}
        </Button>
      ),
    },
  ];

  const lookupField = canLookup ? (
    <Form.Item
      label={t.lookup.label}
      htmlFor={lookupId}
      style={{ marginBottom: 0 }}
      extra={
        lookupError === undefined ? (
          <Typography.Text type="secondary">{t.lookup.hint}</Typography.Text>
        ) : (
          <Typography.Text type="danger" role="status">
            {lookupError}
          </Typography.Text>
        )
      }
    >
      <Flex align="center" gap={8}>
        <Input
          id={lookupId}
          allowClear
          prefix={<SearchOutlined aria-hidden />}
          placeholder={t.lookup.placeholder}
          value={search}
          status={lookupError === undefined ? '' : 'error'}
          onChange={(event) => setSearch(event.target.value)}
          onPressEnter={() => void submitLookup()}
          style={{ width: 320 }}
        />
        <Button
          type="primary"
          icon={<SearchOutlined aria-hidden />}
          loading={searching}
          onClick={() => void submitLookup()}
        >
          {t.lookup.submit}
        </Button>
      </Flex>
    </Form.Item>
  ) : null;

  const filterField = canList ? (
    <Form.Item label={t.riskFilterLabel} htmlFor={riskId} style={{ marginBottom: 0 }}>
      <Select<RiskFilter | undefined>
        id={riskId}
        // 「全部」 shows as the placeholder (in normal text colour): antd's placeholder lets
        // pointer events through to the combobox input, a selected item would cover it.
        value={query.risk === 'all' ? undefined : query.risk}
        placeholder={<Typography.Text>{t.riskFilterAll}</Typography.Text>}
        onChange={(risk) => changeRisk(risk ?? 'all')}
        style={{ width: 200 }}
        options={[
          { value: 'all', label: t.riskFilterAll },
          ...RISK_STATES.map((state) => ({ value: state, label: riskLabel(state) })),
        ]}
      />
    </Form.Item>
  ) : null;

  // Shown with a settled answer for an applied risk filter; announces the condition and the
  // server's total, and never wraps the table or the pagination.
  const applied =
    query.risk !== 'all' && status === 'ready' && data !== undefined ? (
      <Flex
        align="center"
        gap={12}
        wrap
        aria-live="polite"
        style={{
          padding: '10px 16px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Tag icon={<CheckCircleOutlined aria-hidden />} style={{ marginInlineEnd: 0 }}>
          {t.applied}
        </Tag>
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          {t.appliedConditions(riskText)}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          {t.total(data.total)}
        </Typography.Text>
      </Flex>
    ) : null;

  const loadingLine =
    status === 'loading' ? (
      <Flex
        align="center"
        gap={8}
        style={{
          padding: '12px 16px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <ClockCircleOutlined aria-hidden style={{ color: token.colorTextSecondary }} />
        <Typography.Text type="secondary" role="status">
          {t.loading}
        </Typography.Text>
      </Flex>
    ) : null;

  const empty = (
    <Empty
      image={<InboxOutlined aria-hidden style={{ fontSize: 28, color: token.colorTextTertiary }} />}
      styles={{
        image: {
          height: 56,
          width: 56,
          marginInline: 'auto',
          marginBottom: 16,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: token.colorFillTertiary,
        },
      }}
      description={
        <Flex vertical align="center" gap={8}>
          <Typography.Text strong>{t.empty}</Typography.Text>
          <Typography.Text type="secondary">{t.emptyConditions(riskText)}</Typography.Text>
        </Flex>
      }
    >
      <Button onClick={reset}>{t.resetConditions}</Button>
    </Empty>
  );

  const inner = {
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: token.borderRadiusLG,
    overflow: 'hidden',
  } as const;

  let body: ReactElement | null = null;
  if (!canList) {
    body = null;
  } else if (status === 'forbidden') {
    body = (
      <Card title={t.listTitle}>
        <Result status="403" title={t.forbiddenTitle} subTitle={t.listForbiddenDescription} />
      </Card>
    );
  } else if (status === 'failed') {
    body = (
      <Card title={t.listTitle}>
        <div style={inner}>
          <Result
            status="warning"
            icon={
              <Flex
                align="center"
                justify="center"
                style={{
                  width: 56,
                  height: 56,
                  marginInline: 'auto',
                  borderRadius: '50%',
                  background: token.colorErrorBg,
                }}
              >
                <WarningOutlined aria-hidden style={{ fontSize: 24, color: token.colorError }} />
              </Flex>
            }
            title={
              <Typography.Text type="danger" strong style={{ fontSize: token.fontSize }}>
                {t.loadFailedTitle}
              </Typography.Text>
            }
            subTitle={t.loadFailedDescription}
            extra={
              <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={retry}>
                {t.retry}
              </Button>
            }
          />
        </div>
      </Card>
    );
  } else if (data === undefined) {
    body = (
      <Card title={t.listTitle}>
        <div style={inner}>
          {loadingLine}
          <div style={{ padding: 16 }}>
            <Skeleton active title={false} paragraph={{ rows: 4 }} />
          </div>
        </div>
      </Card>
    );
  } else if (status === 'ready' && data.total === 0) {
    body = (
      <Card title={t.listTitle} styles={{ body: { padding: 0 } }}>
        {applied}
        <div style={{ padding: '40px 24px' }}>{empty}</div>
      </Card>
    );
  } else {
    body = (
      <Card title={t.listTitle} styles={{ body: { padding: 0 } }}>
        {applied}
        {loadingLine}
        <Table<UserRow>
          rowKey="user_id"
          columns={columns}
          dataSource={data.items as UserRow[]}
          loading={delayedLoading(status === 'loading', loadingClock)}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: empty }}
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
      <Flex justify="space-between" align="center" wrap gap={8}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t.title}
        </Typography.Title>
        {canExport ? (
          <UsersExportEntries risk={query.risk} riskText={riskText} canReveal={canReveal} />
        ) : null}
      </Flex>
      <Card>
        <ConfigProvider theme={FILTER_THEME}>
          <Form layout="vertical" component="div">
            <Flex align="flex-start" gap={24} wrap>
              {lookupField}
              {filterField}
            </Flex>
          </Form>
        </ConfigProvider>
      </Card>
      {body}
    </Flex>
  );
}
