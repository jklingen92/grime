import { createRoot } from 'react-dom/client';
import EntityDetail from './EntityDetail.jsx';

const el = document.getElementById('entity-detail-root');
if (el) {
  createRoot(el).render(<EntityDetail {...JSON.parse(el.dataset.props)} />);
}
