// 联盟账号与推广位（/unions；契约 tag admin-unions，CT-24h；01 F-ADM-16，BR-ID-24）。页内两个页签：
// 「联盟账号」（本页：全量只读列表、按 reauth_mode 的更新入口、告警手机号）与「推广位」（PidsTab.tsx，
// F1-10gb）。列表读取不要动态码；每一次写都先 totp 动态码。缺 union.account_auth 时联盟账号页签不发
// 任何请求；缺 union.pid 时推广位页签显示无权限、不发任何 union-pids 请求。
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Empty,
  Flex,
  Result,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { PlannedPanel, usePlanned } from '../../components/planned/index.ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import type { AuthClock } from '../../providers/auth/index.ts';
import { unionsTexts as t } from '../../texts/unions.ts';
import { AlertPhonesBlock } from './AlertPhones.tsx';
import { CredentialDialog } from './CredentialDialog.tsx';
import {
  ACCOUNTS_URL,
  PID_PERMISSION,
  beijingTime,
  codeOf,
  dictLabel,
  isNetwork,
  platformLabel,
  type AlertPhones,
  type UnionAccount,
  customOf,
} from './model.ts';
import { PidForbidden, PidsTab } from './PidsTab.tsx';
import { ReauthDialog } from './ReauthDialog.tsx';
import { useStepUp } from './useStepUp.tsx';

export interface UnionsPageProps {
  readonly access: AccessControl;
  readonly clock?: AuthClock | undefined;
}

export const UNION_PERMISSION = 'union.account_auth';
const SYSTEM_CLOCK: AuthClock = { now: () => Date.now() };

type LoadStatus = 'loading' | 'ready' | 'failed' | 'forbidden';

type Editing =
  | { readonly kind: 'oauth'; readonly account: UnionAccount }
  | { readonly kind: 'manual'; readonly account: UnionAccount };

interface Notice {
  readonly type: 'success' | 'error';
  readonly text: string;
}

export function UnionsPage({ access, clock }: UnionsPageProps): ReactElement {
  const permitted = access.can(UNION_PERMISSION);
  const pidPermitted = access.can(PID_PERMISSION);
  const now = clock ?? SYSTEM_CLOCK;
  // 联盟账号列表或告警手机号的读接口还没上线（planned，D10-284）：联盟账号页签显示占位、不发请求；
  // 推广位页签照常（它的账号选项来自 account-options，F1-10gc）。
  const accountsPlanned = usePlanned('adminListUnionAccounts', 'adminListUnionAlertPhones');
  let accountsTab: ReactElement;
  if (!permitted) accountsTab = <Forbidden />;
  else if (accountsPlanned) accountsTab = <PlannedPanel />;
  else accountsTab = <AccountsTab clock={now} />;
  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t.title}
      </Typography.Title>
      <Tabs
        defaultActiveKey="accounts"
        items={[
          {
            key: 'accounts',
            label: t.tabs.accounts,
            children: accountsTab,
          },
          {
            key: 'pids',
            label: t.tabs.pids,
            children: pidPermitted ? <PidsTab clock={now} /> : <PidForbidden />,
          },
        ]}
      />
    </Flex>
  );
}

export function Forbidden(): ReactElement {
  return (
    <Card>
      <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
    </Card>
  );
}

