// 联盟 OAuth 回调页（/unions/oauth-callback，后台路由，不在侧栏）：从地址栏读 state 与 code（或联盟的
// error），带登录态 POST /admin/v1/union-accounts/oauth/callback（不要动态码），显示返回的会话结果。
// code 是一次性的：只提交一次（StrictMode 下也一样）、失败不自动重发，不显示、不记日志，读到后
// 立即从地址栏去掉查询串。未登录的窗口见 UnionOAuthCallbackSignedOut。
import type { Schema } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import { Button, Card, Flex, Result, Typography } from 'antd';
import { useEffect, useEffectEvent, useRef, useState, type ReactElement } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { PlannedPage, usePlanned } from '../../components/planned/index.ts';
import { unionsTexts as t } from '../../texts/unions.ts';
import { CALLBACK_URL, codeOf, customOf, fieldsOf, isNetwork, type ReauthResult } from './model.ts';
import { Forbidden, UNION_PERMISSION, type UnionsPageProps } from './UnionsPage.tsx';
import { DelayedSpin } from '../../components/loading/index.ts';

type Outcome =
  | { readonly kind: 'submitting' }
  | { readonly kind: 'result'; readonly result: ReauthResult }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'error'; readonly text: string };

type CallbackBody = Schema<'AdminUnionOAuthCallbackRequest'>;

/** 地址栏查询串 → 请求体；缺 state 或 code / error 都没有时为 undefined（不提交）。 */
function bodyOf(search: string): CallbackBody | undefined {
  const params = new URLSearchParams(search);
  const state = params.get('state');
  const code = params.get('code');
  const error = params.get('error');
  if (state === null || state === '') return undefined;
  if (code !== null && code !== '') return { state, code };
  if (error !== null && error !== '') return { state, error };
  return undefined;
}

/** 回调接口还没上线（planned，D10-284）：显示占位，不提交 state 与 code。 */
export function UnionOAuthCallbackPage(props: UnionsPageProps): ReactElement {
  const planned = usePlanned('adminCompleteUnionReauthorization');
  return planned ? <PlannedPage title={t.title} /> : <OAuthCallbackContent {...props} />;
}

function OAuthCallbackContent({ access }: UnionsPageProps): ReactElement {
  const permitted = access.can(UNION_PERMISSION);
  const location = useLocation();
  const navigate = useNavigate();
  const getProvider = useDataProvider();
  // 首次渲染时读一次；之后地址栏的查询串会被去掉。
  const [body] = useState(() => bodyOf(location.search));
  const [outcome, setOutcome] = useState<Outcome>(() =>
    body === undefined ? { kind: 'error', text: t.callback.incomplete } : { kind: 'submitting' },
  );
  const sent = useRef(false);
  const mounted = useRef(false);

  const submit = (payload: CallbackBody): Promise<void> =>
    customOf(getProvider())<ReauthResult>({ url: CALLBACK_URL, method: 'post', payload }).then(
      (response) => {
        if (mounted.current) setOutcome({ kind: 'result', result: response.data });
      },
      (cause: unknown) => {
        if (!mounted.current) return;
        const code = codeOf(cause);
        if (code === 10403) setOutcome({ kind: 'forbidden' });
        else if (code === 20001 && fieldsOf(cause).includes('state'))
          setOutcome({ kind: 'error', text: t.callback.stateInvalid });
        else if (code === 20001) setOutcome({ kind: 'error', text: t.callback.incomplete });
        else if (isNetwork(cause)) setOutcome({ kind: 'error', text: t.callback.network });
        else setOutcome({ kind: 'error', text: t.callback.unknown });
      },
    );

  // 只在挂载时提交一次（sent 防 StrictMode 的第二次执行）。
  const start = useEffectEvent(() => {
    if (sent.current || !permitted) return;
    sent.current = true;
    if (location.search !== '') void navigate(location.pathname, { replace: true });
    if (body !== undefined) void submit(body);
  });

  useEffect(() => {
    mounted.current = true;
    start();
    return () => {
      mounted.current = false;
    };
  }, []);

  const back = (
    <Button type="primary" onClick={() => void navigate('/unions')}>
      {t.callback.back}
    </Button>
  );

  let content: ReactElement;
  if (!permitted || outcome.kind === 'forbidden') {
    content = <Forbidden />;
  } else if (outcome.kind === 'submitting') {
    content = (
      <Card>
        <Flex align="center" gap={8} role="status">
          <DelayedSpin size="small" />
          <Typography.Text>{t.callback.submitting}</Typography.Text>
        </Flex>
      </Card>
    );
  } else if (outcome.kind === 'error') {
    content = (
      <Card>
        <Result status="error" title={outcome.text} extra={back} />
      </Card>
    );
  } else {
    const { result } = outcome;
    const view =
      result.status === 'succeeded'
        ? { status: 'success' as const, title: t.callback.succeeded }
        : result.status === 'failed'
          ? {
              status: 'error' as const,
              title:
                result.error === null ? t.callback.failed : t.callback.failedCause(result.error),
            }
          : result.status === 'expired'
            ? { status: 'warning' as const, title: t.callback.expired }
            : { status: 'info' as const, title: t.callback.pending };
    content = (
      <Card>
        <Result status={view.status} title={view.title} extra={back} />
      </Card>
    );
  }

  return (
    <Flex vertical gap={16}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        {t.callback.title}
      </Typography.Title>
      {content}
    </Flex>
  );
}

/**
 * 未登录时打开的回调地址（F1-10ga r1 S1 裁定 2，选「明确提示重新发起」）：不提交、不保存
 * state 与 code（code 一次性，且回调必须由发起授权的管理员带登录态提交），立即从地址栏去掉
 * 查询串，提示回到后台窗口查看或登录后重新发起授权。
 */
export function UnionOAuthCallbackSignedOut(): ReactElement {
  const location = useLocation();
  const navigate = useNavigate();
  const search = location.search;
  const pathname = location.pathname;
  useEffect(() => {
    if (search !== '') void navigate(pathname, { replace: true });
  }, [search, pathname, navigate]);
  return (
    <Flex justify="center" style={{ padding: '48px 16px' }}>
      <Card style={{ maxWidth: 560, width: '100%' }}>
        <Result
          status="warning"
          title={t.callback.signedOutTitle}
          subTitle={t.callback.signedOut}
          extra={
            <Button type="primary" onClick={() => void navigate('/login', { replace: true })}>
              {t.callback.signIn}
            </Button>
          }
        />
      </Card>
    </Flex>
  );
}
