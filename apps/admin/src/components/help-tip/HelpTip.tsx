// F1-07ec: a question-mark entry named 「说明」 whose explanation shows on hover and on keyboard
// focus (antd Tooltip). The entry is a real button so it is reachable with Tab; it does nothing
// on click.
import { QuestionCircleOutlined } from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import type { ReactElement } from 'react';
import { componentsTexts } from '../../texts/components.ts';

export interface HelpTipProps {
  readonly text: string;
}

export function HelpTip({ text }: HelpTipProps): ReactElement {
  return (
    <Tooltip title={text} trigger={['hover', 'focus']}>
      <Button
        type="text"
        size="small"
        aria-label={componentsTexts.helpTip.label}
        icon={<QuestionCircleOutlined />}
      />
    </Tooltip>
  );
}
