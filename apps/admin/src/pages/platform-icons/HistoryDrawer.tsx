import { useDataProvider } from '@refinedev/core';
import { PictureOutlined, UndoOutlined, UploadOutlined } from '@ant-design/icons';
import {
  Alert,
  Avatar,
  Button,
  Drawer,
  Flex,
  Pagination,
  Result,
  Space,
  Typography,
  theme,
} from 'antd';
import { useEffect, useState } from 'react';
import { platformIconsTexts as t } from '../../texts/platform-icons.ts';
import {
  canPublish,
  currentLabel,
  time,
  type ActionKind,
  type Icon,
  type Version,
} from './model.ts';
import { builtinRow, Preview } from './Preview.tsx';
import { VersionDetails } from './VersionDetails.tsx';
import { StatusTag } from './StatusTag.tsx';
import { DelayedSpin } from '../../components/loading/index.ts';

export function HistoryDrawer({
  icon,
  refresh,
  onClose,
  onAction,
  onUpload,
  onSource,
  savedVersion,
}: {
  readonly icon: Icon;
  readonly refresh: number;
  readonly onClose: () => void;
  readonly onAction: (kind: ActionKind, target?: Version, retained?: readonly number[]) => void;
  readonly onUpload: () => void;
  readonly onSource: (version: Version) => void;
  readonly savedVersion: Version | undefined;
}) {
  const provider = useDataProvider();
  const { token } = theme.useToken();
  const [pagination, setPagination] = useState({ page: 1, saved: savedVersion?.version });
  // A newly saved version belongs on page one without remounting the drawer underneath it.
  const page = pagination.saved === savedVersion?.version ? pagination.page : 1;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    status: 'loading' | 'ready' | 'failed';
    items: Version[];
    total: number;
  }>({ status: 'loading', items: [], total: 0 });
  useEffect(() => {
    let active = true;
    void provider()
      .getList<Version>({
        resource: `platform-icons/${icon.key}/versions`,
        pagination: { currentPage: page, pageSize: 20, mode: 'server' },
      })
      .then(
        (result) => {
          if (active) setState({ status: 'ready', items: result.data, total: result.total });
        },
        () => {
          if (active) setState({ status: 'failed', items: [], total: 0 });
        },
      );
    return () => {
      active = false;
    };
  }, [provider, icon.key, page, attempt, refresh]);
  const platform = t.names[icon.key];
  const pages = Math.max(1, Math.ceil(state.total / 20));
  const changePage = (next: number) => {
    setState((old) => ({ ...old, status: 'loading', items: [] }));
    setPagination({ page: next, saved: savedVersion?.version });
  };
  return (
    <Drawer
      open
      width={720}
      closable={{ placement: 'end' }}
      title={
        <div>
          {t.historyTitle(platform)}
          <div style={{ fontSize: 12, fontWeight: 400, color: token.colorTextSecondary }}>
            {icon.key} · {t.permission} · {t.immediate}
          </div>
        </div>
      }
      onClose={onClose}
      footer={
        <Flex justify="end">
          <Button onClick={onClose}>{t.close}</Button>
        </Flex>
      }
    >
      <Flex vertical gap={16}>
        {savedVersion && (
          <Alert
            type="success"
            showIcon
            style={{ border: 0, background: 'var(--color-status-success-background)' }}
            message={
              savedVersion.publishable
                ? t.savedPublishable(savedVersion.version)
                : t.savedDraft(savedVersion.version)
            }
          />
        )}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            background: token.colorInfoBg,
            borderRadius: token.borderRadius,
            padding: 12,
          }}
        >
          <div>
            <Typography.Text type="secondary">{t.current}</Typography.Text>
            <div>
              <StatusTag tone={icon.current ? 'success' : 'neutral'}>
                {currentLabel(icon)}
              </StatusTag>
            </div>
          </div>
          <div>
            <Typography.Text type="secondary">{t.changed}</Typography.Text>
            <div>
              {icon.updated_at ? `${time(icon.updated_at)} · ${icon.updated_by ?? t.dash}` : t.dash}
            </div>
          </div>
          <div>
            <Typography.Text type="secondary">{t.savedVersions}</Typography.Text>
            <div>{t.savedCount(state.total)}</div>
          </div>
        </div>
        {!(state.status === 'ready' && state.total === 0) && (
          <Flex justify="space-between" align="center">
            <Typography.Text strong>{t.versions}</Typography.Text>
            <Space>
              <Button icon={<UploadOutlined aria-hidden />} onClick={onUpload}>
                {t.uploadNew}
              </Button>
              <Button
                icon={<UndoOutlined aria-hidden />}
                disabled={icon.current_version === null}
                onClick={() => onAction('restore')}
              >
                {t.restore}
              </Button>
            </Space>
          </Flex>
        )}
        {state.status === 'loading' ? (
          <DelayedSpin />
        ) : state.status === 'failed' ? (
          <Result
            status="error"
            title={t.historyFailed}
            extra={
              <Button
                onClick={() => {
                  setState((old) => ({ ...old, status: 'loading' }));
                  setAttempt((n) => n + 1);
                }}
              >
                {t.retry}
              </Button>
            }
          />
        ) : state.total === 0 ? (
          <>
            <Typography.Text strong>{t.builtinPreview}</Typography.Text>
            <Preview iconKey={icon.key} rows={[builtinRow(icon.key)]} />
            <Result
              icon={
                <Avatar
                  shape="square"
                  size={96}
                  icon={<PictureOutlined />}
                  style={{
                    background: token.colorInfoBg,
                    color: token.colorTextSecondary,
                    borderRadius: token.borderRadiusLG,
                  }}
                />
              }
              title={
                <Typography.Text strong style={{ fontSize: 16 }}>
                  {t.empty}
                </Typography.Text>
              }
              subTitle={t.emptyDescription(platform)}
              extra={
                <Button type="primary" icon={<UploadOutlined aria-hidden />} onClick={onUpload}>
                  {t.uploadReplacement}
                </Button>
              }
            />
          </>
        ) : (
          <>
            <Flex vertical gap={12} role="list">
              {state.items.map((version) => {
                const live = version.version === icon.current_version;
                const publishable = canPublish(version);
                const rollback =
                  publishable &&
                  icon.current_version !== null &&
                  version.version < icon.current_version;
                const label = live
                  ? t.current
                  : !publishable
                    ? t.draft
                    : version.ever_published
                      ? t.published
                      : t.publishable;
                return (
                  <div
                    key={version.version}
                    role="listitem"
                    style={{
                      padding: 16,
                      border: `1px solid ${live ? token.colorPrimary : token.colorBorderSecondary}`,
                      borderRadius: token.borderRadius,
                      background: live ? 'var(--color-brand-subtle)' : token.colorBgContainer,
                    }}
                  >
                    <Flex justify="space-between" align="center" style={{ marginBottom: 12 }}>
                      <Space>
                        <Typography.Text strong>{t.version(version.version)}</Typography.Text>
                        <StatusTag tone={live ? 'success' : !publishable ? 'warning' : 'neutral'}>
                          {label}
                        </StatusTag>
                      </Space>
                      <Space size={8}>
                        {!version.ever_published && !live && (
                          <Button
                            type="link"
                            size="small"
                            aria-label={
                              publishable
                                ? t.editName(platform, version.version)
                                : t.registerName(platform, version.version)
                            }
                            onClick={() => onSource(version)}
                          >
                            {publishable ? t.editSource : t.register}
                          </Button>
                        )}
                        {!live && (
                          <Button
                            type={
                              savedVersion?.version === version.version && publishable
                                ? 'primary'
                                : 'link'
                            }
                            size="small"
                            disabled={!publishable}
                            aria-label={
                              rollback
                                ? t.rollbackName(platform, version.version)
                                : t.publishName(platform, version.version)
                            }
                            onClick={() =>
                              onAction(
                                rollback ? 'rollback' : 'publish',
                                version,
                                state.items
                                  .filter((item) => item.version !== version.version)
                                  .map((item) => item.version)
                                  .sort((a, b) => a - b),
                              )
                            }
                          >
                            {rollback ? t.rollbackTo : t.publish}
                          </Button>
                        )}
                      </Space>
                    </Flex>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '292px minmax(0, 1fr)',
                        gap: 16,
                      }}
                    >
                      <Preview
                        iconKey={icon.key}
                        rows={[
                          { label: t.version(version.version), url: version.url },
                          builtinRow(icon.key),
                        ]}
                      />
                      <VersionDetails version={version} />
                    </div>
                    {(!publishable || !live) && (
                      <Typography.Paragraph
                        type="secondary"
                        style={{ fontSize: 12, margin: '12px 0 0' }}
                      >
                        {!publishable
                          ? t.sourceRequired
                          : version.ever_published
                            ? t.sourceLocked
                            : t.sourceEditable}
                      </Typography.Paragraph>
                    )}
                  </div>
                );
              })}
            </Flex>
            <Flex justify="space-between" align="center" gap={8}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t.pagination(state.total, page, pages)}
              </Typography.Text>
              <Pagination
                current={page}
                total={state.total}
                pageSize={20}
                showSizeChanger={false}
                onChange={changePage}
                itemRender={(_, type) =>
                  type === 'prev' || type === 'next' ? (
                    <Button
                      size="small"
                      style={{
                        background: token.colorInfoBg,
                        borderColor: token.colorBorderSecondary,
                      }}
                      disabled={type === 'prev' ? page <= 1 : page >= pages}
                    >
                      {type === 'prev' ? t.previous : t.next}
                    </Button>
                  ) : null
                }
              />
            </Flex>
          </>
        )}
      </Flex>
    </Drawer>
  );
}
