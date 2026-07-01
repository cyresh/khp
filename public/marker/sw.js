// marker/sw.js — registered as a classic (non-module) script for
// broad browser compatibility (Firefox does not support ES modules
// inside service workers as of this writing). Caches only the static
// app shell so the marker app can launch offline; never intercepts
// cross-origin requests, so Firestore/Auth/the Firebase SDK CDN are
// always left to the browser's normal (live, uncached) handling.
//
// IMPORTANT: Cache Storage is shared per ORIGIN, not per service
// worker — khtpc-admin-shell and khtpc-marker-shell are two separate
// named caches living in the same shared storage. Earlier versions of
// this file used the bare, no-argument caches.match()/caches.keys()
// APIs, which search/operate across EVERY cache on the origin, not
// just this worker's own. That let this worker's activate handler
// delete the admin app's cache (and vice versa), and let its fetch
// fallback potentially resolve a cached response belonging to the
// OTHER app's cache for an unrelated request. Every cache operation
// below now goes through this worker's own named Cache object
// (caches.open(CACHE_NAME)...) exclusively — never the bare
// origin-wide caches.match()/caches.keys() shortcuts.
//
// Version bumped to v2 to force every existing installation to drop
// whatever it had cached under v1 and start clean.

const CACHE_NAME = "khtpc-marker-shell-v3";
const FILES_TO_CACHE = [
  "/marker/index.html",
  "/marker/manifest.json",
  "/shared/design-system.css",
  "/shared/firebase-init.js",
  "/shared/firebase-config.js",
  "/shared/auth.js",
  "/shared/college-header.js",
  "/shared/pin-keypad.js",
  "/shared/biometric-auth.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(FILES_TO_CACHE))
  );
});

self.addEventListener("activate", (event) => {
  // Only ever remove THIS app's own old cache versions (names that
  // start with "khtpc-marker-shell-" but aren't the current one) —
  // never touch any other cache name, so this worker can never delete
  // the admin app's cache.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith("khtpc-marker-shell-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // leave Firestore/Auth/CDN alone
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      fetch(event.request)
        .then((response) => {
          cache.put(event.request, response.clone());
          return response;
        })
        // Offline fallback reads ONLY from this worker's own named
        // cache (`cache.match`, not the bare `caches.match`), so it
        // can never resolve to a response that was actually cached
        // by the admin app's service worker.
        .catch(() => cache.match(event.request))
    )
  );
});
