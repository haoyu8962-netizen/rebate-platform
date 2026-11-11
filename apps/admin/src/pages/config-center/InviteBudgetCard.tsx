// Invite reward budget used (BR-INV-24 ④) in the configuration center's invite group, for fund.view
// accounts only (the caller decides). The used amounts are the `budget` of
// GET /admin/v1/invite-rewards (read once with page 1 and no filter: the budget does not depend on
// them); the limits are the config items daily_budget_fen / total_budget_fen of the rows shown.
// Remaining = limit − used, shown as 0.00 when used is over the limit. Amounts only through
// @couli/money. 【发放记录】 opens the read-only record subpage.
import { UnorderedListOutlined } from '@ant-design/icons';
import type { Schema } from '@couli/contracts-ts';
import { formatYuanAdmin, parseFen, subFen } from '@couli/money';
import { useDataProvider } from '@refinedev/core';
import { Button, Card, Flex, Typography, theme } from 'antd';
import { useEffect, useState, type ReactElement } from 'react';
import { AdminApiError } from '../../providers/data/index.ts';
import { configCenterTexts } from '../../texts/config-center.ts';
import type { ConfigRow } from './model.ts';

const t = configCenterTexts.inviteBudget;

type Budget = Schema<'AdminInviteRewardBudget'>;
type ReadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly budget: Budget }
  | { readonly status: 'failed' }
  | { readonly status: 'forbidden' };

const INVITE_REWARDS_URL = '/admin/v1/invite-rewards';
const DAILY_BUDGET_KEY = 'growth.invite_reward.daily_budget_fen';
const TOTAL_BUDGET_KEY = 'growth.invite_reward.total_budget_fen';

/** A budget limit of the rows: integer fen; never written (null) is 0 (未填); unreadable: none. */
function limitOf(rows: readonly ConfigRow[], key: string): bigint | undefined {
  const row = rows.find((candidate) => candidate.key === key);
  if (row === undefined) return undefined;
  if (row.value === null) return 0n;
  try {
    return parseFen(row.value);
  } catch {
    return undefined;
  }
}

/** limit − used, never below zero; undefined when the limit or an amount is unknown. */
function remaining(limit: bigint | undefined, ...used: readonly unknown[]): bigint | undefined {
  if (limit === undefined) return undefined;
  try {
    let left = limit;
    for (const amount of used) left = subFen(left, parseFen(amount));
    return left < 0n ? 0n : left;
  } catch {
    return undefined;
  }
}

function amount(value: unknown): string {
  try {
    return formatYuanAdmin(parseFen(value));
  } catch {
    return t.dash;
  }
}

export interface InviteBudgetCardProps {
  readonly rows: readonly ConfigRow[];
  readonly onOpenRecords: () => void;
}

export function InviteBudgetCard({ rows, onOpenRecords }: InviteBudgetCardProps): ReactElement {
  const getProvider = useDataProvider();
  const { token } = theme.useToken();
  const [state, setState] = useState<ReadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    const custom = getProvider().custom;
    if (custom === undefined) throw new Error('Missing custom data provider');
    custom<{ budget: Budget }>({
      url: INVITE_REWARDS_URL,
      method: 'get',
      query: { page: 1, page_size: 1 },
    }).then(
      (response) => {
        if (current) setState({ status: 'ready', budget: response.data.budget });
      },
      (cause: unknown) => {
        if (!current) return;
        const forbidden = cause instanceof AdminApiError && cause.code === 10403;
        setState(forbidden ? { status: 'forbidden' } : { status: 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, [getProvider, attempt]);

  const small = { fontSize: token.fontSizeSM } as const;
  const figure = (label: string, value: string) => (
    <Flex vertical gap={4} style={{ flex: '1 1 140px', minWidth: 120 }}>
      <Typography.Text type="secondary" style={small}>
        {label}
      </Typography.Text>
      <Typography.Text
        strong
        style={{ fontSize: token.fontSizeLG, fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </Typography.Text>
    </Flex>
  );

  let content: ReactElement;
  if (state.status === 'loading') {
    content = (
      <Typography.Text type="secondary" role="status">
        {t.loading}
      </Typography.Text>
    );
  } else if (state.status === 'forbidden') {
    content = <Typography.Text type="secondary">{t.forbidden}</Typography.Text>;
  } else if (state.status === 'failed') {
    content = (
      <Flex align="center" gap={8} wrap>
        <Typography.Text type="danger">{t.failed}</Typography.Text>
        <Button
          size="small"
          onClick={() => {
            setState({ status: 'loading' });
            setAttempt((value) => value + 1);
          }}
        >
          {t.retry}
        </Button>
      </Flex>
    );
  } else {
    const { today, total } = state.budget;
    const todayLeft = remaining(limitOf(rows, DAILY_BUDGET_KEY), today.granted_fen);
    const totalLeft = remaining(
      limitOf(rows, TOTAL_BUDGET_KEY),
      total.reserved_fen,
      total.granted_fen,
    );
    content = (
      <Flex vertical gap={12}>
        <Typography.Text type="secondary" style={small}>
          {t.todayOf(today.date)}
        </Typography.Text>
        <Flex gap={16} wrap>
          {figure(t.todayGranted, amount(today.granted_fen))}
          {figure(t.todayLeft, todayLeft === undefined ? t.dash : formatYuanAdmin(todayLeft))}
          {figure(t.reserved, amount(total.reserved_fen))}
          {figure(t.totalGranted, amount(total.granted_fen))}
          {figure(t.totalLeft, totalLeft === undefined ? t.dash : formatYuanAdmin(totalLeft))}
        </Flex>
        <Typography.Text type="secondary" style={small}>
          {t.note}
        </Typography.Text>
      </Flex>
    );
  }

  return (
    <Card
      style={{ boxShadow: token.boxShadowTertiary }}
      title={
        <Typography.Title level={5} style={{ margin: 0 }}>
          {t.title}
        </Typography.Title>
      }
      extra={
        <Button icon={<UnorderedListOutlined aria-hidden />} onClick={onOpenRecords}>
          {t.records}
        </Button>
      }
    >
      {content}
    </Card>
  );
}
