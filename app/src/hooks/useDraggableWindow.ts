import React, { useCallback, useRef } from 'react';

export function useDraggableWindow() {
  const isDraggingRef = useRef(false);
  const lastPosRef = useRef({ x: 0, y: 0 });

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;

    const target = e.target as HTMLElement;
    if (target.closest('button, input, select, textarea, a, [role="button"], .no-drag')) {
      return;
    }

    isDraggingRef.current = true;
    lastPosRef.current = { x: e.screenX, y: e.screenY };

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const deltaX = moveEvent.screenX - lastPosRef.current.x;
      const deltaY = moveEvent.screenY - lastPosRef.current.y;
      lastPosRef.current = { x: moveEvent.screenX, y: moveEvent.screenY };

      if (deltaX !== 0 || deltaY !== 0) {
        window.desktopBridge?.dragControlWindow({ x: deltaX, y: deltaY });
      }
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.desktopBridge?.dragControlWindowEnd();
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, []);

  return { handleMouseDown };
}
