// 「消息模板」页签：每个编码一行，站内信 / 推送 / 短信三列照接口字段画（push_switchable、
// sms_switchable、sms_fixed、channels、category、sms_ready、sms_state），前端不写死编码名单。开关 →
// （sms_billing_confirm 的编码由关到开先二次确认）→ 动态码 → PATCH 只带被切的渠道与 row_version；
// 不做乐观更新，成功按返回项更新整行，失败开关保持原值并提示，20902 重新读取列表。短信关着且未就绪时
// 开关置灰；开着但未就绪显示「开（未就绪）」，照普通开关可关。没有 notify.channels 时不出开关，只显示值。
// TODO(规划/11 §7): 站内信措辞编辑与【预览】入口 — blocked on 契约未出
import { LockOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Flex,
  Modal,
  Switch,
  Table,
  Tag,
  Typography,
  type TableColumnsType,
} from 'antd';
import { useState, type ReactElement, type ReactNode } from 'react';
import { messagesTexts as t } from '../../texts/messages.ts';
import {
  channelUrl,
  codeOf,
  fieldsOf,
  hasChannel,
  needsBillingConfirm,
  needsStepUpAgain,
  reasonOf,
  smsGreyed,
  type ChannelItem,
  type Notify,
  type SwitchChannel,
  type SwitchRequest,
} from './model.ts';
import type { StepUp } from './useStepUp.tsx';

export interface ChannelsTabProps {
  readonly items: readonly ChannelItem[];
  /** 读该编码当前项（row_version 取写那一刻的值）。 */
  readonly current: (code: string) => ChannelItem | undefined;
  readonly stepUp: StepUp;
  /** 持有 notify.channels：给开关；否则只显示值。 */
  readonly canWrite: boolean;
  /** adminSwitchNotifyChannels 还是 planned：开关置灰。 */
  readonly switchPlanned: boolean;
  readonly onItem: (item: ChannelItem) => void;
  readonly onReload: () => void;
  readonly notify: Notify;
  /** 「去「短信」登记 / 处理」：切到「短信」页签并定位该编码。 */
  readonly onGoSms: (code: string) => void;
}

function Cell({ main, note, lock }: { main: ReactNode; note?: string; lock?: boolean }) {
  return (
    <Flex vertical gap={2}>
      <span>
        {lock === true ? <LockOutlined aria-hidden style={{ marginRight: 4 }} /> : null}
        {main}
      </span>
      {note === undefined ? null : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {note}
        </Typography.Text>
      )}
    </Flex>
  );
}

function channelNames(channels: readonly string[]): string {
  return channels.map((channel) => t.channelNames[channel] ?? channel).join(t.channelJoin);
}

/** 默认含短信、开着但未就绪（sms_state=enabled_not_ready）。 */
const onNotReady = (item: ChannelItem): boolean => item.sms_state === 'enabled_not_ready';

