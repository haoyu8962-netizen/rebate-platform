// Invite reward records (01 F-ADM-27, 04 §6.6 invite-rewards; BR-INV-24): a read-only subpage of
// 配置中心 at /invite-rewards. GET /admin/v1/invite-rewards page by page under the applied
// filters (invitee, inviter, status, +08:00 qualification days); 【详情】 reads the one record
// again (GET /admin/v1/invite-rewards/{invitee_id}) and shows that answer. fund.view reads;
// without it the page says so and sends nothing. No write operation of any kind.
import { ArrowLeftOutlined, SearchOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  DatePicker,
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
} from 'antd';
import dayjs from 'dayjs';
import { useEffect, useId, useState, type CSSProperties, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { inviteRewardsTexts as t } from '../../texts/invite-rewards.ts';
import { RewardDrawer } from './RewardDrawer.tsx';
import {
  NO_FILTERS,
  PAGE_SIZE,
  REWARDS_URL,
  STATUSES,
  amountLabel,
  beijingTime,
  bindSourceLabel,
  inviteeParty,
  inviterParty,
  queryOf,
  rangeInvalid,
  statusLabel,
  statusWithReason,
  type Filters,
  type Reward,
  type RewardStatus,
} from './model.ts';

export interface InviteRewardsPageProps {
  readonly access: AccessControl;
}

type ListStatus = 'loading' | 'ready' | 'failed' | 'forbidden' | 'invalid';

interface RewardPage extends Record<string, unknown> {
  readonly items: Reward[];
  readonly total: number;
}

const DAY_FORMAT = 'YYYY-MM-DD';
const ALL = '__all__';
const HIDDEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
};
const CELL: CSSProperties = { flex: '1 1 200px', minWidth: 180, marginBottom: 0 };

export function InviteRewardsPage({ access }: InviteRewardsPageProps): ReactElement {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const allowed = access.can('fund.view');
  const back = (
    <Button icon={<ArrowLeftOutlined aria-hidden />} onClick={() => void navigate('/config')}>
      {t.back}
    </Button>
  );
  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center" wrap gap={8}>
        <Flex vertical gap={4}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t.title}
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
            {t.description}
          </Typography.Text>
        </Flex>
        {back}
      </Flex>
      {allowed ? (
        <RewardList />
      ) : (
        <Card>
          <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
        </Card>
      )}
    </Flex>
  );
}

