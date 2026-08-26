import { useEffect, useRef } from 'react';

/* Dotted wave surface: a perspective grid of dots rippling on two sine waves.
   ponytail: plain canvas 2D instead of three.js — the original is a static point
   grid with an animated Y and size-attenuated points, which is ~10 lines of
   projection math. Swap in three.js only if this ever needs real 3D (lighting,
   depth sorting, shaders). */
export default function DottedSurface({
  className = '',
  size = 8,
  opacity = 0.8,
  color = '255, 255, 255',
}) {
  const ref = useRef(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas.getContext('2d');

    // Same numbers as the three.js original.
    const SEPARATION = 150, AMOUNTX = 40, AMOUNTY = 60;
    const CAM_Y = 355, CAM_Z = 1220, FOV = 60;

    let w = 0, h = 0, focal = 0;
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth; h = canvas.clientHeight;
      if (!w || !h) return;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = `rgb(${color})`;
      focal = (h / 2) / Math.tan((FOV * Math.PI) / 360);
    }
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    let raf = 0;

    // Phase off the wall clock (0.1/frame @60fps == 6 units/sec) so two
    // surfaces mounted at different times stay in step — the curtain has to
    // pick up exactly where the login hero left off.
    function draw() {
      const count = performance.now() * 0.006;
      if (!w || !h) return;
      ctx.clearRect(0, 0, w, h);
      for (let iy = 0; iy < AMOUNTY; iy++) {          // far -> near
        const z = iy * SEPARATION - (AMOUNTY * SEPARATION) / 2;
        const d = CAM_Z - z;                          // camera looks down -Z
        if (d < 1) continue;                          // behind the camera
        const k = focal / d;
        const px = (size * (h / 2)) / d;              // three's sizeAttenuation
        if (px < 0.35) continue;
        // Stand-in for the original's distance fog.
        const fade = 1 - 0.65 * Math.min(1, Math.max(0, (d - 1500) / 4500));
        ctx.globalAlpha = opacity * fade;
        ctx.beginPath();
        for (let ix = 0; ix < AMOUNTX; ix++) {
          const x = ix * SEPARATION - (AMOUNTX * SEPARATION) / 2;
          const y = Math.sin((ix + count) * 0.3) * 50 + Math.sin((iy + count) * 0.5) * 50;
          const sx = w / 2 + x * k;
          const sy = h / 2 - (y - CAM_Y) * k;
          if (sx < -px || sx > w + px || sy < -px || sy > h + px) continue;
          ctx.moveTo(sx + px / 2, sy);
          ctx.arc(sx, sy, px / 2, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      draw();
      return () => ro.disconnect();
    }

    const loop = () => { draw(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [size, opacity, color]);

  return <canvas ref={ref} className={`dotted-surface ${className}`} aria-hidden="true" />;
}
