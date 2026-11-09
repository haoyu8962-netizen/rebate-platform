// 规则清单 tab of the risk page (contract CT-24f admin-risk). One read of GET
// /admin/v1/risk-rules (not paged, not filtered, no step-up) lists every rule. Enabling or
// disabling goes confirmation (optional reason ≤200) → totp step-up (/admin/v1/auth/step-up) →
// one POST …/{rule_id}/enable | …/disable with X-Step-Up-Token and the listed `expected_version`;
// every change asks for a new code. The row then shows the server's answer (an already-target
// rule is a success too). Threshold keys only lead to the config center (/config?item=<key>);
// this page never edits a threshold.
import type { Schema } from '@couli/contracts-ts';
import { SafetyOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  ConfigProvider,
  Empty,
  Flex,
  Result,
  Table,
  Tag,
  Typography,
  theme,
  type TableColumnsType,
} from 'antd';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Link } from 'react-router';
import { plannedButtonProps, usePlanned } from '../../components/planned/index.ts';
import { StepUpModal, type StepUpResult } from '../../components/step-up/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { rawCodePointLength } from '../../text-length.ts';
import { riskTexts } from '../../texts/risk.ts';
import { ConfirmModal } from './ConfirmModal.tsx';
import {
  REASON_MAX,
  RISK_RULES_URL,
  STEP_UP_URL,
  actionLabel,
  beijingTime,
  changeOf,
  changeRequest,
  configItemTarget,
  fieldsOf,
  statusLabel,
  targetOf,
  writeOutcomeUnknown,
  type RiskRule,
  type RiskRuleChange,
} from './model.ts';

const t = riskTexts.rules;

type LoadStatus = 'loading' | 'ready' | 'failed' | 'forbidden';

interface Pending {
  readonly rule: RiskRule;
  readonly change: RiskRuleChange;
  readonly reason: string;
  readonly phase: 'confirm' | 'verify' | 'writing';
  /** The last write was refused for its step-up proof (10003): verify again, then resend. */
  readonly again: boolean;
}

interface Notice {
  readonly type: 'success' | 'error';
  readonly text: string;
}

const verbOf = (change: RiskRuleChange): string => (change === 'enable' ? t.enable : t.disable);

/** GET /admin/v1/risk-rules: every rule, no query, no step-up. */
async function readRules(
  provider: ReturnType<ReturnType<typeof useDataProvider>>,
): Promise<RiskRule[]> {
  const custom = provider.custom;
  if (custom === undefined) throw new Error('Missing custom data provider');
  const response = await custom<Schema<'AdminRiskRuleList'>>({
    url: RISK_RULES_URL,
    method: 'get',
  });
  return response.data.items;
}