function RewardList(): ReactElement {
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const ids = {
    invitee: useId(),
    inviter: useId(),
    status: useId(),
    from: useId(),
    to: useId(),
  };
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [applied, setApplied] = useState<Filters>(NO_FILTERS);
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ListStatus>('loading');
  const [data, setData] = useState<RewardPage>();
  const [detailId, setDetailId] = useState<string>();

  const queryKey = JSON.stringify(queryOf(applied));

  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    const query = {
      page,
      page_size: PAGE_SIZE,
      ...(JSON.parse(queryKey) as Record<string, string>),
    };
    custom<RewardPage>({ url: REWARDS_URL, method: 'get', query }).then(
      (response) => {
        if (!current) return;
        setData(response.data);
        setStatus('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        // A failed read never keeps the rows of an earlier answer; nothing is sent again by itself.
        setData(undefined);
        const code = cause instanceof AdminApiError ? cause.code : undefined;
        setStatus(code === 10403 ? 'forbidden' : code === 20001 ? 'invalid' : 'failed');
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, queryKey, page, attempt]);

  const draftInvalid = rangeInvalid(draft);

  const submit = () => {
    if (draftInvalid) return;
    setStatus('loading');
    setApplied(draft);
    setPage(1);
    setAttempt((value) => value + 1);
  };

  const reset = () => {
    setDraft(NO_FILTERS);
    setStatus('loading');
    setApplied(NO_FILTERS);
    setPage(1);
    setAttempt((value) => value + 1);
  };

  const retry = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  const small = { fontSize: token.fontSizeSM } as const;
  const code = {
    fontFamily: token.fontFamilyCode,
    fontSize: token.fontSizeSM,
    overflowWrap: 'anywhere',
  } as const;

  const person = (phone: string | null, id: string) => (
    <Flex vertical gap={2}>
      <Typography.Text>{phone ?? t.dash}</Typography.Text>
      <Typography.Text type="secondary" style={code}>
        {id}
      </Typography.Text>
    </Flex>
  );

  const columns: TableColumnsType<Reward> = [
    {
      key: 'invitee',
      title: t.columns.invitee,
      width: 180,
      render: (_, row) => person(row.invitee_phone_masked, row.invitee_id),
    },
    {
      key: 'inviter',
      title: t.columns.inviter,
      width: 180,
      render: (_, row) => person(row.inviter_phone_masked, row.inviter_id),
    },
    {
      key: 'amount',
      title: t.columns.amount,
      width: 104,
      render: (_, row) => <Typography.Text>{amountLabel(row.amount_fen)}</Typography.Text>,
    },
    {
      key: 'source',
      title: t.columns.source,
      width: 96,
      render: (_, row) => <Typography.Text>{bindSourceLabel(row.bind_source)}</Typography.Text>,
    },
    {
      key: 'qualified',
      title: t.columns.qualifiedAt,
      width: 140,
      render: (_, row) => <Typography.Text>{beijingTime(row.qualified_at)}</Typography.Text>,
    },
    {
      key: 'trigger',
      title: t.columns.trigger,
      width: 200,
      render: (_, row) =>
        row.trigger_order_id === null ? (
          <Typography.Text type="secondary">{t.dash}</Typography.Text>
        ) : (
          <Flex vertical gap={2}>
            <Typography.Text style={code}>{row.trigger_order_id}</Typography.Text>
            <Typography.Text type="secondary" style={small}>
              {beijingTime(row.triggered_at)}
            </Typography.Text>
          </Flex>
        ),
    },
    {
      key: 'status',
      title: t.columns.status,
      width: 140,
      render: (_, row) => <Typography.Text>{statusWithReason(row)}</Typography.Text>,
    },
    {
      key: 'inviterResult',
      title: t.columns.inviterResult,
      width: 150,
      render: (_, row) => <Typography.Text>{inviterParty(row)}</Typography.Text>,
    },
    {
      key: 'inviteeResult',
      title: t.columns.inviteeResult,
      width: 150,
      render: (_, row) => <Typography.Text>{inviteeParty(row)}</Typography.Text>,
    },
    {
      key: 'granted',
      title: t.columns.grantedAt,
      width: 140,
      render: (_, row) => (
        <Typography.Text {...(row.granted_at === null ? { type: 'secondary' as const } : {})}>
          {beijingTime(row.granted_at)}
        </Typography.Text>
      ),
    },
    {
      key: 'actions',
      title: t.columns.actions,
      width: 72,
      fixed: 'right',
      render: (_, row) => (
        <Button
          type="link"
          size="small"
          style={{ paddingInline: 0 }}
          aria-label={t.detailActionLabel(row.invitee_phone_masked ?? row.invitee_id)}
          onClick={() => setDetailId(row.invitee_id)}
        >
          {t.detailAction}
        </Button>
      ),
    },
  ];

  let body: ReactElement;
  if (status === 'loading') {
    body = (
      <Typography.Text type="secondary" role="status">
        {t.loading}
      </Typography.Text>
    );
  } else if (status === 'forbidden') {
    body = <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />;
  } else if (status === 'failed') {
    body = (
      <Result
        status="error"
        title={t.loadFailedTitle}
        subTitle={t.loadFailedDescription}
        extra={<Button onClick={retry}>{t.retry}</Button>}
      />
    );
  } else if (status === 'invalid') {
    body = <Alert type="error" showIcon message={t.invalidQuery} />;
  } else if (data === undefined || data.items.length === 0) {
    const filtered = Object.keys(JSON.parse(queryKey) as object).length > 0;
    body = <Empty description={filtered ? t.filteredEmpty : t.empty} />;
  } else {
    body = (
      <Table<Reward>
        rowKey="invitee_id"
        columns={columns}
        dataSource={data.items}
        tableLayout="fixed"
        scroll={{ x: 1460 }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: data.total,
          showSizeChanger: false,
          showTotal: (total) => t.total(total),
          onChange: (next) => {
            setStatus('loading');
            setPage(next);
          },
        }}
      />
    );
  }

  return (
    <>
      <Card>
        <Form layout="vertical" component="div" colon={false}>
          <Flex gap={16} wrap align="flex-end">
            <Form.Item label={t.filters.invitee} htmlFor={ids.invitee} style={CELL}>
              <Input
                id={ids.invitee}
                allowClear
                placeholder={t.filters.inviteePlaceholder}
                value={draft.invitee}
                onChange={(event) => setDraft({ ...draft, invitee: event.target.value })}
                onPressEnter={submit}
              />
            </Form.Item>
            <Form.Item label={t.filters.inviter} htmlFor={ids.inviter} style={CELL}>
              <Input
                id={ids.inviter}
                allowClear
                placeholder={t.filters.inviterPlaceholder}
                value={draft.inviter}
                onChange={(event) => setDraft({ ...draft, inviter: event.target.value })}
                onPressEnter={submit}
              />
            </Form.Item>
            <Form.Item label={t.filters.status} htmlFor={ids.status} style={CELL}>
              <Select<string>
                id={ids.status}
                aria-label={t.filters.status}
                value={draft.status ?? ALL}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    status: value === ALL ? undefined : (value as RewardStatus),
                  })
                }
                options={[
                  { value: ALL, label: t.filters.all },
                  ...STATUSES.map((value) => ({ value, label: statusLabel(value) })),
                ]}
              />
            </Form.Item>
            <Form.Item
              label={t.filters.qualified}
              style={{ ...CELL, flex: '2 1 320px' }}
              validateStatus={draftInvalid ? 'error' : ''}
              {...(draftInvalid ? { help: t.filters.rangeInvalid } : {})}
            >
              <Flex gap={8}>
                <label htmlFor={ids.from} style={HIDDEN}>
                  {t.filters.qualifiedFrom}
                </label>
                <DatePicker
                  id={ids.from}
                  format={DAY_FORMAT}
                  placeholder={t.filters.fromPlaceholder}
                  value={draft.from === undefined ? null : dayjs(draft.from)}
                  onChange={(value) =>
                    setDraft({ ...draft, from: value?.format(DAY_FORMAT) ?? undefined })
                  }
                  style={{ flex: 1, minWidth: 0 }}
                />
                <label htmlFor={ids.to} style={HIDDEN}>
                  {t.filters.qualifiedTo}
                </label>
                <DatePicker
                  id={ids.to}
                  format={DAY_FORMAT}
                  placeholder={t.filters.toPlaceholder}
                  value={draft.to === undefined ? null : dayjs(draft.to)}
                  onChange={(value) =>
                    setDraft({ ...draft, to: value?.format(DAY_FORMAT) ?? undefined })
                  }
                  style={{ flex: 1, minWidth: 0 }}
                />
              </Flex>
            </Form.Item>
            <Flex gap={12}>
              <Button
                type="primary"
                icon={<SearchOutlined aria-hidden />}
                disabled={draftInvalid}
                onClick={submit}
              >
                {t.filters.submit}
              </Button>
              <Button onClick={reset}>{t.filters.reset}</Button>
            </Flex>
          </Flex>
        </Form>
      </Card>
      <Card>{body}</Card>
      {detailId === undefined ? null : (
        <RewardDrawer key={detailId} inviteeId={detailId} onClose={() => setDetailId(undefined)} />
      )}
    </>
  );
}
