// shared/firebase-init.js
//
// Each of this project's pages (admin, marker) calls initFirebase()
// with its own app name, giving each one its own Firebase Auth
// persistence key (Auth's IndexedDB/localStorage key is namespaced
// by app name, not just by API key) — entirely separate from the
// others. Without this, admin and marker shared one Auth session by
// virtue of using the same browser/origin: logging into marker would
// silently sign the admin tab out (or vice versa), since both were
// really the same underlying Firebase Auth instance. Each page now
// gets its own login, independent of what's signed in elsewhere on
// the same device.
//
// Loaded as a native ES module directly in the browser (no bundler
// needed) via the Firebase modular CDN build.
//
// Offline persistence: uses the modern initializeFirestore({localCache:
// persistentLocalCache(...)}) API (P3), not the deprecated
// enableIndexedDbPersistence(). Multi-tab is used so an admin can
// have the live dashboard open in one tab and the re-upload screen
// open in another without one of them silently losing persistence —
// the old single-tab-only behavior was the most common source of
// confusing "why isn't this working" reports with the deprecated API.
//
// If persistence can't be enabled (private/incognito mode in some
// browsers, or a browser that doesn't support IndexedDB at all), we
// fall back to a plain in-memory Firestore instance rather than
// throwing — the app should still work online, just without offline
// support, instead of failing to load entirely.

import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  memoryLocalCache,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

/**
 * Initializes (or reuses) a named Firebase app instance and returns
 * its { app, auth, db }. Each calling page should pass a stable,
 * unique name — e.g. "admin" or "marker" — so its Auth session never
 * collides with another page's. Calling this twice with the same
 * name (e.g. a hot-reload) reuses the existing instance instead of
 * throwing Firebase's "app already exists" error.
 *
 * Also assigns the module-level `app`/`auth`/`db` bindings below, so
 * every other module's existing `import { db, auth } from
 * "./firebase-init.js"` keeps working exactly as before — as long as
 * the calling page's <script> calls initFirebase() before any other
 * module actually USES db/auth (every other module in this codebase
 * only touches them inside functions, never at module-top-level, so
 * this ordering requirement is naturally satisfied by each page's own
 * entry-point script running first).
 */
export function initFirebase(appName) {
  const newApp = getApps().some((a) => a.name === appName)
    ? getApp(appName)
    : initializeApp(firebaseConfig, appName);
  const newAuth = getAuth(newApp);

  let newDb;
  try {
    newDb = initializeFirestore(newApp, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
  } catch (err) {
    // initializeFirestore() with persistentLocalCache can throw
    // synchronously (rather than rejecting a promise, unlike the old
    // enableIndexedDbPersistence) if the browser environment can't
    // support it at all. Fall back to memory-only so the app still
    // works online.
    console.warn("Firestore offline persistence unavailable, falling back to memory-only cache:", err);
    newDb = initializeFirestore(newApp, { localCache: memoryLocalCache() });
  }

  app = newApp;
  auth = newAuth;
  db = newDb;

  return { app, auth, db };
}

// Mutable live bindings — `let`, not `const`, so initFirebase() above
// can assign them after this module first loads. Every other module
// imports these by name and only reads them lazily inside functions,
// so they'll see the real instance by the time they're actually used.
export let app;
export let auth;
export let db;
