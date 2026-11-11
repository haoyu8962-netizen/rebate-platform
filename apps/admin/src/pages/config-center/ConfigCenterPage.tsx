// Configuration center (design-hifi AdmConfigCenter, AdmConfigItemDrawer; F-ADM-12, 规划/04 §10).
// Lists every item the server registered (GET /admin/v1/config-items, page by page through the
// data provider) in page groups and registry order. A change, a rollback or a batch goes
// confirmation → (config.risk / config.business: totp step-up) → one write with
// `expected_version`; the rows then show the server's answer. A refused token (10003) asks for a
// new step-up and replays the same body; a conflict (20902) re-reads; an unknown result
// (network, unreadable answer, 5xxxx) is reported and re-read, never resent.
import type { Schema } from '@couli/contracts-ts';
import { HistoryOutlined, SafetyOutlined, SearchOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  ConfigProvider,
  Empty,
  Flex,
  Input,
  Menu,
  Result,
  Table,
  Tag,
  Typography,
  theme,
  type TableColumnsType,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router';
import { StepUpModal, type StepUpResult } from '../../components/step-up/index.ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { configCenterTexts as t } from '../../texts/config-center.ts';
import { BatchDrawer } from './BatchDrawer.tsx';
import { ConfirmModal } from './ConfirmModal.tsx';
import { InviteBudgetCard } from './InviteBudgetCard.tsx';
import { ItemDrawer } from './ItemDrawer.tsx';
import {
  GROUP_IDS,
  STEP_UP_URL,
  authorOf,
  beijingTime,
  displayName,
  editable,
  errorText,
  groupLabel,
  groupOf,
  isPendingOwner,
  itemUrl,
  nameOf,
  needsStepUp,
  permitted,
  scopeOf,
  typeLabel,
  valueLabel,
  writeOutcomeUnknown,
  type ConfigRow,
  type GroupId,
} from './model.ts';
import {
  callOf,
  detailsOf,
  keysOf,
  operationOf,
  permissionOf,
  type WriteRequest,
} from './write.ts';

export interface ConfigCenterPageProps {
  readonly access: AccessControl;
}

type LoadStatus = 'loading' | 'ready' | 'failed' | 'forbidden';

interface Pending {
  readonly request: WriteRequest;
  readonly phase: 'confirm' | 'verify' | 'writing';
  /** The last write was refused for its step-up token (10003): verify again, then replay. */
  readonly again: boolean;
}

interface Notice {
  readonly type: 'success' | 'error' | 'warning';
  readonly text: string;
  /** Offer 【重新读取】 (a write whose result is still unconfirmed, or a failed re-read). */
  readonly reload?: boolean;
}

interface BatchResponse extends Record<string, unknown> {
  items: ConfigRow[];
}

const NO_KEYS: ReadonlySet<string> = new Set();
const PAGE_SIZE = 200;
/** The invite reward record subpage (App.tsx routes it under 配置中心). */
const INVITE_REWARDS_PATH = '/invite-rewards';

export function ConfigCenterPage({ access }: ConfigCenterPageProps): ReactElement {
  const getProvider = useDataProvider();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const [rows, setRows] = useState<ConfigRow[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<GroupId>();
  const [search, setSearch] = useState('');
  const [drawerKey, setDrawerKey] = useState<string>();
  const [batchOpen, setBatchOpen] = useState(false);
  const [pending, setPendingState] = useState<Pending>();
  const [notice, setNotice] = useState<Notice>();
  // Rows whose last write has an unknown result and no successful read since.
  const [unconfirmed, setUnconfirmed] = useState<ReadonlySet<string>>(NO_KEYS);
  const pendingRef = useRef<Pending | undefined>(undefined);
  const listSequence = useRef(0);
  const writeSequence = useRef(0);

  const setPending = useCallback((next: Pending | undefined) => {
    pendingRef.current = next;
    setPendingState(next);
  }, []);

  const merge = useCallback((updates: readonly ConfigRow[]) => {
    const byKey = new Map(updates.map((row) => [row.key, row]));
    setRows((previous) => previous.map((row) => byKey.get(row.key) ?? row));
    setUnconfirmed((previous) => {
      if (!updates.some((row) => previous.has(row.key))) return previous;
      const next = new Set(previous);
      for (const row of updates) next.delete(row.key);
      return next;
    });
  }, []);

  /**
   * Reads every page (page_size ≤ 200) until the server's total is reached. Resolves to the rows,
   * null when the read failed, or undefined when a newer read or write superseded it.
   */
  const loadList = useCallback(async (): Promise<ConfigRow[] | null | undefined> => {
    const request = ++listSequence.current;
    try {
      const provider = getProvider();
      const collected: ConfigRow[] = [];
      for (let page = 1; ; page += 1) {
        const response = await provider.getList<ConfigRow>({
          resource: 'config-items',
          pagination: { currentPage: page, pageSize: PAGE_SIZE, mode: 'server' },
        });
        if (request !== listSequence.current) return undefined;
        collected.push(...response.data);
        if (response.data.length === 0 || collected.length >= (response.total ?? 0)) break;
      }
      setRows(collected);
      setStatus('ready');
      // A full read shows the server's values: nothing is unconfirmed any more.
      setUnconfirmed(NO_KEYS);
      return collected;
    } catch (cause) {
      if (request !== listSequence.current) return undefined;
      setStatus((previous) => {
        // A failed refresh keeps the rows already shown.
        if (previous === 'ready') return previous;
        return cause instanceof AdminApiError && cause.code === 10403 ? 'forbidden' : 'failed';
      });
      return null;
    }
  }, [getProvider]);

  useEffect(() => {
    void loadList();
    return () => {
      listSequence.current += 1;
      writeSequence.current += 1;
    };
  }, [loadList]);

  const customOf = () => {
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    return custom;
  };

  /** Reads one item again; null when the read failed, undefined when superseded. */
  const readOne = async (key: string): Promise<ConfigRow | null | undefined> => {
    const request = ++listSequence.current;
    try {
      const response = await customOf()<ConfigRow>({ url: itemUrl(key), method: 'get' });
      if (request !== listSequence.current) return undefined;
      merge([response.data]);
      return response.data;
    } catch {
      if (request !== listSequence.current) return undefined;
      return null;
    }
  };

  const retry = () => {
    setStatus('loading');
    void loadList();
  };

  const openConfirm = (request: WriteRequest) => {
    // One write at a time: a second click (or a click during a write) opens nothing.
    if (pendingRef.current !== undefined || refreshing) return;
    const keys = keysOf(request);
    if (keys.length === 0 || keys.some((key) => unconfirmed.has(key))) return;
    const touched =
      request.kind === 'batch' ? request.entries.map((entry) => entry.row) : [request.row];
    if (!touched.every((row) => editable(row, access))) return;
    setNotice(undefined);
    setPending({ request, phase: 'confirm', again: false });
  };

  const cancel = () => {
    const current = pendingRef.current;
    if (current === undefined || current.phase === 'writing') return;
    setPending(undefined);
  };

  const verifyCode = async (code: string): Promise<StepUpResult> => {
    const request: Schema<'AdminStepUpRequest'> = { tier: 'totp', code };
    try {
      const response = await customOf()<Schema<'AdminStepUpResponse'>['data']>({
        url: STEP_UP_URL,
        method: 'post',
        payload: request,
      });
      return { ok: true, stepUpToken: response.data.step_up_token };
    } catch (cause) {
      if (cause instanceof AdminApiError)
        return cause.retryAfterSeconds === undefined
          ? { ok: false, code: cause.code }
          : { ok: false, code: cause.code, retryAfterSeconds: cause.retryAfterSeconds };
      return { ok: false, code: 0 };
    }
  };

  /** Re-reads what a failed write touched: the item, or every item after a batch. */
  const reread = async (request: WriteRequest): Promise<ConfigRow | null | undefined | true> => {
    setRefreshing(true);
    try {
      if (request.kind === 'batch') {
        const fresh = await loadList();
        if (fresh === undefined) return undefined;
        return fresh === null ? null : true;
      }
      return await readOne(request.row.key);
    } finally {
      setRefreshing(false);
    }
  };

  const afterConflict = async (request: WriteRequest): Promise<void> => {
    setNotice({ type: 'error', text: t.errors.conflict });
    const fresh = await reread(request);
    if (fresh === null) setNotice({ type: 'error', text: t.errors.conflictUnread, reload: true });
  };

  const afterUnknown = async (request: WriteRequest): Promise<void> => {
    const keys = keysOf(request);
    setUnconfirmed((previous) => new Set([...previous, ...keys]));
    setNotice({ type: 'warning', text: t.errors.unknownChecking });
    const fresh = await reread(request);
    if (fresh === undefined) return;
    if (fresh === null) {
      setNotice({ type: 'error', text: t.errors.unknownUnread, reload: true });
      return;
    }
    if (fresh === true) {
      setNotice({ type: 'warning', text: t.errors.unknownBatchChecked });
      return;
    }
    setNotice({
      type: 'warning',
      text: t.errors.unknownChecked(valueLabel(fresh, fresh.value), fresh.version),
    });
  };

  const write = async (target: Pending, stepUpToken: string | undefined): Promise<void> => {
    const sequence = ++writeSequence.current;
    // Reads started before this write must not overwrite its answer.
    listSequence.current += 1;
    const { request } = target;
    const call = callOf(request);
    try {
      const response = await customOf()<ConfigRow | BatchResponse>({
        url: call.url,
        method: call.method,
        payload: call.payload,
        ...(stepUpToken === undefined ? {} : { meta: { stepUpToken } }),
      });
      if (sequence !== writeSequence.current) return;
      setPending(undefined);
      if (request.kind === 'batch') {
        const items = (response.data as BatchResponse).items;
        merge(items);
        setBatchOpen(false);
        setNotice({ type: 'success', text: t.success.batch(items.length) });
        return;
      }
      const updated = response.data as ConfigRow;
      merge([updated]);
      setDrawerKey(undefined);
      setNotice({
        type: 'success',
        text:
          request.kind === 'edit'
            ? t.success.edit(displayName(updated.key), valueLabel(updated, updated.value))
            : t.success.rollback(displayName(updated.key), updated.version),
      });
    } catch (cause) {
      if (sequence !== writeSequence.current) return;
      if (cause instanceof AdminApiError && cause.code === 10003) {
        // The token was not accepted: verify again (never resend the old token), then replay.
        setPending({ ...target, phase: 'verify', again: true });
        return;
      }
      setPending(undefined);
      if (cause instanceof AdminApiError && cause.code === 20902) {
        await afterConflict(request);
        return;
      }
      if (writeOutcomeUnknown(cause)) {
        // The change may have been applied: never resend; read the server's value instead.
        await afterUnknown(request);
        return;
      }
      setNotice({ type: 'error', text: errorText(cause) });
    }
  };

  const reload = () => {
    if (refreshing || pendingRef.current !== undefined) return;
    const keys = [...unconfirmed];
    const key = keys.length === 1 ? keys[0] : undefined;
    setRefreshing(true);
    void (async () => {
      try {
        const fresh = key === undefined ? await loadList() : await readOne(key);
        if (fresh === undefined) return;
        if (fresh === null) {
          setNotice({ type: 'error', text: t.errors.unknownUnread, reload: true });
          return;
        }
        setNotice(
          Array.isArray(fresh)
            ? undefined
            : {
                type: 'warning',
                text: t.errors.unknownChecked(valueLabel(fresh, fresh.value), fresh.version),
              },
        );
      } finally {
        setRefreshing(false);
      }
    })();
  };

  const confirm = () => {
    const current = pendingRef.current;
    if (current?.phase !== 'confirm') return;
    if (needsStepUp(permissionOf(current.request))) {
      setPending({ ...current, phase: 'verify' });
      return;
    }
    const writing: Pending = { ...current, phase: 'writing' };
    setPending(writing);
    void write(writing, undefined);
  };

  const onVerified = (stepUpToken: string) => {
    const current = pendingRef.current;
    if (current === undefined || current.phase !== 'verify') return;
    const writing: Pending = { ...current, phase: 'writing' };
    setPending(writing);
    void write(writing, stepUpToken);
  };

  const writing = pending?.phase === 'writing';
  const writingKeys = writing ? keysOf(pending.request) : [];
  const locked = writing || refreshing || status !== 'ready';

  const counts = useMemo(() => {
    const map = new Map<GroupId, number>();
    for (const row of rows) map.set(groupOf(row), (map.get(groupOf(row)) ?? 0) + 1);
    return map;
  }, [rows]);
  const groupIds: GroupId[] = [...GROUP_IDS, ...(counts.has('other') ? ['other' as const] : [])];
  const group: GroupId =
    selected ?? groupIds.find((id) => (counts.get(id) ?? 0) > 0) ?? GROUP_IDS[0];
  const groupRows = useMemo(() => rows.filter((row) => groupOf(row) === group), [rows, group]);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query === '') return groupRows;
    return groupRows.filter(
      (row) =>
        row.key.toLowerCase().includes(query) ||
        (nameOf(row.key) ?? '').toLowerCase().includes(query),
    );
  }, [groupRows, search]);
  const batchRows = groupRows.filter((row) => editable(row, access) && !unconfirmed.has(row.key));

  const drawerRow = drawerKey === undefined ? undefined : rows.find((row) => row.key === drawerKey);

  const small = { fontSize: 12 } as const;
  const code = { fontFamily: token.fontFamilyCode, fontSize: 12 } as const;

  const groupDescription = (() => {
    const points = [...new Set(groupRows.map((row) => row.permission))];
    const [point] = points;
    if (point === undefined) return t.groupDescription.empty;
    if (points.length === 1) return t.groupDescription.single(point, needsStepUp(point));
    return t.groupDescription.mixed(points.join(t.separator));
  })();

  const renderActions = (row: ConfigRow) => {
    const name = displayName(row.key);
    if (!editable(row, access))
      return (
        <Flex vertical align="flex-start" gap={2}>
          <Button
            type="link"
            size="small"
            aria-label={t.viewLabel(name)}
            style={{ paddingInline: 0 }}
            disabled={status !== 'ready'}
            onClick={() => {
              setNotice(undefined);
              setDrawerKey(row.key);
            }}
          >
            {t.view}
          </Button>
          <Typography.Text type="secondary" style={small}>
            {row.admin_editable ? t.noPermission(row.permission) : t.readOnly}
          </Typography.Text>
        </Flex>
      );
    const blocked = unconfirmed.has(row.key);
    return (
      <Flex vertical align="flex-start" gap={2}>
        <Button
          type="link"
          size="small"
          icon={needsStepUp(row.permission) ? <SafetyOutlined aria-hidden /> : undefined}
          aria-label={t.editLabel(name)}
          aria-busy={writingKeys.includes(row.key) ? true : undefined}
          style={{ paddingInline: 0 }}
          disabled={locked || blocked || pending !== undefined}
          onClick={() => {
            if (pendingRef.current !== undefined) return;
            setNotice(undefined);
            setDrawerKey(row.key);
          }}
        >
          {t.edit}
        </Button>
        {blocked ? (
          <Typography.Text type="danger" style={small}>
            {t.unconfirmedNote}
          </Typography.Text>
        ) : null}
      </Flex>
    );
  };

  const columns: TableColumnsType<ConfigRow> = [
    {
      key: 'item',
      title: t.columns.item,
      width: 232,
      render: (_, row) => (
        <Flex vertical gap={2}>
          {nameOf(row.key) === null ? null : (
            <Typography.Text strong>{nameOf(row.key)}</Typography.Text>
          )}
          <Typography.Text type="secondary" style={{ ...code, overflowWrap: 'anywhere' }}>
            {row.key}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      key: 'current',
      title: t.columns.current,
      width: 160,
      render: (_, row) => (
        <Flex align="center" gap={6} wrap>
          <Typography.Text {...(row.value === null ? { type: 'secondary' as const } : {})}>
            {valueLabel(row, row.value)}
          </Typography.Text>
          {isPendingOwner(row.key) ? (
            <Tag color="warning" style={{ marginInlineEnd: 0 }}>
              {t.pendingOwner}
            </Tag>
          ) : null}
          {unconfirmed.has(row.key) ? (
            <Tag color="error" style={{ marginInlineEnd: 0 }}>
              {t.unconfirmed}
            </Tag>
          ) : null}
        </Flex>
      ),
    },
    {
      key: 'type',
      title: t.columns.type,
      width: 64,
      render: (_, row) => (
        <Typography.Text type="secondary" style={small}>
          {typeLabel(row)}
        </Typography.Text>
      ),
    },
    {
      key: 'scope',
      title: t.columns.scope,
      width: 112,
      render: (_, row) => <Typography.Text>{scopeOf(row.key)}</Typography.Text>,
    },
    {
      key: 'version',
      title: t.columns.version,
      width: 64,
      render: (_, row) => <Typography.Text>{t.version(row.version)}</Typography.Text>,
    },
    {
      key: 'updated',
      title: t.columns.updated,
      width: 144,
      render: (_, row) => (
        <Flex vertical gap={2}>
          <Typography.Text>{authorOf(row.updated_by)}</Typography.Text>
          {row.updated_at === null ? null : (
            <Typography.Text type="secondary" style={small}>
              {beijingTime(row.updated_at)}
            </Typography.Text>
          )}
        </Flex>
      ),
    },
    {
      key: 'actions',
      title: t.columns.actions,
      width: 100,
      render: (_, row) => renderActions(row),
    },
  ];

  const noticeNode =
    notice === undefined ? null : (
      <Alert
        type={notice.type}
        showIcon
        closable
        message={notice.text}
        action={
          notice.reload === true ? (
            <Button size="small" disabled={refreshing || writing} onClick={reload}>
              {t.reload}
            </Button>
          ) : undefined
        }
        onClose={() => setNotice(undefined)}
      />
    );
  const noticeInDrawer = drawerRow !== undefined || batchOpen;

  let body: ReactElement;
  if (status === 'loading') {
    body = (
      <Card aria-busy>
        <Typography.Text type="secondary" role="status">
          {t.loading}
        </Typography.Text>
      </Card>
    );
  } else if (status === 'forbidden') {
    body = (
      <Card>
        <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
      </Card>
    );
  } else if (status === 'failed') {
    body = (
      <Card>
        <Result
          status="error"
          title={t.loadFailedTitle}
          subTitle={t.loadFailedDescription}
          extra={<Button onClick={retry}>{t.retry}</Button>}
        />
      </Card>
    );
  } else if (rows.length === 0) {
    body = (
      <Card>
        <Empty description={t.empty} />
      </Card>
    );
  } else {
    body = (
      <Flex gap={16} align="flex-start">
        <Card
          style={{ width: 240, flex: 'none', boxShadow: token.boxShadowTertiary }}
          styles={{ body: { padding: 12 } }}
        >
          <Flex vertical gap={8}>
            <Typography.Text type="secondary" style={{ ...small, paddingInline: 12 }}>
              {t.groupsTitle}
            </Typography.Text>
            <Menu
              mode="inline"
              selectedKeys={[group]}
              style={{ borderInlineEnd: 0, background: token.colorBgContainer }}
              onClick={({ key }) => {
                setSelected(key as GroupId);
                setSearch('');
              }}
              items={groupIds.map((id) => ({
                key: id,
                label: (
                  <Flex justify="space-between" align="center" gap={8}>
                    <Typography.Text style={{ color: 'inherit' }}>{groupLabel(id)}</Typography.Text>
                    <Typography.Text type="secondary" style={{ ...small, color: 'inherit' }}>
                      {t.count(counts.get(id) ?? 0)}
                    </Typography.Text>
                  </Flex>
                ),
              }))}
            />
            <Typography.Text
              type="secondary"
              style={{
                ...small,
                padding: 12,
                borderBlockStart: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              {t.groupsFootnote}
            </Typography.Text>
          </Flex>
        </Card>
        <Flex vertical gap={16} style={{ flex: 1, minWidth: 0 }}>
          <Card style={{ boxShadow: token.boxShadowTertiary }}>
            <Flex justify="space-between" align="center" gap={16} wrap>
              <Flex vertical gap={4}>
                <Typography.Title level={5} style={{ margin: 0 }}>
                  {groupLabel(group)}
                </Typography.Title>
                <Typography.Text type="secondary" style={small}>
                  {groupDescription}
                </Typography.Text>
              </Flex>
              <Flex gap={8} align="center">
                <Input
                  allowClear
                  prefix={<SearchOutlined aria-hidden />}
                  placeholder={t.searchPlaceholder}
                  aria-label={t.searchLabel}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  style={{ width: 260 }}
                />
                {batchRows.length > 1 ? (
                  <Button
                    disabled={locked || pending !== undefined}
                    onClick={() => {
                      setNotice(undefined);
                      setBatchOpen(true);
                    }}
                  >
                    {t.batch}
                  </Button>
                ) : null}
              </Flex>
            </Flex>
          </Card>
          {group === 'invite' && access.can('fund.view') ? (
            // Budget used and the record subpage: fund.view only (BR-INV-24 ④, F-ADM-27).
            <InviteBudgetCard
              rows={groupRows}
              onOpenRecords={() => void navigate(INVITE_REWARDS_PATH)}
            />
          ) : null}
          {group === 'withdraw' ? (
            <Alert
              role="note"
              type="info"
              showIcon
              style={{ border: 0, alignItems: 'flex-start' }}
              message={
                <Flex vertical gap={4}>
                  <Typography.Text strong>{t.placeholderTitle}</Typography.Text>
                  <Typography.Text>{t.placeholderBody}</Typography.Text>
                </Flex>
              }
            />
          ) : null}
          {filtered.length === 0 ? (
            <Card>
              <Empty description={groupRows.length === 0 ? t.groupEmpty : t.filteredEmpty} />
            </Card>
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
              <Card
                styles={{ body: { padding: 0 } }}
                style={{ overflow: 'hidden', boxShadow: token.boxShadowTertiary }}
              >
                <Table<ConfigRow>
                  rowKey="key"
                  columns={columns}
                  dataSource={filtered}
                  pagination={false}
                  tableLayout="fixed"
                  scroll={{ x: 876 }}
                />
              </Card>
            </ConfigProvider>
          )}
        </Flex>
      </Flex>
    );
  }

  return (
    <Flex vertical gap={16} aria-busy={status === 'loading' ? true : undefined}>
      <Flex justify="space-between" align="center" wrap gap={8}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t.title}
        </Typography.Title>
        <Button icon={<HistoryOutlined aria-hidden />} onClick={() => void navigate('/audit-logs')}>
          {t.history}
        </Button>
      </Flex>
      {noticeInDrawer ? null : noticeNode}
      {body}
      {drawerRow === undefined ? null : (
        <ItemDrawer
          key={drawerRow.key}
          row={drawerRow}
          editable={editable(drawerRow, access)}
          permitted={permitted(drawerRow, access)}
          busy={locked || pending !== undefined}
          writing={writingKeys.includes(drawerRow.key)}
          unconfirmed={unconfirmed.has(drawerRow.key)}
          notice={noticeNode}
          onClose={() => {
            if (pendingRef.current !== undefined) return;
            setDrawerKey(undefined);
            setNotice(undefined);
          }}
          onSave={(value, reason) => openConfirm({ kind: 'edit', row: drawerRow, value, reason })}
          onRollback={(version, reason) =>
            openConfirm({
              kind: 'rollback',
              row: drawerRow,
              toVersion: version.version,
              toValue: version.value,
              reason,
            })
          }
        />
      )}
      {batchOpen ? (
        <BatchDrawer
          group={group}
          rows={batchRows}
          busy={locked || pending !== undefined}
          notice={noticeNode}
          onClose={() => {
            if (pendingRef.current !== undefined) return;
            setBatchOpen(false);
            setNotice(undefined);
          }}
          onSave={(permission, entries, reason) =>
            openConfirm({ kind: 'batch', group, permission, entries, reason })
          }
        />
      ) : null}
      {pending?.phase === 'confirm' ? (
        <ConfirmModal request={pending.request} onCancel={cancel} onConfirm={confirm} />
      ) : null}
      <StepUpModal
        open={pending?.phase === 'verify'}
        tier="totp"
        operation={pending === undefined ? '' : operationOf(pending.request)}
        details={
          pending === undefined
            ? []
            : [...detailsOf(pending.request), ...(pending.again ? [t.stepUp.again] : [])]
        }
        onSubmit={verifyCode}
        onClose={cancel}
        onVerified={onVerified}
      />
    </Flex>
  );
}
