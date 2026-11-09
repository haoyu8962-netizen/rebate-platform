import type { ReactElement } from 'react';
import { StateLayout } from './StateLayout.tsx';
import type { StateProps } from './types.ts';

/**
 * The decorative placeholder exposes data-slot="state-illustration". Title and helper text sit in
 * a `role="alert"` region; the retry button stays outside it. With `autoFocusAction` and an
 * `action`, focus moves to the retry button once on mount (or when the switch turns on).
 */
export function ErrorState(props: StateProps): ReactElement {
  return <StateLayout {...props} alert />;
}
