// 直推名单抽屉（design-hifi AdmUserInvitees；adminListInvitees，权限点 user.lookup 或 user.list）：
// 打开时才请求，页码分页（page / page_size），只显示契约五个字段（手机号只有脱敏值）；加载中、
// 空、出错（【重试】只再请求一次）三态；行操作「查看 <UID>」打开该用户详情。
import type { Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import {
  Button,
  Drawer,
  Empty,
  Flex,
  Result,
  Table,
  Typography,
  theme,
  type TableColumnsType,
  type TablePaginationConfig,
} from 'antd';
import { useEffect, useState, type ReactElement } from 'react';
import { usersTexts } from '../../../texts/users.ts';
import { beijingTime } from '../model.ts';
import type { InviteesDrawerProps } from './types.ts';
import { delayedLoading, useLoadingClock } from '../../../motion.ts';

const t = usersTexts.relations.invitees;
const USERS_URL = '/admin/v1/users';
/** 画板 10 条 / 页（契约 page_size ≤ 200）。 */
const PAGE_SIZE = 10;

type Invitee = Schema<'AdminInviteeListItem'>;
type Status = 'loading' | 'ready' | 'failed';

interface Paging {
  readonly page: number;
  readonly size: number;
}

const FIRST: Paging = { page: 1, size: PAGE_SIZE };

export function InviteesDrawer({
  userId,
  open,
  onClose,
  onOpenUser,
  afterClose,
}: InviteesDrawerProps): ReactElement {
  const loadingClock = useLoadingClock();
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const [paging, setPaging] = useState<Paging>(FIRST);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<Status>('loading');
  const [items, setItems] = useState<readonly Invitee[]>([]);
  const [total, setTotal] = useState<number>();

  useEffect(() => {
    if (!open) return;
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<Schema<'AdminInviteePage'>>({
      url: `${USERS_URL}/${encodeURIComponent(userId)}/invitees`,
      method: 'get',
      query: { page: paging.page, page_size: paging.size },
    }).then(
      (response) => {
        if (!current) return;
        setItems(response.data.items);
        setTotal(response.data.total);
        setStatus('ready');
      },
      () => {
        if (!current) return;
        setStatus('failed');
      },
    );
    return () => {
      // 翻页、关闭或离开详情后，旧回答不再显示。
      current = false;
    };
    // `attempt` 让【重试】按同样的页码再请求一次。
  }, [getProvider, userId, open, paging, attempt]);

  // 关闭后清空，下次打开从第 1 页重新读取（渲染期按上一次的 open 调整，不用 effect）。
  const [shown, setShown] = useState(open);
  if (shown !== open) {
    setShown(open);
    if (!open) {
      setPaging(FIRST);
      setItems([]);
      setTotal(undefined);
      setStatus('loading');
    }
  }

  const retry = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  const changePage = (pagination: TablePaginationConfig) => {
    const size = pagination.pageSize ?? paging.size;
    const page = size === paging.size ? (pagination.current ?? paging.page) : 1;
    if (page === paging.page && size === paging.size) return;
    setStatus('loading');
    setPaging({ page, size });
  };

  const code = { fontFamily: token.fontFamilyCode } as const;
  const columns: TableColumnsType<Invitee> = [
    {
      key: 'uid',
      title: t.columns.uid,
      render: (_, row) => (
        <Button
          type="link"
          size="small"
          aria-label={t.open(row.user_id)}
          style={{ paddingInline: 0, height: 'auto', ...code }}
          onClick={() => onOpenUser(row.user_id)}
        >
          {row.user_id}
        </Button>
      ),
    },
    { key: 'nickname', title: t.columns.nickname, render: (_, row) => row.nickname },
    {
      key: 'phone',
      title: t.columns.phone,
      width: 120,
      render: (_, row) => row.phone_masked ?? usersTexts.dash,
    },
    {
      key: 'registeredAt',
      title: t.columns.registeredAt,
      width: 150,
      render: (_, row) => beijingTime(row.registered_at),
    },
    { key: 'level', title: t.columns.level, width: 64, render: (_, row) => row.level },
  ];

  const title = (
    <Flex vertical gap={4}>
      <span>{t.title(userId)}</span>
      <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM, fontWeight: 400 }}>
        {total === undefined ? t.summary : `${t.count(total)} · ${t.summary}`}
      </Typography.Text>
    </Flex>
  );

  return (
    <Drawer
      open={open}
      width={800}
      title={title}
      closable={{ placement: 'end' }}
      onClose={onClose}
      afterOpenChange={(visible) => {
        if (!visible) afterClose?.();
      }}
      footer={
        <Flex justify="end">
          <Button onClick={onClose}>{t.close}</Button>
        </Flex>
      }
    >
      {status === 'failed' ? (
        <Result
          status="error"
          title={t.failedTitle}
          subTitle={t.failedDescription}
          extra={<Button onClick={retry}>{t.retry}</Button>}
        />
      ) : (
        <Table<Invitee>
          aria-label={t.tableLabel}
          rowKey="user_id"
          size="middle"
          columns={columns}
          dataSource={status === 'loading' && total === undefined ? [] : [...items]}
          loading={delayedLoading(status === 'loading', loadingClock)}
          locale={{
            emptyText:
              status === 'loading' ? (
                <Typography.Text type="secondary" role="status">
                  {t.loading}
                </Typography.Text>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t.empty} />
              ),
          }}
          pagination={{
            current: paging.page,
            pageSize: paging.size,
            total: total ?? 0,
            showSizeChanger: false,
            showTotal: (count) => t.total(count),
            hideOnSinglePage: false,
          }}
          onChange={changePage}
        />
      )}
    </Drawer>
  );
}
