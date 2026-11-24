// Writes the build stamp (see vite.demo.config.js) into the banner's #demo-version span.
const el = document.getElementById('demo-version');
if (el) el.textContent = __DEMO_VERSION__;
