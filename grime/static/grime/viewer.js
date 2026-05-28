import { initCore }             from './viewer-core.js';
import { createOcrModule }      from './viewer-ocr.js';
import { createNerModule }      from './viewer-ner.js';
import { createAnnotationModule } from './viewer-annotation.js';
import { createImageModule }    from './viewer-image.js';
import { createJobsModule }  from './viewer-jobs.js';


var core       = initCore(window.VIEWER_CONFIG);
var ocr        = createOcrModule(core);
var ner        = createNerModule(core);
var annotation = createAnnotationModule(core);
var img        = createImageModule(core);
var jobs = createJobsModule(core);

core.registerModule('ocr',   ocr);
core.registerModule('ner',   ner);
core.registerModule('label', annotation);
core.registerModule('image', img);

// Expose openJobModal so ocr/ner modules can call it from their setupUI
core.openJobModal = jobs.openJobModal;

jobs.setupUI();
ocr.setupUI();
ner.setupUI();
annotation.setupUI();
img.setupUI();
core.bindMouseHandlers();

document.addEventListener('click', function(e) {
  if (core.state.suppressClickClose) { core.state.suppressClickClose = false; return; }
  ocr.onGlobalClick(e);
  ner.onGlobalClick(e);
});

core.initPageSelect();
annotation.buildList();
annotation.renderAnnotationOverlays();
annotation.populateLabelDatalist();
core.dpShowTab(core.state.activeTab);

var img = document.getElementById('dp-img');
if (img) {
  var onLoad = function() { core.dpFit(); core.updateBadge(); ocr.updateTextPanels(); };
  if (img.complete) onLoad();
  else img.addEventListener('load', onLoad);
}
