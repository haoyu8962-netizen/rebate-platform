// 【重新授权】（oauth 账号；画板 AdmUnionAccountReauth，未定稿）：选填原因 → 动态码 → POST
// …/{union_account_id}/reauthorize → 在新窗口打开 auth_url，同时立即开始轮询 GET
// …/reauthorize/{session_id}，直到 status 不是 pending。轮询有本地上限（会话有效期 + 宽限、
// 最多次数），对话框关闭或卸载即停止，迟到的响应一律丢弃。
import { useDataProvider } from '@refinedev/core';
import { Alert, Button, Flex, Form, Input, Modal, Typography } from 'antd';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { AuthClock } from '../../providers/auth/index.ts';
import { unionsTexts as t } from '../../texts/unions.ts';
import {
  REASON_MAX,
  beijingTime,
  codeOf,
  fieldsOf,
  pollUrl,
  openAuthWindow,
  safeAuthUrl,
  startUrl,
  type ReauthResult,
  type ReauthSession,
  type UnionAccount,
  fieldStatus,
  customOf,
} from './model.ts';
import type { StepUp } from './useStepUp.tsx';
import { DelayedSpin } from '../../components/loading/index.ts';

/** 两次查询之间的间隔。 */
export const POLL_INTERVAL_MS = 3000;
/** 会话 expires_at 之后再等多久仍未拿到终态就本地停止。 */
export const POLL_GRACE_MS = 30_000;
/** 无论时钟如何，最多查询这么多次（约 12 分钟）。 */
export const POLL_MAX = 240;
/** 契约：授权链接与 state 有效 10 分钟（expires_at 读不懂时的兜底）。 */
const SESSION_VALIDITY_MS = 10 * 60_000;

type Phase =
  | { readonly kind: 'form'; readonly message?: string; readonly reasonError?: string }
  | { readonly kind: 'starting' }
  | { readonly kind: 'waiting'; readonly session: ReauthSession; readonly url?: string }
  | { readonly kind: 'failed'; readonly cause: string | null }
  | { readonly kind: 'expired' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'stopped'; readonly message: string };

export interface ReauthDialogProps {
  readonly account: UnionAccount;
  readonly clock: AuthClock;
  readonly stepUp: StepUp;
  readonly onClose: () => void;
  /** 会话成功：父页关闭对话框并重读列表。 */
  readonly onSucceeded: () => void;
}

