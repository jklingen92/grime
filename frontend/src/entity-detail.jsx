import { createRoot } from 'react-dom/client';
import EntityDetail from './EntityDetail.jsx';

const el = document.getElementById('entity-detail-root');
if (el && window.__ENTITY_PROPS__) {
  createRoot(el).render(<EntityDetail {...window.__ENTITY_PROPS__} />);
}
