// The sync status bar above the order list (F1-07edb, BR-ID-46): it always shows the latest sync
// record, read once when the list first loads through the existing records operation
// (GET /admin/v1/order-syncs with page=1, page_size=1; no limits read). It shows the platform's
// display name (./platforms.ts, all nine platforms alike), the status's console dictionary name
// and the creation time in Beijing time; no record shows the empty text. A failed read only shows
// a line in the bar: the list is not affected and no global notice is raised. Only that read is
// shown: after a manual sync is accepted on this page (created or reused) the bar reads it once
// more, and of overlapping reads only the answer to the last one sent is shown (./sync-bar.ts).
import { SyncOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import { Flex, Tag, Typography, theme } from 'antd';
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
import { syncBarReader, type SyncBarReader, type SyncBarState } from './sync-bar.ts';

const t = ordersTexts.sync.bar;

export interface SyncStatusBarProps {
  /** Manual syncs accepted on this page so far; each new one reads the latest record again. */
  readonly refresh: number;
}

export function SyncStatusBar({ refresh }: SyncStatusBarProps): ReactElement | null {
  // adminListOrderSyncs not live yet (planned): no bar and no read (D10-284).
  const planned = usePlanned('adminListOrderSyncs');
  return planned ? null : <SyncStatusLine refresh={refresh} />;
}

function SyncStatusLine({ refresh }: SyncStatusBarProps): ReactElement {
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const [latest, setLatest] = useState<SyncBarState>({ status: 'loading' });
  const reader = useRef<SyncBarReader | undefined>(undefined);
  const seen = useRef(refresh);

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

  // A manual sync accepted since: one more read.
  useEffect(() => {
    if (refresh === seen.current) return;
    seen.current = refresh;
    reader.current?.load();
  }, [refresh]);

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
      <Typography.Text type="secondary" style={small}>
        {t.empty}
      </Typography.Text>
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
    </Flex>
  );
}
