// Compute the ratio of rendered image width to reference width. With
// usePreprocessedBbox, word boxes are in the preprocessed image's space,
// which is at least 2000px wide.

import { useCallback, useEffect, useState } from 'react';

export function useScale(imgRef, usePreprocessedBbox) {
  const [scale, setScale] = useState(1);

  const recompute = useCallback(() => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return;
    const refWidth = usePreprocessedBbox ? Math.max(img.naturalWidth, 2000) : img.naturalWidth;
    setScale(img.clientWidth / refWidth);
  }, [imgRef, usePreprocessedBbox]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    if (img.complete) recompute();
    img.addEventListener('load', recompute);
    const ro = new ResizeObserver(recompute);
    ro.observe(img);
    return () => {
      img.removeEventListener('load', recompute);
      ro.disconnect();
    };
  }, [imgRef, recompute]);

  return { scale, recompute };
}
