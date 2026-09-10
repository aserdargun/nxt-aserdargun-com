/* global window, Image */
// Keep the early warmup external so script-src 'self' can execute it.
(() => {
  try {
    const pathname = window.location.pathname;
    const privateRoute = pathname === "/" || pathname === "/login" || pathname === "/app" || pathname.startsWith("/app/");
    if (!privateRoute) return;
    const image = new Image();
    image.decoding = "async";
    image.loading = "eager";
    image.fetchPriority = "low";
    image.src = "/api/private/session?_warmup=1&_t=" + Date.now();
  } catch {
    // Best effort; never block rendering.
  }
})();
