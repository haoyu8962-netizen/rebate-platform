// The admin's stand-alone loading spinner (手感方案 ⑥, D10-1037): antd Spin that waits for
// motion.skeleton.show-delay, counted from when it is on screen (see useLoadingClock).
import { Spin, type SpinProps } from 'antd';
import type { ReactElement } from 'react';
import { LOADING_DELAY_MS, useLoadingClock } from '../../motion.ts';

export type DelayedSpinProps = Omit<SpinProps, 'delay'>;

export function DelayedSpin({ spinning = true, ...rest }: DelayedSpinProps): ReactElement {
  const clock = useLoadingClock();
  return <Spin {...rest} spinning={spinning && clock} delay={LOADING_DELAY_MS} />;
}
