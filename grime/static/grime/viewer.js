import { initCore }          from './viewer-core.js';
import { createOcrModule }   from './viewer-ocr.js';
import { createNerModule }   from './viewer-ner.js';
import { createTagModule }   from './viewer-tag.js';
import { createImageModule } from './viewer-image.js';

var core = initCore(window.VIEWER_CONFIG);
var ocr  = createOcrModule(core);
var ner  = createNerModule(core);
var tag  = createTagModule(core);
var img  = createImageModule(core);

core.registerModule('ocr',   ocr);
core.registerModule('ner',   ner);
core.registerModule('label', tag);
core.registerModule('image', img);

ocr.setupUI();
ner.setupUI();
tag.setupUI();
img.setupUI();
core.bindMouseHandlers();

document.addEventListener('click', function(e) {
  if (core.state.suppressClickClose) { core.state.suppressClickClose = false; return; }
  ocr.onGlobalClick(e);
  ner.onGlobalClick(e);
  var ocrMenu = document.getElementById('dp-rerun-ocr-menu');
  if (ocrMenu && ocrMenu.classList.contains('open') && !e.target.closest('.dp-split-btn'))
    ocrMenu.classList.remove('open');
});

core.initPageSelect();
tag.buildList();
tag.renderTagOverlays();
tag.populateLabelDatalist();
core.dpShowTab(core.state.activeTab);

var img = document.getElementById('dp-img');
if (img) {
  var onLoad = function() { core.dpFit(); core.updateBadge(); ocr.updateTextPanels(); };
  if (img.complete) onLoad();
  else img.addEventListener('load', onLoad);
}
