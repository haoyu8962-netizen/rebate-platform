// 后台「消息模板」页（运营 / 消息模板，资源 messages；画板 AdmNotify*，负责人 2026-10-24 定稿）：
// 「消息模板」页签按编码开关推送与短信，「短信」页签按 code × variant 登记签名与模板 CODE，保存为
// 「待测试」并测试发送，测试已受理后启用新配置。数据来自 GET /admin/v1/notify-channels（CT-24t，不分页；
// 读权限 content.article 或 notify.channels 任一，服务端 10403 时显示无权限）；没有 notify.channels 时
// 能看、写控件不出现。验证手机号取 adminGetMyPermissions 的 verify_phone_masked。列表接口还是 planned
// 时整页「功能开发中」。
// TODO(规划/11 §7): 「发送记录」页签 — blocked on 契约未出
import { useDataProvider } from '@refinedev/core';
import { Alert, Button, Flex, Result, Tabs, Typography } from 'antd';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { PlannedPage, usePlanned } from '../../components/planned/index.ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { messagesTexts as t } from '../../texts/messages.ts';
import { ChannelsTab } from './ChannelsTab.tsx';
import {
  LIST_URL,
  ME_URL,
  codeOf,
  enableUrl,
  fieldsOf,
  forbiddenWordsOf,
  needsStepUpAgain,
  notAccepted,
  pendingUrl,
  reasonOf,
  retestUrl,
  smsUrl,
  variantOf,
  type ChannelItem,
  type EnableRequest,
  type Me,
  type NoticeType,
  type Notify,
  type RegisterDraft,
  type RegisterRequest,
  type RetestRequest,
  type SmsResult,
} from './model.ts';
import { SmsDrawer, type DrawerErrors } from './SmsDrawer.tsx';
import { SmsTab } from './SmsTab.tsx';
import { TestSendModal, type TestDialog } from './TestSendModal.tsx';
import { useStepUp } from './useStepUp.tsx';
import { DelayedSpin } from '../../components/loading/index.ts';

export interface MessagesPageProps {
  readonly access: AccessControl;
}

type LoadStatus = 'loading' | 'ready' | 'failed' | 'forbidden';
type TabKey = 'channels' | 'sms';

interface Notice {
  readonly id: number;
  readonly type: NoticeType;
  readonly text: string;
}

interface Editing {
  readonly code: string;
  readonly variant: string;
  readonly draft?: RegisterDraft;
}

function Title(): ReactElement {
  return (
    <Typography.Title level={4} className="admin-page-title" style={{ margin: 0 }}>
      {t.title}
    </Typography.Title>
  );
}

export function MessagesPage({ access }: MessagesPageProps): ReactElement {
  const listPlanned = usePlanned('adminListNotifyChannels');
  if (listPlanned) return <PlannedPage title={t.title} />;
  return (
    <MessagesContent
      canWrite={access.can('notify.channels')}
      canFund={access.can('content.fund_terms')}
    />
  );
}

