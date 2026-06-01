// React island entry point: mount the viewer into #viewer-root using the
// VIEWER_CONFIG payload the Django template emits.

import { createRoot } from 'react-dom/client';
import { ViewerProvider } from './viewer/state/ViewerContext.jsx';
import ViewerApp from './viewer/ViewerApp.jsx';

const config = window.VIEWER_CONFIG;
const mount = document.getElementById('viewer-root');

if (mount && config) {
  createRoot(mount).render(
    <ViewerProvider config={config}>
      <ViewerApp />
    </ViewerProvider>,
  );
}