export function ReauthDialog({
  account,
  clock,
  stepUp,
  onClose,
  onSucceeded,
}: ReauthDialogProps): ReactElement | null {
  const getProvider = useDataProvider();
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });
  // 每次发起、关闭、卸载都加一；旧一代的响应与定时器不再生效。
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      generation.current += 1;
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );

  const custom = () => customOf(getProvider());

  const poll = async (session: ReauthSession, gen: number, count: number, deadline: number) => {
    if (gen !== generation.current) return;
    if (count >= POLL_MAX || clock.now() > deadline) {
      setPhase({ kind: 'timeout' });
      return;
    }
    const next = () => {
      timer.current = setTimeout(() => {
        timer.current = undefined;
        void poll(session, gen, count + 1, deadline);
      }, POLL_INTERVAL_MS);
    };
    let result: ReauthResult;
    try {
      const response = await custom()<ReauthResult>({
        url: pollUrl(account.union_account_id, session.session_id),
        method: 'get',
      });
      result = response.data;
    } catch (cause) {
      if (gen !== generation.current) return;
      const code = codeOf(cause);
      if (code === 10403) setPhase({ kind: 'stopped', message: t.noPermissionAction });
      else if (code === 20001) setPhase({ kind: 'stopped', message: t.reauth.expired });
      // 网络等临时失败：照常下次再查，仍受上限约束。
      else next();
      return;
    }
    if (gen !== generation.current) return;
    if (result.status === 'pending') next();
    else if (result.status === 'succeeded') {
      generation.current += 1;
      onSucceeded();
    } else if (result.status === 'failed') setPhase({ kind: 'failed', cause: result.error });
    else setPhase({ kind: 'expired' });
  };

  const start = async (stepUpToken: string, note: string) => {
    const gen = ++generation.current;
    setPhase({ kind: 'starting' });
    let session: ReauthSession;
    try {
      const response = await custom()<ReauthSession>({
        url: startUrl(account.union_account_id),
        method: 'post',
        payload: note === '' ? {} : { reason: note },
        meta: { stepUpToken },
      });
      session = response.data;
    } catch (cause) {
      if (gen !== generation.current) return;
      const code = codeOf(cause);
      if (code === 10003) {
        // 令牌没被接受：重新验证（不复用旧令牌），再发起。
        stepUp.ask({
          operation: t.reauth.operation(account.account_name),
          again: true,
          run: (token) => void start(token, note),
          onCancel: () => setPhase({ kind: 'form' }),
        });
        return;
      }
      if (code === 10403) setPhase({ kind: 'form', message: t.noPermissionAction });
      else if (code === 20001 && fieldsOf(cause).includes('reason'))
        setPhase({ kind: 'form', reasonError: t.reasonInvalid });
      else if (code === 20001) setPhase({ kind: 'form', message: t.reauth.notAllowed });
      else setPhase({ kind: 'form', message: t.failed });
      return;
    }
    if (gen !== generation.current) return;
    // 拿到响应的同一轮里打开授权页面并开始查询结果（不等管理员点按钮）。
    const url = safeAuthUrl(session.auth_url);
    if (url !== undefined) openAuthWindow(url);
    setPhase(url === undefined ? { kind: 'waiting', session } : { kind: 'waiting', session, url });
    const expires = Date.parse(session.expires_at);
    const deadline =
      (Number.isNaN(expires) ? clock.now() + SESSION_VALIDITY_MS : expires) + POLL_GRACE_MS;
    void poll(session, gen, 0, deadline);
  };

  const submit = () => {
    if (phase.kind !== 'form') return;
    const note = reason.trim();
    if (note.length > REASON_MAX) {
      setPhase({ kind: 'form', reasonError: t.reasonInvalid });
      return;
    }
    setPhase({ kind: 'form' });
    stepUp.ask({
      operation: t.reauth.operation(account.account_name),
      details: note === '' ? [] : [note],
      run: (token) => void start(token, note),
    });
  };

  let body: ReactElement;
  if (phase.kind === 'form' || phase.kind === 'starting') {
    const reasonError = phase.kind === 'form' ? phase.reasonError : undefined;
    body = (
      <Flex vertical gap={12}>
        <Typography.Paragraph style={{ margin: 0 }}>{t.reauth.intro}</Typography.Paragraph>
        {phase.kind === 'form' && phase.message !== undefined ? (
          <Alert type="error" showIcon message={phase.message} />
        ) : null}
        <Form layout="vertical" component={false}>
          <Form.Item
            label={t.reasonLabel}
            htmlFor={reasonId}
            {...fieldStatus(reasonError)}
            style={{ marginBottom: 0 }}
          >
            <Input.TextArea
              id={reasonId}
              value={reason}
              rows={2}
              maxLength={REASON_MAX}
              placeholder={t.reasonPlaceholder}
              disabled={phase.kind === 'starting'}
              onChange={(event) => setReason(event.target.value)}
            />
          </Form.Item>
        </Form>
        {phase.kind === 'starting' ? (
          <Flex align="center" gap={8} role="status">
            <DelayedSpin size="small" />
            <Typography.Text type="secondary">{t.reauth.starting}</Typography.Text>
          </Flex>
        ) : null}
      </Flex>
    );
  } else if (phase.kind === 'waiting') {
    const url = phase.url;
    body = (
      <Flex vertical gap={12}>
        <Flex align="center" gap={8} role="status">
          <DelayedSpin size="small" />
          <Typography.Text>{t.reauth.waiting}</Typography.Text>
        </Flex>
        {url === undefined ? null : (
          // 不用 target=_blank 链接：同样要经 openAuthWindow 带上登录态并切断 opener。
          <Button
            type="link"
            size="small"
            style={{ paddingInline: 0, alignSelf: 'flex-start' }}
            onClick={() => openAuthWindow(url)}
          >
            {t.reauth.openAgain}
          </Button>
        )}
        <Typography.Text type="secondary">
          {t.reauth.expiresAt(beijingTime(phase.session.expires_at))}
        </Typography.Text>
      </Flex>
    );
  } else if (phase.kind === 'failed') {
    body = (
      <Alert
        type="error"
        showIcon
        role="alert"
        message={phase.cause === null ? t.reauth.failed : t.reauth.failedCause(phase.cause)}
      />
    );
  } else if (phase.kind === 'expired') {
    body = <Alert type="warning" showIcon role="alert" message={t.reauth.expired} />;
  } else if (phase.kind === 'timeout') {
    body = <Alert type="warning" showIcon role="alert" message={t.reauth.timeout} />;
  } else {
    body = <Alert type="error" showIcon role="alert" message={phase.message} />;
  }

  const active = phase.kind === 'form' || phase.kind === 'starting' || phase.kind === 'waiting';
  const footer = active
    ? [
        <Button key="cancel" onClick={onClose}>
          {t.cancel}
        </Button>,
        ...(phase.kind === 'waiting'
          ? []
          : [
              <Button
                key="submit"
                type="primary"
                disabled={phase.kind === 'starting'}
                onClick={submit}
              >
                {t.reauth.submit}
              </Button>,
            ]),
      ]
    : [
        <Button key="close" type="primary" onClick={onClose}>
          {t.close}
        </Button>,
      ];

  // 动态码对话框打开时先收起（见 StepUp.open）。
  if (stepUp.open) return null;
  return (
    <Modal
      open
      centered
      width={520}
      title={t.reauth.title(account.account_name)}
      destroyOnHidden
      maskClosable={false}
      onCancel={onClose}
      footer={footer}
    >
      {body}
    </Modal>
  );
}
