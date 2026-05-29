// Image-adjustment helpers shared between the panel, the SVG filter, and
// the save/reset endpoints. Must stay numerically identical to
// grime/static/grime/viewer-image.js so previews match server output.

import { IMAGE_DEFAULTS } from './initialState.js';

export { IMAGE_DEFAULTS };

// Convert slider-space to canonical params posted to the backend.
export function slidersToParams(a) {
  return {
    brightness: a.brightness / 100,
    contrast: a.contrast / 100,
    gamma: a.gamma / 100,
    black: a.black,
    white: Math.max(a.black + 1, a.white),
    grayscale: !!a.grayscale,
    invert: !!a.invert,
    threshold: a.threshold != null ? parseInt(a.threshold, 10) : null,
    sharpen: !!a.sharpen,
    rotate90: a.rotate90 || 0,
    rotate_fine: a.rotateFine || 0,
  };
}

export function buildLut(p) {
  const lut = new Array(256);
  const span = p.white - p.black;
  const invG = 1.0 / p.gamma;
  for (let i = 0; i < 256; i++) {
    let x = (i - p.black) / span;
    if (x < 0) x = 0;
    else if (x > 1) x = 1;
    x = Math.pow(x, invG);
    x = (x - 0.5) * p.contrast + 0.5;
    x = x + p.brightness;
    if (x < 0) x = 0;
    else if (x > 1) x = 1;
    lut[i] = x.toFixed(4);
  }
  return lut.join(' ');
}

export function isIdentityLut(p) {
  return (
    p.brightness === 0 &&
    p.contrast === 1 &&
    p.gamma === 1 &&
    p.black === 0 &&
    p.white === 255
  );
}

export function isIdentity(p) {
  return (
    isIdentityLut(p) &&
    !p.grayscale &&
    !p.invert &&
    p.threshold == null &&
    !p.sharpen &&
    !p.rotate90 &&
    !p.rotate_fine
  );
}

export function isDirty(currentSliders, savedSliders) {
  const a = currentSliders;
  const s = savedSliders;
  return (
    a.brightness !== s.brightness ||
    a.contrast !== s.contrast ||
    a.gamma !== s.gamma ||
    a.black !== s.black ||
    a.white !== s.white ||
    !!a.grayscale !== !!s.grayscale ||
    !!a.invert !== !!s.invert ||
    a.threshold !== s.threshold ||
    !!a.sharpen !== !!s.sharpen ||
    a.rotate90 !== s.rotate90 ||
    a.rotateFine !== s.rotateFine
  );
}

export function formatSliderVal(key, v) {
  if (key === 'contrast' || key === 'gamma') return (v / 100).toFixed(2);
  if (key === 'brightness') return (v > 0 ? '+' : '') + v;
  return String(v);
}
