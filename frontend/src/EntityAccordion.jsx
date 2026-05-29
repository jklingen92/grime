import EntityThumbnail from './EntityThumbnail.jsx';

function PageGroup({ page }) {
  return (
    <div className="mb-3">
      <div className="mb-1">
        <a href={page.pageUrl} className="small fw-semibold text-decoration-none">
          p.&nbsp;{page.pageNumber ?? '?'}
        </a>
      </div>
      <div className="d-flex flex-column gap-2">
        {page.occurrences.map((occ, i) => (
          <EntityThumbnail
            key={i}
            imageUrl={occ.imageUrl}
            left={occ.left}
            top={occ.top}
            width={occ.width}
            height={occ.height}
          />
        ))}
      </div>
    </div>
  );
}

function DocItem({ doc, index }) {
  const collapseId = `entity-doc-${index}`;
  const headingId  = `entity-doc-h-${index}`;
  return (
    <div className="accordion-item">
      <h2 className="accordion-header" id={headingId}>
        <button
          className="accordion-button collapsed"
          type="button"
          data-bs-toggle="collapse"
          data-bs-target={`#${collapseId}`}
          aria-expanded="false"
          aria-controls={collapseId}
        >
          <a
            href={doc.docUrl}
            className="me-2 text-decoration-none text-reset"
            onClick={e => e.stopPropagation()}
          >
            {doc.title}
          </a>
          <span className="badge bg-secondary ms-auto me-2">{doc.occurrenceCount}</span>
        </button>
      </h2>
      <div
        id={collapseId}
        className="accordion-collapse collapse"
        aria-labelledby={headingId}
      >
        <div className="accordion-body pt-2">
          {doc.pages.map((page, j) => (
            <PageGroup key={j} page={page} />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function EntityAccordion({ docs }) {
  if (!docs || docs.length === 0) {
    return <p className="text-muted">No occurrences found.</p>;
  }
  return (
    <div className="accordion" id="entity-docs-accordion">
      {docs.map((doc, i) => (
        <DocItem key={i} doc={doc} index={i} />
      ))}
    </div>
  );
}
