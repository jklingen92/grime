// SVG filter chain applied to #dp-img via CSS filter url(). The LUT for
// brightness/contrast/gamma/levels and the threshold step are computed from
// the current image sliders and injected into the feFuncR/G/B tableValues.

import { useMemo } from 'react';
import { buildLut, isIdentityLut, slidersToParams } from '../state/imageParams.js';

export default function ImageFilterSvg({ sliders }) {
  const params = useMemo(() => slidersToParams(sliders), [sliders]);

  const lutTable = useMemo(
    () => (isIdentityLut(params) ? '0 1' : buildLut(params)),
    [params],
  );

  const threshold = sliders.threshold;
  const thresholdSlope = 1000;
  const thresholdIntercept =
    threshold != null ? -((threshold / 255) * thresholdSlope) : -502;

  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <filter id="dp-image-filter" colorInterpolationFilters="sRGB">
        <feComponentTransfer>
          <feFuncR id="dp-image-filter-r" type="table" tableValues={lutTable} />
          <feFuncG id="dp-image-filter-g" type="table" tableValues={lutTable} />
          <feFuncB id="dp-image-filter-b" type="table" tableValues={lutTable} />
        </feComponentTransfer>
      </filter>
      <filter id="dp-threshold-filter" colorInterpolationFilters="sRGB">
        <feColorMatrix type="saturate" values="0" />
        <feComponentTransfer>
          <feFuncR
            id="dp-threshold-filter-r"
            type="linear"
            slope={String(thresholdSlope)}
            intercept={thresholdIntercept.toFixed(1)}
          />
          <feFuncG
            id="dp-threshold-filter-g"
            type="linear"
            slope={String(thresholdSlope)}
            intercept={thresholdIntercept.toFixed(1)}
          />
          <feFuncB
            id="dp-threshold-filter-b"
            type="linear"
            slope={String(thresholdSlope)}
            intercept={thresholdIntercept.toFixed(1)}
          />
        </feComponentTransfer>
      </filter>
    </svg>
  );
}
