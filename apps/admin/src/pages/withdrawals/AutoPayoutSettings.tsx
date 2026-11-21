// 提现审核页「自动到账设置」页签（F1-08ap；BR-WDR-30 细则「后台配置页」，规格 admin-withdrawals.md）。
// 读：进入页签时才读 GET /admin/v1/config-items（adminListConfigItems，page / page_size ≤ 200，逐页读完）取
// withdraw.auto_payout.*；持 switch.* 任一时读 GET /admin/v1/kill-switches，只读显示总开关
// withdraw.auto_payout.enabled 的状态并放【去紧急开关页】（本页不发任何开关写请求、无开关控件，D10-2375 ①）；
// 不持 switch.* 时不请求开关列表、总开关显示无权限查看。
// 分组：「自动到账设置」按花卷云 ①–⑧ 的顺序；⑨ ⑫ 另列「本系统附加」并注明花卷云无此项；⑤ ⑥ 只读「不自动到账」；
// 「开启前置检查」只列四个条目、不显示满足与否；不做配置历史与【恢复默认值】（D10-2017）。
// 写：【保存】只送改过的键，一次 POST /admin/v1/config-items/batch {items:[{key,value,expected_version}]}；
// config.business 为 totp 档动态码，凭证一次性，每次保存都重新要动态码。成功后以回答的新 version 刷新。
// 20001 data.fields 逐项标出；20902 提示已被他人修改需刷新、不自动重发；10403 无权限；普通 10003 重新要动态码
// 后原样重发。结果未知（D10-1731 / D10-1739 / D10-2060 / D10-2061）：无回应、网络错误、无法解析、带外壳的 5xx →
// 锁定表单，只给【原样重试】（同一请求体，重新要动态码）与【刷新核对】；重试收到 10403、10003 +
// verify_phone_missing、20902 仍结果未知；普通 10003 重验后原样重发；20001 等确定拒绝解锁。进入结果未知时记
// unknown-marker（page=withdrawals），拿到确定结果或【刷新核对】后清本实例那一份（D10-2075）。
// 资金评审（D10-2050）：没有无交互角色却带点击 / 按键处理的元素（时段用原生下拉、标签用原生勾选框），
// 也没有任何把金额、默认值或当前时间填进输入框的入口。
import type { Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Divider,
  Flex,
  Form,
  Input,
  Result,
  Switch,
  Typography,
  theme,
} from 'antd';
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { StepUpModal, type StepUpResult } from '../../components/step-up/index.ts';
import { endsSession, useUnknownMarker } from '../../components/unknown-marker/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { stepUpTexts } from '../../texts/step-up.ts';
import { withdrawalsTexts } from '../../texts/withdrawals.ts';
import {
  AUTO_KEY,
  CONFIG_BATCH_URL,
  CONFIG_ITEMS_URL,
  CONFIG_PAGE_SIZE,
  DEFAULT_ENDS,
  DEFAULT_STARTS,
  FIXED_FLAG,
  MASTER_KEY,
  OPTIONAL_FLAGS,
  SWITCHES_ROUTE,
  autoPayoutItems,
  checkDraft,
  draftOf,
  masterOf,
  type AutoPayoutDraft,
  type AutoPayoutEntry,
  type AutoPayoutError,
  type AutoPayoutField,
  type AutoPayoutItem,
  type AutoPayoutKey,
  type AutoPayoutMaster,
} from './auto-payout.ts';
import { keepsUnknown, verifyAgain } from './DetailPayoutActions.tsx';
import { MARKER_PAGE, type ManualPaidClock } from './ManualPaid.tsx';
import {
  KILL_SWITCHES_URL,
  STEP_UP_URL,
  SWITCH_PAGE_SIZE,
  fieldsOf,
  RISK_FLAGS,
  isSettledRejection,
  riskLabel,
  type KillSwitchPage,
} from './model.ts';

const t = withdrawalsTexts.autoPayout;
const FORBIDDEN = 10403;
const INVALID = 20001;
const CONFLICT = 20902;
/** Upper bound of list pages read (the registry is far smaller). */
const MAX_PAGES = 20;

type ConfigPage = Schema<'AdminConfigItemPage'>;
type BatchRequest = { readonly items: readonly AutoPayoutEntry[] };

