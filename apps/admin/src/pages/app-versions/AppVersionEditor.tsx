// 单个端与渠道的版本编辑（契约 adminGetAppVersion / adminSaveAppVersion）。只读该行（无行 30701
// 即新建，expected_row_version=null）；保存整行替换。动态码只在提高最低支持版本时先要（totp 档），
// 服务端回 10003 时验证后同一请求体重发一次。保存前核对由服务端判定：默认商店不满足 → 字段旁提示；
// 其他商店落后（[confirmed_stores]）→ 一个确认框列出全部落后商店，确认后整组放进 confirmed_stores
// 重发一次，取消不发。20902 提示刷新并重读该行。不带 Idempotency-Key。
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import { Alert, Button, Card, Flex, Form, Input, Modal, Result, Select, Typography } from 'antd';
import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { Schema } from '@couli/contracts-ts';
import { StepUpModal, type StepUpResult } from '../../components/step-up/index.ts';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { AdminApiError } from '../../providers/data/index.ts';
import { appVersionsTexts as t } from '../../texts/app-versions.ts';
import {
  PERMISSION,
  RAISE_OPERATION,
  STEP_UP_URL,
  codeLabel,
  codeOf,
  draftOf,
  fieldNameOf,
  fieldsOf,
  isNetwork,
  laggingStores,
  newListingId,
  raisesMinimum,
  requestOf,
  rowUrl,
  targetLabel,
  tierOf,
  type AppVersionRow,
  type ChannelCode,
  type Draft,
  type EditablePlatform,
  type FieldName,
  type ListingDraft,
  type SaveRequest,
} from './model.ts';

export interface AppVersionEditorProps {
  readonly access: AccessControl;
  readonly platform: EditablePlatform;
  readonly channel: ChannelCode;
  /** 页面内打开时：【返回列表】。 */
  readonly onBack?: () => void;
  /** 保存成功（响应里的整行）。不给时留在编辑页并换成保存后的内容。 */
  readonly onSaved?: (row: AppVersionRow) => void;
}

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'ready'; readonly row: AppVersionRow | undefined };

type Errors = Partial<Record<FieldName, string>>;
type Notice = { readonly type: 'error' | 'success'; readonly text: string };

interface StepUpAsk {
  readonly tier: 'totp' | 'sms';
  readonly details: readonly string[];
  readonly run: (token: string) => void;
}

interface Confirm {
  readonly body: SaveRequest;
  readonly stores: readonly { store: string; listed: string }[];
  readonly token: string | undefined;
}

