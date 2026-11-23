// F1-07ec: a row of statistic cards above a list. Amounts use MoneyText (integer fen, null shows
// the placeholder); counts are grouped by thousands. Only the first `initialVisibleCount` cards
// show until 「展开」; 「收起」 goes back to them. A card with a filter value is a button that hands
// that value back to the caller (which applies it); other cards are plain.
import { Button, Card, Flex, Typography, theme } from 'antd';
import { useState, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { componentsTexts } from '../../texts/components.ts';
import { MoneyText } from '../money-text/index.ts';

type FilterValue = Readonly<Record<string, string>>;

type StatCard = {
  readonly key: string;
  readonly label: string;
  readonly filterValue?: FilterValue;
} & (
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'money'; readonly fen: bigint | null; readonly signed?: boolean }
);

export interface StatCardsProps {
  readonly cards: readonly StatCard[];
  readonly initialVisibleCount?: number;
  readonly onSelect?: (filterValue: FilterValue) => void;
}

const t = componentsTexts.statCards;
/** Cards on the first row before 「展开」. */
const DEFAULT_VISIBLE_COUNT = 6;

/** A count with ',' every three digits; non-integers and non-finite values as they are. */
export function groupCount(value: number): string {
  if (!Number.isSafeInteger(value)) return String(value);
  const digits = String(Math.abs(value));
  const head = digits.length % 3 || 3;
  let out = digits.slice(0, head);
  for (let i = head; i < digits.length; i += 3) out += `,${digits.slice(i, i + 3)}`;
  return value < 0 ? `-${out}` : out;
}

function valueOf(card: StatCard): ReactNode {
  return card.kind === 'money' ? (
    <MoneyText fen={card.fen} signed={card.signed === true} />
  ) : (
    <span className="tabular-nums">{groupCount(card.value)}</span>
  );
}

export function StatCards({
  cards,
  initialVisibleCount = DEFAULT_VISIBLE_COUNT,
  onSelect,
}: StatCardsProps): ReactElement {
  const { token } = theme.useToken();
  const [expanded, setExpanded] = useState(false);
  const limit = Math.max(1, Math.trunc(initialVisibleCount));
  const overflow = cards.length > limit;
  const shown = expanded || !overflow ? cards : cards.slice(0, limit);

  const valueStyle: CSSProperties = {
    fontSize: token.fontSizeHeading4,
    fontWeight: token.fontWeightStrong,
    color: token.colorText,
  };
  const buttonStyle: CSSProperties = {
    display: 'block',
    width: '100%',
    border: 'none',
    background: 'none',
    padding: token.paddingSM,
    textAlign: 'start',
    cursor: 'pointer',
    font: 'inherit',
    color: 'inherit',
  };

  const content = (card: StatCard): ReactElement => (
    <>
      <Typography.Text type="secondary" style={{ display: 'block' }}>
        {card.label}
      </Typography.Text>
      <span style={{ ...valueStyle, display: 'block' }}>{valueOf(card)}</span>
    </>
  );

  return (
    <div>
      <Flex wrap gap="middle">
        {shown.map((card) => {
          const filterValue = card.filterValue;
          const select =
            filterValue !== undefined && onSelect !== undefined
              ? (): void => onSelect(filterValue)
              : undefined;
          const clickable = select !== undefined;
          return (
            <Card
              key={card.key}
              size="small"
              hoverable={clickable}
              style={{ minWidth: token.controlHeightLG * 4 }}
              styles={clickable ? { body: { padding: token.paddingXXS } } : undefined}
            >
              {clickable ? (
                <button type="button" style={buttonStyle} onClick={select}>
                  {content(card)}
                </button>
              ) : (
                content(card)
              )}
            </Card>
          );
        })}
      </Flex>
      {overflow ? (
        <Button type="link" size="small" onClick={() => setExpanded((open) => !open)}>
          {expanded ? t.collapse : t.expand}
        </Button>
      ) : null}
    </div>
  );
}
