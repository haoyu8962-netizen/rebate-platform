// Order detail subpage (/orders/<order_id>; design-hifi AdmOrderDetail, AdmAdaptOrderDetail1280;
// design/specs/admin-order-detail.md; 01 F-ADM-05, F1-07e): GET /admin/v1/orders/{order_id} only
// (a direct address never reads the list) with the status card (both lock marks side by side),
// basic and attribution information, the commission snapshot, the status history and the link
// records. 【同步此单】 (F1-07eb, CT-24n) asks a manual sync of this sub-order; the other write
// buttons (hold / unhold, assign) come with a later contract and the raw union payload has no
// permission point yet, so neither is rendered. An unknown or
// not visible order (20001) shows nothing of it. 【返回】 goes to the list with its conditions (the
// list address, F1-07ed). 「分佣明细」 (F1-07ed) groups the snapshot's beneficiaries by role with each
// one's ratio, settlement state and forfeit mark; it shows no amount (amounts stay in 「分佣快照」).
import { ArrowLeftOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import { beneficiary_role } from '@couli/contracts-ts';
import { useDataProvider } from '@refinedev/core';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Flex,
  Result,
  Table,
  Tag,
  Timeline,
  Typography,
  theme,
  type DescriptionsProps,
  type TableColumnsType,
} from 'antd';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { AccessControl } from '../../providers/access-control/index.ts';
import { PlannedPage, usePlanned } from '../../components/planned/index.ts';
import { ordersTexts } from '../../texts/orders.ts';
import { FlagTags, StatusTag } from './parts.tsx';
import { nextNoticeId, noticeOf, useSyncRequest, type SyncNotice } from './sync.ts';
import {
  backQueryOf,
  beijingTime,
  failureOf,
  money,
  orderUrl,
  percent,
  platformLabel,
  searchOf,
  thisOrderRejectedText,
  type DictKind,
  type OrderDetail,
  type OrdersBackState,
} from './model.ts';

const t = ordersTexts.detail;
const dash = ordersTexts.dash;

type Beneficiary = NonNullable<OrderDetail['commission_split']>['beneficiaries'][number];
type LinkLog = OrderDetail['link_logs'][number];
type LoadStatus = 'loading' | 'ready' | 'failed' | 'missing' | 'forbidden';

export interface OrderDetailPageProps {
  readonly access: AccessControl;
  readonly orderId: string;
}

/** GET /admin/v1/orders/{order_id} not live yet (planned): the placeholder, no read (D10-284). */
export function OrderDetailPage(props: OrderDetailPageProps): ReactElement {
  const planned = usePlanned('adminGetOrder');
  return planned ? <PlannedPage title={t.title} /> : <OrderDetailContent {...props} />;
}

