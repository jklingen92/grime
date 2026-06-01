// Position a floating element flush with the right edge of the viewer wrap.
// Mirrors viewer-core.js:53 positionAtViewerEdge.

import { useCallback } from 'react';

export function useViewerEdgePositioner(wrapRef) {
  return useCallback(
    (el) => {
      if (!el || !wrapRef.current) return;
      const rect = wrapRef.current.getBoundingClientRect();
      el.style.left = rect.right - 8 + 'px';
      el.style.top = rect.top + 8 + 'px';
      el.style.display = 'flex';
    },
    [wrapRef],
  );
}
