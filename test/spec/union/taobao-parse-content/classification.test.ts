import { expect, it } from 'vitest';
import type { UnionErrorCode } from '../../../../apps/api/src/modules/union/domain/types.ts';
import type { UnionTransportResponse } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import { response, setup as setupDataoke } from '../dataoke-core/kit.ts';
import { ctx, detailSetup, unionFailure } from '../taobao-goods/kit.ts';

const token = '￥SyntheticNoGoods01￥';

it('[AC-B1-04zzzzo#10] 仅成功码且无商品数据视为未识别，网关业务错和故障沿用分类', async () => {
  const cases: readonly (readonly [UnionTransportResponse, UnionErrorCode])[] = [
    [response({ code: 10014 }), 'rate_limited'],
    [{ ...response({}), body: 'synthetic non-JSON' }, 'upstream_unavailable'],
    [response({ code: 0, data: null }, 503), 'upstream_unavailable'],
    [response({ code: 0, data: null }), 'link_unrecognized'],
    [response({ code: 0 }), 'link_unrecognized'],
  ];

  for (const [reply, code] of cases) {
    const dataoke = setupDataoke();
    dataoke.transport.mockResolvedValue(reply);
    const taobao = detailSetup([], { orderSource: dataoke.client });

    await unionFailure(() => taobao.adapter.resolveLink(token, ctx), code);

    expect(dataoke.transport).toHaveBeenCalledTimes(1);
    expect(taobao.credentials).not.toHaveBeenCalled();
    expect(taobao.transport).not.toHaveBeenCalled();
  }
});
