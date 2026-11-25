// The state of the order detail drawer (F1-07edb, BR-ID-46). Every opening (and every 【重试】)
// gets a new number; only the answer of the current number is shown, so a reopened drawer never
// shows what an earlier opening read (the order's attribution may have changed meanwhile) and an
// answer that arrives after the drawer switched order or closed is dropped.
import type { OrderDetail } from './model.ts';

export type DrawerLoaded =
  | { readonly status: 'ready'; readonly order: OrderDetail }
  | { readonly status: 'failed' | 'missing' | 'forbidden' };

export interface DrawerState {
  /** The order shown; undefined: closed. */
  readonly orderId: string | undefined;
  /** The number of the current opening or retry. */
  readonly opening: number;
  /** The answer of the current opening; undefined: loading. */
  readonly loaded: DrawerLoaded | undefined;
}

export type DrawerEvent =
  | { readonly type: 'show'; readonly orderId: string | undefined }
  | { readonly type: 'retry' }
  | { readonly type: 'answer'; readonly opening: number; readonly loaded: DrawerLoaded };

export const drawerClosed: DrawerState = { orderId: undefined, opening: 0, loaded: undefined };

export function drawerStep(state: DrawerState, event: DrawerEvent): DrawerState {
  switch (event.type) {
    case 'show':
      // Opening, switching and closing all start over without any earlier answer.
      return { orderId: event.orderId, opening: state.opening + 1, loaded: undefined };
    case 'retry':
      return state.orderId === undefined
        ? state
        : { ...state, opening: state.opening + 1, loaded: undefined };
    case 'answer':
      return state.orderId === undefined || event.opening !== state.opening
        ? state
        : { ...state, loaded: event.loaded };
  }
}
