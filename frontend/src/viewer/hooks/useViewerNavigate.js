// Navigate while preserving the active tab in the query string
// (read back by getInitialTab in state/initialState.js).

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
