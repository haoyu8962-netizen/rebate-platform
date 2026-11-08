// Admin accounts list (design-hifi AdmAdmins; design/specs/admins.md): super admins only,
// read-only. antd Table with server pagination over adminListAdmins through the Refine data
// provider; loading / empty / failed states, and a no-permission page for 10403.
import type { Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import { Alert, Button, Empty, Flex, Result, Table, Tag, Typography } from 'antd';
import type { TableColumnsType, TablePaginationConfig } from 'antd';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { AdminApiError } from '../../providers/data/index.ts';
import { adminsTexts } from '../../texts/admins.ts';
import { formatBeijingDate, formatBeijingTime, isLocked } from './format.ts';
import { delayedLoading, useLoadingClock } from '../../motion.ts';

type Account = Schema<'AdminAccount'>;

export interface AdminsPageProps {
  /** Current time for the lock state (tests); defaults to the clock. */
  readonly now?: () => Date;
}

const PAGE_SIZE = 20;

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly status: 'failed' }
  | { readonly status: 'forbidden' };

interface PageData {
  readonly items: readonly Account[];
  readonly total: number;
}

function isPermissionDenied(error: unknown): boolean {
  if (!(error instanceof AdminApiError) || error.code !== 10403) return false;
  const data = error.data;
  return (
    typeof data === 'object' &&
    data !== null &&
    'reason' in data &&
    data.reason === 'admin_permission_denied'
  );
}

function columns(now: Date): TableColumnsType<Account> {
  const texts = adminsTexts;
  return [
    { key: 'username', title: texts.columns.username, dataIndex: 'username', width: 180 },
    {
      key: 'type',
      title: texts.columns.type,
      width: 120,
      render: (_, account) => (account.is_super ? texts.type.super : texts.type.ordinary),
    },
    {
      key: 'permissions',
      title: texts.columns.permissions,
      width: 100,
      render: (_, account) =>
        account.is_super ? texts.permissionsAll : texts.permissionCount(account.permissions.length),
    },
    {
      key: 'totp',
      title: texts.columns.totp,
      width: 100,
      render: (_, account) => (account.totp_bound ? texts.totp.bound : texts.totp.unbound),
    },
    {
      key: 'verifyPhone',
      title: texts.columns.verifyPhone,
      width: 140,
      render: (_, account) => account.verify_phone_masked ?? texts.verifyPhoneMissing,
    },
    {
      key: 'status',
      title: texts.columns.status,
      width: 160,
      render: (_, account) => {
        // The text carries the meaning; the preset tag colour only reinforces it.
        if (account.status === 'disabled') return <Tag>{texts.status.disabled}</Tag>;
        if (isLocked(account.locked_until, now)) {
          return (
            <Tag color="warning">
              {texts.lockedUntil(formatBeijingTime(account.locked_until ?? ''))}
            </Tag>
          );
        }
        return <Tag color="success">{texts.status.active}</Tag>;
      },
    },
    {
      key: 'createdAt',
      title: texts.columns.createdAt,
      width: 120,
      render: (_, account) => formatBeijingDate(account.created_at),
    },
  ];
}

const SCROLL_X = 180 + 120 + 100 + 100 + 140 + 160 + 120;

export function AdminsPage({ now }: AdminsPageProps): ReactElement {
  const loadingClock = useLoadingClock();
  const getDataProvider = useDataProvider();
  const [current, setCurrent] = useState(1);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [data, setData] = useState<PageData>({ items: [], total: 0 });
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    latest.current += 1;
    const request = latest.current;
    getDataProvider()
      .getList<Account>({
        resource: 'admins',
        pagination: { currentPage: current, pageSize: PAGE_SIZE, mode: 'server' },
      })
      .then(
        (result) => {
          if (request !== latest.current) return;
          setData({ items: result.data, total: result.total });
          setState({ status: 'ready' });
        },
        (error: unknown) => {
          if (request !== latest.current) return;
          setState({ status: isPermissionDenied(error) ? 'forbidden' : 'failed' });
        },
      );
    return () => {
      // A newer page or an unmount drops this answer.
      latest.current += 1;
    };
  }, [getDataProvider, current, attempt]);

  // Each new request starts in the loading state (set here, where it is triggered).
  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((value) => value + 1);
  }, []);
  const onChange = useCallback(
    (pagination: TablePaginationConfig) => {
      if (pagination.current === undefined || pagination.current === current) return;
      setState({ status: 'loading' });
      setCurrent(pagination.current);
    },
    [current],
  );

  let body: ReactElement;
  if (state.status === 'forbidden') {
    body = (
      <Result
        status="403"
        title={adminsTexts.forbiddenTitle}
        subTitle={adminsTexts.forbiddenDescription}
      />
    );
  } else if (state.status === 'failed') {
    body = (
      <Result
        status="error"
        title={adminsTexts.loadFailedTitle}
        subTitle={adminsTexts.loadFailedDescription}
        extra={
          <Button type="primary" onClick={retry}>
            {adminsTexts.retry}
          </Button>
        }
      />
    );
  } else {
    body = (
      <Table<Account>
        rowKey="admin_id"
        columns={columns(now?.() ?? new Date())}
        dataSource={data.items as Account[]}
        loading={delayedLoading(state.status === 'loading', loadingClock)}
        scroll={{ x: SCROLL_X }}
        locale={{
          emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={adminsTexts.empty} />,
        }}
        pagination={{
          current,
          pageSize: PAGE_SIZE,
          total: data.total,
          showSizeChanger: false,
          showTotal: (total) => adminsTexts.total(total),
        }}
        onChange={onChange}
      />
    );
  }

  return (
    <Flex vertical gap="middle">
      <Typography.Title level={4} className="admin-page-title">
        {adminsTexts.title}
      </Typography.Title>
      <Alert type="info" showIcon role="note" message={adminsTexts.note} />
      {body}
    </Flex>
  );
}
