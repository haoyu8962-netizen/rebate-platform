import type { Schema } from '@couli/contracts-ts';
import { InfoCircleOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  ConfigProvider,
  Flex,
  Result,
  Space,
  Table,
  Typography,
  theme,
  type TableColumnsType,
} from 'antd';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { AdminApiError } from '../../providers/data/index.ts';
import { platformIconsTexts as t } from '../../texts/platform-icons.ts';
import { ConfirmationModal } from './ConfirmationModal.tsx';
import { HistoryDrawer } from './HistoryDrawer.tsx';
import { PermissionLine } from './PermissionLine.tsx';
import { StatusTag } from './StatusTag.tsx';
import { SourceDialog, UploadDialog } from './upload.ts';
import {
  currentLabel,
  time,
  type ActionError,
  type ActionKind,
  type Confirmation,
  type Icon,
  type Version,
} from './model.ts';
import { builtinRow, Preview } from './Preview.tsx';
import { delayedLoading, useLoadingClock } from '../../motion.ts';

export interface PlatformIconsPageProps {
  readonly now?: () => Date;
}
type LoadStatus = 'loading' | 'ready' | 'failed' | 'forbidden';

export function PlatformIconsPage({ now }: PlatformIconsPageProps): ReactElement {
  const loadingClock = useLoadingClock();
  const getProvider = useDataProvider();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const [items, setItems] = useState<Icon[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [historyKey, setHistoryKey] = useState<Icon['key']>();
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [uploadIcon, setUploadIcon] = useState<Icon>();
  const [sourceTarget, setSourceTarget] = useState<{ key: Icon['key']; version: Version }>();
  const [savedVersion, setSavedVersion] = useState<{ key: Icon['key']; version: Version }>();
  const [unknownKey, setUnknownKey] = useState(false);
  const [action, setAction] = useState<Confirmation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ActionError>();
  const [result, setResult] = useState<{ key: Icon['key']; message: string }>();
  const listSequence = useRef(0);
  const writeSequence = useRef(0);
  const writing = useRef(false);
  const loadList = useCallback((): Promise<Icon[] | undefined> => {
    const request = ++listSequence.current;
    return Promise.resolve()
      .then(() => {
        const custom = getProvider().custom;
        if (!custom) throw new Error('Missing custom data provider');
        return custom<Schema<'AdminPlatformIconList'>>({
          url: '/admin/v1/platform-icons',
          method: 'get',
        });
      })
      .then(
        (response) => {
          if (request !== listSequence.current) return undefined;
          setItems(response.data.items);
          setStatus('ready');
          return response.data.items;
        },
        (cause: unknown) => {
          if (request === listSequence.current)
            setStatus(
              cause instanceof AdminApiError && cause.code === 10403 ? 'forbidden' : 'failed',
            );
          return undefined;
        },
      );
  }, [getProvider]);
  const invalidateRequests = useCallback(() => {
    listSequence.current++;
    writeSequence.current++;
  }, []);
  useEffect(() => {
    void loadList();
    return invalidateRequests;
  }, [loadList, invalidateRequests]);

  const openUpload = (icon: Icon) => {
    setUnknownKey(false);
    setSavedVersion(undefined);
    setUploadIcon(icon);
  };
  const handleUnknownKey = () => {
    setUploadIcon(undefined);
    setSourceTarget(undefined);
    setAction(undefined);
    setHistoryKey(undefined);
    setResult(undefined);
    setUnknownKey(true);
    void loadList();
  };
  const refreshSource = () => {
    setSourceTarget(undefined);
    setHistoryRefresh((n) => n + 1);
    void loadList();
  };
  const audit = () => {
    void navigate('/audit-logs');
  };
  const openAction = (
    icon: Icon,
    kind: ActionKind,
    fromHistory: boolean,
    target?: Version,
    retained: readonly number[] = [],
  ) => {
    setError(undefined);
    setAction({
      kind,
      icon,
      fromHistory,
      ...(target ? { target } : {}),
      openedAt: (now?.() ?? new Date()).toISOString(),
      retained,
    });
  };
  const closeHistory = () => {
    setHistoryKey(undefined);
    setSavedVersion(undefined);
    void loadList();
  };
  const refreshHistory = () => {
    const fromHistory = action?.fromHistory;
    setAction(undefined);
    setError(undefined);
    void loadList();
    if (fromHistory) setHistoryRefresh((n) => n + 1);
  };
  const submit = async () => {
    if (!action || writing.current || error) return;
    writing.current = true;
    const request = ++writeSequence.current;
    listSequence.current++;
    setBusy(true);
    const { icon, kind, target } = action;
    try {
      const custom = getProvider().custom;
      if (!custom) throw new Error('Missing custom data provider');
      // Confirm exactly the mark revision shown when the modal opened.
      const response = await custom<Icon>({
        url: `/admin/v1/platform-icons/${icon.key}/${kind === 'restore' ? 'restore-builtin' : 'publish'}`,
        method: 'post',
        payload:
          kind === 'restore'
            ? { expected_revision: icon.revision }
            : { version: target?.version, expected_revision: icon.revision },
      });
      if (request !== writeSequence.current) return;
      // Invalidate every read started before this successful write, then apply its response.
      listSequence.current++;
      setItems((old) => old.map((item) => (item.key === response.data.key ? response.data : item)));
      setStatus('ready');
      setResult({
        key: icon.key,
        message:
          kind === 'restore'
            ? t.restoreSuccess(t.names[icon.key], response.data.latest_version ?? 0)
            : t.success(t.names[icon.key], target?.version ?? 0, kind === 'rollback'),
      });
      setAction(undefined);
      setHistoryKey(undefined);
      setSavedVersion(undefined);
    } catch (cause) {
      if (request !== writeSequence.current) return;
      if (cause instanceof AdminApiError && cause.code === 20902) {
        setError({ kind: 'conflict' });
        const fresh = await loadList();
        if (request !== writeSequence.current) return;
        const latest = fresh?.find((item) => item.key === icon.key);
        setError({ kind: 'conflict', ...(latest ? { latest } : {}) });
      } else if (cause instanceof AdminApiError && cause.code === 20001) {
        const data = cause.data;
        const fields =
          typeof data === 'object' &&
          data !== null &&
          'fields' in data &&
          Array.isArray(data.fields)
            ? data.fields
            : [];
        if (fields.includes('key')) {
          handleUnknownKey();
          return;
        }
        setError({
          kind: fields.includes('version')
            ? 'version'
            : fields.includes('source_url') || fields.includes('downloaded_on')
              ? 'source'
              : 'failed',
        });
      } else setError({ kind: 'failed' });
    } finally {
      writing.current = false;
      if (request === writeSequence.current) setBusy(false);
    }
  };
  const columns: TableColumnsType<Icon> = [
    {
      title: t.columns[0],
      key: 'identity',
      width: 144,
      render: (_, icon) => (
        <>
          <Typography.Text strong>{t.names[icon.key]}</Typography.Text>
          <div style={{ fontSize: 12, fontFamily: 'monospace', color: token.colorTextSecondary }}>
            {icon.key}
          </div>
        </>
      ),
    },
    {
      title: t.columns[1],
      key: 'current',
      width: 184,
      render: (_, icon) => (
        <>
          <StatusTag tone={icon.current ? 'success' : 'neutral'}>{currentLabel(icon)}</StatusTag>
          {icon.latest_version !== null && icon.latest_version > (icon.current_version ?? 0) && (
            <div style={{ fontSize: 12, marginTop: 4 }}>{t.unpublished(icon.latest_version)}</div>
          )}
        </>
      ),
    },
    {
      title: t.columns[2],
      key: 'preview',
      width: 316,
      render: (_, icon) => (
        <Preview
          iconKey={icon.key}
          rows={[
            ...(icon.current
              ? [{ label: t.version(icon.current.version), url: icon.current.url }]
              : []),
            builtinRow(icon.key),
          ]}
        />
      ),
    },
    {
      title: t.columns[3],
      key: 'source',
      width: 168,
      render: (_, icon) => (
        <div style={{ fontSize: 12, overflowWrap: 'anywhere', color: token.colorTextSecondary }}>
          {icon.current ? (
            <>
              <StatusTag tone="success">{t.registered}</StatusTag>
              <div style={{ marginTop: 4 }}>{icon.current.source_url}</div>
              <div>
                {t.downloaded(icon.current.downloaded_on ?? t.dash)} ·{' '}
                {icon.current.format.toUpperCase()}
                {icon.current.sanitized ? ` · ${t.cleaned}` : ''}
              </div>
            </>
          ) : (
            t.builtinSource
          )}
        </div>
      ),
    },
    {
      title: t.columns[4],
      key: 'changed',
      width: 128,
      render: (_, icon) =>
        icon.updated_at ? (
          <>
            <div>{time(icon.updated_at)}</div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {icon.updated_by}
            </Typography.Text>
          </>
        ) : (
          t.dash
        ),
    },
    {
      title: t.columns[5],
      key: 'actions',
      width: 232,
      render: (_, icon) => (
        <Space size={8}>
          <Button
            type="link"
            size="small"
            style={{ paddingInline: 0 }}
            aria-label={t.rowAction(t.upload, t.names[icon.key])}
            onClick={() => openUpload(icon)}
          >
            {t.upload}
          </Button>
          <Button
            type="link"
            size="small"
            style={{ paddingInline: 0 }}
            aria-label={t.rowAction(t.history, t.names[icon.key])}
            onClick={() => setHistoryKey(icon.key)}
          >
            {t.history}
          </Button>
          <Button
            type="link"
            size="small"
            style={{ paddingInline: 0 }}
            aria-label={t.rowAction(t.restore, t.names[icon.key])}
            disabled={icon.current_version === null}
            onClick={() => openAction(icon, 'restore', false)}
          >
            {t.restore}
          </Button>
        </Space>
      ),
    },
  ];
  const historyIcon = items.find((item) => item.key === historyKey);
  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center" wrap gap={8}>
        <Space>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t.title}
          </Typography.Title>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t.total(items.length)}
          </Typography.Text>
        </Space>
        <PermissionLine />
      </Flex>
      {unknownKey && <Alert type="error" showIcon message={t.unknownKey} />}
      {result && (
        <Alert
          type="success"
          showIcon
          style={{
            background: 'var(--color-status-success-background)',
            border: 0,
          }}
          message={<span style={{ color: token.colorSuccess }}>{result.message}</span>}
          action={
            <Button type="link" onClick={audit}>
              {t.audit}
            </Button>
          }
        />
      )}
      <Alert
        type="info"
        showIcon
        icon={<InfoCircleOutlined aria-hidden style={{ marginTop: 4 }} />}
        role="note"
        style={{ padding: 12, alignItems: 'flex-start' }}
        message={
          <>
            <div>{t.introduction}</div>
            <div style={{ marginTop: 4 }}>{t.instructions}</div>
          </>
        }
      />
      {status === 'forbidden' ? (
        <Result status="403" title={t.forbidden} />
      ) : status === 'failed' ? (
        <Result
          status="error"
          title={t.failed}
          extra={
            <Button
              onClick={() => {
                setStatus('loading');
                void loadList();
              }}
            >
              {t.retry}
            </Button>
          }
        />
      ) : (
        <ConfigProvider
          theme={{
            components: {
              Table: {
                headerBg: token.colorInfoBg,
                headerColor: token.colorTextSecondary,
                cellPaddingBlock: 12,
              },
            },
          }}
        >
          <Table<Icon>
            style={{
              borderRadius: token.borderRadiusLG,
              overflow: 'hidden',
              boxShadow: token.boxShadowTertiary,
            }}
            rowKey="key"
            columns={columns.map((column) => ({
              ...column,
              onCell: (icon: Icon) => ({
                style:
                  result?.key === icon.key ? { backgroundColor: 'var(--color-brand-subtle)' } : {},
              }),
            }))}
            dataSource={items}
            pagination={false}
            loading={delayedLoading(status === 'loading', loadingClock)}
            tableLayout="fixed"
            scroll={{ x: 1172 }}
            rowClassName={(icon) => (result?.key === icon.key ? 'platform-icon-changed' : '')}
          />
        </ConfigProvider>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t.footnote}
      </Typography.Text>
      {historyIcon && (
        <HistoryDrawer
          key={`history-${historyIcon.key}`}
          icon={historyIcon}
          refresh={historyRefresh}
          onClose={closeHistory}
          onAction={(kind, target, retained) =>
            openAction(historyIcon, kind, true, target, retained)
          }
          onUpload={() => openUpload(historyIcon)}
          onSource={(version) => setSourceTarget({ key: historyIcon.key, version })}
          savedVersion={savedVersion?.key === historyIcon.key ? savedVersion.version : undefined}
        />
      )}
      {action && (
        <ConfirmationModal
          action={action}
          busy={busy}
          error={error}
          onCancel={() => {
            if (!writing.current) {
              setAction(undefined);
              setError(undefined);
            }
          }}
          onConfirm={() => {
            void submit();
          }}
          onRefresh={refreshHistory}
          onAudit={audit}
          onRegister={() => {
            if (!action.target) return;
            setHistoryKey(action.icon.key);
            setSourceTarget({ key: action.icon.key, version: action.target });
            setAction(undefined);
            setError(undefined);
          }}
        />
      )}
      {uploadIcon && (
        <UploadDialog
          key={`upload-${uploadIcon.key}`}
          icon={uploadIcon}
          onClose={() => setUploadIcon(undefined)}
          onUnknownKey={handleUnknownKey}
          onSaved={(version) => {
            setSavedVersion({ key: uploadIcon.key, version });
            setUploadIcon(undefined);
            setHistoryKey(uploadIcon.key);
            setHistoryRefresh((n) => n + 1);
            void loadList();
          }}
        />
      )}
      {sourceTarget && (
        <SourceDialog
          key={`source-${sourceTarget.key}-${sourceTarget.version.version}`}
          iconKey={sourceTarget.key}
          version={sourceTarget.version}
          onClose={() => setSourceTarget(undefined)}
          onSaved={(version) => {
            setSavedVersion((previous) =>
              previous?.key === sourceTarget.key && previous.version.version === version.version
                ? { key: sourceTarget.key, version }
                : previous,
            );
            refreshSource();
          }}
          onRefresh={refreshSource}
          onUnknownKey={handleUnknownKey}
        />
      )}
    </Flex>
  );
}
