// Compute the CSS filter chain and transform for the page <img> from the
// current image sliders. Matches viewer-image.js:106 applyFilter().

import { isIdentity, isIdentityLut, slidersToParams } from '../state/imageParams.js';

export function computeImageStyle(sliders, savedSliders, hasCorrected, imageUrl, originalImageUrl) {
  const params = slidersToParams(sliders);
  const dirty = isDirtyImage(sliders, savedSliders);

  if (!dirty && hasCorrected) {
    return { src: imageUrl, filter: '', transform: '' };
  }

  const src = originalImageUrl;

  if (isIdentity(params)) {
    return { src, filter: '', transform: '' };
  }

  const filters = [];
  if (!isIdentityLut(params)) filters.push('url(#dp-image-filter)');
  if (sliders.grayscale) filters.push('grayscale(1)');
  if (sliders.invert) filters.push('invert(1)');
  if (sliders.threshold !== null && sliders.threshold !== undefined) {
    filters.push('url(#dp-threshold-filter)');
  }

  const totalDeg = sliders.rotate90 * 90 + sliders.rotateFine;
  const transform = totalDeg ? 'rotate(' + totalDeg + 'deg)' : '';

  return { src, filter: filters.join(' '), transform };
}

function isDirtyImage(a, s) {
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
