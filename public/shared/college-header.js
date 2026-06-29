// shared/college-header.js
//
// College header component — shown on every screen of both the
// marker app and admin app. Fetches college/main once (Firestore
// offline persistence + the in-memory cache below mean this is cheap
// even if many screens mount it) and renders name, address, and
// phone numbers consistently everywhere.
//
// Usage:
//   import { renderCollegeHeader } from "../shared/college-header.js";
//   renderCollegeHeader(document.getElementById("header-mount"));

import { db } from "./firebase-init.js";
import { doc, getDoc, getDocFromCache } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let cachedCollege = null;
let inFlightFetch = null;

async function fetchCollege() {
  if (cachedCollege) return cachedCollege;
  if (inFlightFetch) return inFlightFetch;

  inFlightFetch = (async () => {
    const ref = doc(db, "college", "main");
    let snap;
    try {
      // Try the Firestore cache first so the header loads instantly
      // even when the device is offline or the network is slow.
      snap = await getDocFromCache(ref);
    } catch (_) {
      // Cache miss (first load or cache cleared) — fall back to network.
      // This is the normal path on first load; do NOT swallow real
      // network errors here — let them propagate to the outer catch
      // in renderCollegeHeader so the error UI is shown correctly.
      try {
        snap = await getDoc(ref);
      } catch (networkErr) {
        inFlightFetch = null;
        throw networkErr;
      }
    }
    cachedCollege = snap.exists() ? snap.data() : null;
    inFlightFetch = null;
    return cachedCollege;
  })();

  return inFlightFetch;
}

/**
 * Renders the college header into `container`. Shows a lightweight
 * loading state immediately, then fills in real data once fetched.
 * Safe to call multiple times across different screens — the
 * underlying Firestore read is cached/deduplicated.
 *
 * @param {HTMLElement} container
 * @param {{compact?: boolean}} [options] - compact mode shows just
 *   the name (used in tight spaces like the PIN login screen's top
 *   bar); full mode (default) also shows address + phones.
 */
export async function renderCollegeHeader(container, options = {}) {
  if (!container) return;
  const compact = !!options.compact;

  container.innerHTML = `
    <div class="college-header college-header--loading">
      <div class="college-header__name">Loading college info…</div>
    </div>
  `;

  let college;
  try {
    college = await fetchCollege();
  } catch (err) {
    container.innerHTML = `
      <div class="college-header college-header--error">
        <div class="college-header__name">Kongu Hi-Tek Polytechnic College</div>
        <div class="college-header__sub">Could not load latest details (offline?) — showing cached name only.</div>
      </div>
    `;
    return;
  }

  if (!college) {
    container.innerHTML = `
      <div class="college-header college-header--error">
        <div class="college-header__name">College info not set up yet</div>
        <div class="college-header__sub">Ask an admin to run the Excel import (P2) to populate this.</div>
      </div>
    `;
    return;
  }

  const phoneList = (college.phones || []).filter((p) => p && p.digits);
  const phonesHtml = phoneList.length
    ? `<div class="college-header__phones">${phoneList.map((p) => `<span class="college-header__phone" style="white-space:nowrap;">${escapeHtml(formatPhone(p.digits))}</span>`).join('<span class="college-header__phone-sep">|</span>')}</div>`
    : "";
  const websiteHtml = !compact && college.website
    ? `<div class="college-header__website">${escapeHtml(college.website)}</div>`
    : "";
  const logoHtml = college.logoDataUrl
    ? `<img class="college-header__logo${compact ? " college-header__logo--compact" : ""}" src="${college.logoDataUrl}" alt="${escapeHtml(college.name || "College logo")}" />`
    : "";

  container.innerHTML = `
    <div class="college-header${compact ? " college-header--compact" : ""}">
      ${logoHtml}
      <div class="college-header__text">
        <div class="college-header__name">${escapeHtml(college.name || "")}</div>
        ${!compact && college.address ? `<div class="college-header__sub">${escapeHtml(college.address)}</div>` : ""}
        ${!compact ? phonesHtml : ""}
        ${websiteHtml}
      </div>
    </div>
  `;
}

/** Clears the in-memory cache — call after an admin edits college info
 * (P7's college info editor) so the next render picks up fresh data
 * instead of the stale cached copy. */
export function invalidateCollegeCache() {
  cachedCollege = null;
  inFlightFetch = null;
}

function formatPhone(digits) {
  if (digits.length !== 10) return digits;
  return `${digits.slice(0, 5)} ${digits.slice(5)}`;
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}
