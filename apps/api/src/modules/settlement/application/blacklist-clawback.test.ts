// B2-04zzl 源码旁单元测试（不连库）：差错单 ref_id 的拼写与解析、扣回总额的净额口径。
import { expect, it } from 'vitest';
import type { OrderNets } from '../../ledger/index.ts';
import { blacklistRefIdOf, clawedBackFenOf, parseBlacklistRef } from './blacklist-clawback.ts';

function nets(rows: readonly (readonly [string, 'self' | 'direct', bigint])[]): OrderNets {
  return {
    beneficiaries: rows.map(([beneficiary_user_id, role, net_fen]) => ({
      beneficiary_user_id,
      role,
      net_fen,
    })),
    platform_net_fen: 0n,
    union_receivable_net_fen: 0n,
  };
}

it('[AC-B2-04zzl#U1] ref_id 的维度按字典序、英文逗号连接并去重，与事件里的顺序无关', () => {
  expect(blacklistRefIdOf('taobao:5550004', ['order_no_suffix', 'channel', 'channel'])).toBe(
    'taobao:5550004#BLACKLIST#channel,order_no_suffix',
  );
  expect(blacklistRefIdOf('taobao:5550004', ['channel'])).toBe('taobao:5550004#BLACKLIST#channel');
});

it('[AC-B2-04zzl#U2] parseBlacklistRef 只认 ref_type order 与 `平台:子订单号#BLACKLIST#…`，其余都是 null', () => {
  expect(parseBlacklistRef('order', 'taobao:5550004#BLACKLIST#channel')).toEqual({
    platform: 'taobao',
    subOrderId: '5550004',
  });
  for (const [refType, refId] of [
    ['bill', 'taobao:5550004#BLACKLIST#channel'],
    ['order', null],
    ['order', 'taobao:5550004'],
    ['order', '#BLACKLIST#channel'],
    ['order', 'taobao#BLACKLIST#channel'],
    ['order', ':5550004#BLACKLIST#channel'],
    ['order', 'taobao:#BLACKLIST#channel'],
    ['order', 'taobao:1:2#BLACKLIST#channel'],
  ] as const) {
    expect(parseBlacklistRef(refType, refId), `${refType} ${String(refId)}`).toBeNull();
  }
});

it('[AC-B2-04zzl#U3] 扣回总额是各受益人净额的下降之和：净额为 0 或未下降的不计，平台净额不计', () => {
  const before = {
    ...nets([
      ['u1', 'self', 425n],
      ['u2', 'direct', 85n],
      ['u3', 'direct', 0n],
    ]),
    platform_net_fen: 448n,
  };
  const after = nets([
    ['u1', 'self', 0n],
    ['u2', 'direct', 0n],
    ['u3', 'direct', 0n],
  ]);
  expect(clawedBackFenOf(before, after)).toBe(510n);
  expect(clawedBackFenOf(before, before)).toBe(0n);
});
