// shared/attendance.js
//
// Shared attendance record logic — building deterministic document
// IDs, fetching/sorting rosters for a given scope, and loading/saving
// attendanceRecords documents. Used by the marker app (P4/P5) and
// will be reused by the admin app's daily/monthly views (P6) so the
// doc ID scheme and record shape stay identical everywhere rather
// than duplicated and risking drift.
//
// Document shape (attendanceRecords/{recordId}):
//   {
//     category: "bus" | "hostel" | "class",
//     scopeId: string,        // busId, "hostel_main", or classId
//     date: "YYYY-MM-DD",
//     session: "morning" | "evening" | null,  // null for class (no session)
//     records: [{ regNo, name, status: "present"|"absent", remarks: string|null,
//                 markedBy: { uid, name, staffId } | null }],
//     presentCount: number,
//     absentCount: number,
//     totalCount: number,
//     locked: boolean,
//     markedBy: { uid, name, staffId },  // whoever made the most recent save
//     createdAt, updatedAt: server timestamps,
//   }
//
// MULTI-MARKER NOTE: bus and hostel scopes can be assigned to more
// than one marker (see admin/user-manager.js). For those two
// categories, saveRecord() merges incoming rows into the existing
// record by regNo instead of overwriting the whole document, so two
// markers working the same bus/hostel extend each other's submission
// rather than one wiping out the other. Each row's `markedBy` tracks
// whoever last touched that specific student. "class" is unchanged
// (single marker assumed) — revisit if classes ever get co-markers.

import { db } from "./firebase-init.js";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  getDocs,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/**
 * Builds the deterministic attendanceRecords document ID for a given
 * category/scope/date/session. Class records omit the session
 * segment entirely (single daily attendance, no morning/evening
 * split) per the product decision for this phase.
 *
 * scopeId values for bus/hostel already carry their category as a
 * prefix (e.g. "bus_11", "hostel_main"), so we avoid doubling it
 * (e.g. NOT "bus_bus_11_...") by stripping that prefix from scopeId
 * specifically when building the ID, while still storing the full
 * original scopeId in the document's own `scopeId` field unchanged.
 */
export function buildRecordId({ category, scopeId, date }) {
  // Session has been removed: all categories (bus, hostel, class)
  // now produce a single per-day record with no morning/evening split.
  const scopePart = scopeId.startsWith(`${category}_`) ? scopeId.slice(category.length + 1) : scopeId;
  return `${category}_${scopePart}_${date}`;
}

/** Today's date as YYYY-MM-DD in the LOCAL timezone (not UTC — using
 * toISOString() directly would shift the date around midnight for
 * users in IST, which is exactly when a marker doing the evening
 * session is most likely to be using this). */
export function todayLocalDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Fetches the roster (list of active students) for a given
 * category+scopeId, sorted according to P4's spec:
 *   - bus: grouped by stop number ascending, alphabetical by name
 *     within each stop. Returns { stopNo, stopName, students: [...] }[]
 *   - hostel / class: flat list, alphabetical by name.
 *
 * @returns for bus: { groups: Array<{stopNo, stopName, students}> }
 *          for hostel/class: { students: Array<student> }
 */
export async function fetchRoster({ category, scopeId }) {
  const studentsCol = collection(db, "students");
  let q;
  if (category === "bus") {
    q = query(studentsCol, where("busId", "==", scopeId), where("active", "==", true));
  } else if (category === "hostel") {
    q = query(studentsCol, where("category", "==", "hostel"), where("active", "==", true));
  } else if (category === "class") {
    q = query(studentsCol, where("classId", "==", scopeId), where("active", "==", true));
  } else {
    throw new Error(`Unknown category "${category}"`);
  }

  const snap = await getDocs(q);
  const students = [];
  snap.forEach((d) => students.push({ regNo: d.id, ...d.data() }));

  if (category === "bus") {
    return { groups: groupByStop(students) };
  }

  students.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return { students };
}

function groupByStop(students) {
  const byStop = new Map();
  for (const s of students) {
    const key = s.stopNo ?? -1; // unresolved-stop students sort first as a visible edge case, not silently dropped
    if (!byStop.has(key)) {
      byStop.set(key, { stopNo: s.stopNo, stopName: s.stopName || "(unresolved stop)", students: [] });
    }
    byStop.get(key).students.push(s);
  }
  const groups = Array.from(byStop.values());
  groups.sort((a, b) => (a.stopNo ?? -1) - (b.stopNo ?? -1));
  for (const g of groups) {
    g.students.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }
  return groups;
}

/**
 * Loads an existing attendance record, if one exists, for the given
 * scope/date/session. Returns null if none exists yet (caller should
 * then default everyone to Present and treat this as a fresh entry).
 */
export async function loadRecord({ category, scopeId, date }) {
  const recordId = buildRecordId({ category, scopeId, date });
  const snap = await getDoc(doc(db, "attendanceRecords", recordId));
  return snap.exists() ? { id: recordId, ...snap.data() } : null;
}

/**
 * Saves (creates or overwrites) an attendance record. Throws if the
 * existing record is locked and the current user isn't an admin —
 * mirrors the Firestore rule so the UI can show a friendly error
 * instead of a raw permission-denied exception bubbling up, though
 * the rule is still the actual enforcement point.
 *
 * MULTI-MARKER SCOPES (bus / hostel): admin can now assign more than
 * one marker to the same bus or hostel (e.g. two staff on a large
 * bus, two wardens splitting a hostel). To support that without one
 * marker's save wiping out another's, bus/hostel records are merged
 * by regNo rather than replaced wholesale — each student row keeps
 * whichever version of itself was written most recently, and rows
 * untouched by the current save simply carry over from the existing
 * record. "class" keeps the previous whole-record overwrite behavior
 * (single-teacher-per-class is still the assumed case there; revisit
 * if that changes).
 *
 * @param {object} existingRecord - result of loadRecord(), or null
 * @param {boolean} isCurrentUserAdmin
 */
