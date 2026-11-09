// Edit drawer of one configuration item (design-hifi AdmConfigItemDrawer): description, current
// value, scope and version, the new-value control by type with the required reason, and the
// version history (GET …/versions, newest first) with rollback to any older version. Saving and
// rolling back only hand a request to the page, which confirms, verifies and writes.
import { SafetyOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Drawer,
  Flex,
  Form,
  Input,
  Table,
  Tag,
  Typography,
  theme,
  type TableColumnsType,
} from 'antd';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { codePointLength } from '../../text-length.ts';
import { configCenterTexts as t } from '../../texts/config-center.ts';
import {
  REASON_MAX,
  authorOf,
  beijingTime,
  descriptionOf,
  displayName,
  fenLabel,
  groupLabel,
  groupOf,
  initialInput,
  isMoney,
  isPendingOwner,
  itemUrl,
  needsStepUp,
  parseInput,
  scopeOf,
  valueLabel,
  type ConfigRow,
  type ConfigVersion,
  type FieldValue,
  type NewValue,
} from './model.ts';
import { ValueField } from './ValueField.tsx';
import { delayedLoading, useLoadingClock } from '../../motion.ts';

const VERSION_PAGE_SIZE = 20;

export interface ItemDrawerProps {
  readonly row: ConfigRow;
  /** The account may change the row (admin_editable and the row's point held). */
  readonly editable: boolean;
  /** The account holds the row's permission point (else the read-only note names it). */
  readonly permitted: boolean;
  /** A write or re-read is under way: controls are disabled. */
  readonly busy: boolean;
  /** A write of this row is under way (the save button shows it). */
  readonly writing: boolean;
  /** The last write has an unknown result and no read since: nothing may be sent. */
  readonly unconfirmed: boolean;
  /** Notice of the last write, shown at the top of the drawer. */
  readonly notice: ReactNode;
  readonly onClose: () => void;
  readonly onSave: (value: NewValue, reason: string) => void;
  readonly onRollback: (version: ConfigVersion, reason: string) => void;
}

interface FormValues {
  value: FieldValue;
  reason: string;
}

type HistoryState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly items: ConfigVersion[]; readonly total: number };

