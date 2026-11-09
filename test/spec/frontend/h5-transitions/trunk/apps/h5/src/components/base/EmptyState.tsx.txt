import type { ReactElement } from 'react';
import { StateLayout } from './StateLayout.tsx';
import type { StateProps } from './types.ts';

/**
 * The decorative placeholder exposes data-slot="state-illustration". `autoFocusAction` is ignored:
 * an empty state never moves focus.
 */
export function EmptyState(props: StateProps): ReactElement {
  return <StateLayout {...props} autoFocusAction={false} alert={false} />;
}