export function RulesTab(): ReactElement {
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  // 启用 / 停用接口还没上线（planned，D10-284）时该行按钮置灰并标「功能开发中」。
  const enablePlanned = usePlanned('adminEnableRiskRule');
  const disablePlanned = usePlanned('adminDisableRiskRule');
  const [rules, setRules] = useState<RiskRule[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPendingState] = useState<Pending>();
  const [notice, setNotice] = useState<Notice>();
  const pendingRef = useRef<Pending | undefined>(undefined);
  const listSequence = useRef(0);
  const writeSequence = useRef(0);

  const setPending = useCallback((next: Pending | undefined) => {
    pendingRef.current = next;
    setPendingState(next);
  }, []);

  const customOf = useCallback(() => {
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    return custom;
  }, [getProvider]);

  /**
   * One read of the whole list (a promise chain: no state is set synchronously in the effect). A
   * failed read, also a refresh, shows the error and never the rows shown before.
   */
  const loadList = useCallback((): Promise<void> => {
    const request = ++listSequence.current;
    return Promise.resolve()
      .then(() => readRules(getProvider()))
      .then(
        (items) => {
          if (request !== listSequence.current) return;
          setRules(items);
          setStatus('ready');
          setRefreshing(false);
        },
        (cause: unknown) => {
          if (request !== listSequence.current) return;
          setRules([]);
          setStatus(
            cause instanceof AdminApiError && cause.code === 10403 ? 'forbidden' : 'failed',
          );
          setRefreshing(false);
        },
      );
  }, [getProvider]);

  useEffect(() => {
    void loadList();
    return () => {
      listSequence.current += 1;
      writeSequence.current += 1;
    };
  }, [loadList]);

  const refresh = () => {
    setRefreshing(true);
    void loadList();
  };

  const retry = () => {
    if (refreshing) return;
    setStatus('loading');
    void loadList();
  };

  const openConfirm = (rule: RiskRule) => {
    // One change at a time: a click during another change or a refresh opens nothing.
    if (pendingRef.current !== undefined || refreshing) return;
    setNotice(undefined);
    setPending({ rule, change: changeOf(rule), reason: '', phase: 'confirm', again: false });
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

  const write = async (target: Pending, proof: string): Promise<void> => {
    const request = ++writeSequence.current;
    // Reads started before this write must not overwrite its answer.
    listSequence.current += 1;
    const { rule, change, reason } = target;
    const verb = verbOf(change);
    try {
      const response = await customOf()<RiskRule>({
        url: `${RISK_RULES_URL}/${encodeURIComponent(rule.rule_id)}/${change}`,
        method: 'post',
        payload: changeRequest(rule, reason),
        meta: { stepUpToken: proof },
      });
      if (request !== writeSequence.current) return;
      const updated = response.data;
      setRules((previous) =>
        previous.map((item) => (item.rule_id === updated.rule_id ? updated : item)),
      );
      setPending(undefined);
      setNotice({ type: 'success', text: t.success(verb, updated.name) });
    } catch (cause) {
      if (request !== writeSequence.current) return;
      if (cause instanceof AdminApiError && cause.code === 10003) {
        // The proof was not accepted: verify again (never resend the old one), then resend.
        setPending({ ...target, phase: 'verify', again: true });
        return;
      }
      setPending(undefined);
      if (cause instanceof AdminApiError && cause.code === 20902) {
        setNotice({ type: 'error', text: t.errors.conflict });
        refresh();
        return;
      }
      if (cause instanceof AdminApiError && cause.code === 20001) {
        const fields = fieldsOf(cause);
        if (fields.includes('rule_id')) {
          setNotice({ type: 'error', text: t.errors.missing });
          refresh();
          return;
        }
        setNotice({
          type: 'error',
          text: fields.includes('reason') ? t.errors.reason : t.errors.invalid(verb),
        });
        return;
      }
      if (cause instanceof AdminApiError && cause.code === 10403) {
        setNotice({ type: 'error', text: t.errors.forbidden(verb) });
        return;
      }
      if (writeOutcomeUnknown(cause)) {
        // The change may have been applied: never resend; read the server's state instead.
        setNotice({ type: 'error', text: t.errors.unknown(verb) });
        refresh();
        return;
      }
      setNotice({ type: 'error', text: t.errors.failed(verb) });
    }
  };

  const onVerified = (proof: string) => {
    const current = pendingRef.current;
    if (current === undefined || current.phase !== 'verify') return;
    const writing: Pending = { ...current, phase: 'writing' };
    setPending(writing);
    void write(writing, proof);
  };

  const writingId = pending?.phase === 'writing' ? pending.rule.rule_id : undefined;
  const locked = writingId !== undefined || refreshing;
  const small = { fontSize: 12 } as const;
  const code = { fontFamily: token.fontFamilyCode, fontSize: 12 } as const;

  const columns: TableColumnsType<RiskRule> = [
    {
      key: 'rule',
      title: t.columns.rule,
      width: 220,
      render: (_, rule) => (
        <Flex vertical gap={2}>
          <Typography.Text strong>{rule.name}</Typography.Text>
          <Typography.Text type="secondary" style={{ ...code, overflowWrap: 'anywhere' }}>
            {rule.rule_id}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      key: 'scene',
      title: t.columns.scene,
      width: 140,
      render: (_, rule) => (
        <Typography.Text style={{ ...code, overflowWrap: 'anywhere' }}>
          {rule.scene}
        </Typography.Text>
      ),
    },
    {
      key: 'action',
      title: t.columns.action,
      width: 120,
      render: (_, rule) => (
        <Tag style={{ marginInlineEnd: 0 }}>{actionLabel(rule.risk_action)}</Tag>
      ),
    },
    {
      key: 'status',
      title: t.columns.status,
      width: 110,
      render: (_, rule) => (
        <Tag
          color={rule.status === 'enabled' ? 'success' : 'default'}
          style={{ marginInlineEnd: 0 }}
        >
          {statusLabel(rule.status)}
        </Tag>
      ),
    },
    {
      key: 'thresholds',
      title: t.columns.thresholds,
      width: 260,
      render: (_, rule) =>
        rule.threshold_keys.length === 0 ? (
          <Typography.Text type="secondary">{t.dash}</Typography.Text>
        ) : (
          <Flex vertical align="flex-start" gap={4}>
            {rule.threshold_keys.map((key) => (
              <Link
                key={key}
                to={configItemTarget(key)}
                style={{ ...code, overflowWrap: 'anywhere' }}
              >
                {key}
              </Link>
            ))}
          </Flex>
        ),
    },
    {
      key: 'updated',
      title: t.columns.updated,
      width: 150,
      render: (_, rule) => (
        <Typography.Text type="secondary" style={small}>
          {beijingTime(rule.updated_at)}
        </Typography.Text>
      ),
    },
    {
      key: 'operations',
      title: t.columns.operations,
      width: 100,
      render: (_, rule) => {
        const change = changeOf(rule);
        const planned = change === 'enable' ? enablePlanned : disablePlanned;
        return (
          <Button
            type="link"
            size="small"
            danger={change === 'disable'}
            icon={<SafetyOutlined aria-hidden />}
            style={{ paddingInline: 0 }}
            disabled={locked}
            aria-busy={writingId === rule.rule_id ? true : undefined}
            onClick={() => openConfirm(rule)}
            {...plannedButtonProps(planned)}
          >
            {verbOf(change)}
          </Button>
        );
      },
    },
  ];

  let body: ReactElement;
  if (status === 'loading') {
    body = (
      <Typography.Text type="secondary" role="status">
        {t.loading}
      </Typography.Text>
    );
  } else if (status === 'forbidden') {
    body = <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />;
  } else if (status === 'failed') {
    body = (
      <Result
        status="error"
        title={t.loadFailedTitle}
        subTitle={t.loadFailedDescription}
        extra={
          <Button onClick={retry} disabled={refreshing}>
            {t.retry}
          </Button>
        }
      />
    );
  } else if (rules.length === 0) {
    body = <Empty description={t.empty} />;
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
        <Flex vertical gap={8}>
          <Typography.Text type="secondary" style={small}>
            {t.count(rules.length)}
          </Typography.Text>
          <Table<RiskRule>
            rowKey="rule_id"
            columns={columns}
            dataSource={rules}
            pagination={false}
            tableLayout="fixed"
            scroll={{ x: 1100 }}
          />
        </Flex>
      </ConfigProvider>
    );
  }

  const pendingVerb = pending === undefined ? '' : verbOf(pending.change);
  return (
    <Flex vertical gap={12}>
      <Typography.Text type="secondary">{t.intro}</Typography.Text>
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
      {pending?.phase === 'confirm' ? (
        <ConfirmModal
          rule={pending.rule}
          change={pending.change}
          reason={pending.reason}
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
        operation={pending === undefined ? '' : t.stepUpOperation(pendingVerb, pending.rule.name)}
        details={
          pending === undefined
            ? []
            : [
                t.stepUpDetail(
                  pending.rule.rule_id,
                  statusLabel(pending.rule.status),
                  statusLabel(targetOf(pending.change)),
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