export async function saveRecord(
  { category, scopeId, date, session, records, markedBy },
  existingRecord,
  isCurrentUserAdmin
) {
  if (existingRecord && existingRecord.locked && !isCurrentUserAdmin) {
    throw new Error("This record is locked and can no longer be edited. Ask an admin if a correction is needed.");
  }

  const recordId = buildRecordId({ category, scopeId, date });

  let finalRecords = records;
  if ((category === "bus" || category === "hostel") && existingRecord?.records?.length) {
    finalRecords = mergeRecordsByRegNo(existingRecord.records, records, markedBy);
  } else {
    // Fresh record or class category: stamp who marked each row so
    // a later merge (if this scope ever gains a second marker) has
    // per-row attribution to work from.
    finalRecords = records.map((r) => ({ ...r, markedBy: markedBy || r.markedBy || null }));
  }

  const presentCount = finalRecords.filter((r) => r.status === "present").length;
  const absentCount = finalRecords.filter((r) => r.status === "absent").length;

  const payload = {
    category,
    scopeId,
    date,
    session: null,  // sessions disabled — single daily record for all categories
    records: finalRecords,
    presentCount,
    absentCount,
    totalCount: finalRecords.length,
    locked: existingRecord?.locked || false,
    markedBy,
    updatedAt: serverTimestamp(),
  };
  if (!existingRecord) {
    payload.createdAt = serverTimestamp();
  }

  await setDoc(doc(db, "attendanceRecords", recordId), payload, { merge: true });
  return recordId;
}

/**
 * Merges two `records` arrays (shape: { regNo, name, status, remarks })
 * keyed by regNo. `incoming` wins per-row over `base` — this is
 * "last save wins per student", not per whole document — and any row
 * present in `base` but absent from `incoming` (shouldn't normally
 * happen, since the marker app always submits the full roster, but
 * guards against a partial-roster caller) is kept as-is so no student
 * silently drops off the record. Each row gets stamped with who most
 * recently touched it, so the admin dashboard can show contributions
 * from multiple markers on the same bus/hostel.
 */
function mergeRecordsByRegNo(base, incoming, markedBy) {
  const byRegNo = new Map(base.map((r) => [r.regNo, r]));
  for (const row of incoming) {
    byRegNo.set(row.regNo, { ...row, markedBy: markedBy || null });
  }
  return Array.from(byRegNo.values());
}

// ----------------------------------------------------------------
// Holidays
// ----------------------------------------------------------------
//
// Document shape (holidays/{category}_{date}):
//   {
//     category: "bus" | "hostel" | "class",
//     date: "YYYY-MM-DD",
//     label: string|null,       // e.g. "Pongal" — optional, for display only
//     createdBy: { uid, name, staffId },
//     createdAt: server timestamp,
//   }
//
// Holidays are set per CATEGORY, not per individual scope — the
// product decision here is that e.g. all classes are off together,
// but buses or the hostel might still run that same day, so each
// category gets its own independent holiday calendar. Doc ID is
// deterministic ("bus_2026-06-20") so "is today a holiday for this
// marker's category" is a single getDoc, no query needed — that
// check has to be fast since it gates the PIN-keypad roster screen.

export function buildHolidayId({ category, date }) {
  return `${category}_${date}`;
}

/**
 * Returns the holiday doc ({ label, ... }) if `date` is a holiday
 * for `category`, otherwise null. Used by the marker app to block
 * attendance marking on a holiday.
 */
export async function getHoliday({ category, date }) {
  const snap = await getDoc(doc(db, "holidays", buildHolidayId({ category, date })));
  return snap.exists() ? snap.data() : null;
}

/** Admin-only: mark (or relabel) a holiday for a category+date. */
export async function setHoliday({ category, date, label, createdBy }) {
  const id = buildHolidayId({ category, date });
  await setDoc(doc(db, "holidays", id), {
    category,
    date,
    label: label || null,
    createdBy,
    createdAt: serverTimestamp(),
  });
  return id;
}

/** Admin-only: remove a previously-marked holiday. */
export async function deleteHoliday({ category, date }) {
  await deleteDoc(doc(db, "holidays", buildHolidayId({ category, date })));
}

/**
 * Fetches all holidays for a category within a given month, keyed
 * by day-of-month (1-31) for O(1) lookup while rendering a monthly
 * grid. Filters client-side by date prefix rather than a Firestore
 * range query — same pattern loadMonthlyReport() already uses for
 * attendanceRecords, so no extra composite index is needed.
 *
 * @returns Map<dayNumber, { label: string|null }>
 */
export async function fetchHolidaysForMonth({ category, year, month }) {
  const padM = String(month).padStart(2, "0");
  const monthPrefix = `${year}-${padM}-`;
  const snap = await getDocs(query(collection(db, "holidays"), where("category", "==", category)));
  const map = new Map();
  snap.forEach((d) => {
    const data = d.data();
    if (data.date?.startsWith(monthPrefix)) {
      map.set(Number(data.date.slice(8)), { label: data.label || null });
    }
  });
  return map;
}

/** Fetches ALL holidays for a category, sorted by date ascending.
 * Used by the admin Holidays management screen (full list + delete),
 * as opposed to fetchHolidaysForMonth() which is scoped to one month
 * for grid rendering. */
export async function fetchAllHolidays({ category }) {
  const snap = await getDocs(query(collection(db, "holidays"), where("category", "==", category)));
  const list = [];
  snap.forEach((d) => list.push(d.data()));
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return list;
}
