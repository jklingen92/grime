// Navigate while preserving the active tab in the query string.
// Mirrors viewer-core.js:99 navigate().

import { useCallback } from 'react';

export function useViewerNavigate(activeTab) {
  return useCallback(
    (url) => {
      if (!url) return;
      const sep = url.indexOf('?') >= 0 ? '&' : '?';
      window.location.href = url + sep + 'tab=' + activeTab;
    },
    [activeTab],
  );
}