function AccountsTab({ clock }: { readonly clock: AuthClock }): ReactElement {
  const getProvider = useDataProvider();
  const stepUp = useStepUp();
  const [rows, setRows] = useState<UnionAccount[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [network, setNetwork] = useState(false);
  const [editing, setEditing] = useState<Editing>();
  const [notice, setNotice] = useState<Notice>();
  const [phones, setPhones] = useState<AlertPhones>();
  const sequence = useRef(0);

  const load = useCallback(() => {
    const request = ++sequence.current;
    return customOf(getProvider())<{ items: UnionAccount[] }>({
      url: ACCOUNTS_URL,
      method: 'get',
    }).then(
      (response) => {
        if (request !== sequence.current) return;
        setRows(response.data.items);
        setStatus('ready');
      },
      (cause: unknown) => {
        if (request !== sequence.current) return;
        // 再查失败不显示旧数据。
        setRows([]);
        setNetwork(isNetwork(cause));
        setStatus(codeOf(cause) === 10403 ? 'forbidden' : 'failed');
      },
    );
  }, [getProvider]);

  useEffect(() => {
    void load();
    return () => {
      sequence.current += 1;
    };
  }, [load]);

  const retry = () => {
    setStatus('loading');
    void load();
  };

  const open = (kind: Editing['kind'], account: UnionAccount) => {
    setNotice(undefined);
    setEditing({ kind, account });
  };

  // 告警号码是整个后台的一组：读到了就以它为准，没读到时看账号行的 alert_phones_configured。
  const phonesMissing =
    phones === undefined
      ? rows.some((row) => !row.alert_phones_configured)
      : phones.items.length === 0;

  const columns: TableColumnsType<UnionAccount> = [
    {
      key: 'platform',
      title: t.columns.platform,
      width: 96,
      render: (_, row) => <Typography.Text>{platformLabel(row.platform)}</Typography.Text>,
    },
    {
      key: 'account',
      title: t.columns.account,
      width: 180,
      render: (_, row) => <Typography.Text strong>{row.account_name}</Typography.Text>,
    },
    {
      key: 'auth_status',
      title: t.columns.authStatus,
      width: 112,
      render: (_, row) => (
        <Tag
          color={
            row.auth_status === 'active'
              ? 'success'
              : row.auth_status === 'expired'
                ? 'error'
                : 'warning'
          }
          style={{ marginInlineEnd: 0 }}
        >
          {dictLabel('auth_status', row.auth_status)}
        </Tag>
      ),
    },
    {
      key: 'expires',
      title: t.columns.expiresAt,
      width: 180,
      render: (_, row) => (
        <Flex align="center" gap={6} wrap>
          <Typography.Text>{beijingTime(row.auth_expires_at)}</Typography.Text>
          {row.auth_expires_at !== null && row.auth_expires_estimated ? (
            <Tooltip title={t.estimatedHint}>
              <Tag style={{ marginInlineEnd: 0 }}>{t.estimated}</Tag>
            </Tooltip>
          ) : null}
        </Flex>
      ),
    },
    {
      // F1-10gd：只读显示能否自动续期；字段缺省（旧版响应）与 null 一样显示「未知」，不读行里其它字段。
      key: 'refreshable',
      title: t.columns.refreshable,
      width: 112,
      render: (_, row) => {
        const refreshable = row.auth_refreshable ?? null;
        return (
          <Tag
            color={refreshable === null ? 'default' : refreshable ? 'success' : 'error'}
            style={{ marginInlineEnd: 0 }}
          >
            {refreshable === null
              ? t.refreshable.unknown
              : refreshable
                ? t.refreshable.yes
                : t.refreshable.no}
          </Tag>
        );
      },
    },
    {
      key: 'renewed',
      title: t.columns.renewed,
      width: 200,
      render: (_, row) =>
        row.auth_renewed_at === null ? (
          <Typography.Text type="secondary">{t.dash}</Typography.Text>
        ) : (
          <Flex vertical gap={2}>
            <Typography.Text>{beijingTime(row.auth_renewed_at)}</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
              {row.auth_renewed_by ?? t.autoRenewed}
            </Typography.Text>
          </Flex>
        ),
    },
    {
      key: 'probe',
      title: t.columns.probe,
      width: 200,
      render: (_, row) =>
        row.last_probe_at === null && row.last_probe_ok === null ? (
          <Typography.Text type="secondary">{t.neverProbed}</Typography.Text>
        ) : (
          <Flex vertical gap={2}>
            <Typography.Text>{beijingTime(row.last_probe_at)}</Typography.Text>
            {row.last_probe_ok === null ? null : (
              <Typography.Text type={row.last_probe_ok ? 'success' : 'danger'}>
                {dictLabel('last_probe_ok', String(row.last_probe_ok))}
              </Typography.Text>
            )}
            {row.last_probe_error === null ? null : (
              <Typography.Text type="secondary" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
                {row.last_probe_error}
              </Typography.Text>
            )}
          </Flex>
        ),
    },
    {
      key: 'actions',
      title: t.columns.actions,
      width: 120,
      render: (_, row) =>
        row.reauth_mode === 'oauth' ? (
          <Button
            type="link"
            size="small"
            style={{ paddingInline: 0 }}
            onClick={() => open('oauth', row)}
          >
            {t.reauthorize}
          </Button>
        ) : row.reauth_mode === 'manual' ? (
          <Button
            type="link"
            size="small"
            style={{ paddingInline: 0 }}
            onClick={() => open('manual', row)}
          >
            {t.enterCredential}
          </Button>
        ) : (
          <Typography.Text type="secondary">{t.noEntry}</Typography.Text>
        ),
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
    body = <Forbidden />;
  } else if (status === 'failed') {
    body = (
      <Card>
        <Result
          status="error"
          title={t.loadFailedTitle}
          subTitle={network ? t.loadFailedNetwork : t.loadFailedDescription}
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
      <Card styles={{ body: { padding: 0 } }} style={{ overflow: 'hidden' }}>
        <Table<UnionAccount>
          rowKey="union_account_id"
          columns={columns}
          dataSource={rows}
          pagination={false}
          tableLayout="fixed"
          scroll={{ x: 1088 }}
        />
      </Card>
    );
  }

  return (
    <Flex vertical gap={16}>
      {status === 'ready' && phonesMissing ? (
        <Alert
          type="warning"
          showIcon
          message={t.alertPhonesMissing}
          description={t.alertPhonesMissingBody}
        />
      ) : null}
      {notice === undefined ? null : (
        <Alert
          type={notice.type}
          showIcon
          closable
          message={notice.text}
          onClose={() => setNotice(undefined)}
        />
      )}
      {body}
      {status === 'ready' ? <AlertPhonesBlock stepUp={stepUp} onPhones={setPhones} /> : null}
      {editing?.kind === 'oauth' ? (
        <ReauthDialog
          key={editing.account.union_account_id}
          account={editing.account}
          clock={clock}
          stepUp={stepUp}
          onClose={() => setEditing(undefined)}
          onSucceeded={() => {
            setEditing(undefined);
            setNotice({ type: 'success', text: t.reauth.succeeded });
            void load();
          }}
        />
      ) : null}
      {editing?.kind === 'manual' ? (
        <CredentialDialog
          key={editing.account.union_account_id}
          account={editing.account}
          stepUp={stepUp}
          onClose={() => setEditing(undefined)}
          onSaved={(updated) => {
            setEditing(undefined);
            setRows((previous) =>
              previous.map((row) =>
                row.union_account_id === updated.union_account_id ? updated : row,
              ),
            );
            setNotice({ type: 'success', text: t.credential.saved });
          }}
        />
      ) : null}
      {stepUp.modal}
    </Flex>
  );
}
