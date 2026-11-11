// One invite reward record (adminGetInviteReward): read again by invitee when the drawer opens and
// shown as the server answered (never the list row's older copy). 30701 shows 「无记录」; nothing
// is resent by itself; no write operation.
import { useDataProvider } from '@refinedev/core';
import { Button, Descriptions, Drawer, Empty, Result, Typography, theme } from 'antd';
import { useEffect, useState, type ReactElement } from 'react';
import { AdminApiError } from '../../providers/data/index.ts';
import { inviteRewardsTexts as t } from '../../texts/invite-rewards.ts';
import {
  amountLabel,
  beijingTime,
  bindSourceLabel,
  resultLabel,
  rewardUrl,
  skipReasonLabel,
  statusLabel,
  voidReasonLabel,
  type Reward,
} from './model.ts';

export interface RewardDrawerProps {
  readonly inviteeId: string;
  readonly onClose: () => void;
}

type ReadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly reward: Reward }
  | { readonly status: 'not-found' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'failed' };

export function RewardDrawer({ inviteeId, onClose }: RewardDrawerProps): ReactElement {
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const [state, setState] = useState<ReadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<Reward>({ url: rewardUrl(inviteeId), method: 'get' }).then(
      (response) => {
        if (current) setState({ status: 'ready', reward: response.data });
      },
      (cause: unknown) => {
        if (!current) return;
        const code = cause instanceof AdminApiError ? cause.code : undefined;
        if (code === 30701) setState({ status: 'not-found' });
        else if (code === 10403) setState({ status: 'forbidden' });
        else setState({ status: 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, inviteeId, attempt]);

  const code = {
    fontFamily: token.fontFamilyCode,
    fontSize: token.fontSizeSM,
    overflowWrap: 'anywhere',
  } as const;

  let body: ReactElement;
  if (state.status === 'loading') {
    body = (
      <Typography.Text type="secondary" role="status">
        {t.detail.loading}
      </Typography.Text>
    );
  } else if (state.status === 'not-found') {
    body = <Empty description={t.detail.notFound} />;
  } else if (state.status === 'forbidden') {
    body = <Result status="403" title={t.detail.forbidden} subTitle={t.forbiddenDescription} />;
  } else if (state.status === 'failed') {
    body = (
      <Result
        status="error"
        title={t.detail.failed}
        subTitle={t.loadFailedDescription}
        extra={
          <Button
            onClick={() => {
              setState({ status: 'loading' });
              setAttempt((value) => value + 1);
            }}
          >
            {t.detail.retry}
          </Button>
        }
      />
    );
  } else {
    const { reward } = state;
    const person = (phone: string | null, id: string) => (
      <>
        <Typography.Text>{phone ?? t.dash}</Typography.Text>
        <br />
        <Typography.Text type="secondary" style={code}>
          {id}
        </Typography.Text>
      </>
    );
    body = (
      <Descriptions
        column={1}
        size="small"
        bordered
        items={[
          {
            key: 'invitee',
            label: t.detail.invitee,
            children: person(reward.invitee_phone_masked, reward.invitee_id),
          },
          {
            key: 'inviter',
            label: t.detail.inviter,
            children: person(reward.inviter_phone_masked, reward.inviter_id),
          },
          { key: 'amount', label: t.detail.amount, children: amountLabel(reward.amount_fen) },
          {
            key: 'days',
            label: t.detail.eligibilityDays,
            children: t.detail.days(reward.eligibility_days),
          },
          { key: 'source', label: t.detail.source, children: bindSourceLabel(reward.bind_source) },
          {
            key: 'qualified',
            label: t.detail.qualifiedAt,
            children: beijingTime(reward.qualified_at),
          },
          {
            key: 'order',
            label: t.detail.triggerOrder,
            children:
              reward.trigger_order_id === null ? (
                t.dash
              ) : (
                <Typography.Text style={code}>{reward.trigger_order_id}</Typography.Text>
              ),
          },
          {
            key: 'triggered',
            label: t.detail.triggeredAt,
            children: beijingTime(reward.triggered_at),
          },
          { key: 'status', label: t.detail.status, children: statusLabel(reward.status) },
          ...(reward.status === 'voided'
            ? [
                {
                  key: 'void',
                  label: t.detail.voidReason,
                  children: voidReasonLabel(reward.void_reason),
                },
              ]
            : []),
          // Each party only with its own result and reason (BR-INV-24 ③).
          {
            key: 'inviterResult',
            label: t.detail.inviterResult,
            children: resultLabel(reward.inviter_result),
          },
          {
            key: 'inviterReason',
            label: t.detail.inviterSkipReason,
            children: skipReasonLabel(reward.inviter_skip_reason),
          },
          {
            key: 'inviteeResult',
            label: t.detail.inviteeResult,
            children: resultLabel(reward.invitee_result),
          },
          {
            key: 'inviteeReason',
            label: t.detail.inviteeSkipReason,
            children: skipReasonLabel(reward.invitee_skip_reason),
          },
          { key: 'granted', label: t.detail.grantedAt, children: beijingTime(reward.granted_at) },
        ]}
      />
    );
  }

  return (
    <Drawer open width={520} title={t.detail.title} onClose={onClose} destroyOnHidden>
      {body}
    </Drawer>
  );
}