export function AppVersionEditor({
  access,
  platform,
  channel,
  onBack,
  onSaved,
}: AppVersionEditorProps): ReactElement {
  const getProvider = useDataProvider();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [draft, setDraft] = useState<Draft>(() => draftOf(undefined));
  const [errors, setErrors] = useState<Errors>({});
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState(false);
  const [stepUp, setStepUp] = useState<StepUpAsk>();
  const [confirm, setConfirm] = useState<Confirm>();
  const alive = useRef(true);
  const attempt = useRef(0);
  const ids = {
    platform: useId(),
    channel: useId(),
    latest: useId(),
    minimum: useId(),
    recommended: useId(),
    defaultStore: useId(),
    title: useId(),
    notes: useId(),
    storeUrl: useId(),
    stores: useId(),
  };
  const target = targetLabel(platform, channel);
  const url = rowUrl(platform, channel);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** 读取该行；`keepNotice` 时保留表单与当前提示（20902 后重读）。加载态由调用方先设。 */
  const read = useCallback(
    (keepNotice: boolean): Promise<void> => {
      attempt.current += 1;
      const current = attempt.current;
      const call = getProvider().custom;
      if (call === undefined) return Promise.reject(new Error('Missing custom data provider'));
      const stale = (): boolean => !alive.current || current !== attempt.current;
      return call<AppVersionRow>({ url, method: 'get' }).then(
        (response) => {
          if (stale()) return;
          setDraft(draftOf(response.data));
          setErrors({});
          setLoad({ status: 'ready', row: response.data });
        },
        (cause: unknown) => {
          if (stale()) return;
          const code = codeOf(cause);
          if (code === 30701) {
            setDraft(draftOf(undefined));
            setErrors({});
            setLoad({ status: 'ready', row: undefined });
          } else if (keepNotice) {
            setNotice({ type: 'error', text: `${t.errors.conflict} ${t.errors.reloadFailed}` });
          } else {
            setLoad({ status: code === 10403 ? 'forbidden' : 'failed' });
          }
        },
      );
    },
    [getProvider, url],
  );

  useEffect(() => {
    void read(false);
  }, [read]);

  const original = load.status === 'ready' ? load.row : undefined;
  const stepUpTier = (cause?: unknown): 'totp' | 'sms' =>
    tierOf(cause) ?? access.stepUpTier(PERMISSION, RAISE_OPERATION) ?? 'totp';

  const verify = async (code: string): Promise<StepUpResult> => {
    const call = getProvider().custom;
    if (call === undefined || stepUp === undefined) return { ok: false, code: 0 };
    const payload: Schema<'AdminStepUpRequest'> = { tier: stepUp.tier, code };
    try {
      const response = await call<Schema<'AdminStepUpResponse'>['data']>({
        url: STEP_UP_URL,
        method: 'post',
        payload,
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

  /**
   * 发一次 PUT。`verified`：这次请求的令牌是刚为它验证得来的；此后再回 10003 只提示，不再弹验证。
   */
  const put = async (
    body: SaveRequest,
    token: string | undefined,
    verified: boolean,
  ): Promise<void> => {
    if (!alive.current) return;
    setBusy(true);
    setNotice(undefined);
    setErrors({});
    const call = getProvider().custom;
    try {
      if (call === undefined) throw new Error('Missing custom data provider');
      const response = await call<AppVersionRow>({
        url,
        method: 'put',
        payload: body,
        ...(token === undefined ? {} : { meta: { stepUpToken: token } }),
      });
      if (!alive.current) return;
      setBusy(false);
      if (onSaved !== undefined) {
        onSaved(response.data);
        return;
      }
      setDraft(draftOf(response.data));
      setLoad({ status: 'ready', row: response.data });
      setNotice({ type: 'success', text: t.savedNotice(target) });
    } catch (cause) {
      if (!alive.current) return;
      setBusy(false);
      const code = codeOf(cause);
      if (code === 10003) {
        if (verified) {
          setNotice({ type: 'error', text: t.errors.stepUpFailed });
          return;
        }
        setBusy(true);
        setStepUp({
          tier: stepUpTier(cause),
          details: [t.editor.stepUpAgain],
          run: (next) => void put(body, next, true),
        });
        return;
      }
      if (code === 20001) {
        const named = fieldsOf(cause).map(fieldNameOf);
        const next: Errors = {};
        for (const name of named)
          if (name !== undefined && name !== 'confirmed_stores') next[name] = t.errors[name];
        const onlyStores = named.includes('confirmed_stores') && Object.keys(next).length === 0;
        if (onlyStores) {
          const stores = body.confirmed_stores.length === 0 ? laggingStores(body) : [];
          if (stores.length > 0) {
            setConfirm({ body, stores, token });
            return;
          }
          setNotice({ type: 'error', text: t.errors.storesUnconfirmed });
          return;
        }
        setErrors(next);
        if (Object.keys(next).length === 0) setNotice({ type: 'error', text: t.errors.invalid });
        return;
      }
      if (code === 20902) {
        setNotice({ type: 'error', text: t.errors.conflict });
        void read(true);
        return;
      }
      if (code === 10403) setNotice({ type: 'error', text: t.errors.noPermission });
      else if (isNetwork(cause)) setNotice({ type: 'error', text: t.errors.network });
      else setNotice({ type: 'error', text: t.errors.failed });
    }
  };

  const save = (): void => {
    if (busy || load.status !== 'ready') return;
    const body = requestOf(draft, original);
    setNotice(undefined);
    setErrors({});
    if (raisesMinimum(original?.min_supported_version, body.min_supported_version)) {
      setBusy(true);
      setStepUp({
        tier: stepUpTier(),
        details: [
          t.editor.stepUpDetail(
            original?.min_supported_version ?? t.dash,
            body.min_supported_version ?? t.dash,
          ),
        ],
        run: (token) => void put(body, token, true),
      });
      return;
    }
    void put(body, undefined, false);
  };

  const closeStepUp = (): void => {
    setStepUp(undefined);
    setBusy(false);
  };
  const onVerified = (token: string): void => {
    const current = stepUp;
    setStepUp(undefined);
    current?.run(token);
  };

  const confirmStores = (): void => {
    const current = confirm;
    setConfirm(undefined);
    if (current === undefined) return;
    // 整组放进 confirmed_stores 重发一次；沿用这次保存已验证的令牌（若有）。
    void put(
      { ...current.body, confirmed_stores: current.stores.map((item) => item.store) },
      current.token,
      false,
    );
  };

  const set = (patch: Partial<Draft>): void => setDraft((previous) => ({ ...previous, ...patch }));
  const setListing = (id: number, patch: Partial<ListingDraft>): void =>
    setDraft((previous) => ({
      ...previous,
      listings: previous.listings.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    }));
  const move = (index: number, delta: -1 | 1): void =>
    setDraft((previous) => {
      const listings = [...previous.listings];
      const other = index + delta;
      if (other < 0 || other >= listings.length) return previous;
      [listings[index], listings[other]] = [listings[other]!, listings[index]!];
      return { ...previous, listings };
    });
  const remove = (id: number): void =>
    setDraft((previous) => ({
      ...previous,
      listings: previous.listings.filter((item) => item.id !== id),
    }));
  const add = (): void =>
    setDraft((previous) => ({
      ...previous,
      listings: [...previous.listings, { id: newListingId(), store: '', listed: '' }],
    }));

  const header = (
    <Flex align="center" justify="space-between" gap={12} wrap>
      <Typography.Title level={4} className="admin-page-title" style={{ margin: 0 }}>
        {t.editor.title(target)}
      </Typography.Title>
      {onBack === undefined ? null : <Button onClick={onBack}>{t.editor.back}</Button>}
    </Flex>
  );

  if (load.status === 'loading') {
    return (
      <Flex vertical gap="middle">
        {header}
        <Card>
          <Typography.Text type="secondary" role="status">
            {t.editor.loading}
          </Typography.Text>
        </Card>
      </Flex>
    );
  }
  if (load.status === 'forbidden' || load.status === 'failed') {
    return (
      <Flex vertical gap="middle">
        {header}
        <Card>
          {load.status === 'forbidden' ? (
            <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
          ) : (
            <Result
              status="error"
              title={t.editor.loadFailedTitle}
              subTitle={t.loadFailedDescription}
              extra={
                <Button
                  onClick={() => {
                    setLoad({ status: 'loading' });
                    void read(false);
                  }}
                >
                  {t.retry}
                </Button>
              }
            />
          )}
        </Card>
      </Flex>
    );
  }

  const status = (name: FieldName) =>
    errors[name] === undefined ? {} : { validateStatus: 'error' as const, help: errors[name] };
  const storeOptions = [
    ...new Set(
      [...draft.listings.map((item) => item.store), draft.defaultStore].filter((s) => s !== ''),
    ),
  ].map((store) => ({ value: store, label: codeLabel('app_store', store) }));

  return (
    <Flex vertical gap="middle">
      {header}
      {original === undefined ? <Alert type="info" showIcon message={t.editor.missing} /> : null}
      {notice === undefined ? null : <Alert type={notice.type} showIcon message={notice.text} />}
      <Form layout="vertical" component={false}>
        <Card title={t.editor.versionSection} size="small">
          <Flex gap={16} wrap>
            <Form.Item label={t.editor.platform} htmlFor={ids.platform} {...status('platform')}>
              <Input id={ids.platform} value={codeLabel('client_platform', platform)} readOnly />
            </Form.Item>
            <Form.Item label={t.editor.channel} htmlFor={ids.channel} {...status('channel')}>
              <Input id={ids.channel} value={codeLabel('install_channel', channel)} readOnly />
            </Form.Item>
          </Flex>
          <Flex gap={16} wrap>
            <Form.Item label={t.editor.latest} htmlFor={ids.latest} {...status('latest_version')}>
              <Input
                id={ids.latest}
                value={draft.latest}
                placeholder="x.y.z"
                onChange={(event) => set({ latest: event.target.value })}
              />
            </Form.Item>
            <Form.Item
              label={t.editor.minimum}
              htmlFor={ids.minimum}
              extra={t.editor.minimumHint}
              {...status('min_supported_version')}
            >
              <Input
                id={ids.minimum}
                value={draft.minimum}
                placeholder="x.y.z"
                onChange={(event) => set({ minimum: event.target.value })}
              />
            </Form.Item>
            <Form.Item
              label={t.editor.recommended}
              htmlFor={ids.recommended}
              {...status('recommended_version')}
            >
              <Input
                id={ids.recommended}
                value={draft.recommended}
                placeholder="x.y.z"
                onChange={(event) => set({ recommended: event.target.value })}
              />
            </Form.Item>
          </Flex>
          <Form.Item
            label={t.editor.defaultStore}
            htmlFor={ids.defaultStore}
            {...status('default_store')}
            style={{ marginBottom: 0, maxWidth: 360 }}
          >
            <Select
              id={ids.defaultStore}
              virtual={false}
              value={draft.defaultStore === '' ? null : draft.defaultStore}
              placeholder={t.editor.defaultStorePlaceholder}
              options={storeOptions}
              onChange={(value: string) => set({ defaultStore: value })}
            />
          </Form.Item>
        </Card>
        <Card title={t.editor.copySection} size="small">
          <Form.Item label={t.editor.updateTitle} htmlFor={ids.title} {...status('update_title')}>
            <Input
              id={ids.title}
              value={draft.title}
              maxLength={100}
              onChange={(event) => set({ title: event.target.value })}
            />
          </Form.Item>
          <Form.Item label={t.editor.updateNotes} htmlFor={ids.notes} {...status('update_notes')}>
            <Input.TextArea
              id={ids.notes}
              value={draft.notes}
              rows={4}
              maxLength={2000}
              onChange={(event) => set({ notes: event.target.value })}
            />
          </Form.Item>
          <Form.Item
            label={t.editor.storeUrl}
            htmlFor={ids.storeUrl}
            {...status('store_url')}
            style={{ marginBottom: 0 }}
          >
            <Input
              id={ids.storeUrl}
              value={draft.storeUrl}
              placeholder="https://"
              onChange={(event) => set({ storeUrl: event.target.value })}
            />
          </Form.Item>
        </Card>
      </Form>
      <div role="group" aria-labelledby={ids.stores}>
        <Card title={<span id={ids.stores}>{t.editor.storesSection}</span>} size="small">
          <Flex vertical gap={8}>
            <Typography.Text type="secondary">{t.editor.storesHint}</Typography.Text>
            {errors.store_listings === undefined ? null : (
              <div className="ant-form-item-explain-error" role="alert">
                <Typography.Text type="danger">{errors.store_listings}</Typography.Text>
              </div>
            )}
            {draft.listings.length === 0 ? (
              <Typography.Text type="secondary">{t.editor.noStores}</Typography.Text>
            ) : null}
            {draft.listings.map((listing, index) => {
              const n = index + 1;
              const name = t.editor.rowName(listing.store, n);
              return (
                <Flex key={listing.id} gap={8} align="center" wrap>
                  <Input
                    aria-label={t.editor.storeName(n)}
                    value={listing.store}
                    style={{ width: 220 }}
                    onChange={(event) => setListing(listing.id, { store: event.target.value })}
                  />
                  <Input
                    aria-label={t.editor.listedVersion(n)}
                    value={listing.listed}
                    placeholder="x.y.z"
                    style={{ width: 160 }}
                    onChange={(event) => setListing(listing.id, { listed: event.target.value })}
                  />
                  <Button
                    icon={<ArrowUpOutlined />}
                    aria-label={t.editor.moveUp(name)}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  />
                  <Button
                    icon={<ArrowDownOutlined />}
                    aria-label={t.editor.moveDown(name)}
                    disabled={index === draft.listings.length - 1}
                    onClick={() => move(index, 1)}
                  />
                  <Button
                    danger
                    icon={<DeleteOutlined />}
                    aria-label={t.editor.remove(name)}
                    onClick={() => remove(listing.id)}
                  />
                </Flex>
              );
            })}
            <div>
              <Button icon={<PlusOutlined />} onClick={add}>
                {t.editor.addStore}
              </Button>
            </div>
          </Flex>
        </Card>
      </div>
      <Flex gap={8}>
        <Button type="primary" disabled={busy} aria-busy={busy || undefined} onClick={save}>
          {t.editor.save}
        </Button>
      </Flex>
      <StepUpModal
        open={stepUp !== undefined}
        tier={stepUp?.tier ?? 'totp'}
        operation={t.editor.stepUpOperation(target)}
        details={stepUp?.details ?? []}
        onSubmit={verify}
        onClose={closeStepUp}
        onVerified={onVerified}
      />
      {confirm === undefined ? null : (
        <Modal
          open
          centered
          width={520}
          title={t.confirm.title}
          destroyOnHidden
          maskClosable={false}
          onCancel={() => setConfirm(undefined)}
          footer={[
            <Button key="cancel" onClick={() => setConfirm(undefined)}>
              {t.confirm.cancel}
            </Button>,
            <Button key="ok" type="primary" onClick={confirmStores}>
              {t.confirm.ok}
            </Button>,
          ]}
        >
          <Flex vertical gap={8}>
            <Typography.Paragraph style={{ margin: 0 }}>
              {t.confirm.intro(confirm.body.min_supported_version ?? t.dash)}
            </Typography.Paragraph>
            <ul style={{ margin: 0 }}>
              {confirm.stores.map((item) => (
                <li key={item.store}>
                  {t.confirm.line(codeLabel('app_store', item.store), item.listed)}
                </li>
              ))}
            </ul>
            <Typography.Text type="secondary">{t.confirm.outro}</Typography.Text>
          </Flex>
        </Modal>
      )}
    </Flex>
  );
}
