// F1-07ec: the product of an order row: picture, platform icon and single-line title (full title
// on hover), tags, then one line each for the paid amount, commission rate, estimated commission,
// shop and paid time. A null or missing field hides its whole line (no label, no placeholder);
// zero amounts and a zero rate are values and show. Amounts go through MoneyText; the rate in bp
// is only turned into percentage text for display and never takes part in an amount calculation.
import { Flex, Tag, Typography, theme } from 'antd';
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { componentsTexts } from '../../texts/components.ts';
import { MoneyText } from '../money-text/index.ts';

export interface ProductCellProps {
  readonly title?: string | null | undefined;
  readonly imageUrl?: string | null | undefined;
  readonly platformIconUrl?: string | null | undefined;
  readonly tags?: readonly string[] | null | undefined;
  readonly amountFen?: bigint | null | undefined;
  readonly commissionRateBp?: number | null | undefined;
  readonly estimatedCommissionFen?: bigint | null | undefined;
  readonly shopName?: string | null | undefined;
  readonly paidAtText?: string | null | undefined;
}

const t = componentsTexts.productCell;
const BP_PER_PERCENT = 100;

/** A ratio in bp (integer, 万分之一) as a percentage with two decimals: 1234 → "12.34%". */
export function percentOfBp(bp: number): string {
  if (!Number.isSafeInteger(bp)) return '';
  const magnitude = Math.abs(bp);
  const whole = Math.trunc(magnitude / BP_PER_PERCENT);
  const cents = String(magnitude % BP_PER_PERCENT).padStart(2, '0');
  return `${bp < 0 ? '-' : ''}${String(whole)}.${cents}%`;
}

const present = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value !== '';

function Line({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div>
      <Typography.Text type="secondary">{label}</Typography.Text>{' '}
      <span className="tabular-nums">{children}</span>
    </div>
  );
}

export function ProductCell(props: ProductCellProps): ReactElement | null {
  const { token } = theme.useToken();
  const { title, imageUrl, platformIconUrl, shopName, paidAtText } = props;
  const tags = (props.tags ?? []).filter((tag) => tag !== '');
  const amountFen = props.amountFen ?? null;
  const estimatedFen = props.estimatedCommissionFen ?? null;
  const rate =
    props.commissionRateBp === null || props.commissionRateBp === undefined
      ? ''
      : percentOfBp(props.commissionRateBp);

  const lines: ReactNode[] = [];
  if (amountFen !== null)
    lines.push(
      <Line key="amount" label={t.amount}>
        <MoneyText fen={amountFen} />
      </Line>,
    );
  if (rate !== '')
    lines.push(
      <Line key="rate" label={t.commissionRate}>
        {rate}
      </Line>,
    );
  if (estimatedFen !== null)
    lines.push(
      <Line key="commission" label={t.estimatedCommission}>
        <MoneyText fen={estimatedFen} />
      </Line>,
    );
  if (present(shopName))
    lines.push(
      <Line key="shop" label={t.shop}>
        {shopName}
      </Line>,
    );
  if (present(paidAtText))
    lines.push(
      <Line key="paid-at" label={t.paidAt}>
        {paidAtText}
      </Line>,
    );

  const hasTitle = present(title);
  const hasIcon = present(platformIconUrl);
  const hasImage = present(imageUrl);
  if (!hasTitle && !hasImage && !hasIcon && tags.length === 0 && lines.length === 0) return null;

  const picture: CSSProperties = {
    width: token.controlHeightLG * 1.5,
    height: token.controlHeightLG * 1.5,
    objectFit: 'cover',
    borderRadius: token.borderRadiusSM,
    flex: 'none',
  };
  const icon: CSSProperties = { width: token.fontSize, height: token.fontSize, flex: 'none' };
  const singleLine: CSSProperties = {
    display: 'block',
    minWidth: 0,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  };

  return (
    <Flex gap="small" align="flex-start" style={{ minWidth: 0 }}>
      {hasImage ? <img src={imageUrl} alt="" style={picture} /> : null}
      <Flex vertical gap="small" style={{ minWidth: 0, flex: 1 }}>
        {hasTitle || hasIcon ? (
          <Flex gap="small" align="center" style={{ minWidth: 0 }}>
            {hasIcon ? <img src={platformIconUrl} alt="" style={icon} /> : null}
            {hasTitle ? (
              <span title={title} style={singleLine}>
                {title}
              </span>
            ) : null}
          </Flex>
        ) : null}
        {tags.length > 0 ? (
          <Flex wrap gap="small">
            {tags.map((tag, index) => (
              <Tag key={`${String(index)}:${tag}`} bordered={false}>
                {tag}
              </Tag>
            ))}
          </Flex>
        ) : null}
        {lines.length > 0 ? <div>{lines}</div> : null}
      </Flex>
    </Flex>
  );
}
