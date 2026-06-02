import { useEffect, useRef } from "react";

/**
 * BackgroundFX — the high-tech HUD layer, skinned to the SERVARI brand tokens.
 *
 * Every stroke/fill is SERVARI teal (#149C96 / rgba(20,156,150,…)). Three
 * layers, painted back-to-front:
 *   1. a slow-drifting constellation network on a single <canvas> (rAF),
 *   2. a faint HUD grid + scanline overlay (pure CSS, no per-frame cost),
 *   3. two soft radial glow pools (teal) for depth.
 *
 * This is meant to LAYER under AmbientBackground (the calm ink+feathers) OR
 * replace it — either way it is self-contained: it ships its own scoped CSS so
 * it never depends on a shared theme.css class.
 *
 * PERFORMANCE DISCIPLINE (premium AND smooth):
 *   - the canvas loop is capped to ~30fps (not the full ~60) — the drift is
 *     slow, so half the frames look identical and cost nothing,
 *   - the loop PAUSES entirely while the document is hidden (tab/exe in the
 *     background) and resumes on visibility,
 *   - device-pixel-ratio aware so it stays crisp on HiDPI without overdraw,
 *   - the canvas is fully pointer-events-none and fixed behind everything.
 */
export function BackgroundFX() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Cap device-pixel-ratio at 2 so 4K HiDPI panels don't quadruple overdraw.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let cssW = window.innerWidth;
    let cssH = window.innerHeight;

    const resize = () => {
      cssW = window.innerWidth;
      cssH = window.innerHeight;
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels
    };
    resize();
    window.addEventListener("resize", resize);

    // Constellation points — count scales gently with viewport area so a large
    // monitor isn't sparse and a small one isn't crowded (clamped 36..70).
    const area = cssW * cssH;
    const N = Math.max(36, Math.min(70, Math.round(area / 26000)));
    const pts = Array.from({ length: N }, () => ({
      x: Math.random() * cssW,
      y: Math.random() * cssH,
      vx: (Math.random() - 0.5) * 0.22,
      vy: (Math.random() - 0.5) * 0.22,
    }));

    const LINK_DIST = 150; // px within which two points are connected
    const LINK_DIST_SQ = LINK_DIST * LINK_DIST;

    // SERVARI teal, as rgba components.
    const TEAL = "20, 156, 150";

    let raf = 0;
    let last = 0;
    const FRAME_MS = 1000 / 30; // ~30fps cap

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      // Throttle to the frame cap — skip frames that arrive too soon.
      if (now - last < FRAME_MS) return;
      last = now;

      ctx.clearRect(0, 0, cssW, cssH);

      // nodes
      ctx.fillStyle = `rgba(${TEAL}, 0.55)`;
      for (const p of pts) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > cssW) p.vx *= -1;
        if (p.y < 0 || p.y > cssH) p.vy *= -1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }

      // links
      ctx.lineWidth = 0.6;
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const dx = pts[i].x - pts[j].x;
          const dy = pts[i].y - pts[j].y;
          const d2 = dx * dx + dy * dy;
          if (d2 < LINK_DIST_SQ) {
            const a = (1 - Math.sqrt(d2) / LINK_DIST) * 0.18;
            ctx.strokeStyle = `rgba(${TEAL}, ${a})`;
            ctx.beginPath();
            ctx.moveTo(pts[i].x, pts[i].y);
            ctx.lineTo(pts[j].x, pts[j].y);
            ctx.stroke();
          }
        }
      }
    };

    // Pause the loop entirely when the document is hidden; resume on focus.
    const onVisibility = () => {
      if (document.hidden) {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      } else if (!raf) {
        last = 0;
        raf = requestAnimationFrame(tick);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    if (!document.hidden) raf = requestAnimationFrame(tick);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <>
      {/* Scoped HUD CSS — teal theme vars so this component has no external CSS
          dependency. */}
      <style>{`
        .servari-hud-grid {
          background-image:
            linear-gradient(rgba(20, 156, 150, 0.045) 1px, transparent 1px),
            linear-gradient(90deg, rgba(20, 156, 150, 0.045) 1px, transparent 1px);
          background-size: 42px 42px;
        }
        .servari-hud-scan::before {
          content: "";
          position: absolute; inset: 0; pointer-events: none;
          background: repeating-linear-gradient(
            to bottom,
            rgba(20, 156, 150, 0.022) 0px,
            rgba(20, 156, 150, 0.022) 1px,
            transparent 1px,
            transparent 3px
          );
          mix-blend-mode: screen;
        }
      `}</style>

      {/* Faint HUD grid */}
      <div className="fixed inset-0 servari-hud-grid pointer-events-none opacity-60" />

      {/* Constellation network canvas */}
      <canvas ref={ref} className="fixed inset-0 pointer-events-none opacity-70" />

      {/* Scanline overlay */}
      <div className="fixed inset-0 servari-hud-scan pointer-events-none" />

      {/* Soft teal depth pools */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at 50% 112%, rgba(20,156,150,0.10), transparent 60%), radial-gradient(ellipse at 8% -10%, rgba(20,156,150,0.06), transparent 52%)",
        }}
      />
    </>
  );
}
