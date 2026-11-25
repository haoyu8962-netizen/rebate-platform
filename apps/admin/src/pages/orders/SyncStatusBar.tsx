// The sync status bar above the order list (F1-07edb, BR-ID-46): it shows the latest sync record
// as of the moment it was read, through the existing records operation (GET /admin/v1/order-syncs
// with page=1, page_size=1; no limits read). It is read once when the list first loads and once
// more on each click of its 【刷新】 (the order list is not read again); a manual sync submitted on
// this page does not change it. It shows the platform's display name (./platforms.ts, all nine
// platforms alike), the status's console dictionary name, the creation time in Beijing time and
// 「更新于 HH:mm:ss」, the Beijing time the read succeeded; no record shows the empty text. A failed
// read only shows a line in the bar: the list is not affected and no global notice is raised. Of
// overlapping reads only the answer to the last one sent is shown (./sync-bar.ts).
import { ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import { Button, Flex, Tag, Typography, theme } from 'antd';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { usePlanned } from '../../components/planned/index.ts';
import { ordersTexts } from '../../texts/orders.ts';
import {
  SYNCS_URL,
  beijingMinute,
  platformLabel,
  syncStatusName,
  syncTone,
  type SyncPage,
} from './model.ts';
import {
  syncBarReader,
  syncBarUpdated,
  type SyncBarReader,
  type SyncBarState,
} from './sync-bar.ts';

const t = ordersTexts.sync.bar;

export function SyncStatusBar(): ReactElement | null {
  // adminListOrderSyncs not live yet (planned): no bar and no read (D10-284).
  const planned = usePlanned('adminListOrderSyncs');
  return planned ? null : <SyncStatusLine />;
}

function SyncStatusLine(): ReactElement {
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const [latest, setLatest] = useState<SyncBarState>({ status: 'loading' });
  const reader = useRef<SyncBarReader | undefined>(undefined);

  // The first load: exactly one read.
  useEffect(() => {
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    const mounted = syncBarReader(
      () =>
        custom<SyncPage>({ url: SYNCS_URL, method: 'get', query: { page: 1, page_size: 1 } }).then(
          (response) => response.data,
        ),
      setLatest,
    );
    reader.current = mounted;
    mounted.load();
    return () => {
      mounted.stop();
      if (reader.current === mounted) reader.current = undefined;
    };
  }, [getProvider]);

  // 【刷新】: exactly one more read; what is shown stays until its answer arrives.
  const refresh = () => reader.current?.load();

  const small = { fontSize: token.fontSizeSM } as const;
  let content: ReactElement;
  if (latest.status === 'loading') {
    content = (
      <Typography.Text type="secondary" style={small}>
        {t.loading}
      </Typography.Text>
    );
  } else if (latest.status === 'failed') {
    content = (
      <Typography.Text type="warning" style={small}>
        {t.failed}
      </Typography.Text>
    );
  } else if (latest.item === undefined) {
    content = (
      <Flex align="center" gap={8} wrap>
        <Typography.Text type="secondary" style={small}>
          {t.empty}
        </Typography.Text>
        <Typography.Text type="secondary" style={small}>
          {t.updatedAt(syncBarUpdated(latest.readAt))}
        </Typography.Text>
      </Flex>
    );
  } else {
    const item = latest.item;
    content = (
      <Flex align="center" gap={8} wrap>
        <Typography.Text style={small}>{platformLabel(item.platform)}</Typography.Text>
        <Tag color={syncTone(item.status)} style={{ marginInlineEnd: 0 }}>
          {syncStatusName(item.status)}
        </Tag>
        <Typography.Text type="secondary" style={small}>
          {t.createdAt(beijingMinute(item.created_at))}
        </Typography.Text>
        <Typography.Text type="secondary" style={small}>
          {t.updatedAt(syncBarUpdated(latest.readAt))}
        </Typography.Text>
      </Flex>
    );
  }

  return (
    <Flex align="center" gap={8} wrap aria-live="polite">
      <SyncOutlined aria-hidden style={{ color: token.colorTextTertiary }} />
      <Typography.Text type="secondary" style={small}>
        {t.label}
      </Typography.Text>
      {content}
      <Button
        size="small"
        type="link"
        autoInsertSpace={false}
        icon={<ReloadOutlined aria-hidden />}
        onClick={refresh}
      >
        {t.refresh}
      </Button>
    </Flex>
  );
}
