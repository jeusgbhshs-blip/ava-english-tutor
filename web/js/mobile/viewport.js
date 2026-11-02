// Keep overlays and their hit regions in the same viewport when iOS opens the keyboard.
// Ignore pinch-zoom: changing layout in response to zoom would undo accessibility zoom.
export function viewportMetrics({ height, layoutHeight, visualHeight, visualTop = 0, scale = 1, editing = false }) {
  if (Math.abs(scale - 1) > 0.01) return null;
  const usableHeight = Number.isFinite(visualHeight) && visualHeight > 0 ? visualHeight : height;
  const keyboardOpen = editing && Math.max(height, layoutHeight) - usableHeight > 120;
  return {
    height: Math.round(usableHeight),
    top: keyboardOpen ? Math.max(0, Math.round(visualTop)) : 0,
    keyboardOpen,
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  let frame = 0;
  const sync = () => {
    frame = 0;
    const active = document.activeElement;
    const editing = Boolean(active?.matches('textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="range"]), [contenteditable="true"]'));
    const metrics = viewportMetrics({
      height: window.innerHeight,
      layoutHeight: root.clientHeight,
      visualHeight: viewport?.height,
      visualTop: viewport?.offsetTop,
      scale: viewport?.scale,
      editing,
    });
    if (!metrics) return;
    root.style.setProperty('--app-height', `${metrics.height}px`);
    root.style.setProperty('--app-top', `${metrics.top}px`);
    root.classList.toggle('keyboard-open', metrics.keyboardOpen);
  };
  const schedule = () => { if (!frame) frame = window.requestAnimationFrame(sync); };
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  window.addEventListener('pageshow', schedule);
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', schedule);
  sync();
}
