import { call, has } from '@couli/bridge-sdk';
import { bridge } from '@couli/contracts-ts';
import { t } from '../../shared/texts.ts';

/**
 * Page title per contract h5 path, read from its page-title key in contracts/texts.default.json
 * (literal keys, so the build-time dictionary trim keeps them); null while the contract dictionary
 * has no page-title key for that route (the native title is then left as it is).
 */
const NAV_TITLES: Readonly<Record<string, (() => string) | null>> = {
  [bridge.routes.Earnings.h5_path]: () => t('earnings.title'),
  // TODO(规划/11 §7.1): /find-order 页面标题键（建议 find_order.title） — blocked on content 补 texts.default.json
  [bridge.routes.FindOrder.h5_path]: null,
  // TODO(规划/11 §7.1): /ledger 页面标题键（建议 ledger.title） — blocked on content 补 texts.default.json
  [bridge.routes.Ledger.h5_path]: null,
  // TODO(规划/11 §7.1): /messages 页面标题键（建议 messages.title） — blocked on content 补 texts.default.json
  [bridge.routes.Messages.h5_path]: null,
  // TODO(规划/11 §7.1): /invite 页面标题键（建议 invite.title） — blocked on content 补 texts.default.json
  [bridge.routes.InviteShare.h5_path]: null,
  // TODO(规划/11 §7.1): /rules 页面标题键（建议 rules.title） — blocked on content 补 texts.default.json
  [bridge.routes.Rules.h5_path]: null,
  // TODO(规划/11 §7.1): /help 页面标题键（建议 help.title） — blocked on content 补 texts.default.json
  [bridge.routes.Help.h5_path]: null,
  // TODO(规划/11 §7.1): /notice 页面标题键（建议 notice.title） — blocked on content 补 texts.default.json
  [bridge.routes.Notice.h5_path]: null,
  // TODO(规划/11 §7.1): /agreement 页面标题键（建议 agreement.title） — blocked on content 补 texts.default.json
  [bridge.routes.Agreement.h5_path]: null,
};

/**
 * The shell's only ui.setNavBar call, sent once per entry into a contract h5 path. The title comes
 * from the contract dictionary only; a route without a page-title key sends no title. Outside the
 * App, or when native does not declare ui.setNavBar, nothing is sent; a failed call is ignored.
 */
export function syncNavBar(pathname: string): void {
  if (!Object.hasOwn(NAV_TITLES, pathname)) return;
  const setNavBar = has('ui.setNavBar');
  if (setNavBar === null) return;
  const title = NAV_TITLES[pathname]?.() ?? '';
  call(setNavBar, title === '' ? {} : { title }).catch(() => undefined);
}
