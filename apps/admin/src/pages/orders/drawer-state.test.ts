// Unit tests of the order drawer state (F1-07edb): each opening shows only its own answer.
import { expect, it } from 'vitest';
import { drawerClosed, drawerStep, type DrawerState } from './drawer-state.ts';
import type { OrderDetail } from './model.ts';

const A = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a01';
const B = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a02';
const order = (marker: string) => ({ sub_order_id: marker }) as unknown as OrderDetail;

it('[AC-F1-07edb-UNIT#1] 关闭后再开同一单：回到加载态，不显示上次读到的详情', () => {
  let state: DrawerState = drawerStep(drawerClosed, { type: 'show', orderId: A });
  const first = state.opening;
  state = drawerStep(state, {
    type: 'answer',
    opening: first,
    loaded: { status: 'ready', order: order('old') },
  });
  expect(state.loaded?.status).toBe('ready');
  state = drawerStep(state, { type: 'show', orderId: undefined });
  expect(state.loaded).toBeUndefined();
  state = drawerStep(state, { type: 'show', orderId: A });
  expect(state.orderId).toBe(A);
  expect(state.loaded, 'reopened: loading, nothing old').toBeUndefined();
  expect(state.opening).not.toBe(first);
  // The same order shown again without closing in between also starts over.
  const again = drawerStep(
    drawerStep(state, {
      type: 'answer',
      opening: state.opening,
      loaded: { status: 'ready', order: order('new') },
    }),
    { type: 'show', orderId: A },
  );
  expect(again.loaded).toBeUndefined();
});

it('[AC-F1-07edb-UNIT#2] 旧一次打开的响应晚到（已切换订单、已关闭或已重试）一律丢弃', () => {
  const openA = drawerStep(drawerClosed, { type: 'show', orderId: A });
  const late = {
    type: 'answer',
    opening: openA.opening,
    loaded: { status: 'ready', order: order('A') },
  } as const;
  const openB = drawerStep(openA, { type: 'show', orderId: B });
  expect(drawerStep(openB, late)).toEqual(openB);
  const closed = drawerStep(openA, { type: 'show', orderId: undefined });
  expect(drawerStep(closed, late)).toEqual(closed);
  const reopened = drawerStep(closed, { type: 'show', orderId: A });
  expect(drawerStep(reopened, late).loaded).toBeUndefined();
  const retried = drawerStep(openA, { type: 'retry' });
  expect(drawerStep(retried, late).loaded).toBeUndefined();
  const own = drawerStep(retried, { ...late, opening: retried.opening });
  expect(own.loaded).toEqual({ status: 'ready', order: order('A') });
  expect(
    drawerStep(retried, { ...late, opening: retried.opening, loaded: { status: 'failed' } }).loaded,
  ).toEqual({
    status: 'failed',
  });
});
