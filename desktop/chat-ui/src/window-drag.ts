// Lets the user drag the whole window by pressing inside the chat header (or
// any element tagged `data-window-drag`), the way a native title bar behaves.
//
// The window is borderless with `NSWindow.isMovableByWindowBackground = true`,
// so pressing on the native left sidebar already drags it. But the chat header
// is rendered inside the WKWebView, which swallows the mouse events that
// `isMovableByWindowBackground` would otherwise use — so dragging from there
// does nothing.
//
// We bridge the gap by reporting the on-screen rectangles of every
// `[data-window-drag]` element to the native shell, which then starts a real
// window drag when the user presses inside one. Elements tagged
// `[data-no-window-drag]` punch holes in those regions so interactive controls
// (buttons, tabs) stay clickable.

declare global {
  interface Window {
    __versoWindowDragInstalled?: boolean;
  }
}

type Rect = { x: number; y: number; width: number; height: number };

function collect(selector: string): Rect[] {
  const rects: Rect[] = [];
  document.querySelectorAll(selector).forEach((el) => {
    const r = el.getBoundingClientRect();
    // getBoundingClientRect is in CSS points relative to the viewport, which
    // maps 1:1 onto the WKWebView's AppKit points — no scaling needed.
    if (r.width > 0 && r.height > 0) {
      rects.push({ x: r.left, y: r.top, width: r.width, height: r.height });
    }
  });
  return rects;
}

let lastSent = '';

function post() {
  const bridge = window.webkit?.messageHandlers?.chatBridge;
  if (!bridge) return;

  const payload = {
    type: 'windowDragRegions',
    drag: collect('[data-window-drag]'),
    noDrag: collect('[data-no-window-drag]'),
  };

  // The DOM mutates constantly while a response streams in; only cross the
  // bridge when the drag geometry actually changed.
  const serialized = JSON.stringify(payload);
  if (serialized === lastSent) return;
  lastSent = serialized;
  bridge.postMessage(payload);
}

export function installWindowDrag(): void {
  if (window.__versoWindowDragInstalled) return;
  window.__versoWindowDragInstalled = true;

  let frame = 0;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      post();
    });
  };

  // Width changes move the header's right edge; mount/unmount of the header
  // (or any drag region) changes the set of rectangles.
  window.addEventListener('resize', schedule);
  new MutationObserver(schedule).observe(document.body, {
    childList: true,
    subtree: true,
  });

  schedule();
}
