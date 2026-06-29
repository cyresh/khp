// shared/firestore-commit.js
//
// Batched Firestore writer for the Excel import pipeline (P2/P7).
// Takes the already-parsed/diffed output of excel-import.js and
// performs the actual writes, chunked to Firestore's 500-operations-
// per-batch limit, reporting progress via a callback so the UI can
// show a progress bar.
//
// Deliberately kept separate from excel-import.js: that module is
// pure parsing/transformation with no Firebase dependency, which
// keeps it unit-testable in plain Node. This module is the seam that
// actually talks to Firestore.

import { db } from "./firebase-init.js";
import {
  doc,
  writeBatch,
  getDocs,
  collection,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const MAX_OPS_PER_BATCH = 500;

/**
 * Fetches all current students from Firestore as a Map keyed by
 * regNo, suitable for passing into excel-import.js's
 * diffAgainstExisting(). Call this BEFORE parsing the new workbook so
 * the diff reflects what's truly live right now.
 */
export async function fetchExistingStudents() {
  const snap = await getDocs(collection(db, "students"));
  const map = new Map();
  snap.forEach((docSnap) => {
    map.set(docSnap.id, { regNo: docSnap.id, ...docSnap.data() });
  });
  return map;
}

/**
 * Builds a flat list of write operations from the parsed import
 * result and (for a re-upload) the diff against existing data. Pure
 * function — no Firestore calls — so the admin preview screen can
 * call this to get an exact operation count before committing.
 *
 * @param {object} parsed - output of excel-import.js's parseWorkbook()
 * @param {{added:object[], updated:object[], removed:object[]}|null} diff
 *   - output of diffAgainstExisting(), or null for a first-time import
 *     (no existing data to diff against — everything is "added").
 * @returns {Array<{type: string, path: string, data: object|null}>}
 */
export function buildWritePlan(parsed, diff) {
  const ops = [];

  // --- college/main (merge, not overwrite) ---
  // The Excel sheet only ever carries name/address/phones — it has no
  // concept of a logo or website, both of which are set separately
  // from the admin panel's College Info tab. A plain overwrite here
  // would silently wipe those fields out on every re-import, so this
  // op is flagged merge: true to only touch the three fields the
  // sheet actually owns.
  if (parsed.college) {
    ops.push({
      type: "set",
      collection: "college",
      id: "main",
      merge: true,
      data: {
        name: parsed.college.name,
        address: parsed.college.address,
        phones: parsed.college.phones,
        updatedAt: "__serverTimestamp__",
      },
    });
  }

  // --- buses/{busId} (always a full overwrite of each bus doc) ---
  for (const bus of parsed.buses) {
    ops.push({
      type: "set",
      collection: "buses",
      id: bus.busId,
      data: {
        label: bus.label,
        driver: bus.driver,
        incharge: bus.incharge,
        stops: bus.stops,
        updatedAt: "__serverTimestamp__",
        ...(bus.capacity != null ? { capacity: bus.capacity } : {}),
      },
    });
  }

  // --- classes/{classId} (always a full overwrite, fully derived) ---
  // classCapacities from Sheet 3 take precedence over any existing value.
  const capMap = parsed.classCapacities || {};
  for (const cls of parsed.classes) {
    const cap = capMap[cls.classId];
    ops.push({
      type: "set",
      collection: "classes",
      id: cls.classId,
      data: {
        year: cls.year,
        course: cls.course,
        studentCount: cls.studentCount,
        updatedAt: "__serverTimestamp__",
        ...(cap != null ? { capacity: cap } : {}),
      },
    });
  }

  // --- students/{regNo} ---
  if (diff) {
    // Re-upload path: only touch what actually changed.
    for (const student of diff.added) {
      ops.push({ type: "set", collection: "students", id: student.regNo, data: studentDocData(student, true) });
    }
    for (const u of diff.updated) {
      ops.push({ type: "set", collection: "students", id: u.regNo, data: studentDocData(u.after, true) });
    }
    for (const removedStudent of diff.removed) {
      // Soft-delete: never hard-remove (rules also enforce this), so
      // attendance history stays meaningful.
      ops.push({
        type: "update",
        collection: "students",
        id: removedStudent.regNo,
        data: { active: false, removedAt: "__serverTimestamp__" },
      });
    }
  } else {
    // First-time import: every parsed student is a new doc.
    for (const student of parsed.students) {
      ops.push({ type: "set", collection: "students", id: student.regNo, data: studentDocData(student, true) });
    }
  }

  return ops;
}

function studentDocData(student, active) {
  return {
    ...student,
    active,
    importedAt: "__serverTimestamp__",
  };
}

/**
 * Executes a write plan (from buildWritePlan) against Firestore in
 * chunks of at most MAX_OPS_PER_BATCH operations, reporting progress.
 *
 * @param {Array} ops - output of buildWritePlan()
 * @param {(progress: {completed:number, total:number, currentChunk:number, totalChunks:number}) => void} onProgress
 * @returns {Promise<{opsWritten: number, chunksWritten: number}>}
 */
export async function commitWritePlan(ops, onProgress) {
  const total = ops.length;
  if (total === 0) {
    onProgress?.({ completed: 0, total: 0, currentChunk: 0, totalChunks: 0 });
    return { opsWritten: 0, chunksWritten: 0 };
  }

  const chunks = [];
  for (let i = 0; i < ops.length; i += MAX_OPS_PER_BATCH) {
    chunks.push(ops.slice(i, i + MAX_OPS_PER_BATCH));
  }

  let completed = 0;
  for (let i = 0; i < chunks.length; i++) {
    const batch = writeBatch(db);
    for (const op of chunks[i]) {
      const ref = doc(db, op.collection, String(op.id));
      const data = resolveServerTimestamps(op.data);
      if (op.type === "set") {
        batch.set(ref, data, op.merge ? { merge: true } : undefined);
      } else if (op.type === "update") {
        batch.update(ref, data);
      } else {
        throw new Error(`Unknown write op type: ${op.type}`);
      }
    }
    await batch.commit();
    completed += chunks[i].length;
    onProgress?.({
      completed,
      total,
      currentChunk: i + 1,
      totalChunks: chunks.length,
    });
  }

  return { opsWritten: completed, chunksWritten: chunks.length };
}

// Write-plan data uses the placeholder string "__serverTimestamp__"
// instead of calling serverTimestamp() directly, so buildWritePlan()
// can stay a pure, Firestore-import-free function (testable in plain
// Node without pulling in the Firestore SDK). This swaps the real
// sentinel in right before writing.
function resolveServerTimestamps(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === "__serverTimestamp__") {
      out[k] = serverTimestamp();
    } else if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      out[k] = resolveServerTimestamps(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Convenience top-level orchestrator: fetches existing students,
 * computes the diff, builds the write plan, and commits it. Returns
 * everything the admin preview/result screen would want to show.
 *
 * For the actual P2/P7 UI flow, you'll likely call fetchExistingStudents
 * + parseWorkbook + diffAgainstExisting + buildWritePlan yourself to
 * show the preview BEFORE committing (so the admin can review/resolve
 * needs_review items first), then call commitWritePlan separately once
 * they confirm. This function is provided for simpler call sites (e.g.
 * the bootstrap first-import flow, which has no existing data and no
 * need for a review step beyond the diagnostics already in `parsed`).
 */
export async function importFreshNoReview(parsed, onProgress) {
  const ops = buildWritePlan(parsed, null);
  return commitWritePlan(ops, onProgress);
}