function MessagesContent({
  canWrite,
  canFund,
}: {
  readonly canWrite: boolean;
  readonly canFund: boolean;
}): ReactElement {
  const getProvider = useDataProvider();
  const switchPlanned = usePlanned('adminSwitchNotifyChannels');
  const stepUp = useStepUp();
  const [items, setItems] = useState<readonly ChannelItem[]>([]);
  const itemsRef = useRef<readonly ChannelItem[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [tab, setTab] = useState<TabKey>('channels');
  const [focus, setFocus] = useState<string>();
  const [phone, setPhone] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>();
  const noticeId = useRef(0);
  const [editing, setEditing] = useState<Editing>();
  const [fieldErrors, setFieldErrors] = useState<DrawerErrors>({});
  const [drawerNotice, setDrawerNotice] = useState<string>();
  const [drawerBusy, setDrawerBusy] = useState(false);
  const [dialog, setDialog] = useState<TestDialog>();
  const dialogRef = useRef<TestDialog | undefined>(undefined);
  const listSequence = useRef(0);

  const notify: Notify = useCallback((type, text) => {
    if (type === undefined || text === undefined) {
      setNotice(undefined);
      return;
    }
    noticeId.current += 1;
    setNotice({ id: noticeId.current, type, text });
  }, []);

  const showDialog = useCallback((next: TestDialog | undefined) => {
    dialogRef.current = next;
    setDialog(next);
  }, []);
  const updateDialog = (patch: Partial<TestDialog>) => {
    const open = dialogRef.current;
    if (open !== undefined) showDialog({ ...open, ...patch });
  };

  const show = useCallback((next: readonly ChannelItem[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const call = useCallback(
    async <T,>(params: {
      url: string;
      method: 'get' | 'post' | 'put' | 'patch' | 'delete';
      query?: Record<string, string>;
      payload?: unknown;
      stepUpToken?: string;
    }): Promise<T> => {
      const custom = getProvider().custom;
      if (custom === undefined) throw new Error('Missing custom data provider');
      const response = await custom<T & object>({
        url: params.url,
        method: params.method,
        ...(params.query === undefined ? {} : { query: params.query }),
        ...(params.payload === undefined ? {} : { payload: params.payload }),
        ...(params.stepUpToken === undefined ? {} : { meta: { stepUpToken: params.stepUpToken } }),
      });
      return response.data;
    },
    [getProvider],
  );

  const load = useCallback(
    (first: boolean) => {
      const request = ++listSequence.current;
      return call<{ items: ChannelItem[] }>({ url: LIST_URL, method: 'get' }).then(
        (data) => {
          if (request !== listSequence.current) return;
          show(data.items);
          setStatus('ready');
        },
        (cause: unknown) => {
          if (request !== listSequence.current) return;
          if (codeOf(cause) === 10403) setStatus('forbidden');
          // 重新读取失败时保留已显示的列表（各写操作已各自提示）。
          else if (first) setStatus('failed');
        },
      );
    },
    [call, show],
  );

  useEffect(() => {
    void load(true);
    return () => {
      listSequence.current += 1;
    };
  }, [load]);

  useEffect(() => {
    let live = true;
    call<Me>({ url: ME_URL, method: 'get' }).then(
      (me) => {
        if (live) setPhone(me.verify_phone_masked);
      },
      () => {
        // 读不到时按没有验证手机号处理：测试发送前提示先登记。
      },
    );
    return () => {
      live = false;
    };
  }, [call]);

  const current = useCallback(
    (code: string) => itemsRef.current.find((item) => item.code === code),
    [],
  );

  /** 写成功：按返回项更新该编码（此前发出的读取作废，免得旧列表盖掉它）。 */
  const apply = useCallback(
    (next: ChannelItem) => {
      listSequence.current += 1;
      show(itemsRef.current.map((item) => (item.code === next.code ? next : item)));
    },
    [show],
  );

  const reload = useCallback(() => void load(false), [load]);

  const conflict = () => {
    notify('warning', t.conflict);
    reload();
  };

  const closeDrawer = () => {
    setEditing(undefined);
    setFieldErrors({});
    setDrawerNotice(undefined);
    setDrawerBusy(false);
  };
  const openDrawer = (code: string, variant: string, draft?: RegisterDraft) => {
    setFieldErrors({});
    setDrawerNotice(undefined);
    setDrawerBusy(false);
    setEditing(draft === undefined ? { code, variant } : { code, variant, draft });
  };

  const fundBlocked = (item: ChannelItem): boolean => item.fund_terms && !canFund;

  // ---- 保存（PUT …/sms?variant=）----------------------------------------------------------

  const register = async (
    code: string,
    variant: string,
    draft: RegisterDraft,
    test: boolean,
    stepUpToken: string,
  ): Promise<void> => {
    const item = current(code);
    if (item === undefined) return;
    const first = variantOf(item, variant)?.active === null;
    const body: RegisterRequest = { ...draft, row_version: item.row_version };
    setDrawerBusy(true);
    setDrawerNotice(undefined);
    try {
      const result = await call<SmsResult>({
        url: smsUrl(code),
        method: 'put',
        query: { variant },
        payload: body,
        stepUpToken,
      });
      apply(result.item);
      closeDrawer();
      if (!test) {
        showDialog(undefined);
        notify('success', t.saved(code, variant));
        return;
      }
      const saved = variantOf(result.item, variant);
      const outcome = saved?.pending?.test.status;
      const base = dialogRef.current ?? testDialog(result.item, variant, 'save', draft);
      if (base === undefined) return;
      if (outcome === 'accepted')
        showDialog({ ...base, view: 'accepted', first, sentTo: result.test_send_phone_masked });
      else if (outcome === 'not_sent_no_verify_phone')
        showDialog({ ...base, view: 'noPhone', first, saved: true });
      else showDialog({ ...base, view: 'failed', first });
    } catch (cause) {
      if (needsStepUpAgain(cause)) {
        stepUp.ask({
          operation: t.drawer.operation(code, variant),
          again: true,
          run: (token) => void register(code, variant, draft, test, token),
          onCancel: () => {
            setDrawerBusy(false);
            showDialog(undefined);
          },
        });
        return;
      }
      setDrawerBusy(false);
      const failure = codeOf(cause);
      if (notAccepted(cause)) {
        // 新配置照存为「测试失败」、row_version 已变：刷新列表。抽屉留着，【修改配置】回到它。
        updateDialog({ view: 'failed', first, ...(failure === undefined ? {} : { failure }) });
        reload();
        return;
      }
      showDialog(undefined);
      if (failure === 20001) {
        const fields = fieldsOf(cause);
        const reason = reasonOf(cause);
        const next: DrawerErrors = {};
        if (fields.includes('sign_name')) next.sign_name = t.errors.signInvalid;
        if (fields.includes('template_code')) next.template_code = t.errors.templateInvalid;
        if (fields.includes('template_type')) next.template_type = t.errors.typeInvalid;
        if (fields.includes('preview_text')) {
          const words = forbiddenWordsOf(fields);
          next.preview_text =
            reason === 'notify_preview_vars_mismatch'
              ? t.errors.previewVarsMismatch
              : reason === 'notify_code_ttl_mismatch'
                ? t.errors.previewTtlMismatch
                : words.length > 0
                  ? t.errors.previewForbidden(words)
                  : t.errors.previewInvalid;
        }
        setFieldErrors(next);
        if (Object.keys(next).length === 0)
          setDrawerNotice(
            fields.includes('code') && reason === 'notify_channel_locked'
              ? t.errors.codeLocked
              : t.errors.invalid,
          );
      } else if (failure === 20902) {
        setDrawerNotice(t.conflict);
        conflict();
      } else if (failure === 10403) setDrawerNotice(t.errors.forbidden);
      else setDrawerNotice(t.errors.failed);
    }
  };

  /** 测试发送弹窗的底稿：新配置（抽屉填的或已存的「待测试」登记）与当前生效。 */
  const testDialog = (
    item: ChannelItem,
    variant: string,
    source: TestDialog['source'],
    draft?: RegisterDraft,
  ): TestDialog | undefined => {
    const row = variantOf(item, variant);
    const fresh = draft ?? row?.pending;
    if (row === undefined || fresh === undefined || fresh === null) return undefined;
    return {
      code: item.code,
      variant,
      view: 'confirm',
      source,
      first: row.active === null,
      fresh: { sign_name: fresh.sign_name, template_code: fresh.template_code },
      current: row.active,
      variables: row.variables,
      fundBlocked: fundBlocked(item),
    };
  };

  const save = (draft: RegisterDraft, test: boolean) => {
    if (editing === undefined) return;
    const { code, variant } = editing;
    const ask = () =>
      stepUp.ask({
        operation: t.drawer.operation(code, variant),
        run: (token) => void register(code, variant, draft, test, token),
        onCancel: () => showDialog(undefined),
      });
    const item = current(code);
    if (!test || phone === null || item === undefined) {
      // 只改预览正文直接保存；没有验证手机号时仍存为「待测试」、不发（D10-339 ⑤）。
      ask();
      return;
    }
    const next = testDialog(item, variant, 'save', draft);
    if (next === undefined) return;
    showDialog(next);
  };

  // ---- 测试发送 / 重新测试（POST …/sms/pending/test）---------------------------------------

  const retest = async (code: string, variant: string, stepUpToken: string): Promise<void> => {
    const item = current(code);
    if (item === undefined) return;
    const body: RetestRequest = { row_version: item.row_version };
    try {
      const result = await call<SmsResult>({
        url: retestUrl(code),
        method: 'post',
        query: { variant },
        payload: body,
        stepUpToken,
      });
      apply(result.item);
      const outcome = variantOf(result.item, variant)?.pending?.test.status;
      if (outcome === 'accepted')
        updateDialog({ view: 'accepted', sentTo: result.test_send_phone_masked });
      else updateDialog({ view: 'failed' });
    } catch (cause) {
      if (needsStepUpAgain(cause)) {
        stepUp.ask({
          operation: t.retestOperation(code, variant),
          again: true,
          run: (token) => void retest(code, variant, token),
          onCancel: () => showDialog(undefined),
        });
        return;
      }
      const failure = codeOf(cause);
      if (failure === 10003) {
        // verify_phone_missing：不再弹动态码，弹「先登记验证手机号」。
        updateDialog({ view: 'noPhone', saved: false });
        return;
      }
      if (notAccepted(cause)) {
        updateDialog({ view: 'failed', ...(failure === undefined ? {} : { failure }) });
        reload();
        return;
      }
      showDialog(undefined);
      if (failure === 20902) conflict();
      else if (failure === 20001) {
        notify('error', t.test.refused);
        reload();
      } else if (failure === 10403) notify('error', t.forbiddenWrite);
      else notify('error', t.test.failed);
    }
  };

  const startTest = (code: string, variant: string) => {
    const item = current(code);
    if (item === undefined) return;
    const next = testDialog(item, variant, 'row');
    if (next === undefined) return;
    // 页面读到没有验证手机号：直接弹「先登记验证手机号」，不要动态码、不请求。
    showDialog(phone === null ? { ...next, view: 'noPhone', saved: false } : next);
  };

  /** 抽屉【保存】时填的内容（测试发送弹窗【发送测试短信】后一并保存）。 */
  const savingDraft = useRef<RegisterDraft | undefined>(undefined);

  const send = () => {
    const open = dialogRef.current;
    if (open === undefined || open.view !== 'confirm') return;
    const { code, variant } = open;
    stepUp.ask({
      operation:
        open.source === 'save'
          ? t.drawer.operation(code, variant)
          : t.retestOperation(code, variant),
      run: (token) => {
        updateDialog({ view: 'busy' });
        if (open.source === 'save') {
          const pendingDraft = savingDraft.current;
          if (pendingDraft !== undefined) void register(code, variant, pendingDraft, true, token);
        } else void retest(code, variant, token);
      },
    });
  };

  // ---- 启用新配置（POST …/sms/pending/enable）---------------------------------------------

  const enable = async (code: string, variant: string, stepUpToken: string): Promise<void> => {
    const item = current(code);
    if (item === undefined) return;
    const body: EnableRequest = { row_version: item.row_version };
    setDrawerBusy(true);
    try {
      const result = await call<ChannelItem>({
        url: enableUrl(code),
        method: 'post',
        query: { variant },
        payload: body,
        stepUpToken,
      });
      apply(result);
      showDialog(undefined);
      closeDrawer();
      notify('success', t.enabled(code, variant));
    } catch (cause) {
      if (needsStepUpAgain(cause)) {
        stepUp.ask({
          operation: t.enableOperation(code, variant),
          again: true,
          run: (token) => void enable(code, variant, token),
          onCancel: () => setDrawerBusy(false),
        });
        return;
      }
      setDrawerBusy(false);
      showDialog(undefined);
      const failure = codeOf(cause);
      if (failure === 20902) conflict();
      else if (failure === 20001) {
        notify('error', t.enableRefused);
        reload();
      } else if (failure === 10403) notify('error', t.forbiddenWrite);
      else notify('error', t.enableFailed);
    }
  };

  const startEnable = (code: string, variant: string) =>
    stepUp.ask({
      operation: t.enableOperation(code, variant),
      run: (token) => void enable(code, variant, token),
    });

  // ---- 放弃新配置（DELETE …/sms/pending，不要动态码）--------------------------------------

  const discard = async (code: string, variant: string): Promise<void> => {
    const item = current(code);
    if (item === undefined) return;
    try {
      const result = await call<ChannelItem>({
        url: pendingUrl(code),
        method: 'delete',
        query: { variant, row_version: String(item.row_version) },
      });
      apply(result);
      notify('success', t.discarded(code, variant));
    } catch (cause) {
      if (codeOf(cause) === 20902) conflict();
      else if (codeOf(cause) === 10403) notify('error', t.forbiddenWrite);
      else notify('error', t.discardFailed);
    }
  };

  if (status === 'forbidden')
    return (
      <Flex vertical gap={16}>
        <Title />
        <Result status="403" title={t.forbidden} />
      </Flex>
    );

  let body: ReactElement;
  if (status === 'loading') {
    body = (
      <Flex aria-busy="true" align="center" gap={8} style={{ padding: 24 }}>
        <DelayedSpin />
        <Typography.Text type="secondary">{t.loading}</Typography.Text>
      </Flex>
    );
  } else if (status === 'failed') {
    body = (
      <Result
        status="error"
        title={t.loadFailed}
        extra={
          <Button
            type="primary"
            autoInsertSpace={false}
            onClick={() => {
              setStatus('loading');
              void load(true);
            }}
          >
            {t.retry}
          </Button>
        }
      />
    );
  } else {
    body = (
      <Tabs
        activeKey={tab}
        destroyOnHidden
        onChange={(key) => setTab(key === 'sms' ? 'sms' : 'channels')}
        items={[
          {
            key: 'channels',
            label: t.tabs.channels,
            children: (
              <ChannelsTab
                items={items}
                current={current}
                stepUp={stepUp}
                canWrite={canWrite}
                switchPlanned={switchPlanned}
                onItem={apply}
                onReload={reload}
                notify={notify}
                onGoSms={(code) => {
                  setFocus(code);
                  setTab('sms');
                }}
              />
            ),
          },
          {
            key: 'sms',
            label: t.tabs.sms,
            children: (
              <SmsTab
                items={items}
                canWrite={canWrite}
                focus={focus}
                onEdit={(code, variant) => openDrawer(code, variant)}
                onTest={startTest}
                onDiscard={(code, variant) => void discard(code, variant)}
              />
            ),
          },
        ]}
      />
    );
  }

  const editItem = editing === undefined ? undefined : items.find((i) => i.code === editing.code);
  const editRow =
    editing === undefined || editItem === undefined
      ? undefined
      : variantOf(editItem, editing.variant);

  return (
    <Flex vertical gap={16}>
      <Title />
      {status === 'ready' && !canWrite ? (
        <Typography.Text type="secondary">{t.readOnly}</Typography.Text>
      ) : null}
      {notice === undefined ? null : (
        <Alert
          key={notice.id}
          type={notice.type}
          showIcon
          closable
          message={notice.text}
          onClose={() => setNotice(undefined)}
        />
      )}
      {body}
      {canWrite && editing !== undefined && editItem !== undefined && editRow !== undefined ? (
        <SmsDrawer
          key={`${editing.code}/${editing.variant}`}
          item={editItem}
          row={editRow}
          readOnly={fundBlocked(editItem)}
          busy={drawerBusy}
          errors={fieldErrors}
          notice={drawerNotice}
          draft={editing.draft}
          onErrors={setFieldErrors}
          onSave={(draft, test) => {
            savingDraft.current = draft;
            setEditing({ ...editing, draft });
            save(draft, test);
          }}
          onEnable={() => startEnable(editing.code, editing.variant)}
          onClose={closeDrawer}
        />
      ) : null}
      {/* 动态码对话框打开期间先不画测试发送弹窗：antd 在测试环境给每个 Modal 标题同一个 id，叠着时
          动态码对话框的可访问名会被它顶替；验证后弹窗照原内容（或结果）再出现。 */}
      {dialog === undefined || stepUp.open ? null : (
        <TestSendModal
          dialog={dialog}
          phone={phone}
          onSend={send}
          onClose={() => {
            const open = dialogRef.current;
            showDialog(undefined);
            // 未受理后【关闭】：抽屉一并关掉。
            if (open?.view === 'failed') closeDrawer();
          }}
          onEnable={() => {
            const open = dialogRef.current;
            if (open !== undefined) startEnable(open.code, open.variant);
          }}
          onRevise={() => {
            const open = dialogRef.current;
            showDialog(undefined);
            if (open !== undefined && editing === undefined) openDrawer(open.code, open.variant);
          }}
        />
      )}
      {stepUp.modal}
    </Flex>
  );
}
