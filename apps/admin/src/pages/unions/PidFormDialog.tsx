// 【登记推广位】与【修改】（只 pending 行）：平台、该平台的联盟账号、淘宝 site_id（只淘宝有，必填）、
// PID、场景、选填原因 → 动态码 → POST /admin/v1/union-pids 或 PATCH …/{pid_id}。修改只发改动过的
// 字段与 expected_row_version；什么都没改时不发请求。20001 按 data.fields 在字段旁提示；20902 交给
// 页签提示刷新并重新读取。不带 Idempotency-Key。
import { useDataProvider } from '@refinedev/core';
import { Alert, Button, Flex, Form, Input, Modal, Select, Typography } from 'antd';
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { unionsTexts as t } from '../../texts/unions.ts';
import {
  PIDS_URL,
  PID_CODE,
  PID_SCENES,
  REASON_MAX,
  codeOf,
  fieldStatus,
  fieldsOf,
  isNetwork,
  pidUrl,
  platformLabel,
  sceneOption,
  type PidCreateRequest,
  type PidPlatform,
  type PidScene,
  type PidUpdateRequest,
  type UnionAccountOption,
  type UnionPid,
} from './model.ts';
import type { StepUp } from './useStepUp.tsx';

type Field = 'platform' | 'union_account_id' | 'site_id' | 'pid' | 'pid_scene' | 'reason';
type Errors = Partial<Record<Field, string>>;

const SERVER_FIELD_TEXT: Readonly<Record<Field, string>> = {
  platform: t.pids.platformInvalid,
  union_account_id: t.pids.accountInvalid,
  site_id: t.pids.siteInvalid,
  pid: t.pids.pidDuplicate,
  pid_scene: t.pids.sceneInvalid,
  reason: t.reasonInvalid,
};

export interface PidFormDialogProps {
  /** 没有时是登记；有时是修改这一行（只 pending）。 */
  readonly row?: UnionPid | undefined;
  /** 联盟账号选项（account-options）；undefined 表示还没读到、读不到或接口未上线。 */
  readonly accounts: readonly UnionAccountOption[] | undefined;
  /** 选不了账号的原因（读取失败 / 功能开发中）；没有时不提示。 */
  readonly accountsHint?: { readonly title: string; readonly description?: string } | undefined;
  readonly stepUp: StepUp;
  readonly onClose: () => void;
  readonly onSaved: (row: UnionPid, created: boolean) => void;
  readonly onConflict: () => void;
}