type Load = 'loading' | 'ready' | 'failed' | 'forbidden';
type MasterState = AutoPayoutMaster | 'loading' | 'failed';
/** edit: the form is usable; verify / sending: a save is under way; unknown / rechecking: locked. */
type Phase = 'edit' | 'verify' | 'sending' | 'unknown' | 'rechecking';
type Notice = { readonly type: 'success' | 'warning' | 'error'; readonly text: string };

const ERROR_TEXT: Readonly<Record<AutoPayoutError, string>> = t.errors;

export interface AutoPayoutSettingsProps {
  /** switch.all / switch.payout / switch.pay: the master switch's state can be read. */
  readonly canReadMaster: boolean;
  /** The page's injected clock (the moment of the result-unknown marker). */
  readonly clock: ManualPaidClock;
}

/** The failure notice of a settled refusal of the batch. */
function refusalText(cause: unknown): string {
  if (!(cause instanceof AdminApiError)) return t.failed;
  if (cause.code === FORBIDDEN) return t.forbidden;
  if (cause.code === CONFLICT) return t.conflict;
  if (cause.code === INVALID) return t.invalid;
  if (cause.code === 10003) return stepUpTexts.verifyPhoneMissing;
  return t.failed;
}

/** The items of a batch answer (undefined when the answer does not say what was stored). */
function answeredItems(data: unknown): AutoPayoutItem[] | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return undefined;
  const valid = items.every(
    (item: unknown) =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { key?: unknown }).key === 'string' &&
      Number.isSafeInteger((item as { version?: unknown }).version),
  );
  return valid ? (items as AutoPayoutItem[]) : undefined;
}

