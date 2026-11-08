// 卸载式对话框的开关（DSX-107，D10-1037）：对话框只在打开时由父组件渲染，关闭即卸载、不等
// 组件库的离场动画；卸载后由代码把焦点还给触发按钮（不依赖 afterClose）。
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export interface DialogSwitch {
  readonly open: boolean;
  show(): void;
  /** 关闭对话框；卸载后焦点回到触发按钮。 */
  close(): void;
}

export function useDialogSwitch(trigger: RefObject<HTMLElement | null>): DialogSwitch {
  const [open, setOpen] = useState(false);
  const refocus = useRef(false);
  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [open, trigger]);
  const show = useCallback(() => {
    refocus.current = false;
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    refocus.current = true;
    setOpen(false);
  }, []);
  return { open, show, close };
}
