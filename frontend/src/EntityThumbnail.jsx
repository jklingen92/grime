import { useRef, useEffect } from 'react';

const PAD = 80;
const CANVAS_HEIGHT = 200;

export default function EntityThumbnail({ imageUrl, left, top, width, height }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageUrl) return;

    let cancelled = false;
    const observer = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) return;
      observer.disconnect();

      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (cancelled) return;
        const sx = Math.max(0, left - PAD);
        const sy = Math.max(0, top - PAD);
        const sw = Math.min(width + PAD * 2, img.naturalWidth - sx);
        const sh = Math.min(height + PAD * 2, img.naturalHeight - sy);
        const scale = CANVAS_HEIGHT / sh;
        canvas.height = CANVAS_HEIGHT;
        canvas.width  = Math.round(sw * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        // highlight the entity bbox
        ctx.fillStyle = 'rgba(255, 200, 0, 0.35)';
        ctx.strokeStyle = 'rgba(200, 140, 0, 0.7)';
        ctx.lineWidth = 1.5;
        const hx = (left - sx) * scale;
        const hy = (top  - sy) * scale;
        const hw = width  * scale;
        const hh = height * scale;
        ctx.fillRect(hx, hy, hw, hh);
        ctx.strokeRect(hx, hy, hw, hh);
      };
      img.src = imageUrl;
    });
    observer.observe(canvas);

    return () => { cancelled = true; observer.disconnect(); };
  }, [imageUrl, left, top, width, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{ borderRadius: 8, display: 'block', background: '#eee', height: CANVAS_HEIGHT, maxWidth: '100%' }}
    />
  );
}
