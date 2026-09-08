(() => {
  const ACCENT = [34, 211, 238];
  const SIZE = 1;

  function rgba(rgb, a) {
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
  }

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function rebuild(width, height) {
    const count = Math.floor(((width * height) / 14000) * SIZE) + Math.floor(40 * SIZE);
    const stars = [];
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * width,
        y: Math.random() * height,
        r: rand(0.6, 1.8) * Math.sqrt(SIZE),
        tw: rand(0.4, 1.2),
        phase: Math.random() * Math.PI * 2,
        vx: rand(-8, 8),
        vy: rand(-6, 6),
      });
    }
    return stars;
  }

  function drawFrame(ctx, width, height, stars, time, animate) {
    ctx.clearRect(0, 0, width, height);
    const linkDist = Math.min(140, width * 0.12);

    for (let i = 0; i < stars.length; i++) {
      const a = stars[i];
      for (let j = i + 1; j < stars.length; j++) {
        const b = stars[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.hypot(dx, dy);
        if (dist < linkDist) {
          ctx.strokeStyle = rgba(ACCENT, (1 - dist / linkDist) * 0.22);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    for (const s of stars) {
      const pulse = animate
        ? 0.45 + 0.55 * Math.sin(time * s.tw + s.phase)
        : 0.7;
      ctx.fillStyle = rgba(ACCENT, 0.25 + pulse * 0.55);
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function start() {
    const canvas = document.createElement("canvas");
    canvas.id = "horde-constellation";
    canvas.setAttribute("aria-hidden", "true");
    document.body.prepend(canvas);

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const reduced = prefersReducedMotion();
    const maxDpr = 1.5;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let stars = [];
    let raf = 0;
    let last = performance.now();
    let time = 0;
    let resizeTimer = 0;

    const applySize = () => {
      const nextDpr = Math.min(window.devicePixelRatio || 1, maxDpr);
      const nextW = window.innerWidth;
      const nextH = window.innerHeight;
      if (
        Math.abs(nextW - width) < 2 &&
        Math.abs(nextH - height) < 2 &&
        nextDpr === dpr
      ) {
        return;
      }
      dpr = nextDpr;
      width = nextW;
      height = nextH;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = rebuild(width, height);
    };

    applySize();
    window.addEventListener("resize", () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(applySize, 120);
    });

    if (reduced) {
      drawFrame(ctx, width, height, stars, 0, false);
      return;
    }

    const tick = (now) => {
      if (document.hidden) {
        raf = 0;
        return;
      }
      const rawDt = Math.min(0.05, (now - last) / 1000);
      last = now;
      time += rawDt;

      for (const s of stars) {
        s.x += s.vx * rawDt;
        s.y += s.vy * rawDt;
        s.vx += Math.sin(time * 0.35 + s.phase) * 1.5 * rawDt;
        s.vy += Math.cos(time * 0.28 + s.phase * 1.3) * 1.2 * rawDt;
        const speed = Math.hypot(s.vx, s.vy);
        if (speed > 14) {
          s.vx = (s.vx / speed) * 14;
          s.vy = (s.vy / speed) * 14;
        }
        if (s.x < -20) s.x = width + 20;
        if (s.x > width + 20) s.x = -20;
        if (s.y < -20) s.y = height + 20;
        if (s.y > height + 20) s.y = -20;
      }

      drawFrame(ctx, width, height, stars, time, true);
      raf = requestAnimationFrame(tick);
    };

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        return;
      }
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    });

    raf = requestAnimationFrame(tick);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
