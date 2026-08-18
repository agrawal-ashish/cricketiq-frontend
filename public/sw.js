// CricketIQ service worker
// Bump this version string any time you want to force-clear old caches
// after a deploy (e.g. after updating styles, questions, or game logic).
const CACHE_NAME = "cricketiq-v2.10";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only handle GET requests — POST (like /api/answer) always goes straight
  // to the network, never cached.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isApiCall = url.pathname.startsWith("/api/");

  if (isApiCall) {
    // Network-first: always try to get live questions when online.
    // If the network fails (offline), fall back to the last successful
    // response so a previously-loaded game can still be played offline.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Static assets (JS, CSS, HTML, icons): cache-first for speed and offline
  // support, falling back to the network and caching the result for next time.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        // Don't cache opaque/error responses
        if (!response || response.status !== 200 || response.type === "error") {
          return response;
        }
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      });
    })
  );
});