function OrderDetailContent({ access, orderId }: OrderDetailPageProps): ReactElement {
  const getProvider = useDataProvider();
  const navigate = useNavigate();
  const location = useLocation();
  const { token } = theme.useToken();
  const permitted = access.can('order.view');
  const [order, setOrder] = useState<OrderDetail>();
  const [status, setStatus] = useState<LoadStatus>(permitted ? 'loading' : 'forbidden');
  const [attempt, setAttempt] = useState(0);
  const sync = useSyncRequest();
  const [notice, setNotice] = useState<SyncNotice>();

  useEffect(() => {
    if (!permitted) return undefined;
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<OrderDetail>({ url: orderUrl(orderId), method: 'get' }).then(
      (response) => {
        if (!current) return;
        setOrder(response.data);
        setStatus('ready');
      },
      (cause: unknown) => {
        if (!current) return;
        setOrder(undefined);
        const kind = failureOf(cause);
        setStatus(kind === 'invalid' ? 'missing' : kind);
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, orderId, attempt, permitted]);

  const retry = () => {
    setStatus('loading');
    setAttempt((value) => value + 1);
  };

  const back = () => {
    const query = backQueryOf(location.state);
    const state: OrdersBackState | undefined =
      query === undefined ? undefined : { ordersQuery: query };
    void navigate(`/orders${query === undefined ? '' : searchOf(query)}`, { state });
  };

  // 【同步此单】 (F1-07eb, CT-24n): sends at once { platform, order_nos: [this sub-order] }.
  const syncThisOrder = async (shown: OrderDetail) => {
    if (sync.busy) return;
    const outcome = await sync.send({ platform: shown.platform, order_nos: [shown.sub_order_id] });
    if (outcome === undefined) return;
    const text =
      outcome.kind === 'fields'
        ? { type: 'error' as const, text: thisOrderRejectedText(outcome.fields) }
        : noticeOf(outcome);
    setNotice(text === undefined ? undefined : { id: nextNoticeId(), ...text });
  };

  const code = { fontFamily: token.fontFamilyCode } as const;

  const header = (
    <Flex justify="space-between" align="center" wrap gap={8}>
      <Flex align="center" gap={12} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {t.title}
        </Typography.Title>
        {order === undefined ? null : (
          <>
            <Typography.Text copyable style={code}>
              {order.sub_order_id}
            </Typography.Text>
            <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
              {platformLabel(order.platform)}
            </Tag>
          </>
        )}
      </Flex>
      <Flex gap={8} wrap>
        {order === undefined || status !== 'ready' ? null : (
          <Button
            icon={<SyncOutlined aria-hidden />}
            disabled={sync.busy}
            aria-busy={sync.busy || undefined}
            onClick={() => void syncThisOrder(order)}
          >
            {ordersTexts.sync.thisOrderEntry}
          </Button>
        )}
        <Button icon={<ArrowLeftOutlined aria-hidden />} onClick={back}>
          {t.back}
        </Button>
      </Flex>
    </Flex>
  );

  let body: ReactElement;
  if (status === 'loading') {
    body = (
      <Card>
        <Typography.Text type="secondary" role="status">
          {t.loading}
        </Typography.Text>
      </Card>
    );
  } else if (status === 'missing') {
    body = (
      <Card>
        <Result status="404" title={t.missingTitle} subTitle={t.missingDescription} />
      </Card>
    );
  } else if (status === 'forbidden') {
    body = (
      <Card>
        <Result status="403" title={t.forbiddenTitle} subTitle={t.forbiddenDescription} />
      </Card>
    );
  } else if (status === 'failed' || order === undefined) {
    body = (
      <Card>
        <Result
          status="error"
          title={t.loadFailedTitle}
          subTitle={t.loadFailedDescription}
          extra={
            <Button type="primary" icon={<ReloadOutlined aria-hidden />} onClick={retry}>
              {ordersTexts.retry}
            </Button>
          }
        />
      </Card>
    );
  } else {
    body = <DetailBody order={order} />;
  }

  return (
    <Flex vertical gap={16} style={{ minWidth: 0 }}>
      {header}
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
    </Flex>
  );
}

type Items = NonNullable<DescriptionsProps['items']>;
type Column = NonNullable<DescriptionsProps['column']>;

// Description grids (AdmOrderDetail; 1280 keeps three / four columns, narrower screens fewer).
const THREE: Column = { xs: 1, sm: 2, lg: 3 };
const FOUR: Column = { xs: 1, sm: 2, lg: 3, xl: 4 };

function DetailBody({ order }: { readonly order: OrderDetail }): ReactElement {
  const { token } = theme.useToken();
  const code = { fontFamily: token.fontFamilyCode, fontSize: token.fontSizeSM } as const;
  const mono = (value: string | null): ReactNode =>
    value === null ? dash : <span style={{ ...code, wordBreak: 'break-all' }}>{value}</span>;
  const note = { color: token.colorTextSecondary, fontSize: token.fontSizeSM } as const;
  const descriptions = (items: Items, column: Column = THREE) => (
    <Descriptions
      layout="vertical"
      size="small"
      colon={false}
      column={column}
      items={items}
      styles={{ label: { color: token.colorTextSecondary, fontSize: token.fontSizeSM } }}
    />
  );

  const status = (kind: DictKind, value: string | null): ReactNode =>
    value === null ? dash : <StatusTag kind={kind} code={value} />;

  const statusItems: Items = [
    {
      key: 'platform',
      label: t.status.platformStatus,
      children: status('platform_status', order.platform_status),
    },
    {
      key: 'rebate',
      label: t.status.rebateStatus,
      children: status('rebate_status', order.rebate_status),
    },
    {
      key: 'display',
      label: t.status.displayStatus,
      children:
        order.display_status === null ? (
          dash
        ) : (
          <Tag style={{ marginInlineEnd: 0, ...code }}>{order.display_status}</Tag>
        ),
    },
    {
      key: 'holdRights',
      label: t.status.holdRights,
      children: (
        <Flex gap={8} wrap>
          {order.flags.hold ? (
            <FlagTags
              flags={{ locked: false, status_locked: false, rights_pending: false, hold: true }}
              holdReason={order.hold_reason}
            />
          ) : (
            <Tag bordered={false}>{ordersTexts.flags.noHold}</Tag>
          )}
          {order.flags.rights_pending ? (
            <FlagTags
              flags={{ locked: false, status_locked: false, rights_pending: true, hold: false }}
              holdReason={null}
            />
          ) : (
            <Tag bordered={false}>{ordersTexts.flags.noRights}</Tag>
          )}
        </Flex>
      ),
    },
    {
      key: 'statusLock',
      label: t.status.statusLock,
      children: (
        <Flex vertical gap={4}>
          {order.flags.status_locked ? (
            <FlagTags
              flags={{ locked: false, status_locked: true, rights_pending: false, hold: false }}
              holdReason={null}
            />
          ) : (
            <Tag bordered={false} style={{ alignSelf: 'flex-start' }}>
              {ordersTexts.flags.unlocked}
            </Tag>
          )}
          <span style={note}>{t.status.statusLockNote}</span>
        </Flex>
      ),
    },
    {
      key: 'attributionLock',
      label: t.status.attributionLock,
      children: (
        <Flex vertical gap={4}>
          {order.flags.locked ? (
            <FlagTags
              flags={{ locked: true, status_locked: false, rights_pending: false, hold: false }}
              holdReason={null}
            />
          ) : (
            <Tag bordered={false} style={{ alignSelf: 'flex-start' }}>
              {ordersTexts.flags.unlocked}
            </Tag>
          )}
          <span style={note}>{t.status.attributionLockNote}</span>
        </Flex>
      ),
    },
  ];
  if (order.hold_reason !== null)
    statusItems.push({
      key: 'holdReason',
      label: t.status.holdReason,
      children: status('hold_reason', order.hold_reason),
    });

  const b = t.basic;
  const basicItems: Items = [
    { key: 'sub', label: b.subOrderId, children: mono(order.sub_order_id) },
    { key: 'parent', label: b.parentOrderId, children: mono(order.parent_order_id) },
    { key: 'title', label: b.productTitle, children: order.title ?? dash },
    {
      key: 'item',
      label: b.itemKey,
      children: (
        <span style={{ ...code, wordBreak: 'break-all' }}>
          {`${order.raw_item_id} / ${order.product_key ?? dash}`}
        </span>
      ),
    },
    {
      key: 'quantity',
      label: b.quantity,
      children: `${order.quantity ?? dash} / ${order.refunded_quantity ?? dash}`,
    },
    { key: 'pay', label: b.payAmount, children: money(order.pay_amount_fen) },
    { key: 'paidAt', label: b.paidAt, children: beijingTime(order.paid_at) },
    { key: 'receivedAt', label: b.receivedAt, children: beijingTime(order.received_at) },
    {
      key: 'settledAt',
      label: b.settledAt,
      children: `${beijingTime(order.settled_at)} / ${order.settle_period ?? dash}`,
    },
    { key: 'creditedAt', label: b.creditedAt, children: beijingTime(order.credited_at) },
    { key: 'est', label: b.estCommission, children: money(order.est_commission_fen) },
    { key: 'settle', label: b.settleCommission, children: money(order.settle_commission_fen) },
    {
      key: 'rate',
      label: b.commissionRate,
      children:
        order.commission_rate_bp === null
          ? dash
          : b.rate(order.commission_rate_bp, percent(order.commission_rate_bp)),
    },
    {
      key: 'presale',
      label: b.presale,
      children: `${order.is_presale ? b.presaleYes : b.presaleNo} / ${beijingTime(order.deposit_paid_at)}`,
    },
    { key: 'reason', label: b.reason, children: mono(order.reason) },
  ];

  const a = t.attribution;
  const attributionItems: Items = [
    {
      key: 'user',
      label: a.user,
      children:
        order.user === null ? (
          <Typography.Text type="secondary">{ordersTexts.noUser}</Typography.Text>
        ) : (
          <Flex gap={8} wrap>
            <span style={{ ...code, color: token.colorPrimary, wordBreak: 'break-all' }}>
              {order.user.user_id}
            </span>
            <span style={code}>{order.user.phone_masked ?? dash}</span>
          </Flex>
        ),
    },
    { key: 'buyType', label: a.buyType, children: mono(order.buy_type) },
    {
      key: 'basis',
      label: a.basis,
      children: mono(`${order.scene_basis ?? dash} / ${order.user_basis ?? dash}`),
    },
  ];

  const split = order.commission_split;
  const s = t.split;
  const splitItems: Items =
    split === null
      ? []
      : [
          { key: 'rule', label: s.ruleVersion, children: mono(split.rule_version_id) },
          { key: 'type', label: s.orderType, children: mono(split.order_type) },
          { key: 'raw', label: s.rawN, children: money(split.raw_n_fen) },
          { key: 'subsidy', label: s.subsidy, children: money(split.subsidy_commission_fen) },
          { key: 'reserveBp', label: s.reserveBp, children: percent(split.reserve_bp) },
          { key: 'reserve', label: s.reserve, children: money(split.reserve_fen) },
          { key: 'tlj', label: s.tlj, children: money(split.tlj_deduct_fen) },
          { key: 'base', label: s.base, children: money(split.base_fen) },
          { key: 'retain', label: s.retain, children: money(split.platform_retain_fen) },
          { key: 'created', label: s.createdAt, children: beijingTime(split.created_at) },
        ];
  const beneficiaryColumns: TableColumnsType<Beneficiary> = [
    {
      key: 'user',
      title: s.beneficiary,
      render: (_, row) => (
        <span style={{ ...code, color: token.colorPrimary, wordBreak: 'break-all' }}>
          {row.user_id}
        </span>
      ),
    },
    { key: 'role', title: s.role, render: (_, row) => <span style={code}>{row.role}</span> },
    { key: 'ratio', title: s.ratio, align: 'right', render: (_, row) => percent(row.ratio_bp) },
    {
      key: 'forfeit',
      title: s.forfeit,
      render: (_, row) =>
        row.forfeit_reason === null ? dash : <span style={code}>{row.forfeit_reason}</span>,
    },
  ];

  const h = t.history;
  const linkColumns: TableColumnsType<LinkLog> = [
    {
      key: 'at',
      title: t.links.at,
      render: (_, row) => <span style={{ whiteSpace: 'nowrap' }}>{beijingTime(row.at)}</span>,
    },
    {
      key: 'event',
      title: t.links.event,
      render: (_, row) => <span style={code}>{row.event}</span>,
    },
    {
      key: 'scene',
      title: t.links.scene,
      render: (_, row) => <span style={code}>{row.scene}</span>,
    },
  ];

  const historyCard = (
    <Card
      title={h.title}
      extra={
        order.status_history.length === 0 ? null : (
          <span style={note}>{ordersTexts.total(order.status_history.length)}</span>
        )
      }
      style={{ height: '100%' }}
    >
      {order.status_history.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={h.empty} />
      ) : (
        <Flex vertical gap={12}>
          <Timeline
            items={order.status_history.map((entry, index) => {
              const kind: DictKind =
                entry.field === 'platform' ? 'platform_status' : 'rebate_status';
              return {
                key: `${index}`,
                children: (
                  <Flex vertical gap={4}>
                    <Flex justify="space-between" gap={8} wrap>
                      <Flex align="center" gap={6} wrap>
                        <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
                          {h.fields[entry.field] ?? entry.field}
                        </Tag>
                        {entry.from === null ? (
                          <span style={note}>{h.initial}</span>
                        ) : (
                          <StatusTag kind={kind} code={entry.from} />
                        )}
                        <span aria-hidden>{h.arrow}</span>
                        <StatusTag kind={kind} code={entry.to} />
                      </Flex>
                      <span style={{ whiteSpace: 'nowrap' }}>{beijingTime(entry.at)}</span>
                    </Flex>
                    <span style={note}>{h.meta(entry.event, entry.source)}</span>
                  </Flex>
                ),
              };
            })}
          />
          <Alert type="info" showIcon message={h.note} />
        </Flex>
      )}
    </Card>
  );

  const linksCard = (
    <Card title={t.links.title} extra={<span style={note}>{t.links.note}</span>}>
      {order.link_logs.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t.links.empty} />
      ) : (
        <Table<LinkLog>
          rowKey={(row) => `${row.at}-${row.event}-${row.scene}`}
          size="middle"
          columns={linkColumns}
          dataSource={order.link_logs}
          pagination={false}
          scroll={{ x: 'max-content' }}
        />
      )}
    </Card>
  );

  return (
    <Flex vertical gap={16} style={{ minWidth: 0 }}>
      <Card>{descriptions(statusItems)}</Card>
      <Card title={b.title}>{descriptions(basicItems)}</Card>
      <Card title={a.title}>{descriptions(attributionItems)}</Card>
      <Card title={s.title}>
        {split === null ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={s.empty} />
        ) : (
          <Flex vertical gap={16}>
            {descriptions(splitItems, FOUR)}
            <Typography.Text strong>{s.beneficiaries}</Typography.Text>
            <Table<Beneficiary>
              rowKey={(row) => `${row.user_id}-${row.role}`}
              size="middle"
              columns={beneficiaryColumns}
              dataSource={split.beneficiaries}
              pagination={false}
              scroll={{ x: 'max-content' }}
            />
            <Alert type="info" showIcon message={s.note} />
          </Flex>
        )}
      </Card>
      <SplitDetail order={order} />
      {historyCard}
      {linksCard}
    </Flex>
  );
}

