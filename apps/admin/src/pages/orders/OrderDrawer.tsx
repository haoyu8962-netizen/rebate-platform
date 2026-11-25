// The order detail drawer of the list (F1-07edb, BR-ID-46): a row's 【查看】 (or a list address
// carrying detail=<order_id>) opens it on the right without leaving the list. It reads only
// GET /admin/v1/orders/{order_id}, once per opening (【重试】 after a failure reads again), and
// shows the main fields of that order. Every opening shows only its own answer (loading until it
// arrives, nothing from an earlier opening; ./drawer-state.ts); the full detail page (/orders/<order_id>) is unchanged and
// stays behind the row's 【详情】. Display only: no amount is computed here.
import { ReloadOutlined } from '@ant-design/icons';
import { useDataProvider } from '@refinedev/core';
import { Button, Flex, Typography, theme } from 'antd';
import { useEffect, useReducer, type ReactElement, type ReactNode } from 'react';
import { DetailDrawer, type DetailDrawerProps } from '../../components/detail-drawer/index.ts';
import { ordersTexts } from '../../texts/orders.ts';
import { drawerClosed, drawerStep } from './drawer-state.ts';
import { FlagTags, StatusTag } from './parts.tsx';
import {
  beijingTime,
  failureOf,
  money,
  orderUrl,
  platformLabel,
  type OrderDetail,
} from './model.ts';

const t = ordersTexts.drawer;
const basic = ordersTexts.detail.basic;
const dash = ordersTexts.dash;

export interface OrderDrawerProps {
  /** The order shown; undefined: the drawer is closed. */
  readonly orderId: string | undefined;
  readonly onClose: () => void;
}

export function OrderDrawer({ orderId, onClose }: OrderDrawerProps): ReactElement | null {
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const [state, dispatch] = useReducer(drawerStep, drawerClosed);
  // A new order, a close or a reopen starts a new opening before anything is shown.
  if (state.orderId !== orderId) dispatch({ type: 'show', orderId });
  const opening = state.opening;
  const shownId = state.orderId;

  useEffect(() => {
    if (shownId === undefined) return undefined;
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<OrderDetail>({ url: orderUrl(shownId), method: 'get' }).then(
      (response) => {
        if (current)
          dispatch({ type: 'answer', opening, loaded: { status: 'ready', order: response.data } });
      },
      (cause: unknown) => {
        if (!current) return;
        const kind = failureOf(cause);
        dispatch({
          type: 'answer',
          opening,
          loaded: { status: kind === 'invalid' ? 'missing' : kind },
        });
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, shownId, opening]);

  if (orderId === undefined || state.orderId !== orderId) return null;
  const shown = state.loaded;

  const retry = () => {
    dispatch({ type: 'retry' });
  };

  const code = { fontFamily: token.fontFamilyCode } as const;
  const stateGroups = (value: ReactNode): DetailDrawerProps['groups'] => [
    { key: 'state', title: t.title, fields: [{ key: 'state', label: t.stateLabel, value }] },
  ];

  let groups: DetailDrawerProps['groups'];
  if (shown === undefined) {
    groups = stateGroups(
      <Typography.Text type="secondary" role="status">
        {t.loading}
      </Typography.Text>,
    );
  } else if (shown.status === 'missing') {
    groups = stateGroups(<Typography.Text type="secondary">{t.missing}</Typography.Text>);
  } else if (shown.status === 'forbidden') {
    groups = stateGroups(<Typography.Text type="secondary">{t.forbidden}</Typography.Text>);
  } else if (shown.status !== 'ready') {
    // Only 'failed' is left here; the check is on 'ready' so the branch below narrows to it.
    groups = stateGroups(
      <Flex vertical align="flex-start" gap={8}>
        <Typography.Text type="danger">{t.failed}</Typography.Text>
        <Button size="small" icon={<ReloadOutlined aria-hidden />} onClick={retry}>
          {ordersTexts.retry}
        </Button>
      </Flex>,
    );
  } else {
    const order = shown.order;
    groups = [
      {
        key: 'basic',
        title: basic.title,
        fields: [
          {
            key: 'subOrderId',
            label: basic.subOrderId,
            value: (
              <Typography.Text copyable style={code}>
                {order.sub_order_id}
              </Typography.Text>
            ),
          },
          {
            key: 'parentOrderId',
            label: basic.parentOrderId,
            value:
              order.parent_order_id === null ? null : (
                <span style={code}>{order.parent_order_id}</span>
              ),
          },
          { key: 'platform', label: t.platform, value: platformLabel(order.platform) },
          { key: 'productTitle', label: basic.productTitle, value: order.title },
          {
            key: 'itemKey',
            label: basic.itemKey,
            value: (
              <span style={code}>{`${order.raw_item_id} / ${order.product_key ?? dash}`}</span>
            ),
          },
          { key: 'payAmount', label: basic.payAmount, value: money(order.pay_amount_fen) },
          { key: 'paidAt', label: basic.paidAt, value: beijingTime(order.paid_at) },
          {
            key: 'estCommission',
            label: basic.estCommission,
            value: money(order.est_commission_fen),
          },
          {
            key: 'settleCommission',
            label: basic.settleCommission,
            value: money(order.settle_commission_fen),
          },
        ],
      },
      {
        key: 'status',
        title: t.statusTitle,
        fields: [
          {
            key: 'platformStatus',
            label: t.platformStatus,
            value: <StatusTag kind="platform_status" code={order.platform_status} />,
          },
          {
            key: 'rebateStatus',
            label: t.rebateStatus,
            value: <StatusTag kind="rebate_status" code={order.rebate_status} />,
          },
          {
            key: 'flags',
            label: t.flags,
            value: <FlagTags flags={order.flags} holdReason={order.hold_reason} />,
          },
        ],
      },
      {
        key: 'attribution',
        title: ordersTexts.detail.attribution.title,
        fields: [
          {
            key: 'user',
            label: ordersTexts.detail.attribution.user,
            value:
              order.user === null ? (
                ordersTexts.noUser
              ) : (
                <Flex vertical gap={2}>
                  <span style={{ ...code, wordBreak: 'break-all' }}>{order.user.user_id}</span>
                  <span style={code}>{order.user.phone_masked ?? dash}</span>
                </Flex>
              ),
          },
        ],
      },
    ];
  }

  return <DetailDrawer open title={t.title} groups={groups} onClose={onClose} />;
}