export function ChannelsTab({
  items,
  current,
  stepUp,
  canWrite,
  switchPlanned,
  onItem,
  onReload,
  notify,
  onGoSms,
}: ChannelsTabProps): ReactElement {
  const getProvider = useDataProvider();
  const [pending, setPending] = useState<string>();
  const [confirm, setConfirm] = useState<ChannelItem>();

  const send = async (
    code: string,
    channel: SwitchChannel,
    on: boolean,
    billing: boolean,
    stepUpToken: string,
  ): Promise<void> => {
    const item = current(code);
    if (item === undefined) return;
    const key = `${code}:${channel}`;
    setPending(key);
    const payload: SwitchRequest = {
      ...(channel === 'push' ? { push: on } : { sms: on }),
      ...(billing ? { confirm_sms_billing: true } : {}),
      row_version: item.row_version,
    };
    try {
      const call = getProvider().custom;
      if (call === undefined) throw new Error('Missing custom data provider');
      const response = await call<ChannelItem>({
        url: channelUrl(code),
        method: 'patch',
        payload,
        meta: { stepUpToken },
      });
      setPending(undefined);
      notify(undefined);
      onItem(response.data);
    } catch (cause) {
      if (needsStepUpAgain(cause)) {
        stepUp.ask({
          operation: t.switchOperation(channel, code, on),
          again: true,
          run: (token) => void send(code, channel, on, billing, token),
          onCancel: () => setPending(undefined),
        });
        return;
      }
      setPending(undefined);
      const failure = codeOf(cause);
      const fields = fieldsOf(cause);
      if (failure === 20902) {
        notify('warning', t.conflict);
        onReload();
      } else if (failure === 20001 && fields.includes('confirm_sms_billing'))
        notify('error', t.switchBillingRefused(code));
      else if (failure === 20001 && fields.includes('sms') && reasonOf(cause) === undefined) {
        // 未就绪打开短信：20001 [sms] 不带 reason；刷新列表让置灰跟上服务端。
        notify('error', t.switchNotReady(code));
        onReload();
      } else if (failure === 20001) notify('error', t.switchRefused(code));
      else if (failure === 10403) notify('error', t.forbiddenWrite);
      else notify('error', t.switchFailed(code));
    }
  };

  const start = (code: string, channel: SwitchChannel, on: boolean, billing: boolean) => {
    stepUp.ask({
      operation: t.switchOperation(channel, code, on),
      run: (token) => void send(code, channel, on, billing, token),
    });
  };

  const toggle = (item: ChannelItem, channel: SwitchChannel) => {
    if (pending !== undefined) return;
    const on = !hasChannel(item, channel);
    if (channel === 'sms' && on && !item.sms_ready) return;
    if (needsBillingConfirm(item, channel, on)) {
      setConfirm(item);
      return;
    }
    start(item.code, channel, on, false);
  };

  const noteOf = (item: ChannelItem, channel: SwitchChannel): string => {
    const byDefault = item.default_channels.includes(channel);
    if (channel === 'sms' && smsGreyed(item)) return `${t.sms.notReady} · ${t.sms.notReadyNote}`;
    if (channel === 'sms' && item.sms_billing_confirm && !byDefault)
      return `${t.defaultOff} · ${t.sms.billingNote}`;
    return byDefault ? t.defaultOn : t.defaultOff;
  };

  const switchOf = (item: ChannelItem, channel: SwitchChannel): ReactElement => {
    const on = hasChannel(item, channel);
    const notReady = channel === 'sms' && on && onNotReady(item);
    const value = channel === 'sms' ? t.sms : t.push;
    const shown = notReady ? t.sms.onNotReady : on ? value.on : value.off;
    if (!canWrite) return <Cell main={shown} note={noteOf(item, channel)} />;
    const key = `${item.code}:${channel}`;
    return (
      <Cell
        main={
          <Flex align="center" gap={6}>
            <Switch
              size="small"
              aria-label={t.switchName(channel, item.code)}
              checked={on}
              loading={pending === key}
              disabled={
                switchPlanned ||
                (channel === 'sms' && smsGreyed(item)) ||
                (pending !== undefined && pending !== key)
              }
              onChange={() => toggle(item, channel)}
            />
            {notReady ? <Typography.Text>{t.sms.onNotReady}</Typography.Text> : null}
          </Flex>
        }
        note={noteOf(item, channel)}
      />
    );
  };

  const inboxCell = (item: ChannelItem): ReactElement =>
    hasChannel(item, 'inbox') ? (
      <Cell main={<Tag icon={<LockOutlined />}>{t.inbox.on}</Tag>} note={t.inbox.onNote} />
    ) : (
      <Cell main={t.inbox.none} note={t.inbox.noneNote} />
    );

  const pushCell = (item: ChannelItem): ReactElement => {
    if (item.push_switchable) return switchOf(item, 'push');
    if (hasChannel(item, 'push')) return <Cell main={t.push.fixedOn} note={t.push.fixedOnNote} />;
    if (hasChannel(item, 'inbox'))
      return <Cell main={t.push.inboxOnly} note={t.push.inboxOnlyNote} />;
    return <Cell main={t.push.none} note={t.push.noneNote} />;
  };

  const smsCell = (item: ChannelItem): ReactElement => {
    if (item.sms_fixed)
      return (
        <Cell
          lock
          main={
            <span aria-label={t.sms.fixedLabel}>
              {onNotReady(item) ? t.withNote(t.sms.fixed, t.sms.notReady) : t.sms.fixed}
            </span>
          }
          note={t.sms.fixedNote}
        />
      );
    if (item.sms_switchable) return switchOf(item, 'sms');
    if (hasChannel(item, 'sms')) return <Cell main={t.sms.fixedOn} note={t.sms.fixedOnNote} />;
    if (item.category !== 'service')
      return <Cell main={t.sms.subscription} note={t.sms.subscriptionNote} />;
    return <Cell main={t.sms.none} note={t.sms.noneNote} />;
  };

  /** 短信要登记或处理：有变体还没有在用配置，或有「待测试」登记。 */
  const smsToDo = (item: ChannelItem): boolean =>
    item.sms_registrations.some((row) => row.active === null || row.pending !== null);

  const columns: TableColumnsType<ChannelItem> = [
    {
      key: 'code',
      title: t.channelColumns.code,
      render: (_, item) => <Typography.Text code>{item.code}</Typography.Text>,
    },
    {
      key: 'category',
      title: t.channelColumns.category,
      render: (_, item) => t.categories[item.category] ?? item.category,
    },
    {
      key: 'fund',
      title: t.channelColumns.fund,
      render: (_, item) => (item.fund_terms ? <Tag color="warning">{t.fundTerms}</Tag> : t.dash),
    },
    { key: 'inbox', title: t.channelColumns.inbox, render: (_, item) => inboxCell(item) },
    { key: 'push', title: t.channelColumns.push, render: (_, item) => pushCell(item) },
    { key: 'sms', title: t.channelColumns.sms, render: (_, item) => smsCell(item) },
    {
      key: 'actions',
      title: t.channelColumns.actions,
      render: (_, item) =>
        smsToDo(item) ? (
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            autoInsertSpace={false}
            onClick={() => onGoSms(item.code)}
          >
            {t.goSms}
          </Button>
        ) : null,
    },
  ];

  const senders = (item: ChannelItem): string => {
    const registered = item.sms_registrations.flatMap((row) =>
      row.active === null ? [] : [`${row.active.sign_name} · ${row.active.template_code}`],
    );
    return registered.length === 0 ? t.confirm.senderNone : registered.join(t.listJoin);
  };

  return (
    <Flex vertical gap={12}>
      <Alert type="info" showIcon message={t.channelsIntro} />
      <Table<ChannelItem>
        rowKey="code"
        size="middle"
        columns={columns}
        dataSource={[...items]}
        pagination={false}
        locale={{ emptyText: t.emptyChannels }}
      />
      {confirm === undefined ? null : (
        <Modal
          open
          width={520}
          title={t.confirm.title(confirm.code)}
          onCancel={() => setConfirm(undefined)}
          footer={
            <Flex justify="end" gap={8}>
              <Button autoInsertSpace={false} onClick={() => setConfirm(undefined)}>
                {t.confirm.cancel}
              </Button>
              <Button
                type="primary"
                autoInsertSpace={false}
                onClick={() => {
                  const item = confirm;
                  setConfirm(undefined);
                  start(item.code, 'sms', true, true);
                }}
              >
                {t.confirm.ok}
              </Button>
            </Flex>
          }
        >
          <Flex vertical gap={8}>
            <Typography.Paragraph style={{ margin: 0 }}>
              {t.confirm.defaults(confirm.code, channelNames(confirm.default_channels))}
              {t.confirm.billing}
            </Typography.Paragraph>
            <Typography.Text>
              {t.confirm.sender}
              {t.colon}
              {senders(confirm)}
            </Typography.Text>
            <Typography.Text>
              {t.confirm.userSwitch}
              {t.colon}
              {t.confirm.userSwitchNote}
            </Typography.Text>
            <Typography.Text>
              {t.confirm.sendTime}
              {t.colon}
              {t.confirm.sendTimeNote}
            </Typography.Text>
            <Typography.Text type="secondary">{t.confirm.footnote}</Typography.Text>
          </Flex>
        </Modal>
      )}
    </Flex>
  );
}
