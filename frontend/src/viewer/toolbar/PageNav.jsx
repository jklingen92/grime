import { useViewerConfig, useViewerState } from '../state/ViewerContext.jsx';
import { useViewerNavigate } from '../hooks/useViewerNavigate.js';

export default function PageNav() {
  const config = useViewerConfig();
  const { tab } = useViewerState();
  const navigate = useViewerNavigate(tab);
  const pageList = config.pageList;

  return (
    <>
      {config.prevUrl ? (
        <a
          className="dp-nav-btn btn btn-sm btn-outline-secondary"
          href={config.prevUrl}
          title={config.navPrevLabel || 'Previous'}
          onClick={(e) => {
            e.preventDefault();
            navigate(config.prevUrl);
          }}
        >
          <i className="fa-solid fa-arrow-left" />
        </a>
      ) : (
        <a
          className="dp-nav-btn btn btn-sm btn-outline-secondary disabled"
          aria-disabled="true"
        >
          <i className="fa-solid fa-arrow-left" />
        </a>
      )}

      {pageList ? (
        <select
          id="dp-page-select"
          className="form-select form-select-sm dp-page-select"
          value={pageList.find((p) => p.pk === config.currentPagePk)?.url || ''}
          onChange={(e) => navigate(e.target.value)}
        >
          {pageList.map((p) => (
            <option key={p.pk} value={p.url}>
              p. {p.page_number}
            </option>
          ))}
        </select>
      ) : config.pagePosition && config.totalCount ? (
        <span id="dp-page-indicator">
          {config.navPrefix || ''}
          {config.pagePosition} / {config.totalCount}
        </span>
      ) : null}

      {config.nextUrl ? (
        <a
          className="dp-nav-btn btn btn-sm btn-outline-secondary"
          href={config.nextUrl}
          title={config.navNextLabel || 'Next'}
          onClick={(e) => {
            e.preventDefault();
            navigate(config.nextUrl);
          }}
        >
          <i className="fa-solid fa-arrow-right" />
        </a>
      ) : (
        <a
          className="dp-nav-btn btn btn-sm btn-outline-secondary disabled"
          aria-disabled="true"
        >
          <i className="fa-solid fa-arrow-right" />
        </a>
      )}
    </>
  );
}
