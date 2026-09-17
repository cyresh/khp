// shared/usage-stats.js
//
// "Who is using the app, and how often" — for the admin Activity
// screen. One doc per successful sign-in (PIN or biometric), on
// EITHER app (marker or admin), since the logging hook lives in
// shared/auth.js which both apps go through. At this scale (a
// few dozen staff, a handful of logins each per day) it's cheap
// enough to just read every event in the selected range and
// aggregate client-side rather than maintaining running counters.
//
// Document shape (loginEvents/{auto-id}):
//   {
//     uid, staffId, name, role, category,
//     method: "pin" | "biometric",
//     dateKey: "YYYY-MM-DD",   // local date, same convention as
//                               // attendance.js's todayLocalDate()
//     at: server timestamp,
//   }
//
// Write-only from the signed-in user's own uid; only an admin can
// read the collection back (enforced in firestore.rules). No update
// or delete — this is an append-only audit trail.

import { db } from "./firebase-init.js";
import {
  collection,
  addDoc,
  query,
  where,
  orderBy,
  getDocs,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

function dateKeyFor(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Fire-and-forget: logs a successful sign-in. Deliberately never
 * awaited by callers and never throws — a missed stats entry is a
 * rounding error, but letting a stats write block or fail a real
 * login would turn a nice-to-have into an outage.
 */
export function logLoginEvent({ uid, profile, method }) {
  addDoc(collection(db, "loginEvents"), {
    uid,
    staffId: profile?.staffId || null,
    name: profile?.name || null,
    role: profile?.role || "marker",
    category: profile?.category || null,
    method,
    dateKey: dateKeyFor(new Date()),
    at: serverTimestamp(),
  }).catch(() => {});
}

/**
 * Admin-only: every login event with dateKey in [fromKey, toKey]
 * (inclusive). Single-field range + matching orderBy, so this never
 * needs a composite index. Callers aggregate as needed.
 */
export async function fetchLoginEvents(fromKey, toKey) {
  const q = query(
    collection(db, "loginEvents"),
    where("dateKey", ">=", fromKey),
    where("dateKey", "<=", toKey),
    orderBy("dateKey")
  );
  const snap = await getDocs(q);
  const events = [];
  snap.forEach((d) => events.push(d.data()));
  return events;
}

/**
 * YYYY-MM-DD bounds for the three range presets the Activity screen
 * offers. "week" is a rolling 7 days (today + 6 back), "month" is
 * calendar-month-to-date — both deliberately simple rather than
 * ISO week/ ends-of-month, since the admin just wants a general
 * sense of recent usage, not payroll-grade reporting.
 */
export function rangeKeys(preset) {
  const now = new Date();
  const todayKey = dateKeyFor(now);
  if (preset === "today") return { fromKey: todayKey, toKey: todayKey };
  if (preset === "week") {
    const from = new Date(now);
    from.setDate(from.getDate() - 6);
    return { fromKey: dateKeyFor(from), toKey: todayKey };
  }
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  return { fromKey: dateKeyFor(from), toKey: todayKey };
}

/** Every YYYY-MM-DD key between fromKey and toKey inclusive — used to
 * zero-fill the daily trend so a quiet day shows as 0, not a gap. */
export function keysInRange(fromKey, toKey) {
  const keys = [];
  const [fy, fm, fd] = fromKey.split("-").map(Number);
  const [ty, tm, td] = toKey.split("-").map(Number);
  const cursor = new Date(fy, fm - 1, fd);
  const end = new Date(ty, tm - 1, td);
  while (cursor <= end) {
    keys.push(dateKeyFor(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

/**
 * Turns raw events into what the Activity screen renders: a
 * per-user summary (sorted busiest-first) and a zero-filled daily
 * total trend across the range.
 */
export function aggregateLoginEvents(events, fromKey, toKey) {
  const byUser = new Map();
  const dailyTotals = new Map(keysInRange(fromKey, toKey).map((k) => [k, 0]));

  for (const ev of events) {
    dailyTotals.set(ev.dateKey, (dailyTotals.get(ev.dateKey) || 0) + 1);
    const atMs = ev.at?.toMillis?.() || 0;

    const existing = byUser.get(ev.uid);
    if (!existing) {
      byUser.set(ev.uid, {
        uid: ev.uid,
        name: ev.name,
        staffId: ev.staffId,
        role: ev.role,
        category: ev.category,
        count: 1,
        lastAtMs: atMs,
      });
    } else {
      existing.count += 1;
      if (atMs > existing.lastAtMs) existing.lastAtMs = atMs;
    }
  }

  const users = Array.from(byUser.values()).sort((a, b) => b.count - a.count);
  const daily = Array.from(dailyTotals.entries()).map(([dateKey, count]) => ({ dateKey, count }));
  return { users, daily, totalEvents: events.length, activeUserCount: users.length };
}