export function AutoPayoutSettings({
  canReadMaster,
  clock,
}: AutoPayoutSettingsProps): ReactElement {
  const getProvider = useDataProvider();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const marker = useUnknownMarker(MARKER_PAGE, clock);
  const [load, setLoad] = useState<Load>('loading');
  const [attempt, setAttempt] = useState(0);
  const [items, setItems] = useState<readonly AutoPayoutItem[]>([]);
  const [draft, setDraft] = useState<AutoPayoutDraft>({});
  const [errors, setErrors] = useState<Partial<Record<AutoPayoutKey, string>>>({});
  const [master, setMaster] = useState<MasterState>(canReadMaster ? 'loading' : 'forbidden');
  const [phase, setPhaseValue] = useState<Phase>('edit');
  const [notice, setNotice] = useState<Notice>();
  /** A refusal shown inside the result-unknown notice (the state is kept). */
  const [unknownNote, setUnknownNote] = useState<string>();
  /** 20902 on a first save: offer 【刷新】. */
  const [stale, setStale] = useState(false);
  const [again, setAgain] = useState(false);
  /** How many settings the save under way changes (shown in the step-up dialog). */
  const [pendingCount, setPendingCount] = useState(0);
  const phaseRef = useRef<Phase>('edit');
  /** The body of the save under way; kept unchanged for 【原样重试】 and a 10003 resend. */
  const bodyRef = useRef<BatchRequest | undefined>(undefined);
  /** An earlier send of this body got no settled answer: it may have taken effect. */
  const uncertainRef = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const setPhase = (next: Phase) => {
    phaseRef.current = next;
    setPhaseValue(next);
  };

  const customOf = () => {
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    return custom;
  };

  /** Every config item of the registry (page by page), only the tab's keys kept. */
  const readItems = async (): Promise<AutoPayoutItem[]> => {
    const all: AutoPayoutItem[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await customOf()<ConfigPage>({
        url: CONFIG_ITEMS_URL,
        method: 'get',
        query: { page, page_size: CONFIG_PAGE_SIZE },
      });
      const { items: rows, total, page_size: size } = response.data;
      all.push(...(rows as unknown as AutoPayoutItem[]));
      if (rows.length === 0 || page * size >= total) break;
    }
    return autoPayoutItems(all);
  };

  /** The form shows exactly `next` as the server holds it (nothing typed is kept). */
  const show = (next: readonly AutoPayoutItem[]) => {
    setItems(next);
    setDraft(draftOf(next));
    setErrors({});
  };

  // The settings: read when the tab is entered (this component mounts then), and on 【重试】 / 【刷新】.
  useEffect(() => {
    let current = true;
    readItems().then(
      (next) => {
        if (!current) return;
        show(next);
        setLoad('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        setLoad(
          cause instanceof AdminApiError && cause.code === FORBIDDEN ? 'forbidden' : 'failed',
        );
      },
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read on entry and on `attempt` only
  }, [getProvider, attempt]);

  // The master switch (read only): one read of the switch list, only with a switch point.
  useEffect(() => {
    if (!canReadMaster) return;
    let current = true;
    const read = async (): Promise<MasterState> => {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const response = await customOf()<KillSwitchPage>({
          url: KILL_SWITCHES_URL,
          method: 'get',
          query: { page, page_size: SWITCH_PAGE_SIZE },
        });
        const { items: rows, total, page_size: size } = response.data;
        if (rows.some((row) => row.key === MASTER_KEY)) return masterOf(rows);
        if (rows.length === 0 || page * size >= total) return 'failed';
      }
      return 'failed';
    };
    read().then(
      (state) => {
        if (current) setMaster(state);
      },
      (cause: unknown) => {
        if (!current) return;
        setMaster(
          cause instanceof AdminApiError && cause.code === FORBIDDEN ? 'forbidden' : 'failed',
        );
      },
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per entry
  }, [getProvider, canReadMaster]);

  const locked = phase !== 'edit';
  const checked = checkDraft(items, draft);
  const changed = 'entries' in checked ? checked.entries.length : 0;
  const hasErrors = 'errors' in checked;

  const edit = (key: AutoPayoutKey, value: AutoPayoutField) => {
    if (phaseRef.current !== 'edit') return;
    setDraft((previous) => ({ ...previous, [key]: value }));
    // ③ is checked on both ends together: editing either clears both marks.
    const cleared: readonly AutoPayoutKey[] =
      key === AUTO_KEY.windowStart || key === AUTO_KEY.windowEnd
        ? [AUTO_KEY.windowStart, AUTO_KEY.windowEnd]
        : [key];
    setErrors((previous) => {
      if (cleared.every((one) => previous[one] === undefined)) return previous;
      const next = { ...previous };
      for (const one of cleared) delete next[one];
      return next;
    });
  };

  const save = () => {
    if (phaseRef.current !== 'edit') return;
    const result = checkDraft(items, draft);
    if ('errors' in result) {
      const marks: Partial<Record<AutoPayoutKey, string>> = {};
      for (const [key, error] of Object.entries(result.errors))
        marks[key as AutoPayoutKey] = ERROR_TEXT[error];
      setErrors(marks);
      setNotice(undefined);
      return;
    }
    if (result.entries.length === 0) {
      setNotice({ type: 'warning', text: t.noChange });
      return;
    }
    bodyRef.current = { items: result.entries };
    setPendingCount(result.entries.length);
    uncertainRef.current = false;
    setErrors({});
    setNotice(undefined);
    setStale(false);
    setUnknownNote(undefined);
    setAgain(false);
    setPhase('verify');
  };

  const retry = () => {
    if (phaseRef.current !== 'unknown' || bodyRef.current === undefined) return;
    setAgain(false);
    setPhase('verify');
  };

  const cancelVerify = () => {
    if (phaseRef.current !== 'verify') return;
    if (uncertainRef.current) {
      setPhase('unknown');
      return;
    }
    bodyRef.current = undefined;
    setPhase('edit');
  };

  const verify = async (code: string): Promise<StepUpResult> => {
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

  /** No settled answer: lock the form; only 【原样重试】 and 【刷新核对】 remain. */
  const unknown = (note?: string) => {
    if (!uncertainRef.current) marker.mark();
    uncertainRef.current = true;
    setNotice(undefined);
    setUnknownNote(note);
    setPhase('unknown');
  };

  /** A settled answer: drop this instance's marker (the session ending settles nothing). */
  const settledBy = (cause?: unknown) => {
    if (uncertainRef.current) {
      if (cause !== undefined && endsSession(cause)) marker.leave();
      else marker.clear();
    }
    uncertainRef.current = false;
    bodyRef.current = undefined;
    setUnknownNote(undefined);
  };

  const send = async (body: BatchRequest, stepUpToken: string): Promise<void> => {
    try {
      const response = await customOf()({
        url: CONFIG_BATCH_URL,
        method: 'post',
        payload: body,
        meta: { stepUpToken },
      });
      if (!alive.current) return;
      const answered = answeredItems(response.data);
      if (answered === undefined) {
        // An answer that does not say what was stored is no answer.
        unknown();
        return;
      }
      settledBy();
      const byKey = new Map(answered.map((item) => [item.key, item]));
      const next = items.map((item) => byKey.get(item.key) ?? item);
      show(next);
      setStale(false);
      setNotice({ type: 'success', text: t.saved });
      setPhase('edit');
    } catch (cause) {
      if (!alive.current) return;
      if (verifyAgain(cause)) {
        // The pass was not accepted (used up or expired): a new dynamic code, the same body.
        setAgain(true);
        setPhase('verify');
        return;
      }
      if (
        uncertainRef.current &&
        (keepsUnknown(cause) ||
          (cause instanceof AdminApiError && cause.kind === 'api' && cause.code === CONFLICT))
      ) {
        // The first send may have taken effect: a 10403 / 10003 + verify_phone_missing / 20902
        // of the retry settles nothing; still locked, the body unchanged.
        unknown(refusalText(cause));
        return;
      }
      if (endsSession(cause)) {
        // The session ended: the shell signs in again; an unknown result stays unknown.
        if (uncertainRef.current) {
          marker.leave();
          setPhase('unknown');
          return;
        }
        bodyRef.current = undefined;
        setNotice({ type: 'error', text: t.failed });
        setPhase('edit');
        return;
      }
      if (isSettledRejection(cause)) {
        settledBy(cause);
        if (cause instanceof AdminApiError && cause.code === INVALID) {
          const marks: Partial<Record<AutoPayoutKey, string>> = {};
          for (const key of fieldsOf(cause))
            if (typeof key === 'string' && items.some((item) => item.key === key))
              marks[key as AutoPayoutKey] = t.errors.server;
          setErrors(marks);
        }
        if (cause instanceof AdminApiError && cause.code === CONFLICT) setStale(true);
        setNotice({ type: 'error', text: refusalText(cause) });
        setPhase('edit');
        return;
      }
      // Dropped, unparsable, an enveloped 5xx, 40901 …: the result is unknown.
      unknown();
    }
  };

  const onVerified = (stepUpToken: string) => {
    const body = bodyRef.current;
    if (phaseRef.current !== 'verify' || body === undefined) return;
    setPhase('sending');
    void send(body, stepUpToken);
  };

  /** 【刷新核对】: read the settings again and show what the server holds; then unlock. */
  const recheck = () => {
    if (phaseRef.current !== 'unknown') return;
    setPhase('rechecking');
    readItems().then(
      (next) => {
        if (!alive.current) return;
        settledBy();
        show(next);
        setStale(false);
        setNotice(undefined);
        setPhase('edit');
      },
      () => {
        if (!alive.current) return;
        setUnknownNote(t.recheckFailed);
        setPhase('unknown');
      },
    );
  };

  /** 【刷新】 after 20902: read the settings again (what was typed is dropped). */
  const refresh = () => {
    if (phaseRef.current !== 'edit') return;
    setStale(false);
    setNotice(undefined);
    setAttempt((value) => value + 1);
  };

  if (load === 'forbidden')
    return <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />;
  if (load === 'failed' && items.length === 0)
    return (
      <Result
        status="error"
        title={t.loadFailedTitle}
        subTitle={t.loadFailedDescription}
        extra={
          <Button
            type="primary"
            onClick={() => {
              setLoad('loading');
              setAttempt((value) => value + 1);
            }}
          >
            {t.retry}
          </Button>
        }
      />
    );
  if (load === 'loading' && items.length === 0)
    return (
      <Typography.Text type="secondary" role="status">
        {t.loading}
      </Typography.Text>
    );

  return (
    <Flex vertical gap={16}>
      {phase === 'unknown' || phase === 'rechecking' ? (
        <Alert
          type="warning"
          showIcon
          message={t.unknownTitle}
          description={
            <Flex vertical gap={8}>
              <span>{t.unknown}</span>
              {unknownNote === undefined ? null : <span>{unknownNote}</span>}
              <Flex gap={8} wrap>
                <Button
                  autoInsertSpace={false}
                  type="primary"
                  disabled={phase !== 'unknown'}
                  onClick={retry}
                >
                  {t.unknownRetry}
                </Button>
                <Button autoInsertSpace={false} disabled={phase !== 'unknown'} onClick={recheck}>
                  {t.unknownRecheck}
                </Button>
              </Flex>
            </Flex>
          }
        />
      ) : null}
      {notice === undefined ? null : (
        <Alert
          type={notice.type}
          showIcon
          message={notice.text}
          {...(stale && notice.type === 'error'
            ? {
                action: (
                  <Button autoInsertSpace={false} size="small" onClick={refresh}>
                    {t.refresh}
                  </Button>
                ),
              }
            : {})}
        />
      )}
      <Form layout="vertical" component="div" disabled={locked}>
        <Flex vertical gap={16}>
          <MainGroup
            items={items}
            draft={draft}
            errors={errors}
            locked={locked}
            master={master}
            canReadMaster={canReadMaster}
            onEdit={edit}
            onSwitches={() => void navigate(SWITCHES_ROUTE)}
          />
          <ExtraGroup items={items} draft={draft} errors={errors} locked={locked} onEdit={edit} />
          <Card title={t.checksTitle} size="small">
            <Typography.Paragraph type="secondary">{t.checksIntro}</Typography.Paragraph>
            <ul style={{ margin: 0, paddingInlineStart: token.paddingLG }}>
              {t.checks.map((check) => (
                <li key={check}>{check}</li>
              ))}
            </ul>
          </Card>
          <Flex gap={8} align="center">
            <Button
              autoInsertSpace={false}
              type="primary"
              disabled={locked || (changed === 0 && !hasErrors)}
              onClick={save}
            >
              {t.save}
            </Button>
          </Flex>
        </Flex>
      </Form>
      <StepUpModal
        open={phase === 'verify'}
        tier="totp"
        operation={t.stepUpOperation}
        details={[t.stepUpTarget(pendingCount), ...(again ? [t.stepUpAgain] : [])]}
        onSubmit={verify}
        onClose={cancelVerify}
        onVerified={onVerified}
      />
    </Flex>
  );
}

// ---- the groups ------------------------------------------------------------------------------

interface GroupProps {
  readonly items: readonly AutoPayoutItem[];
  readonly draft: AutoPayoutDraft;
  readonly errors: Partial<Record<AutoPayoutKey, string>>;
  readonly locked: boolean;
  readonly onEdit: (key: AutoPayoutKey, value: AutoPayoutField) => void;
}

const itemOf = (items: readonly AutoPayoutItem[], key: AutoPayoutKey) =>
  items.find((item) => item.key === key);

/** Whether `key` was never written (value null: the system default applies). */
const unsetOf = (items: readonly AutoPayoutItem[], key: AutoPayoutKey): boolean => {
  const item = itemOf(items, key);
  return item === undefined || item.value === null;
};

/** A step title of a group (①–⑫); plain text, not a heading. */
function Step({ children }: { readonly children: ReactNode }): ReactElement {
  const { token } = theme.useToken();
  return (
    <Divider orientation="left" orientationMargin={0} plain style={{ marginBlock: token.marginXS }}>
      <Typography.Text strong>{children}</Typography.Text>
    </Divider>
  );
}

/** A read-only field: its label and its value side by side (no control). */
function ReadOnly(props: {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
}): ReactElement {
  const { token } = theme.useToken();
  return (
    <Flex vertical gap={4} style={{ marginBottom: token.marginSM }}>
      <div>
        <span style={{ color: token.colorTextSecondary }}>{props.label}</span>
        <span style={{ marginInlineStart: token.marginSM, fontWeight: 500 }}>{props.value}</span>
      </div>
      {props.note === undefined ? null : (
        <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
          {props.note}
        </Typography.Text>
      )}
    </Flex>
  );
}

/** One typed field (yuan, count or percentage text). */
function TextField(
  props: GroupProps & {
    readonly field: AutoPayoutKey;
    readonly label: string;
    readonly hint: string;
    readonly inputMode: 'decimal' | 'numeric';
  },
): ReactElement {
  const { items, draft, errors, locked, onEdit, field, label, hint, inputMode } = props;
  const { token } = theme.useToken();
  const id = useId();
  const error = errors[field];
  const value = draft[field];
  const item = itemOf(items, field);
  const unset = unsetOf(items, field);
  return (
    <Form.Item
      label={label}
      htmlFor={id}
      validateStatus={error === undefined ? '' : 'error'}
      help={error}
      extra={unset ? t.unsetWith(hint) : hint}
      style={{ marginBottom: token.margin }}
    >
      <Input
        id={id}
        value={typeof value === 'string' ? value : ''}
        inputMode={inputMode}
        autoComplete="off"
        disabled={locked || item?.admin_editable === false}
        {...(unset ? { placeholder: t.selectPlaceholder } : {})}
        aria-invalid={error === undefined ? undefined : true}
        style={{ maxWidth: 240 }}
        onChange={(event) => onEdit(field, event.target.value)}
      />
    </Form.Item>
  );
}

/** One boolean (switch). */
function FlagField(
  props: GroupProps & {
    readonly field: AutoPayoutKey;
    readonly label: string;
    readonly hint: string;
  },
): ReactElement {
  const { items, draft, errors, locked, onEdit, field, label, hint } = props;
  const { token } = theme.useToken();
  const id = useId();
  const value = draft[field];
  const item = itemOf(items, field);
  const unset = unsetOf(items, field) && value === undefined;
  const error = errors[field];
  return (
    <Form.Item
      label={label}
      htmlFor={id}
      validateStatus={error === undefined ? '' : 'error'}
      help={error}
      extra={unset ? t.unsetWith(hint) : hint}
      style={{ marginBottom: token.margin }}
    >
      <Switch
        id={id}
        aria-label={label}
        checked={value === true}
        checkedChildren={t.on}
        unCheckedChildren={t.off}
        disabled={locked || item?.admin_editable === false}
        onChange={(checked) => onEdit(field, checked)}
      />
    </Form.Item>
  );
}

/** window_start / window_end: a native select, every whole hour directly choosable. */
function TimeField(
  props: GroupProps & {
    readonly field: AutoPayoutKey;
    readonly label: string;
    readonly fallback: readonly string[];
  },
): ReactElement {
  const { items, draft, errors, locked, onEdit, field, label, fallback } = props;
  const { token } = theme.useToken();
  const id = useId();
  const item = itemOf(items, field);
  const options = item?.options ?? fallback;
  const value = draft[field];
  const error = errors[field];
  const unset = unsetOf(items, field) && value === undefined;
  return (
    <Form.Item
      label={label}
      htmlFor={id}
      validateStatus={error === undefined ? '' : 'error'}
      help={error}
      {...(unset ? { extra: t.unset } : {})}
      style={{ marginBottom: token.margin }}
    >
      <select
        id={id}
        value={typeof value === 'string' ? value : ''}
        disabled={locked || item?.admin_editable === false}
        aria-invalid={error === undefined ? undefined : true}
        style={{
          minWidth: 160,
          height: token.controlHeight,
          paddingInline: token.paddingSM,
          borderRadius: token.borderRadius,
          border: `1px solid ${error === undefined ? token.colorBorder : token.colorError}`,
          background: locked ? token.colorBgContainerDisabled : token.colorBgContainer,
          color: token.colorText,
          fontVariantNumeric: 'tabular-nums',
        }}
        onChange={(event) => onEdit(field, event.target.value)}
      >
        {typeof value === 'string' ? null : (
          <option value="" disabled>
            {t.selectPlaceholder}
          </option>
        )}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </Form.Item>
  );
}

function masterText(master: MasterState): string {
  if (master === 'on') return t.masterOn;
  if (master === 'off') return t.masterOff;
  if (master === 'forbidden') return t.masterForbidden;
  if (master === 'loading') return t.masterLoading;
  return t.masterFailed;
}

function MainGroup(
  props: GroupProps & {
    readonly master: MasterState;
    readonly canReadMaster: boolean;
    readonly onSwitches: () => void;
  },
): ReactElement {
  const { master, canReadMaster, onSwitches, ...group } = props;
  const { token } = theme.useToken();
  const L = t.labels;
  const H = t.hints;
  return (
    <Card title={t.mainGroup} size="small">
      <Step>{t.steps.master}</Step>
      <ReadOnly label={L.master} value={masterText(master)} note={t.masterNote} />
      {canReadMaster ? (
        <div style={{ marginBottom: token.margin }}>
          <Button autoInsertSpace={false} size="small" onClick={onSwitches}>
            {t.switchEntry}
          </Button>
        </div>
      ) : null}
      <Step>{t.steps.amount}</Step>
      <TextField
        {...group}
        field={AUTO_KEY.maxAmount}
        label={L.maxAmount}
        hint={H.maxAmount}
        inputMode="decimal"
      />
      <Step>{t.steps.window}</Step>
      <FlagField
        {...group}
        field={AUTO_KEY.windowLimit}
        label={L.windowLimit}
        hint={H.windowLimit}
      />
      <Flex gap={16} wrap>
        <TimeField
          {...group}
          field={AUTO_KEY.windowStart}
          label={L.windowStart}
          fallback={DEFAULT_STARTS}
        />
        <TimeField
          {...group}
          field={AUTO_KEY.windowEnd}
          label={L.windowEnd}
          fallback={DEFAULT_ENDS}
        />
      </Flex>
      <Step>{t.steps.first}</Step>
      <FlagField {...group} field={AUTO_KEY.firstLimit} label={L.firstLimit} hint={H.firstLimit} />
      <Step>{t.steps.frozen}</Step>
      <ReadOnly label={L.frozen} value={t.noAuto} note={t.noAutoNote} />
      <Step>{t.steps.sameDay}</Step>
      <ReadOnly label={L.sameDay} value={t.noAuto} note={t.noAutoNote} />
      <Step>{t.steps.counts}</Step>
      {(
        [
          [AUTO_KEY.payeeDaily, L.payeeDaily],
          [AUTO_KEY.payeeMonthly, L.payeeMonthly],
          [AUTO_KEY.userDaily, L.userDaily],
          [AUTO_KEY.userMonthly, L.userMonthly],
        ] as const
      ).map(([field, label]) => (
        <TextField
          key={field}
          {...group}
          field={field}
          label={label}
          hint={H.count}
          inputMode="numeric"
        />
      ))}
      <Step>{t.steps.warn}</Step>
      {(
        [
          [AUTO_KEY.warnRate, L.warnRate],
          [AUTO_KEY.warnOrders, L.warnOrders],
          [AUTO_KEY.warnInvalid, L.warnInvalid],
          [AUTO_KEY.warnReceived, L.warnReceived],
        ] as const
      ).map(([field, label]) => (
        <TextField
          key={field}
          {...group}
          field={field}
          label={label}
          hint={H.warn}
          inputMode="decimal"
        />
      ))}
    </Card>
  );
}

function ExtraGroup(props: GroupProps): ReactElement {
  const { items, draft, locked, onEdit, errors } = props;
  const { token } = theme.useToken();
  const L = t.labels;
  const field = AUTO_KEY.riskFlags;
  const item = itemOf(items, field);
  const value = draft[field];
  const chosen: readonly string[] = Array.isArray(value) ? value : [];
  const error = errors[field];
  const editable = !locked && item?.admin_editable !== false;
  const toggle = (code: string, on: boolean) => {
    const next = OPTIONAL_FLAGS.filter((one) => (one === code ? on : chosen.includes(one)));
    onEdit(field, next);
  };
  const box = { width: 16, height: 16, margin: 0, accentColor: token.colorPrimary } as const;
  const row = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: token.marginXS,
    minHeight: token.controlHeightSM,
  } as const;
  return (
    <Card title={t.extraGroup} size="small">
      <Typography.Paragraph type="secondary">{t.extraNote}</Typography.Paragraph>
      <Step>{t.steps.platform}</Step>
      <TextField
        {...props}
        field={AUTO_KEY.platformDaily}
        label={L.platformDaily}
        hint={t.hints.platformDaily}
        inputMode="decimal"
      />
      <Step>{t.steps.flags}</Step>
      <Form.Item
        label={L.riskFlags}
        validateStatus={error === undefined ? '' : 'error'}
        help={error}
        extra={
          unsetOf(items, field) && value === undefined
            ? t.unsetWith(t.hints.riskFlags)
            : t.hints.riskFlags
        }
        style={{ marginBottom: 0 }}
      >
        <Flex wrap gap={token.marginMD}>
          {RISK_FLAGS.map((code) =>
            code === FIXED_FLAG ? (
              // blacklist_hit is checked on every decision: always ticked, cannot be removed.
              <label key={code} style={row}>
                <input type="checkbox" style={box} checked disabled readOnly />
                <span>{riskLabel(code)}</span>
              </label>
            ) : (
              <label key={code} style={row}>
                <input
                  type="checkbox"
                  style={box}
                  checked={chosen.includes(code)}
                  disabled={!editable}
                  onChange={(event) => toggle(code, event.target.checked)}
                />
                <span>{riskLabel(code)}</span>
              </label>
            ),
          )}
        </Flex>
      </Form.Item>
    </Card>
  );
}