export function PidFormDialog({
  row,
  accounts,
  accountsHint,
  stepUp,
  onClose,
  onSaved,
  onConflict,
}: PidFormDialogProps): ReactElement | null {
  const getProvider = useDataProvider();
  const platformId = useId();
  const accountId = useId();
  const accountHintId = useId();
  const siteId = useId();
  const pidId = useId();
  const sceneId = useId();
  const reasonId = useId();
  const [platform, setPlatform] = useState<PidPlatform | undefined>(row?.platform);
  const [account, setAccount] = useState<string | undefined>(row?.union_account_id);
  const [site, setSite] = useState(row?.site_id ?? '');
  const [pid, setPid] = useState(row?.pid ?? '');
  const [scene, setScene] = useState<PidScene | undefined>(row?.pid_scene);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [message, setMessage] = useState<{ type: 'error' | 'info'; text: string }>();
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const editing = row !== undefined;

  const clear = (...fields: Field[]) =>
    setErrors((previous) => {
      const next = { ...previous };
      for (const field of fields) delete next[field];
      return next;
    });

  // 平台选项：联盟账号所在的平台（登记只能挂到已有账号），修改时再加上这一行原来的平台。
  const platforms: PidPlatform[] = [];
  for (const item of accounts ?? [])
    if (!platforms.includes(item.platform)) platforms.push(item.platform);
  if (row !== undefined && !platforms.includes(row.platform)) platforms.push(row.platform);

  const accountOptions = (accounts ?? [])
    .filter((item) => item.platform === platform)
    .map((item) => ({ value: item.union_account_id, label: item.account_name }));

  const changePlatform = (next: PidPlatform) => {
    setPlatform(next);
    // 账号只属于一个平台；site_id 只有淘宝有，换平台时清掉，不带到别的平台。
    const owner = (accounts ?? []).find((item) => item.union_account_id === account);
    if (owner === undefined || owner.platform !== next) setAccount(undefined);
    if (next !== 'taobao') setSite('');
    clear('platform', 'union_account_id', 'site_id');
  };

  const operationOf = (payload: PidCreateRequest | PidUpdateRequest): string =>
    row === undefined ? t.pids.registerOperation(payload.pid ?? '') : t.pids.editOperation(row.pid);

  const send = async (
    payload: PidCreateRequest | PidUpdateRequest,
    stepUpToken: string,
  ): Promise<void> => {
    if (!alive.current) return;
    setBusy(true);
    setMessage(undefined);
    setErrors({});
    const call = getProvider().custom;
    try {
      if (call === undefined) throw new Error('Missing custom data provider');
      const response = await call<UnionPid>({
        url: editing ? pidUrl(row.pid_id) : PIDS_URL,
        method: editing ? 'patch' : 'post',
        payload,
        meta: { stepUpToken },
      });
      if (!alive.current) return;
      setBusy(false);
      onSaved(response.data, !editing);
    } catch (cause) {
      if (!alive.current) return;
      const code = codeOf(cause);
      if (code === 10003) {
        stepUp.ask({
          operation: operationOf(payload),
          again: true,
          run: (token) => void send(payload, token),
          onCancel: () => setBusy(false),
        });
        return;
      }
      setBusy(false);
      if (code === 20902) {
        onConflict();
        return;
      }
      if (code === 20001) {
        const fields = fieldsOf(cause);
        const next: Errors = {};
        for (const field of Object.keys(SERVER_FIELD_TEXT) as Field[])
          if (fields.includes(field)) next[field] = SERVER_FIELD_TEXT[field];
        setErrors(next);
        if (fields.includes('body')) setMessage({ type: 'info', text: t.pids.unchanged });
        else if (Object.keys(next).length === 0) setMessage({ type: 'error', text: t.failed });
        return;
      }
      if (code === 10403) setMessage({ type: 'error', text: t.noPermissionAction });
      else if (isNetwork(cause)) setMessage({ type: 'error', text: t.networkUnknown });
      else setMessage({ type: 'error', text: t.failed });
    }
  };

  const submit = () => {
    if (busy) return;
    const next: Errors = {};
    const pidValue = pid.trim();
    const siteValue = site.trim();
    const note = reason.trim();
    if (platform === undefined) next.platform = t.pids.platformRequired;
    if (account === undefined) next.union_account_id = t.pids.accountRequired;
    if (platform === 'taobao') {
      if (siteValue === '') next.site_id = t.pids.siteRequired;
      else if (!PID_CODE.test(siteValue)) next.site_id = t.pids.siteInvalid;
    }
    if (pidValue === '') next.pid = t.pids.pidRequired;
    else if (!PID_CODE.test(pidValue)) next.pid = t.pids.pidInvalid;
    if (scene === undefined) next.pid_scene = t.pids.sceneRequired;
    if (note.length > REASON_MAX) next.reason = t.reasonInvalid;
    setErrors(next);
    setMessage(undefined);
    if (Object.keys(next).length > 0) return;
    if (platform === undefined || account === undefined || scene === undefined) return;
    const siteNext = platform === 'taobao' ? siteValue : null;
    let payload: PidCreateRequest | PidUpdateRequest;
    if (row === undefined) {
      payload = {
        platform,
        union_account_id: account,
        ...(siteNext === null ? {} : { site_id: siteNext }),
        pid: pidValue,
        pid_scene: scene,
        ...(note === '' ? {} : { reason: note }),
      };
    } else {
      const changes: Omit<PidUpdateRequest, 'expected_row_version' | 'reason'> = {
        ...(platform === row.platform ? {} : { platform }),
        ...(account === row.union_account_id ? {} : { union_account_id: account }),
        ...(siteNext === row.site_id ? {} : { site_id: siteNext }),
        ...(pidValue === row.pid ? {} : { pid: pidValue }),
        ...(scene === row.pid_scene ? {} : { pid_scene: scene }),
      };
      if (Object.keys(changes).length === 0) {
        setMessage({ type: 'info', text: t.pids.unchanged });
        return;
      }
      payload = {
        ...changes,
        expected_row_version: row.row_version,
        ...(note === '' ? {} : { reason: note }),
      };
    }
    stepUp.ask({
      operation: operationOf(payload),
      run: (token) => void send(payload, token),
    });
  };

  const item = (field: Field) => fieldStatus(errors[field]);

  // 动态码对话框打开时先收起（见 StepUp.open），填过的内容保留在本组件里。
  if (stepUp.open) return null;
  return (
    <Modal
      open
      centered
      width={560}
      title={editing ? t.pids.editTitle(row.pid) : t.pids.registerTitle}
      destroyOnHidden
      maskClosable={false}
      onCancel={onClose}
      footer={[
        <Button key="cancel" onClick={onClose}>
          {t.cancel}
        </Button>,
        <Button
          key="submit"
          type="primary"
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={submit}
        >
          {editing ? t.pids.editSubmit : t.pids.registerSubmit}
        </Button>,
      ]}
    >
      <Flex vertical gap={12}>
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          {editing ? t.pids.editIntro : t.pids.registerIntro}
        </Typography.Paragraph>
        {accountsHint === undefined ? null : (
          <Alert
            id={accountHintId}
            type="warning"
            showIcon
            message={accountsHint.title}
            description={accountsHint.description}
          />
        )}
        {message === undefined ? null : (
          <Alert type={message.type} showIcon message={message.text} />
        )}
        <Form layout="vertical" component={false}>
          <Form.Item
            label={t.pids.platformLabel}
            htmlFor={platformId}
            required
            {...item('platform')}
          >
            <Select<PidPlatform>
              id={platformId}
              value={platform ?? null}
              disabled={busy}
              options={platforms.map((value) => ({ value, label: platformLabel(value) }))}
              onChange={changePlatform}
            />
          </Form.Item>
          <Form.Item
            label={t.pids.accountLabel}
            htmlFor={accountId}
            required
            {...item('union_account_id')}
          >
            <Select<string>
              id={accountId}
              aria-describedby={accountsHint === undefined ? undefined : accountHintId}
              value={account ?? null}
              disabled={busy}
              placeholder={
                platform === undefined ? t.pids.accountPlatformFirst : t.pids.accountPlaceholder
              }
              options={accountOptions}
              onChange={(value) => {
                setAccount(value);
                clear('union_account_id');
              }}
            />
          </Form.Item>
          {platform === 'taobao' ? (
            <Form.Item label={t.pids.siteLabel} htmlFor={siteId} required {...item('site_id')}>
              <Input
                id={siteId}
                value={site}
                disabled={busy}
                autoComplete="off"
                maxLength={64}
                onChange={(event) => setSite(event.target.value)}
              />
            </Form.Item>
          ) : null}
          <Form.Item label={t.pids.pidLabel} htmlFor={pidId} required {...item('pid')}>
            <Input
              id={pidId}
              value={pid}
              disabled={busy}
              autoComplete="off"
              maxLength={64}
              onChange={(event) => setPid(event.target.value)}
            />
          </Form.Item>
          <Form.Item label={t.pids.sceneLabel} htmlFor={sceneId} required {...item('pid_scene')}>
            <Select<PidScene>
              id={sceneId}
              value={scene ?? null}
              disabled={busy}
              options={PID_SCENES.map((value) => ({ value, label: sceneOption(value) }))}
              onChange={(value) => {
                setScene(value);
                clear('pid_scene');
              }}
            />
          </Form.Item>
          <Form.Item
            label={t.reasonLabel}
            htmlFor={reasonId}
            {...item('reason')}
            style={{ marginBottom: 0 }}
          >
            <Input.TextArea
              id={reasonId}
              value={reason}
              rows={2}
              maxLength={REASON_MAX}
              disabled={busy}
              placeholder={t.reasonPlaceholder}
              onChange={(event) => setReason(event.target.value)}
            />
          </Form.Item>
        </Form>
      </Flex>
    </Modal>
  );
}
