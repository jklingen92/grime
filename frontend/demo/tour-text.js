// Intro modals for the static demo, each shown once per browser tab by tour.js.
// Edit freely: each step is { title, body }; body is HTML.

export default {
  // index.html (document list)
  dashboard: [
    {
      title: 'Welcome to grime',
      body: `<p>Grime is an archival document platform: it ingests scanned PDFs, runs OCR
        and named-entity recognition (NER), and gives archivists tools to correct and
        annotate each page.</p>
        <p>This is a static, browser-only copy.</p>`,
    },
    {
      title: "What's switched off",
      body: `<p>Anything that needs a server is shown but grayed out: uploading, running
        OCR/NER jobs, exports, and editing or deleting documents. Hover a grayed control
        to confirm.</p>`,
    },
    {
      title: 'Open a document',
      body: `<p>Click a title to open it in the viewer. Each demo document includes one page.</p>`,
    },
  ],

  // viewer.html (one page), on load
  viewer: [
    {
      title: 'The viewer',
      body: `<p>The scanned page is on the left; the panel on the right has a tab per task:
        <strong>OCR</strong>, <strong>NER</strong> and <strong>Image</strong>.</p>
        <p>Ctrl/⌘ + scroll zooms.</p>`,
    },
    {
      title: 'OCR',
      body: `<p>Each box is a word the OCR found, coloured by confidence. The OCR on this page
        was run poorly on purpose.</p>
        <ul>
          <li>Click a word to fix its text.</li>
          <li>Drag or shift-click to select several, then ditto or delete them.</li>
          <li>Press <kbd>A</kbd> to draw a box around a word the OCR missed.</li>
        </ul>`,
    },
    {
      title: 'Your edits',
      body: `<p>Corrections are saved in this browser only. <strong>Reset page</strong> in the
        yellow banner restores the original.</p>`,
    },
  ],

  // viewer.html, after the intro above; keyed by page pk (viewer.html?page=<pk>).
  // A page with no entry just gets no card. Drafts: replace with your own notes.
  pages: {
    // American Protective League
    41: [
      {
        title: 'American Protective League',
        body: `<p>Page 6 of a 105-page document.</p>`,
      },
    ],
    // Declaration of Independence
    34: [
      {
        title: 'Declaration of Independence',
        body: `<p>A single dense page with over 1,300 OCR words.</p>`,
      },
    ],
    // hanford glossary of code words
    1: [
      {
        title: 'Hanford glossary of code words',
        body: `<p>Page 1 of a 30-page glossary.</p>`,
      },
    ],
  },

  // viewer.html, the first time each tab is opened; keyed by tab (ner, image, ocr, label)
  tabs: {
    ner: [
      {
        title: 'NER',
        body: `<p>Words tagged as people, places and organisations. Select words on the page or
          in the list to change or clear their entity label.</p>`,
      },
    ],
    image: [
      {
        title: 'Image',
        body: `<p>Adjust brightness, contrast, levels, rotation and threshold to make faded text
          legible. The preview is live; saving the adjusted image is off in the demo.</p>`,
      },
    ],
  },
};