/** Beneficiary roles in contract order (beneficiary_role); an unknown role is listed after them. */
const ROLE_ORDER: readonly string[] = beneficiary_role;

/**
 * 「分佣明细」: one group per role that occurs (self → share → direct → indirect), one line per
 * beneficiary with the user, the ratio (as in the snapshot), settled or not (credited orders show
 * the Beijing credit time) and 「已没收」 for a forfeited share. No amount is shown or derived.
 */
function SplitDetail({ order }: { readonly order: OrderDetail }): ReactElement {
  const { token } = theme.useToken();
  const d = t.splitDetail;
  const split = order.commission_split;
  const code = { fontFamily: token.fontFamilyCode } as const;
  const note = { color: token.colorTextSecondary, fontSize: token.fontSizeSM } as const;
  const settled = order.rebate_status === 'CREDITED';
  const unsettled = order.rebate_status === 'ESTIMATED' || order.rebate_status === 'WAITING';
  const state = settled ? (
    <Flex gap={8} wrap align="center">
      <Tag color="success" style={{ marginInlineEnd: 0 }}>
        {d.settled}
      </Tag>
      {order.credited_at === null ? null : (
        <span style={note}>{d.creditedAt(beijingTime(order.credited_at))}</span>
      )}
    </Flex>
  ) : unsettled ? (
    <Tag style={{ marginInlineEnd: 0 }}>{d.unsettled}</Tag>
  ) : (
    <StatusTag kind="rebate_status" code={order.rebate_status} />
  );
  const roles =
    split === null
      ? []
      : [
          ...ROLE_ORDER,
          ...split.beneficiaries
            .map((one) => one.role as string)
            .filter(
              (role, index, all) => !ROLE_ORDER.includes(role) && all.indexOf(role) === index,
            ),
        ].filter((role) => split.beneficiaries.some((one) => one.role === role));
  return (
    <Card title={d.title}>
      {split === null || split.beneficiaries.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={d.empty} />
      ) : (
        <Flex vertical gap={16}>
          {roles.map((role) => (
            <Flex key={role} vertical gap={8}>
              <Typography.Text strong>{d.roles[role] ?? role}</Typography.Text>
              {split.beneficiaries
                .filter((one) => one.role === role)
                .map((one, index) => (
                  <Flex
                    key={`${one.user_id}-${index}`}
                    gap={12}
                    wrap
                    align="center"
                    style={{
                      padding: `${token.paddingXS}px ${token.paddingSM}px`,
                      border: `1px solid ${token.colorBorderSecondary}`,
                      borderRadius: token.borderRadius,
                    }}
                  >
                    <span style={{ ...code, wordBreak: 'break-all' }}>{one.user_id}</span>
                    <span>{percent(one.ratio_bp)}</span>
                    {state}
                    {one.forfeit_reason === null ? null : (
                      <Flex gap={4} align="center">
                        <Tag color="error" style={{ marginInlineEnd: 0 }}>
                          {d.forfeited}
                        </Tag>
                        <span style={{ ...code, ...note }}>{one.forfeit_reason}</span>
                      </Flex>
                    )}
                  </Flex>
                ))}
            </Flex>
          ))}
        </Flex>
      )}
    </Card>
  );
}
