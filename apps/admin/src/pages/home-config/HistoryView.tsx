// Version history view (design-hifi AdmHomeConfigVersions): the released / gray card with the gray
// operations the contract offers (调整比例, 转为全量, 停止灰度 = roll back the gray version), the
// server-paged version table, and a read-only JSON view of one version. Only contract operations
// appear per row: 查看, 发布 for drafts, 回滚 for the gray version or (without one) the full one.
import { Alert, Button, Card, Empty, Flex, Table, Tag, Typography, theme } from 'antd';
import type { TableColumnsType } from 'antd';
import type { ReactElement, ReactNode } from 'react';
import { homeConfigTexts as t } from '../../texts/home-config.ts';
import {
  beijingTime,
  canRollback,
  errorRate,
  percentOf,
  roleOf,
  type PageConfig,
  type Section,
  type VersionRole,
  type VersionSummary,
} from './model.ts';

export interface VersionsState {
  readonly status: 'loading' | 'ready' | 'failed';
  readonly items: readonly VersionSummary[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface VersionDetailState {
  readonly version: number;
  readonly status: 'loading' | 'ready' | 'failed';
  readonly sections?: readonly Section[];
}

export interface HistoryViewProps {
  readonly pageKey: string;
  readonly page: PageConfig | null;
  readonly versions: VersionsState;
  readonly detail: VersionDetailState | null;
  readonly busy: boolean;
  readonly notice: ReactNode;
  readonly onBack: () => void;
  readonly onPage: (page: number) => void;
  readonly onRetry: () => void;
  readonly onView: (version: number) => void;
  readonly onCloseDetail: () => void;
  readonly onPublish: (version: number) => void;
  readonly onRollback: (version: number) => void;
  readonly onAdjust: () => void;
  readonly onFull: () => void;
  readonly onStop: () => void;
}

const ROLE_COLOR: Record<VersionRole, string> = {
  draft: 'default',
  full: 'success',
  graying: 'warning',
  replaced: 'default',
  rolledBack: 'error',
};

export function HistoryView(props: HistoryViewProps): ReactElement {
  const { token } = theme.useToken();
  const { page, versions } = props;
  const small = { fontSize: 12 } as const;
  const card = { boxShadow: token.boxShadowTertiary } as const;
  const big = { margin: 0, fontWeight: 600 } as const;

  const columns: TableColumnsType<VersionSummary> = [
    {
      key: 'version',
      title: t.history.columns.version,
      width: 88,
      render: (_, row) => <Typography.Text>{t.version(row.version)}</Typography.Text>,
    },
    {
      key: 'status',
      title: t.history.columns.status,
      width: 160,
      render: (_, row) => {
        const role = roleOf(row, page);
        return (
          <Tag color={ROLE_COLOR[role]} style={{ marginInlineEnd: 0 }}>
            {t.history.status[role]}
          </Tag>
        );
      },
    },
    {
      key: 'percent',
      title: t.history.columns.percent,
      width: 96,
      align: 'right',
      render: (_, row) => {
        const percent = percentOf(row, page);
        return <Typography.Text>{percent === null ? t.dash : t.percent(percent)}</Typography.Text>;
      },
    },
    {
      key: 'renders',
      title: t.history.columns.renders,
      width: 96,
      align: 'right',
      render: (_, row) => <Typography.Text>{String(row.render_count)}</Typography.Text>,
    },
    {
      key: 'errors',
      title: t.history.columns.errors,
      width: 96,
      align: 'right',
      render: (_, row) => <Typography.Text>{String(row.error_count)}</Typography.Text>,
    },
    {
      key: 'errorRate',
      title: t.history.columns.errorRate,
      width: 96,
      align: 'right',
      render: (_, row) => (
        <Typography.Text>{errorRate(row.render_count, row.error_count) ?? t.dash}</Typography.Text>
      ),
    },
    {
      key: 'publisher',
      title: t.history.columns.publisher,
      width: 140,
      render: (_, row) => <Typography.Text>{row.publisher ?? t.dash}</Typography.Text>,
    },
    {
      key: 'publishedAt',
      title: t.history.columns.publishedAt,
      width: 160,
      render: (_, row) => (
        <Typography.Text>
          {row.publish_at === null ? t.dash : beijingTime(row.publish_at)}
        </Typography.Text>
      ),
    },
    {
      key: 'actions',
      title: t.history.columns.actions,
      render: (_, row) => (
        <Flex gap={4} wrap>
          <Button
            type="link"
            size="small"
            style={{ paddingInline: 0 }}
            onClick={() => props.onView(row.version)}
          >
            {t.actions.view}
          </Button>
          {row.status === 'draft' ? (
            <Button
              type="link"
              size="small"
              style={{ paddingInline: 4 }}
              disabled={props.busy || page === null || page.gray_version !== null}
              onClick={() => props.onPublish(row.version)}
            >
              {t.actions.publish}
            </Button>
          ) : null}
          {canRollback(row, page) ? (
            <Button
              type="link"
              size="small"
              danger
              style={{ paddingInline: 4 }}
              disabled={props.busy}
              onClick={() => props.onRollback(row.version)}
            >
              {t.actions.rollback}
            </Button>
          ) : null}
        </Flex>
      ),
    },
  ];

  const gray = page?.gray_version ?? null;
  const current = page?.current_version ?? null;

  let detail: ReactNode = null;
  if (props.detail !== null) {
    const view = props.detail;
    detail = (
      <Card
        style={card}
        size="small"
        title={t.history.detailTitle(view.version)}
        extra={
          <Button size="small" onClick={props.onCloseDetail}>
            {t.actions.close}
          </Button>
        }
      >
        {view.status === 'loading' ? (
          <Typography.Text type="secondary" role="status">
            {t.history.detailLoading}
          </Typography.Text>
        ) : null}
        {view.status === 'failed' ? (
          <Typography.Text type="danger">{t.history.detailFailed}</Typography.Text>
        ) : null}
        {view.status === 'ready' && view.sections !== undefined ? (
          <pre
            style={{
              margin: 0,
              maxHeight: 480,
              overflow: 'auto',
              padding: 12,
              borderRadius: token.borderRadius,
              background: token.colorFillQuaternary,
              fontFamily: token.fontFamilyCode,
              fontSize: 12,
            }}
          >
            {JSON.stringify(view.sections, null, 2)}
          </pre>
        ) : null}
      </Card>
    );
  }

  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center" gap={16} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t.history.title(props.pageKey)}
        </Typography.Title>
        <Button onClick={props.onBack}>{t.actions.back}</Button>
      </Flex>
      {props.notice}
      <Card style={card}>
        <Flex vertical gap={16}>
          <Flex gap={24} wrap>
            <Flex vertical gap={4} style={{ flex: 1, minWidth: 200 }}>
              <Typography.Text type="secondary" style={small}>
                {t.history.current}
              </Typography.Text>
              <Typography.Title level={3} style={big}>
                {current === null ? t.history.none : t.version(current)}
              </Typography.Title>
              {current === null ? null : (
                <span>
                  <Tag color="success">{t.history.fullTag}</Tag>
                </span>
              )}
            </Flex>
            <Flex vertical gap={4} style={{ flex: 1, minWidth: 200 }}>
              <Typography.Text type="secondary" style={small}>
                {t.history.grayCard}
              </Typography.Text>
              <Typography.Title level={3} style={big}>
                {gray === null || page === null
                  ? t.history.noGray
                  : t.history.grayValue(gray, page.gray_percent)}
              </Typography.Title>
              {gray === null ? null : (
                <span>
                  <Tag color="warning">{t.history.grayTag}</Tag>
                </span>
              )}
            </Flex>
            {gray === null ? null : (
              <Flex vertical gap={8} style={{ flex: 1, minWidth: 280 }}>
                <Typography.Text type="secondary" style={small}>
                  {t.history.grayActions}
                </Typography.Text>
                <Flex gap={8} wrap>
                  <Button disabled={props.busy} onClick={props.onAdjust}>
                    {t.actions.adjust}
                  </Button>
                  <Button type="primary" disabled={props.busy} onClick={props.onFull}>
                    {t.actions.full}
                  </Button>
                  <Button danger disabled={props.busy} onClick={props.onStop}>
                    {t.actions.stop}
                  </Button>
                </Flex>
              </Flex>
            )}
          </Flex>
          <Alert type="info" showIcon message={t.history.bucketNote(current)} />
        </Flex>
      </Card>
      {detail}
      <Card style={card} styles={{ body: { padding: 0 } }}>
        {versions.status === 'failed' ? (
          <Flex vertical align="center" gap={8} style={{ padding: 24 }}>
            <Typography.Text type="danger">{t.history.failed}</Typography.Text>
            <Button onClick={props.onRetry}>{t.actions.retry}</Button>
          </Flex>
        ) : (
          <Table<VersionSummary>
            rowKey="version"
            columns={columns}
            dataSource={[...versions.items]}
            loading={versions.status === 'loading' && versions.items.length === 0}
            locale={{ emptyText: <Empty description={t.history.empty} /> }}
            tableLayout="fixed"
            pagination={{
              current: versions.page,
              pageSize: versions.pageSize,
              total: versions.total,
              showSizeChanger: false,
              showTotal: (total) => t.history.total(total),
              onChange: props.onPage,
              style: { paddingInline: 16 },
            }}
          />
        )}
      </Card>
    </Flex>
  );
}
