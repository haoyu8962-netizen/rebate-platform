// Emergency switches (design-hifi AdmSwitches, AdmSwitchOff; F-ADM-13, 规划/04 §10.2). Lists every
// switch the server registered, in four groups and registry order, page by page through the data
// provider. A change goes confirmation → totp step-up (/admin/v1/auth/step-up) → one PUT
// /admin/v1/kill-switches/{key} with X-Step-Up-Token; the row then shows the server's answer.
// Who may change a row follows the row's `permissions` and `admin_editable`; the auto payout
// switch is only ever turned off here (BR-WDR-30).
import type { Schema } from '@couli/contracts-ts';
import {
  HistoryOutlined,
  SafetyOutlined,
  SearchOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  ConfigProvider,
  Empty,
  Flex,
  Input,
  Result,
  Select,
  Switch,
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
import { rawCodePointLength } from '../../text-length.ts';
import { killSwitchesTexts as t } from '../../texts/kill-switches.ts';
import { ConfirmModal, REASON_MAX } from './ConfirmModal.tsx';
import {
  AUTO_PAYOUT,
  allowedTarget,
  beijingTime,
  changeable,
  currentOf,
  differs,
  displayName,
  enumLabel,
  groupOf,
  impactOf,
  isStopping,
  nameOf,
  permitted,
  stateLabel,
  targetLabel,
  valueLabel,
  verbOf,
  writeOutcomeUnknown,
  type SwitchRow,
  type SwitchValue,
} from './model.ts';

export interface KillSwitchesPageProps {
  readonly access: AccessControl;
}

type LoadStatus = 'loading' | 'ready' | 'failed' | 'forbidden';
type StatusFilter = 'all' | 'on' | 'off';

interface Pending {
  readonly row: SwitchRow;
  readonly next: SwitchValue;
  readonly reason: string;
  readonly phase: 'confirm' | 'verify' | 'writing';
  /** The last write was refused for its step-up token (10003): verify again, then replay. */
  readonly again: boolean;
}

interface Notice {
  readonly type: 'success' | 'error';
  readonly text: string;
  /** Offer 【重新读取】 (a write whose result is still unconfirmed). */
  readonly reload?: boolean;
}

const NO_KEYS: ReadonlySet<string> = new Set();

const LIST_URL = '/admin/v1/kill-switches';
const STEP_UP_URL = '/admin/v1/auth/step-up';
const PAGE_SIZE = 200;

function fieldsOf(error: AdminApiError): readonly unknown[] {
  const data = error.data;
  if (typeof data === 'object' && data !== null && 'fields' in data && Array.isArray(data.fields))
    return data.fields as unknown[];
  return [];
}

function errorText(cause: unknown, name: string): string {
  if (!(cause instanceof AdminApiError)) return t.errors.failed(name);
  if (cause.kind === 'network') return t.errors.network(name);
  if (cause.code === 10403) return t.errors.forbidden(name);
  if (cause.code === 20001) {
    const fields = fieldsOf(cause);
    if (fields.includes('key')) return t.errors.key(name);
    if (fields.includes('value')) return t.errors.value(name);
    return t.errors.invalid(name);
  }
  return t.errors.failed(name);
}

export function KillSwitchesPage({ access }: KillSwitchesPageProps): ReactElement {
  const getProvider = useDataProvider();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const [rows, setRows] = useState<SwitchRow[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPendingState] = useState<Pending>();
  const [notice, setNotice] = useState<Notice>();
  // Rows whose last write has an unknown result and no successful read since.
  const [unconfirmed, setUnconfirmed] = useState<ReadonlySet<string>>(NO_KEYS);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [differentOnly, setDifferentOnly] = useState(false);
  const pendingRef = useRef<Pending | undefined>(undefined);
  const listSequence = useRef(0);
  const writeSequence = useRef(0);

  const setPending = useCallback((next: Pending | undefined) => {
    pendingRef.current = next;
    setPendingState(next);
  }, []);

  /**
   * Reads every page (page_size ≤ 200) until the server's total is reached. Resolves to the rows,
   * null when the read failed, or undefined when a newer read or write superseded it.
   */
  const loadList = useCallback(async (): Promise<SwitchRow[] | null | undefined> => {
    const request = ++listSequence.current;
    try {
      const provider = getProvider();
      const collected: SwitchRow[] = [];
      for (let page = 1; ; page += 1) {
        const response = await provider.getList<SwitchRow>({
          resource: 'kill-switches',
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
    } finally {
      if (request === listSequence.current) setRefreshing(false);
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

  const retry = () => {
    setStatus('loading');
    void loadList();
  };

  const openConfirm = (row: SwitchRow, next: SwitchValue) => {
    // One change at a time: a second click (or a click during a write) opens nothing.
    if (pendingRef.current !== undefined || refreshing) return;
    if (!changeable(row, access) || !allowedTarget(row, next)) return;
    // An unknown write result must be confirmed by a read before anything else is sent.
    if (unconfirmed.has(row.key)) return;
    if (JSON.stringify(next) === JSON.stringify(currentOf(row))) return;
    setNotice(undefined);
    setPending({ row, next, reason: '', phase: 'confirm', again: false });
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

  const write = async (target: Pending, stepUpToken: string): Promise<void> => {
    const request = ++writeSequence.current;
    // Reads started before this write must not overwrite its answer.
    listSequence.current += 1;
    const { row, next, reason } = target;
    const name = displayName(row.key);
    const payload: Schema<'AdminKillSwitchUpdateRequest'> = {
      value: next,
      expected_version: row.version,
      ...(reason.trim() === '' ? {} : { reason }),
    };
    try {
      const response = await customOf()<SwitchRow>({
        url: `${LIST_URL}/${encodeURIComponent(row.key)}`,
        method: 'put',
        payload,
        meta: { stepUpToken },
      });
      if (request !== writeSequence.current) return;
      const updated = response.data;
      setRows((previous) => previous.map((item) => (item.key === updated.key ? updated : item)));
      setPending(undefined);
      setNotice({
        type: 'success',
        text: t.success(name, stateLabel(updated, currentOf(updated))),
      });
    } catch (cause) {
      if (request !== writeSequence.current) return;
      if (cause instanceof AdminApiError && cause.code === 10003) {
        // The token was not accepted: verify again (never resend the old token), then replay.
        setPending({ ...target, phase: 'verify', again: true });
        return;
      }
      setPending(undefined);
      if (cause instanceof AdminApiError && cause.code === 20902) {
        setNotice({ type: 'error', text: t.errors.conflict(name) });
        setRefreshing(true);
        void loadList();
        return;
      }
      if (writeOutcomeUnknown(cause)) {
        // The change may have been applied: never resend; read the server's value instead.
        setUnconfirmed((previous) => new Set(previous).add(row.key));
        setNotice({ type: 'error', text: t.errors.unknownChecking(name) });
        await verifyAfterUnknown(row.key, name);
        return;
      }
      setNotice({ type: 'error', text: errorText(cause, name) });
    }
  };

  /** Re-reads the list after a write with an unknown result and reports what the server holds. */
  const verifyAfterUnknown = async (key: string, name: string): Promise<void> => {
    setRefreshing(true);
    const fresh = await loadList();
    if (fresh === undefined) return;
    if (fresh === null) {
      setNotice({ type: 'error', text: t.errors.unknownUnread(name), reload: true });
      return;
    }
    const latest = fresh.find((item) => item.key === key);
    setNotice({
      type: 'error',
      text:
        latest === undefined
          ? t.errors.unknownMissing(name)
          : t.errors.unknownChecked(name, stateLabel(latest, currentOf(latest))),
    });
  };

  const reloadUnconfirmed = () => {
    if (refreshing) return;
    const keys = [...unconfirmed];
    const key = keys[0];
    if (key === undefined) {
      setRefreshing(true);
      void loadList();
      return;
    }
    void verifyAfterUnknown(key, displayName(key));
  };

  const onVerified = (stepUpToken: string) => {
    const current = pendingRef.current;
    if (current === undefined || current.phase !== 'verify') return;
    const writing: Pending = { ...current, phase: 'writing' };
    setPending(writing);
    void write(writing, stepUpToken);
  };

  const writingKey = pending?.phase === 'writing' ? pending.row.key : undefined;
  const locked = writingKey !== undefined || refreshing;

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (differentOnly && !differs(row)) return false;
      const current = currentOf(row);
      if (statusFilter === 'on' && current !== true) return false;
      if (statusFilter === 'off' && current !== false) return false;
      if (query === '') return true;
      return (
        row.key.toLowerCase().includes(query) ||
        (nameOf(row.key) ?? '').toLowerCase().includes(query)
      );
    });
  }, [rows, search, statusFilter, differentOnly]);

  const small = { fontSize: 12 } as const;
  const warningTag = {
    marginInlineEnd: 0,
    border: 0,
    color: token.colorWarning,
    background: 'var(--color-status-warning-background)',
  } as const;
  const code = { fontFamily: token.fontFamilyCode, fontSize: 12 } as const;

  const unconfirmedTag = (row: SwitchRow) =>
    unconfirmed.has(row.key) ? (
      <Tag color="error" style={{ marginInlineEnd: 0 }}>
        {t.unconfirmed}
      </Tag>
    ) : null;

  const renderCurrent = (row: SwitchRow) => {
    const current = currentOf(row);
    const can = changeable(row, access) && !unconfirmed.has(row.key);
    if (row.value_type === 'boolean')
      return (
        <Flex align="center" gap={8}>
          <Switch
            checked={current === true}
            disabled={!can || locked}
            aria-label={row.key}
            aria-busy={writingKey === row.key ? true : undefined}
            onChange={(checked) => openConfirm(row, checked)}
          />
          <Typography.Text strong>{stateLabel(row, current)}</Typography.Text>
          {unconfirmedTag(row)}
        </Flex>
      );
    return (
      <Flex vertical align="flex-start" gap={4}>
        <Tag style={{ whiteSpace: 'normal', marginInlineEnd: 0 }}>{valueLabel(current)}</Tag>
        {unconfirmedTag(row)}
      </Flex>
    );
  };

  const renderActions = (row: SwitchRow) => {
    if (!row.admin_editable || row.value_type === 'object')
      return (
        <Typography.Text type="secondary" style={small}>
          {t.readOnly}
        </Typography.Text>
      );
    const can = changeable(row, access) && !unconfirmed.has(row.key);
    const note = unconfirmed.has(row.key) ? (
      <Typography.Text type="danger" style={small}>
        {t.unconfirmedNote}
      </Typography.Text>
    ) : row.key === AUTO_PAYOUT ? (
      <Typography.Text type="secondary" style={small}>
        {t.autoPayoutNote}
      </Typography.Text>
    ) : !permitted(row, access) ? (
      <Typography.Text type="secondary" style={small}>
        {t.noPermission}
      </Typography.Text>
    ) : null;
    const next = row.value_type === 'boolean' ? !(currentOf(row) === true) : undefined;
    const current = currentOf(row);
    return (
      <Flex vertical align="flex-start" gap={4}>
        {row.value_type === 'enum' && can ? (
          // Picking an option only opens the confirmation; the value changes after the PUT.
          <Select<string>
            size="small"
            variant="borderless"
            prefix={<SafetyOutlined aria-hidden style={{ color: token.colorPrimary }} />}
            placeholder={t.switchTo}
            value={null}
            popupMatchSelectWidth={false}
            style={{ width: '100%' }}
            aria-label={row.key}
            disabled={locked}
            options={(row.options ?? []).map((option) => ({
              value: option,
              label: enumLabel(option),
              disabled: option === current,
            }))}
            onChange={(value) => openConfirm(row, value)}
          />
        ) : null}
        {next !== undefined && can ? (
          <Button
            type="link"
            size="small"
            danger={isStopping(row, next)}
            icon={<SafetyOutlined aria-hidden />}
            style={{ paddingInline: 0 }}
            disabled={locked}
            onClick={() => openConfirm(row, next)}
          >
            {verbOf(row, next)}
          </Button>
        ) : null}
        {note}
      </Flex>
    );
  };

  const columns: TableColumnsType<SwitchRow> = [
    {
      key: 'name',
      title: t.columns.name,
      width: 188,
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
      key: 'impact',
      title: t.columns.impact,
      width: 220,
      render: (_, row) => (
        <Typography.Text type="secondary" style={small}>
          {impactOf(row.key) ?? t.dash}
        </Typography.Text>
      ),
    },
    {
      key: 'current',
      title: t.columns.current,
      width: 168,
      render: (_, row) => renderCurrent(row),
    },
    {
      key: 'default',
      title: t.columns.default,
      width: 140,
      render: (_, row) => (
        <Flex vertical align="flex-start" gap={4}>
          <Typography.Text>{stateLabel(row, row.default)}</Typography.Text>
          {differs(row) ? (
            <Tag color="warning" icon={<WarningOutlined aria-hidden />} style={warningTag}>
              {t.different}
            </Tag>
          ) : null}
        </Flex>
      ),
    },
    {
      key: 'updated',
      title: t.columns.updated,
      width: 152,
      render: (_, row) => (
        <Flex vertical gap={2}>
          <Typography.Text strong>{row.updated_by ?? t.systemInit}</Typography.Text>
          {row.updated_at === null ? null : (
            <Typography.Text type="secondary" style={small}>
              {beijingTime(row.updated_at)}
            </Typography.Text>
          )}
        </Flex>
      ),
    },
    {
      key: 'permissions',
      title: t.columns.permissions,
      width: 128,
      render: (_, row) => (
        <Flex vertical gap={2}>
          {row.permissions.map((permission) => (
            <Typography.Text key={permission} type="secondary" style={code}>
              {permission}
            </Typography.Text>
          ))}
        </Flex>
      ),
    },
    {
      key: 'actions',
      title: t.columns.actions,
      width: 140,
      render: (_, row) => renderActions(row),
    },
  ];

  let body: ReactElement;
  if (status === 'loading') {
    body = (
      <Card>
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
  } else if (filtered.length === 0) {
    body = (
      <Card>
        <Empty description={t.filteredEmpty} />
      </Card>
    );
  } else {
    body = (
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
        {t.groups.map((group, index) => {
          const items = filtered.filter((row) => groupOf(row.key) === index);
          if (items.length === 0) return null;
          return (
            <Card
              key={group}
              title={
                <Typography.Title level={5} style={{ margin: 0 }}>
                  {group}
                </Typography.Title>
              }
              extra={
                <Typography.Text type="secondary" style={small}>
                  {t.count(items.length)}
                </Typography.Text>
              }
              styles={{ body: { padding: 0 } }}
              style={{ overflow: 'hidden', boxShadow: token.boxShadowTertiary }}
            >
              <Table<SwitchRow>
                rowKey="key"
                columns={columns}
                dataSource={items}
                pagination={false}
                tableLayout="fixed"
                scroll={{ x: 1136 }}
              />
            </Card>
          );
        })}
      </ConfigProvider>
    );
  }

  const pendingName = pending === undefined ? '' : displayName(pending.row.key);
  return (
    <Flex vertical gap={16}>
      <Flex justify="space-between" align="center" wrap gap={8}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t.title}
        </Typography.Title>
        <Button icon={<HistoryOutlined aria-hidden />} onClick={() => void navigate('/audit-logs')}>
          {t.history}
        </Button>
      </Flex>
      <Alert
        role="note"
        type="warning"
        showIcon
        style={{
          border: 0,
          alignItems: 'flex-start',
          background: 'var(--color-status-warning-background)',
        }}
        message={
          <Flex vertical gap={4}>
            <Typography.Text strong style={{ color: token.colorWarning }}>
              {t.bannerTitle}
            </Typography.Text>
            <Typography.Text>{t.bannerBody}</Typography.Text>
          </Flex>
        }
      />
      <Flex align="center" gap={12} wrap>
        <Input
          allowClear
          prefix={<SearchOutlined aria-hidden />}
          placeholder={t.searchPlaceholder}
          aria-label={t.searchLabel}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          style={{ width: 280 }}
        />
        <Select<StatusFilter>
          aria-label={t.statusFilterLabel}
          value={statusFilter}
          onChange={setStatusFilter}
          style={{ width: 140 }}
          options={(['all', 'on', 'off'] as const).map((value) => ({
            value,
            label: t.statusFilter[value],
          }))}
        />
        <Checkbox
          checked={differentOnly}
          onChange={(event) => setDifferentOnly(event.target.checked)}
        >
          {t.differentOnly}
        </Checkbox>
      </Flex>
      {notice === undefined ? null : (
        <Alert
          type={notice.type}
          showIcon
          closable
          message={notice.text}
          action={
            notice.reload === true && unconfirmed.size > 0 ? (
              <Button size="small" disabled={refreshing} onClick={reloadUnconfirmed}>
                {t.reload}
              </Button>
            ) : undefined
          }
          onClose={() => setNotice(undefined)}
        />
      )}
      {body}
      {pending?.phase === 'confirm' ? (
        <ConfirmModal
          row={pending.row}
          next={pending.next}
          onNext={(next) => {
            const current = pendingRef.current;
            if (current?.phase === 'confirm' && allowedTarget(current.row, next))
              setPending({ ...current, next });
          }}
          onCancel={cancel}
          onConfirm={(reason) => {
            const current = pendingRef.current;
            if (current?.phase !== 'confirm' || rawCodePointLength(reason) > REASON_MAX) return;
            setPending({ ...current, reason, phase: 'verify' });
          }}
        />
      ) : null}
      <StepUpModal
        open={pending?.phase === 'verify'}
        tier="totp"
        operation={
          pending === undefined ? '' : `${verbOf(pending.row, pending.next)}${pendingName}`
        }
        details={
          pending === undefined
            ? []
            : [
                t.stepUpDetail(
                  pending.row.key,
                  stateLabel(pending.row, currentOf(pending.row)),
                  targetLabel(pending.row, pending.next),
                ),
                ...(pending.again ? [t.stepUpAgain] : []),
              ]
        }
        onSubmit={verifyCode}
        onClose={cancel}
        onVerified={onVerified}
      />
    </Flex>
  );
}
