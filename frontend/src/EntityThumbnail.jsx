import { useRef, useEffect } from 'react';

const PAD_V = 60; // vertical padding around entity bbox

export default function EntityThumbnail({ imageUrl, left, top, width, height }) {
  const containerRef = useRef(null);
  const canvasRef    = useRef(null);

  useEffect(() => {
    const canvas    = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !imageUrl) return;

    let imgEl     = null;
    let cancelled = false;

    function draw() {
      if (!imgEl || cancelled) return;
      const cw = Math.round(container.getBoundingClientRect().width);
      if (!cw) return;

      // show full page width; crop vertically around the entity
      const sx = 0;
      const sw = imgEl.naturalWidth;
      const sy = Math.max(0, top - PAD_V);
      const sh = Math.min(height + PAD_V * 2, imgEl.naturalHeight - sy);
      const scale = cw / sw;

      canvas.width  = cw;
      canvas.height = Math.round(sh * scale);

      const ctx = canvas.getContext('2d');
      ctx.drawImage(imgEl, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

      const hx = left          * scale;
      const hy = (top - sy)    * scale;
      const hw = width         * scale;
      const hh = height        * scale;
      ctx.fillStyle   = 'rgba(255, 200, 0, 0.35)';
      ctx.strokeStyle = 'rgba(200, 140, 0, 0.7)';
      ctx.lineWidth   = 1.5;
      ctx.fillRect(hx, hy, hw, hh);
      ctx.strokeRect(hx, hy, hw, hh);
    }

    const io = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) return;
      io.disconnect();
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { imgEl = img; draw(); };
      img.src = imageUrl;
    });
    io.observe(canvas);

    const ro = new ResizeObserver(draw);
    ro.observe(container);

    return () => { cancelled = true; io.disconnect(); ro.disconnect(); };
  }, [imageUrl, left, top, width, height]);

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{ borderRadius: 8, display: 'block', border: '1px solid #dee2e6' }}
      />
    </div>
  );
}