export function ItemDrawer({
  row,
  editable,
  permitted,
  busy,
  writing,
  unconfirmed,
  notice,
  onClose,
  onSave,
  onRollback,
}: ItemDrawerProps): ReactElement {
  const loadingClock = useLoadingClock();
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const [form] = Form.useForm<FormValues>();
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  // One read per item version, page and retry; until its answer arrives the history is loading.
  const requestId = `${row.key}|${row.version}|${page}|${attempt}`;
  const [loaded, setLoaded] = useState<{ readonly id: string; readonly state: HistoryState }>();
  const history: HistoryState =
    loaded !== undefined && loaded.id === requestId ? loaded.state : { status: 'loading' };
  const name = displayName(row.key);
  const stepUp = needsStepUp(row.permission);
  const locked = busy || unconfirmed;

  // Versions of the item; read again when the item's version changes (after a re-read).
  useEffect(() => {
    let active = true;
    const id = `${row.key}|${row.version}|${page}|${attempt}`;
    Promise.resolve()
      .then(() => {
        const custom = getProvider().custom;
        if (custom === undefined) throw new Error('Missing custom data provider');
        return custom<VersionPage>({
          url: `${itemUrl(row.key)}/versions`,
          method: 'get',
          query: { page, page_size: VERSION_PAGE_SIZE },
        });
      })
      .then(
        (response) => {
          if (active)
            setLoaded({
              id,
              state: { status: 'ready', items: response.data.items, total: response.data.total },
            });
        },
        () => {
          if (active) setLoaded({ id, state: { status: 'failed' } });
        },
      );
    return () => {
      active = false;
    };
  }, [getProvider, row.key, row.version, page, attempt]);

  const save = () => {
    if (!editable || locked) return;
    form.validateFields().then(
      (values) => {
        const parsed = parseInput(row, values.value);
        if (!parsed.ok) return;
        onSave(parsed.value, values.reason.trim());
      },
      () => undefined,
    );
  };

  const rollback = (version: ConfigVersion) => {
    if (!editable || locked) return;
    form.validateFields(['reason']).then(
      (values) => onRollback(version, values.reason.trim()),
      () => undefined,
    );
  };

  const small = { fontSize: 12 } as const;
  const code = { fontFamily: token.fontFamilyCode, fontSize: 13 } as const;
  const sectionTitle = (text: string) => (
    <Typography.Title level={5} style={{ margin: 0 }}>
      {text}
    </Typography.Title>
  );
  const label = (text: string) => (
    <Typography.Text type="secondary" style={small}>
      {text}
    </Typography.Text>
  );
  const fen = isMoney(row) && row.value !== null ? fenLabel(row.value) : null;

  const columns: TableColumnsType<ConfigVersion> = [
    {
      key: 'version',
      width: 56,
      render: (_, version) => <Typography.Text>{t.version(version.version)}</Typography.Text>,
    },
    {
      key: 'value',
      render: (_, version) => (
        <Flex vertical gap={2}>
          <Typography.Text>{valueLabel(row, version.value)}</Typography.Text>
          {version.reason === null || version.reason === '' ? null : (
            <Typography.Text type="secondary" style={small}>
              {version.reason}
            </Typography.Text>
          )}
        </Flex>
      ),
    },
    {
      key: 'author',
      width: 108,
      render: (_, version) => <Typography.Text>{authorOf(version.updated_by)}</Typography.Text>,
    },
    {
      key: 'time',
      width: 150,
      render: (_, version) => <Typography.Text>{beijingTime(version.created_at)}</Typography.Text>,
    },
    {
      key: 'action',
      width: 104,
      align: 'right',
      render: (_, version) => {
        if (version.version === row.version)
          return (
            <Tag color="success" style={{ marginInlineEnd: 0 }}>
              {t.drawer.currentTag}
            </Tag>
          );
        if (!editable || version.version > row.version) return null;
        return (
          <Button
            type="link"
            size="small"
            icon={stepUp ? <SafetyOutlined aria-hidden /> : undefined}
            aria-label={t.drawer.rollbackLabel(version.version)}
            disabled={locked}
            style={{ paddingInline: 0 }}
            onClick={() => rollback(version)}
          >
            {t.drawer.rollback}
          </Button>
        );
      },
    },
  ];

  let historyBody: ReactNode;
  if (history.status === 'failed') {
    historyBody = (
      <Alert
        type="error"
        showIcon
        message={t.drawer.historyFailed}
        action={
          <Button size="small" onClick={() => setAttempt((value) => value + 1)}>
            {t.retry}
          </Button>
        }
      />
    );
  } else if (history.status === 'ready' && history.total === 0) {
    historyBody = <Typography.Text type="secondary">{t.drawer.historyEmpty}</Typography.Text>;
  } else {
    historyBody = (
      <Table<ConfigVersion>
        rowKey="version"
        size="middle"
        showHeader={false}
        columns={columns}
        loading={delayedLoading(history.status === 'loading', loadingClock)}
        dataSource={history.status === 'ready' ? history.items : []}
        locale={{ emptyText: t.drawer.historyEmpty }}
        pagination={
          history.status === 'ready' && history.total > VERSION_PAGE_SIZE
            ? {
                current: page,
                pageSize: VERSION_PAGE_SIZE,
                total: history.total,
                size: 'small',
                showSizeChanger: false,
                onChange: setPage,
              }
            : false
        }
      />
    );
  }

  const summary = (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 16,
        padding: 16,
        borderRadius: token.borderRadius,
        background: token.colorInfoBg,
      }}
    >
      <Flex vertical gap={4}>
        {label(t.drawer.key)}
        <Typography.Text style={{ ...code, overflowWrap: 'anywhere' }}>{row.key}</Typography.Text>
      </Flex>
      <Flex vertical gap={4}>
        {label(t.drawer.current)}
        <Flex align="center" gap={8} wrap>
          <Typography.Text strong>{valueLabel(row, row.value)}</Typography.Text>
          {fen === null ? null : <Typography.Text type="secondary">{t.fen(fen)}</Typography.Text>}
          {isPendingOwner(row.key) ? <Tag color="warning">{t.pendingOwner}</Tag> : null}
        </Flex>
      </Flex>
      <Flex vertical gap={4}>
        {label(t.drawer.scope)}
        <Typography.Text>{scopeOf(row.key)}</Typography.Text>
      </Flex>
      <Flex vertical gap={4}>
        {label(t.drawer.effect)}
        <Typography.Text>{t.drawer.effectText}</Typography.Text>
      </Flex>
      <Flex vertical gap={4}>
        {label(t.drawer.version)}
        <Typography.Text>{t.version(row.version)}</Typography.Text>
      </Flex>
      <Flex vertical gap={4}>
        {label(t.drawer.updated)}
        <Typography.Text>
          {t.drawer.updatedLine(
            authorOf(row.updated_by),
            row.updated_at === null ? null : beijingTime(row.updated_at),
          )}
        </Typography.Text>
      </Flex>
    </div>
  );

  const description = descriptionOf(row.key);
  let readOnlyNote: string | null = null;
  if (!row.admin_editable) readOnlyNote = t.drawer.readOnlyNote;
  else if (!permitted) readOnlyNote = t.drawer.noPermissionNote(row.permission);
  else if (unconfirmed) readOnlyNote = t.unconfirmedNote;

  return (
    <Drawer
      open
      width={640}
      destroyOnHidden
      maskClosable={!busy}
      keyboard={!busy}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={
        <Flex vertical gap={2}>
          <Typography.Text strong style={{ fontSize: 16 }}>
            {editable ? t.drawer.editTitle(name) : t.drawer.viewTitle(name)}
          </Typography.Text>
          <Typography.Text type="secondary" style={small}>
            {t.drawer.subtitle(groupLabel(groupOf(row)), row.permission)}
          </Typography.Text>
        </Flex>
      }
      footer={
        editable ? (
          <Flex justify="end" gap={8}>
            <Button disabled={busy} onClick={onClose}>
              {t.drawer.cancel}
            </Button>
            <Button
              type="primary"
              icon={stepUp ? <SafetyOutlined aria-hidden /> : undefined}
              disabled={locked}
              aria-busy={writing ? true : undefined}
              onClick={save}
            >
              {stepUp ? t.drawer.saveStepUp : t.drawer.save}
            </Button>
          </Flex>
        ) : (
          <Flex justify="end">
            <Button onClick={onClose}>{t.drawer.cancel}</Button>
          </Flex>
        )
      }
    >
      <Flex vertical gap={24}>
        {notice}
        {description === null ? null : (
          <Flex vertical gap={8}>
            {sectionTitle(t.drawer.description)}
            <Typography.Text>{description}</Typography.Text>
          </Flex>
        )}
        {summary}
        {readOnlyNote === null ? null : (
          <Alert role="note" type="info" showIcon message={readOnlyNote} />
        )}
        {editable ? (
          <Flex vertical gap={8}>
            {sectionTitle(t.drawer.change)}
            <Form<FormValues>
              form={form}
              name="config-item-edit"
              layout="vertical"
              requiredMark={false}
              disabled={locked}
              initialValues={{ value: initialInput(row), reason: '' }}
            >
              <ValueField
                row={row}
                name="value"
                label={row.value_type === 'object' ? t.drawer.newValueJson : t.drawer.newValue}
              />
              <Form.Item
                name="reason"
                label={t.drawer.reason}
                rules={[
                  {
                    validator: (_, value: unknown) => {
                      const text = typeof value === 'string' ? value.trim() : '';
                      if (text === '') return Promise.reject(new Error(t.validation.reason));
                      if (codePointLength(text) > REASON_MAX)
                        return Promise.reject(new Error(t.validation.reasonMax));
                      return Promise.resolve();
                    },
                  },
                ]}
              >
                <Input.TextArea rows={3} placeholder={t.drawer.reasonPlaceholder} />
              </Form.Item>
            </Form>
          </Flex>
        ) : null}
        <Flex vertical gap={8}>
          {sectionTitle(t.drawer.history)}
          {historyBody}
        </Flex>
      </Flex>
    </Drawer>
  );
}

interface VersionPage extends Record<string, unknown> {
  items: ConfigVersion[];
  total: number;
}
