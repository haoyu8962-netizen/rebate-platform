import { expect, it } from 'vitest';
import type { UnionErrorCode } from '../../../../apps/api/src/modules/union/domain/types.ts';
import {
  ctx,
  detailBody,
  errorBody,
  ref,
  setup,
  unionFailure,
  visible,
  withStatus,
} from './kit.ts';

interface ErrorCase {
  readonly name: string;
  readonly answer: unknown;
  readonly code: UnionErrorCode;
}

const detailErrors: readonly ErrorCase[] = [
  {
    name: 'code 15 + sub_code "50001"（无结果）',
    answer: errorBody(15, '50001'),
    code: 'item_unavailable',
  },
  {
    name: 'code "15" + sub_code 50001（数字与字符串同等）',
    answer: errorBody('15', 50001),
    code: 'item_unavailable',
  },
  {
    name: 'code 15 + sub_code 1911（scene 不支持）',
    answer: errorBody(15, '1911'),
    code: 'upstream_rejected',
  },
  {
    name: 'code 15 + 其他 sub_code',
    answer: errorBody(15, '50002'),
    code: 'upstream_rejected',
  },
  {
    name: 'code 15 无 sub_code',
    answer: errorBody(15),
    code: 'upstream_rejected',
  },
  {
    name: 'code 7（限流，沿用 B1-04j）',
    answer: errorBody(7),
    code: 'rate_limited',
  },
  {
    name: 'HTTP 503（沿用 B1-04j）',
    answer: withStatus(503, 'synthetic outage'),
    code: 'upstream_unavailable',
  },
];

it.each(detailErrors)('[AC-B1-04l#20] 详情 $name 得 $code', async ({ answer, code }) => {
  const { adapter, transport } = setup(() => answer);
  const error = await unionFailure(() => adapter.getItem(ref, ctx), code);
  expect(transport).toHaveBeenCalledTimes(1);
  // 错误信息不带上游 msg / sub_msg / request_id。
  for (const marker of ['synthetic remote error', '合成错误说明', 'synthetic-error-request']) {
    expect(visible(error)).not.toContain(marker);
  }
});

it.each(['tbk_item_detail', 'synthetic_detail_wrapper'])(
  '[AC-B1-04l#21] results 包装 %s 下是空数组 → item_unavailable',
  async (wrapper) => {
    const { adapter, transport } = setup(() => detailBody([], wrapper));
    await unionFailure(() => adapter.getItem(ref, ctx), 'item_unavailable');
    expect(transport).toHaveBeenCalledTimes(1);
  },
);
