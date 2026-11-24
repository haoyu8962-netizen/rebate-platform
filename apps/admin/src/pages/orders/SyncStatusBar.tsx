// The sync status bar above the order list (F1-07edb, BR-ID-46): it always shows the latest sync
// record, read once when the list first loads through the existing records operation
// (GET /admin/v1/order-syncs with page=1, page_size=1; no limits read). It shows the platform's
// display name (./platforms.ts, all nine platforms alike), the status's console dictionary name
// and the creation time in Beijing time; no record shows the empty text. A failed read only shows
// a line in the bar: the list is not affected and no global notice is raised.
import { SyncOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import { Flex, Tag, Typography, theme } from 'antd';
import { useEffect, useState, type ReactElement } from 'react';
import { usePlanned } from '../../components/planned/index.ts';
import { ordersTexts } from '../../texts/orders.ts';
import {
  SYNCS_URL,
  beijingMinute,
  platformLabel,
  syncStatusName,
  syncTone,
  type SyncItem,
  type SyncPage,
} from './model.ts';

const t = ordersTexts.sync.bar;

type Latest =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly item: SyncItem | undefined }
  | { readonly status: 'failed' };

export function SyncStatusBar(): ReactElement | null {
  // adminListOrderSyncs not live yet (planned): no bar and no read (D10-284).
  const planned = usePlanned('adminListOrderSyncs');
  return planned ? null : <SyncStatusLine />;
}

function SyncStatusLine(): ReactElement {
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const [latest, setLatest] = useState<Latest>({ status: 'loading' });

  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<SyncPage>({ url: SYNCS_URL, method: 'get', query: { page: 1, page_size: 1 } }).then(
      (response) => {
        if (current) setLatest({ status: 'ready', item: response.data.items[0] });
      },
      () => {
        if (current) setLatest({ status: 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider]);

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
