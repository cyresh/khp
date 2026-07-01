// admin/db-manager.js
//
// P7: Admin app — database management screens.
//
// Mounted by admin/app.js when the user taps "Database" in the nav.
// Four sub-sections accessed via a sidebar/tab list:
//
//   📥 Excel Import  — re-upload workbook, preview diff, commit
//   👤 Students      — search, view, add, edit, deactivate
//   🚌 Buses         — edit driver/incharge info and stop list
//   🏫 College       — edit name, address, phones
//
// This module is entirely self-contained: it imports from shared
// utilities but does not modify app.js's nav or state.

import { db, auth } from "../shared/firebase-init.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { parseWorkbook, diffAgainstExisting } from "../shared/excel-import.js";
import { invalidateCollegeCache } from "../shared/college-header.js";
import {
  buildWritePlan,
  fetchExistingClasses,
  commitWritePlan,
  fetchExistingStudents,
} from "../shared/firestore-commit.js";
import { fetchAllHolidays, setHoliday, deleteHoliday, todayLocalDate } from "../shared/attendance.js";

const SHEETJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
let sheetJsLoaded = false;
let sheetJsPromise = null;

function loadSheetJs() {
  if (sheetJsLoaded) return Promise.resolve();
  if (sheetJsPromise) return sheetJsPromise;
  sheetJsPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SHEETJS_CDN;
    s.onload = () => { sheetJsLoaded = true; resolve(); };
    s.onerror = () => reject(new Error("Failed to load SheetJS from CDN"));
    document.head.appendChild(s);
  });
  return sheetJsPromise;
}

// ----------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------

export function mountDbManager(container) {
  let activeSection = "import";

  const sections = [
    { id: "import",   label: "📥 Excel Import" },
    { id: "students", label: "👤 Students" },
    { id: "buses",    label: "🚌 Buses" },
    { id: "capacity", label: "📐 Capacity" },
    { id: "holidays", label: "🗓️ Holidays" },
    { id: "college",  label: "🏫 College" },
  ];

  function render() {
    container.innerHTML = `
      <div class="page page--wide">
        <div class="db-layout">
          <nav class="db-sidenav">
            ${sections.map((s) => `
              <button class="db-sidenav__btn ${activeSection === s.id ? "db-sidenav__btn--active" : ""}"
                data-section="${s.id}">${s.label}</button>
            `).join("")}
          </nav>
          <div class="db-content" id="db-content">
            <p class="status">Loading…</p>
          </div>
        </div>
      </div>
    `;

    container.querySelectorAll(".db-sidenav__btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeSection = btn.dataset.section;
        render();
      });
    });

    const content = container.querySelector("#db-content");
    if (activeSection === "import")  mountImportSection(content);
    if (activeSection === "students") mountStudentsSection(content);
    if (activeSection === "buses")   mountBusesSection(content);
    if (activeSection === "capacity") mountCapacitySection(content);
    if (activeSection === "holidays") mountHolidaysSection(content);
    if (activeSection === "college")  mountCollegeSection(content);
  }

  render();
}

// ================================================================
// SECTION 1: Excel Import
// ================================================================

function formatSavedAt(date) {
  const d = date instanceof Date ? date : new Date(date.seconds ? date.seconds * 1000 : date);
  return d.toLocaleDateString("en-IN", { day:"2-digit", month:"short", year:"numeric" })
    + " at " + d.toLocaleTimeString("en-IN", { hour:"2-digit", minute:"2-digit", hour12:true });
}

async function loadSavedImportStats(container) {
  if (!container) return;
  try {
    container.innerHTML = '<p class="status" style="padding:var(--space-3) 0; font-size:0.8rem;">Loading last import summary…</p>';
    const snap = await getDoc(doc(db, "meta", "lastImportStats"));
    if (!snap.exists()) { container.innerHTML = ""; return; }
    const d = snap.data();
    container.innerHTML = renderSavedStats(d);
  } catch(_) { container.innerHTML = ""; /* non-fatal */ }
}

function renderSavedStats(d) {
  const ok = !d.mismatches || d.mismatches.length === 0;
  const savedAt = d.savedAt?.toDate ? d.savedAt.toDate() : new Date();
  const YEAR_LABEL = { first:"I Year", second:"II Year", third:"III Year", fourth:"IV Year" };
  const YEAR_ORDER = ["first","second","third","fourth"];
  const byYear = d.byYear || {};
  const busList = Object.entries(d.busList || {}).sort(([a],[b]) => a.localeCompare(b,undefined,{numeric:true}));
  const hostelList = Object.entries(d.hostelList || {});
  const classList = Object.entries(d.classList || {}).sort(([a],[b]) => a.localeCompare(b));
  const transportSum = (d.byBus||0) + (d.byHostel||0) + (d.byOwn||0);
  const yearSum = Object.values(byYear).reduce((a,b)=>a+b,0);
  const classSum = classList.reduce((a,[,v])=>a+v,0);

  const badge = (n, lbl) =>
    `<div class="ist-badge"><span class="ist-badge__num">${n}</span><span class="ist-badge__label">${lbl}</span></div>`;
  const tRow = (label, val, cls) =>
    `<tr class="${cls||""}"><td>${escapeHtml(String(label))}</td><td class="ist-num">${val}</td></tr>`;

  const diff = d.diffSummary || {};

  return `
    <div id="last-import-stats" style="margin-top:var(--space-5);">
      <div class="ist-saved-tag">
        📅 Last import: ${escapeHtml(formatSavedAt(savedAt))}
        ${diff.added!=null ? ` &nbsp;·&nbsp; +${diff.added} added, ${diff.updated} updated, ${diff.removed} deactivated` : ""}
      </div>
      <div class="ist-wrap">
        <div class="ist-header">
          <span class="ist-title">Import Summary</span>
          ${ok
            ? `<span class="ist-pill ist-pill--ok">✓ All totals match</span>`
            : `<span class="ist-pill ist-pill--err">⚠ ${d.mismatches.length} mismatch${d.mismatches.length>1?"es":""}</span>`}
        </div>
        ${!ok ? `<div class="ist-alert"><strong>Discrepancies from last import:</strong>
          <ul>${d.mismatches.map(m=>`<li>${escapeHtml(m)}</li>`).join("")}</ul></div>` : ""}
        <div class="ist-grand">
          ${badge(d.grand||0, "Total Students")}
          ${badge(d.byBus||0, "🚌 Bus")}
          ${badge(d.byHostel||0, "🏠 Hostel")}
          ${badge(d.byOwn||0, "🚗 Own Vehicle")}
        </div>
        <table class="ist-table" style="margin-top:var(--space-3);">
          <thead><tr><th>Year</th><th class="ist-num">Students</th></tr></thead>
          <tbody>
            ${YEAR_ORDER.filter(y=>byYear[y]).map(y=>tRow(YEAR_LABEL[y]||y, byYear[y])).join("")}
            ${Object.entries(byYear).filter(([y])=>!YEAR_ORDER.includes(y)).map(([y,n])=>tRow(y,n,"ist-muted")).join("")}
            <tr class="ist-total-row"><td>Total</td><td class="ist-num">${yearSum}</td></tr>
          </tbody>
        </table>
        <details class="ist-details" open>
          <summary class="ist-details__summary">🚌 Bus / 🏠 Hostel / 🚗 Own Vehicle breakdown</summary>
          <table class="ist-table">
            <thead><tr><th>Scope</th><th class="ist-num">Students</th></tr></thead>
            <tbody>
              <tr class="ist-group-row"><td colspan="2">Buses</td></tr>
              ${busList.map(([id,n])=>tRow(id,n)).join("")}
              <tr class="ist-sub-total"><td>Bus subtotal</td><td class="ist-num">${d.byBus||0}</td></tr>
              <tr class="ist-group-row"><td colspan="2">Hostel</td></tr>
              ${hostelList.map(([t,n])=>tRow(t+" Hostel",n)).join("")}
              <tr class="ist-sub-total"><td>Hostel subtotal</td><td class="ist-num">${d.byHostel||0}</td></tr>
              <tr class="ist-group-row"><td colspan="2">Own Vehicle</td></tr>
              ${tRow("Own Vehicle", d.byOwn||0)}
              <tr class="ist-total-row"><td>Grand total</td><td class="ist-num">${transportSum}</td></tr>
            </tbody>
          </table>
        </details>
        <details class="ist-details">
          <summary class="ist-details__summary">🎓 Class-wise breakdown</summary>
          <table class="ist-table">
            <thead><tr><th>Class</th><th class="ist-num">Students</th></tr></thead>
            <tbody>
              ${classList.map(([id,n])=>tRow(id.replace(/_/g," ").toUpperCase(),n)).join("")}
              <tr class="ist-total-row"><td>Total</td><td class="ist-num">${classSum}</td></tr>
            </tbody>
          </table>
        </details>
      </div>
    </div>
  `;
}

function mountImportSection(el) {
  // Multi-step: drop → parse → preview → resolve mismatches → commit → done
  let step = "upload"; // "upload" | "preview" | "commit" | "done"
  let parsed = null;
  let diff = null;
  let existingClassIds = null;
  let resolvedMismatches = {}; // regNo → chosen stopNo

  renderUpload();

  function renderUpload() {
    el.innerHTML = `
      <h3>Excel Re-upload</h3>
      <p class="status">Upload the updated Bus Stop List Excel workbook. Changes are shown for review before anything is written to Firestore.</p>

      <div class="dropzone" id="dropzone" tabindex="0" role="button"
        aria-label="Drop Excel file here or click to browse">
        <div class="dropzone__icon">📂</div>
        <p class="dropzone__text">Drop the Excel file here<br><span>or click to browse</span></p>
        <input type="file" id="file-input" accept=".xlsx,.xls" style="display:none" />
      </div>

      <div id="import-msg"></div>
      <div id="last-import-stats-container"></div>
    `;
    // Load saved stats into placeholder after DOM is ready
    loadSavedImportStats(el.querySelector("#last-import-stats-container"));

    const dropzone = el.querySelector("#dropzone");
    const fileInput = el.querySelector("#file-input");
    const msgEl    = el.querySelector("#import-msg");

    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });

    dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dropzone--over"); });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dropzone--over"));
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("dropzone--over");
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file, msgEl);
    });

    fileInput.addEventListener("change", () => {
      if (fileInput.files[0]) handleFile(fileInput.files[0], msgEl);
    });
  }

  async function handleFile(file, msgEl) {
    msgEl.innerHTML = `<p class="status">Parsing workbook…</p>`;
    try {
      await loadSheetJs();
      const buffer = await file.arrayBuffer();
      const workbook = window.XLSX.read(buffer, { type: "array" });

      parsed = parseWorkbook(workbook);

      // Fetch existing students for diff
      msgEl.innerHTML = `<p class="status">Comparing with existing data…</p>`;
      const existingMap = await fetchExistingStudents();
      diff = diffAgainstExisting(parsed.students, existingMap);
      existingClassIds = await fetchExistingClasses();

      // Pre-populate resolved mismatches with best-guess
      resolvedMismatches = {};
      for (const d of parsed.diagnostics.needsReview || []) {
        if (d.bestGuess) resolvedMismatches[d.regNo] = d.bestGuess.stopNo;
      }

      step = "preview";
      renderPreview();
    } catch (err) {
      msgEl.innerHTML = `<div class="msg msg--err">Parse error: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderPreview() {
    const needsReview = parsed.diagnostics.needsReview || [];
    const warnings    = parsed.diagnostics.warnings || [];

    el.innerHTML = `
      <div class="preview-header">
        <h3>Preview Changes</h3>
        <button class="btn btn--secondary" id="back-to-upload">← Re-upload</button>
      </div>

      ${warnings.length ? `
        <div class="msg msg--warn" style="margin-bottom:var(--space-4);">
          <strong>Warnings (${warnings.length})</strong>
          <ul style="margin:var(--space-2) 0 0 var(--space-4);">
            ${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}
          </ul>
        </div>
      ` : ""}

      ${needsReview.length ? `
        <div class="card" style="margin-bottom:var(--space-4);">
          <h4 style="color:var(--color-warning-text); margin-bottom:var(--space-3);">
            ⚠ ${needsReview.length} Unresolved Stop ${needsReview.length === 1 ? "Mismatch" : "Mismatches"}
          </h4>
          <p class="status" style="margin-bottom:var(--space-3);">
            These students' stop names don't exactly match the stop list.
            A best guess is pre-selected — review and confirm.
          </p>
          <div id="mismatch-list">
            ${needsReview.map((d) => `
              <div class="mismatch-item" data-regno="${escapeHtml(d.regNo)}">
                <div class="mismatch-item__student">
                  <strong>${escapeHtml(d.name)}</strong>
                  <span class="status" style="display:inline;margin:0;">${escapeHtml(d.regNo)}</span>
                  — Raw stop: "${escapeHtml(d.rawStopName)}"
                </div>
                <select class="report-controls__input mismatch-select" data-regno="${escapeHtml(d.regNo)}">
                  ${(d.candidates || []).map((c) => `
                    <option value="${c.stopNo}"
                      ${resolvedMismatches[d.regNo] === c.stopNo ? "selected" : ""}>
                      Stop ${c.stopNo} — ${escapeHtml(c.stopName)} (score: ${c.score})
                    </option>
                  `).join("")}
                  <option value="__skip__" ${!resolvedMismatches[d.regNo] ? "selected" : ""}>
                    Skip (don't import this student's stop)
                  </option>
                </select>
              </div>
            `).join("")}
          </div>
        </div>
      ` : ""}

      <div class="diff-summary card" style="margin-bottom:var(--space-4);">
        <h4 style="margin-bottom:var(--space-3);">Changes to Students</h4>
        <div class="diff-counts">
          <span class="diff-count diff-count--added">+${diff.added.length} new</span>
          <span class="diff-count diff-count--updated">~${diff.updated.length} updated</span>
          <span class="diff-count diff-count--removed">−${diff.removed.length} removed</span>
        </div>

        ${diff.added.length ? renderDiffTable("New students", diff.added.map((s) => [s.regNo, s.name, s.classId, s.busId || "—"])) : ""}
        ${diff.updated.length ? renderUpdatedTable(diff.updated) : ""}
        ${diff.removed.length ? renderDiffTable("Removed students (will be deactivated, not deleted)", diff.removed.map((s) => [s.regNo, s.name, s.classId, s.busId || "—"])) : ""}
      </div>

      <div class="summary-actions">
        <button class="btn" id="commit-btn">
          ✅ Commit ${diff.added.length + diff.updated.length + diff.removed.length} Changes
        </button>
        <button class="btn btn--secondary" id="back-to-upload-2">Cancel</button>
      </div>
    `;

    el.querySelector("#back-to-upload").addEventListener("click", () => { step = "upload"; renderUpload(); });
    el.querySelector("#back-to-upload-2").addEventListener("click", () => { step = "upload"; renderUpload(); });

    el.querySelectorAll(".mismatch-select").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        const regNo = e.target.dataset.regno;
        const val = e.target.value;
        if (val === "__skip__") delete resolvedMismatches[regNo];
        else resolvedMismatches[regNo] = Number(val);
      });
    });

    el.querySelector("#commit-btn").addEventListener("click", () => doCommit());
  }

  function renderDiffTable(title, rows) {
    if (!rows.length) return "";
    return `
      <details style="margin-top:var(--space-3);">
        <summary style="cursor:pointer; font-weight:600; margin-bottom:var(--space-2);">${escapeHtml(title)} (${rows.length})</summary>
        <div class="summary-table-wrap">
          <table class="summary-table">
            <thead><tr><th>Reg. No.</th><th>Name</th><th>Class</th><th>Bus</th></tr></thead>
            <tbody>
              ${rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(String(c ?? ""))}</td>`).join("")}</tr>`).join("")}
            </tbody>
          </table>
        </div>
      </details>
    `;
  }

  function renderUpdatedTable(updates) {
    if (!updates.length) return "";
    return `
      <details style="margin-top:var(--space-3);">
        <summary style="cursor:pointer; font-weight:600; margin-bottom:var(--space-2);">Updated students (${updates.length})</summary>
        <div class="summary-table-wrap">
          <table class="summary-table">
            <thead><tr><th>Reg. No.</th><th>Name</th><th>Changed fields</th></tr></thead>
            <tbody>
              ${updates.map((u) => `
                <tr>
                  <td>${escapeHtml(u.regNo)}</td>
                  <td>${escapeHtml(u.after.name)}</td>
                  <td>${escapeHtml(u.changedFields.join(", "))}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </details>
    `;
  }

  async function doCommit() {
    step = "commit";
    el.innerHTML = `
      <h3>Committing…</h3>
      <div class="progress-wrap">
        <div class="progress-bar" id="progress-bar" style="width:0%"></div>
      </div>
      <p class="status" id="progress-label">Preparing…</p>
    `;

    try {
      // Apply mismatch resolutions to parsed students before building write plan
      for (const d of (parsed.diagnostics.needsReview || [])) {
        const chosen = resolvedMismatches[d.regNo];
        if (chosen != null) {
          const student = parsed.students.find((s) => s.regNo === d.regNo);
          if (student) {
            const bus = parsed.buses.find((b) => b.stops.some((s) => s.stopNo === chosen));
            const stop = bus?.stops.find((s) => s.stopNo === chosen);
            if (stop) { student.stopNo = stop.stopNo; student.stopName = stop.stopName; }
          }
        }
      }

      const ops = buildWritePlan(parsed, diff, existingClassIds);
      const total = ops.length;

      await commitWritePlan(ops, ({ completed }) => {
        const pct = total > 0 ? Math.round((completed / total) * 100) : 100;
        el.querySelector("#progress-bar").style.width = `${pct}%`;
        el.querySelector("#progress-label").textContent = `${completed} / ${total} operations…`;
      });

      const statsHtml = renderImportStats(parsed.students);
      const savedAt = new Date();

      // Persist snapshot to Firestore so it survives page reloads
      try {
        const snapshot = buildImportStats(parsed.students);
        await setDoc(doc(db, "meta", "lastImportStats"), {
          savedAt: serverTimestamp(),
          grand: snapshot.grand,
          byBus: snapshot.byBus.length,
          byHostel: snapshot.byHostel.length,
          byOwn: snapshot.byOwn.length,
          byYear: snapshot.byYear,
          busList: Object.fromEntries(snapshot.busList),
          hostelList: Object.fromEntries(snapshot.hostelList),
          classList: Object.fromEntries(snapshot.classList),
          mismatches: snapshot.mismatches,
          diffSummary: { added: diff.added.length, updated: diff.updated.length, removed: diff.removed.length },
        });
            } catch(saveErr) { console.warn("Import stats save failed:", saveErr.message); }  el.innerHTML = `
        <div class="msg msg--ok" style="margin-bottom:var(--space-4);">
          ✅ Import complete — ${diff.added.length} added, ${diff.updated.length} updated, ${diff.removed.length} deactivated.
        </div>
        <div class="ist-saved-tag">Saved ${formatSavedAt(savedAt)}</div>
        ${statsHtml}
        <div style="margin-top:var(--space-4);">
          <button class="btn" id="import-again-btn">📤 Upload another file</button>
        </div>
      `;
      el.querySelector("#import-again-btn").addEventListener("click", () => { step = "upload"; renderUpload(); });
    } catch (err) {
      el.innerHTML = `
        <div class="msg msg--err">Commit failed: ${escapeHtml(err.message)}</div>
        <button class="btn btn--secondary" id="retry-btn" style="margin-top:var(--space-4);">← Back to preview</button>
      `;
      el.querySelector("#retry-btn").addEventListener("click", () => { step = "preview"; renderPreview(); });
    }
  }
}

// ================================================================
// IMPORT STATS — shown after commit with new data only
// ================================================================
function buildImportStats(students) {
  const active = students.filter(s => s.category !== "unknown");
  const grand  = active.length;

  const byBus    = active.filter(s => s.category === "bus");
  const byHostel = active.filter(s => s.category === "hostel");
  const byOwn    = active.filter(s => s.category === "own_vehicle");
  const transportSum = byBus.length + byHostel.length + byOwn.length;

  const YEAR_ORDER = ["first","second","third","fourth"];
  const YEAR_LABEL = { first:"I Year", second:"II Year", third:"III Year", fourth:"IV Year" };
  const byYear = {};
  for (const s of active) {
    const y = (s.year || "unknown").toLowerCase();
    byYear[y] = (byYear[y] || 0) + 1;
  }
  const yearSum = Object.values(byYear).reduce((a,b) => a+b, 0);

  // Bus-wise
  const busMap = {};
  for (const s of byBus) {
    const k = s.busId || "unknown";
    busMap[k] = (busMap[k] || 0) + 1;
  }
  const busList = Object.entries(busMap).sort(([a],[b]) => a.localeCompare(b, undefined, {numeric:true}));
  const busSum  = busList.reduce((a,[,v]) => a+v, 0);

  // Hostel Hindi/Tamil
  const hostelMap = {};
  for (const s of byHostel) {
    const k = s.hostelType || "Other";
    hostelMap[k] = (hostelMap[k] || 0) + 1;
  }
  const hostelList = Object.entries(hostelMap);

  // Class-wise
  const classMap = {};
  for (const s of active) {
    const k = s.classId || "unknown";
    classMap[k] = (classMap[k] || 0) + 1;
  }
  const classList = Object.entries(classMap).sort(([a],[b]) => a.localeCompare(b));
  const classSum  = classList.reduce((a,[,v]) => a+v, 0);

  const mismatches = [];
  if (transportSum !== grand)
    mismatches.push(`Transport total (Bus ${byBus.length} + Hostel ${byHostel.length} + Own Vehicle ${byOwn.length} = ${transportSum}) ≠ Grand total (${grand})`);
  if (yearSum !== grand)
    mismatches.push(`Year total (${yearSum}) ≠ Grand total (${grand})`);
  if (busSum !== byBus.length)
    mismatches.push(`Bus-wise total (${busSum}) ≠ Bus students (${byBus.length})`);
  if (classSum !== grand)
    mismatches.push(`Class-wise total (${classSum}) ≠ Grand total (${grand})`);

  return { grand, transportSum, yearSum, busSum, classSum,
    byBus, byHostel, byOwn, byYear, YEAR_ORDER, YEAR_LABEL,
    busList, hostelList, classList, mismatches };
}

function renderImportStats(students) {
  const st = buildImportStats(students);
  const ok = st.mismatches.length === 0;

  const badge = (n, lbl) =>
    `<div class="ist-badge"><span class="ist-badge__num">${n}</span><span class="ist-badge__label">${lbl}</span></div>`;

  const tRow = (label, val, cls) =>
    `<tr class="${cls||""}"><td>${escapeHtml(label)}</td><td class="ist-num">${val}</td></tr>`;

  return `
    <div class="ist-wrap">
      <div class="ist-header">
        <span class="ist-title">Import Summary</span>
        ${ok
          ? `<span class="ist-pill ist-pill--ok">✓ All totals match</span>`
          : `<span class="ist-pill ist-pill--err">⚠ ${st.mismatches.length} mismatch${st.mismatches.length>1?"es":""}</span>`}
      </div>

      ${!ok ? `<div class="ist-alert"><strong>Discrepancies — please fix Excel and re-upload:</strong>
        <ul>${st.mismatches.map(m => `<li>${escapeHtml(m)}</li>`).join("")}</ul></div>` : ""}

      <div class="ist-grand">
        ${badge(st.grand, "Total Students")}
        ${badge(st.byBus.length, "🚌 Bus")}
        ${badge(st.byHostel.length, "🏠 Hostel")}
        ${badge(st.byOwn.length, "🚗 Own Vehicle")}
      </div>
      ${st.transportSum !== st.grand ? `<p class="ist-mismatch-line">⚠ Transport sum ${st.transportSum} ≠ total ${st.grand}</p>` : ""}

      <table class="ist-table" style="margin-top:var(--space-3);">
        <thead><tr><th>Year</th><th class="ist-num">Students</th></tr></thead>
        <tbody>
          ${st.YEAR_ORDER.filter(y => st.byYear[y]).map(y => tRow(st.YEAR_LABEL[y], st.byYear[y])).join("")}
          ${Object.entries(st.byYear).filter(([y]) => !st.YEAR_ORDER.includes(y)).map(([y,n]) => tRow(y,n,"ist-muted")).join("")}
          <tr class="ist-total-row"><td>Total</td><td class="ist-num">${st.yearSum}</td></tr>
        </tbody>
      </table>
      ${st.yearSum !== st.grand ? `<p class="ist-mismatch-line">⚠ Year sum ${st.yearSum} ≠ total ${st.grand}</p>` : ""}

      <details class="ist-details" open>
        <summary class="ist-details__summary">🚌 Bus / 🏠 Hostel / 🚗 Own Vehicle breakdown</summary>
        <table class="ist-table">
          <thead><tr><th>Scope</th><th class="ist-num">Students</th></tr></thead>
          <tbody>
            <tr class="ist-group-row"><td colspan="2">Buses</td></tr>
            ${st.busList.map(([id,n]) => tRow(id, n)).join("")}
            <tr class="ist-sub-total"><td>Bus subtotal</td><td class="ist-num">${st.byBus.length}</td></tr>
            <tr class="ist-group-row"><td colspan="2">Hostel</td></tr>
            ${st.hostelList.map(([type,n]) => tRow(type+" Hostel", n)).join("")}
            <tr class="ist-sub-total"><td>Hostel subtotal</td><td class="ist-num">${st.byHostel.length}</td></tr>
            <tr class="ist-group-row"><td colspan="2">Own Vehicle</td></tr>
            ${tRow("Own Vehicle", st.byOwn.length)}
            <tr class="ist-total-row"><td>Grand total</td><td class="ist-num">${st.transportSum}</td></tr>
          </tbody>
        </table>
        ${st.transportSum !== st.grand ? `<p class="ist-mismatch-line">⚠ Sum ${st.transportSum} ≠ total ${st.grand}</p>` : ""}
      </details>

      <details class="ist-details">
        <summary class="ist-details__summary">🎓 Class-wise breakdown</summary>
        <table class="ist-table">
          <thead><tr><th>Class</th><th class="ist-num">Students</th></tr></thead>
          <tbody>
            ${st.classList.map(([id,n]) => tRow(id.replace(/_/g," ").toUpperCase(), n)).join("")}
            <tr class="ist-total-row"><td>Total</td><td class="ist-num">${st.classSum}</td></tr>
          </tbody>
        </table>
        ${st.classSum !== st.grand ? `<p class="ist-mismatch-line">⚠ Sum ${st.classSum} ≠ total ${st.grand}</p>` : ""}
      </details>
    </div>
  `;
}

// ================================================================
// SECTION 2: Students
// ================================================================

function mountStudentsSection(el) {
  let searchQuery = "";
  let showInactive = false;
  let editingRegNo = null; // null = list view, string = edit/add form

  renderStudentList();

  async function renderStudentList() {
    el.innerHTML = `
      <div class="section-header">
        <h3>Students</h3>
        <button class="btn" id="add-student-btn">+ Add Student</button>
      </div>
      <div class="student-search-row">
        <input type="text" id="student-search" class="report-controls__input"
          placeholder="Search by name or reg. no." value="${escapeHtml(searchQuery)}" />
        <label class="checkbox-label">
          <input type="checkbox" id="show-inactive" ${showInactive ? "checked" : ""} />
          Show inactive
        </label>
      </div>
      <div id="student-list"><p class="status">Loading…</p></div>
    `;

    el.querySelector("#add-student-btn").addEventListener("click", () => renderStudentForm(null));
    el.querySelector("#student-search").addEventListener("input", (e) => {
      searchQuery = e.target.value;
      loadStudents();
    });
    el.querySelector("#show-inactive").addEventListener("change", (e) => {
      showInactive = e.target.checked;
      loadStudents();
    });

    loadStudents();
  }

  async function loadStudents() {
    const listEl = el.querySelector("#student-list");
    if (!listEl) return;
    listEl.innerHTML = `<p class="status">Loading…</p>`;

    try {
      const snap = await getDocs(collection(db, "students"));
      let students = [];
      snap.forEach((d) => students.push({ regNo: d.id, ...d.data() }));

      if (!showInactive) students = students.filter((s) => s.active !== false);
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        students = students.filter((s) =>
          (s.name || "").toLowerCase().includes(q) || (s.regNo || "").toLowerCase().includes(q)
        );
      }
      students.sort((a, b) => (a.name || "").localeCompare(b.name || ""));

      if (!students.length) {
        listEl.innerHTML = `<div class="msg msg--warn">No students found.</div>`;
        return;
      }

      listEl.innerHTML = `
        <div class="summary-table-wrap">
          <table class="summary-table">
            <thead>
              <tr><th>Reg. No.</th><th>Name</th><th>Class</th><th>Bus / Stop</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              ${students.map((s) => `
                <tr class="${s.active === false ? "student-row--inactive" : ""}">
                  <td>${escapeHtml(s.regNo)}</td>
                  <td>${escapeHtml(s.name || "")}</td>
                  <td>${escapeHtml(s.classId?.replace(/^class_/, "").replace(/_/g, " ") || "")}</td>
                  <td>${escapeHtml(s.busId ? `${s.busId.replace(/^bus_/, "")} / Stop ${s.stopNo ?? "?"}` : (s.category === "hostel" ? `Hostel — ${s.hostelType || "?"}` : "—"))}</td>
                  <td>${s.active === false ? `<span class="dash-card__state--pending" style="padding:2px 6px;">Inactive</span>` : "Active"}</td>
                  <td>
                    <button class="btn btn--secondary edit-student-btn"
                      style="min-height:auto;padding:var(--space-1) var(--space-3);font-size:var(--font-size-sm);"
                      data-regno="${escapeHtml(s.regNo)}">Edit</button>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `;

      listEl.querySelectorAll(".edit-student-btn").forEach((btn) => {
        btn.addEventListener("click", () => renderStudentForm(btn.dataset.regno));
      });
    } catch (err) {
      listEl.innerHTML = `<div class="msg msg--err">${escapeHtml(err.message)}</div>`;
    }
  }

  async function renderStudentForm(regNo) {
    el.innerHTML = `<p class="status">Loading…</p>`;

    let student = {};
    let buses = [];
    let classes = [];

    try {
      const [busSnap, classSnap] = await Promise.all([
        getDocs(collection(db, "buses")),
        getDocs(collection(db, "classes")),
      ]);
      busSnap.forEach((d) => buses.push({ id: d.id, ...d.data() }));
      buses.sort((a, b) => naturalSort(a.id, b.id));
      classSnap.forEach((d) => classes.push({ id: d.id, ...d.data() }));
      classes.sort((a, b) => naturalSort(a.id, b.id));

      if (regNo) {
        const snap = await getDoc(doc(db, "students", regNo));
        if (snap.exists()) student = { regNo: snap.id, ...snap.data() };
      }
    } catch (err) {
      el.innerHTML = `<div class="msg msg--err">${escapeHtml(err.message)}</div>`;
      return;
    }

    const isEdit = !!regNo;
    const selectedBus = buses.find((b) => b.id === student.busId);
    const stops = selectedBus?.stops || [];

    el.innerHTML = `
      <div class="section-header">
        <h3>${isEdit ? "Edit Student" : "Add Student"}</h3>
        <button class="btn btn--secondary" id="back-to-list">← Back</button>
      </div>

      <div class="card student-form">
        <div class="form-row">
          <label class="form-label">Reg. No.</label>
          <input class="report-controls__input" id="f-regno" value="${escapeHtml(student.regNo || "")}" ${isEdit ? "readonly" : ""} placeholder="e.g. 23BCE001" />
        </div>
        <div class="form-row">
          <label class="form-label">Name</label>
          <input class="report-controls__input" id="f-name" value="${escapeHtml(student.name || "")}" placeholder="Full name" />
        </div>
        <div class="form-row">
          <label class="form-label">Class</label>
          <select class="report-controls__input" id="f-class">
            <option value="">— select —</option>
            ${classes.map((c) => `<option value="${c.id}" ${student.classId === c.id ? "selected" : ""}>${c.id.replace(/^class_/, "").replace(/_/g, " ")}</option>`).join("")}
          </select>
        </div>
        <div class="form-row">
          <label class="form-label">Bus</label>
          <select class="report-controls__input" id="f-bus">
            <option value="">— none / hostel —</option>
            ${buses.map((b) => `<option value="${b.id}" ${student.busId === b.id ? "selected" : ""}>Bus ${b.id.replace(/^bus_/, "")}</option>`).join("")}
          </select>
        </div>
        <div class="form-row" id="stop-row" ${!selectedBus ? 'style="display:none"' : ""}>
          <label class="form-label">Stop</label>
          <select class="report-controls__input" id="f-stop">
            <option value="">— select stop —</option>
            ${stops.map((s) => `<option value="${s.stopNo}" ${student.stopNo === s.stopNo ? "selected" : ""}>Stop ${s.stopNo} — ${escapeHtml(s.stopName)}</option>`).join("")}
          </select>
        </div>
        <div class="form-row" id="hostel-type-row" ${selectedBus ? 'style="display:none"' : ""}>
          <label class="form-label">Hostel Type</label>
          <select class="report-controls__input" id="f-hostel-type">
            <option value="">— select —</option>
            <option value="Hindi" ${student.hostelType === "Hindi" ? "selected" : ""}>Hindi</option>
            <option value="Tamil" ${student.hostelType === "Tamil" ? "selected" : ""}>Tamil</option>
          </select>
        </div>
        <div class="form-row">
          <label class="form-label">Year</label>
          <select class="report-controls__input" id="f-year">
            ${["1","2","3"].map((y) => `<option ${student.year === y ? "selected" : ""}>${y}</option>`).join("")}
          </select>
        </div>
        <div class="form-row">
          <label class="form-label">Gender</label>
          <select class="report-controls__input" id="f-gender">
            <option value="M" ${student.gender === "M" ? "selected" : ""}>Male</option>
            <option value="F" ${student.gender === "F" ? "selected" : ""}>Female</option>
          </select>
        </div>
        ${isEdit ? `
        <div class="form-row">
          <label class="form-label">Active</label>
          <select class="report-controls__input" id="f-active">
            <option value="true"  ${student.active !== false ? "selected" : ""}>Active</option>
            <option value="false" ${student.active === false ? "selected" : ""}>Inactive</option>
          </select>
        </div>
        ` : ""}

        <div id="form-msg"></div>
        <div class="summary-actions">
          <button class="btn" id="save-student-btn">💾 Save</button>
          ${isEdit ? `<button class="btn btn--secondary" id="deactivate-btn">${student.active !== false ? "Deactivate" : "Reactivate"}</button>` : ""}
        </div>
      </div>
    `;

    el.querySelector("#back-to-list").addEventListener("click", () => renderStudentList());

    // Bus change → update stop list, toggle hostel-type row
    el.querySelector("#f-bus").addEventListener("change", async (e) => {
      const busId = e.target.value;
      const stopRow = el.querySelector("#stop-row");
      const stopSel = el.querySelector("#f-stop");
      const hostelTypeRow = el.querySelector("#hostel-type-row");
      if (!busId) {
        stopRow.style.display = "none";
        hostelTypeRow.style.display = "";
        return;
      }
      hostelTypeRow.style.display = "none";
      const bus = buses.find((b) => b.id === busId);
      if (!bus) return;
      stopRow.style.display = "";
      stopSel.innerHTML = `<option value="">— select stop —</option>` +
        bus.stops.map((s) => `<option value="${s.stopNo}">Stop ${s.stopNo} — ${escapeHtml(s.stopName)}</option>`).join("");
    });

    el.querySelector("#save-student-btn").addEventListener("click", async () => {
      await saveStudent(regNo, isEdit);
    });

    if (isEdit) {
      el.querySelector("#deactivate-btn").addEventListener("click", async () => {
        const newActive = student.active === false; // toggle
        const msgEl = el.querySelector("#form-msg");
        msgEl.innerHTML = `<p class="status">Saving…</p>`;
        try {
          await updateDoc(doc(db, "students", regNo), { active: newActive, updatedAt: serverTimestamp() });
          msgEl.innerHTML = `<div class="msg msg--ok">${newActive ? "Reactivated" : "Deactivated"}.</div>`;
          setTimeout(() => renderStudentList(), 1000);
        } catch (err) {
          msgEl.innerHTML = `<div class="msg msg--err">${escapeHtml(err.message)}</div>`;
        }
      });
    }
  }

  async function saveStudent(originalRegNo, isEdit) {
    const msgEl = el.querySelector("#form-msg");
    const regNo = el.querySelector("#f-regno").value.trim().toUpperCase();
    const name  = el.querySelector("#f-name").value.trim();
    const classId = el.querySelector("#f-class").value;
    const busId   = el.querySelector("#f-bus").value;
    const stopNo  = el.querySelector("#f-stop")?.value;
    const hostelTypeRaw = el.querySelector("#f-hostel-type")?.value || null;
    const year    = el.querySelector("#f-year").value;
    const gender  = el.querySelector("#f-gender").value;
    const active  = el.querySelector("#f-active") ? el.querySelector("#f-active").value === "true" : true;

    if (!regNo || !name || !classId) {
      msgEl.innerHTML = `<div class="msg msg--err">Reg. No., Name, and Class are required.</div>`;
      return;
    }

    msgEl.innerHTML = `<p class="status">Saving…</p>`;
    try {
      const selectedBus = busId ? (await getDocs(collection(db, "buses"))).docs.find((d) => d.id === busId) : null;
      const stops = selectedBus?.data()?.stops || [];
      const chosenStop = stops.find((s) => String(s.stopNo) === String(stopNo));

      const category = busId ? "bus" : "hostel";

      const data = {
        name,
        classId,
        year,
        gender,
        category,
        active,
        busId: busId || null,
        stopNo: chosenStop?.stopNo ?? null,
        stopName: chosenStop?.stopName ?? null,
        hostelType: category === "hostel" ? hostelTypeRaw : null,
        updatedAt: serverTimestamp(),
      };
      if (!isEdit) data.importedAt = serverTimestamp();

      await setDoc(doc(db, "students", regNo), data, { merge: isEdit });
      msgEl.innerHTML = `<div class="msg msg--ok">Saved successfully.</div>`;
      setTimeout(() => renderStudentList(), 1000);
    } catch (err) {
      msgEl.innerHTML = `<div class="msg msg--err">${escapeHtml(err.message)}</div>`;
    }
  }
}

// ================================================================
// SECTION 3: Buses
// ================================================================

function mountBusesSection(el) {
  let selectedBusId = null;

  renderBusList();

  async function renderBusList() {
    el.innerHTML = `<h3>Buses</h3><p class="status">Loading…</p>`;
    try {
      const snap = await getDocs(collection(db, "buses"));
      const buses = [];
      snap.forEach((d) => buses.push({ id: d.id, ...d.data() }));
      buses.sort((a, b) => naturalSort(a.id, b.id));

      el.innerHTML = `
        <h3>Buses</h3>
        <div class="bus-list">
          ${buses.map((b) => `
            <div class="card bus-list-item" style="display:flex; align-items:center; justify-content:space-between; gap:var(--space-3); margin-bottom:var(--space-3); flex-wrap:wrap;">
              <div>
                <div style="font-weight:700;">Bus ${b.id.replace(/^bus_/, "")}</div>
                <div class="status" style="margin:0;">Driver: ${escapeHtml(b.driver?.name || "—")} · Incharge: ${escapeHtml(b.incharge?.name || "—")}</div>
                <div class="status" style="margin:0;">${(b.stops || []).length} stops</div>
              </div>
              <button class="btn btn--secondary edit-bus-btn"
                style="min-height:auto; padding:var(--space-2) var(--space-4);"
                data-busid="${escapeHtml(b.id)}">Edit</button>
            </div>
          `).join("")}
        </div>
      `;

      el.querySelectorAll(".edit-bus-btn").forEach((btn) => {
        btn.addEventListener("click", () => renderBusForm(btn.dataset.busid, buses.find((b) => b.id === btn.dataset.busid)));
      });
    } catch (err) {
      el.innerHTML = `<h3>Buses</h3><div class="msg msg--err">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderBusForm(busId, bus) {
    const stops = (bus.stops || []).map((s, i) => ({ ...s, _idx: i }));

    el.innerHTML = `
      <div class="section-header">
        <h3>Bus ${busId.replace(/^bus_/, "")} — Edit</h3>
        <button class="btn btn--secondary" id="back-to-buses">← Back</button>
      </div>

      <div class="card" style="margin-bottom:var(--space-4);">
        <h4 style="margin-bottom:var(--space-3);">Staff</h4>
        <div class="form-row">
          <label class="form-label">Driver name</label>
          <input class="report-controls__input" id="f-driver-name" value="${escapeHtml(bus.driver?.name || "")}" />
        </div>
        <div class="form-row">
          <label class="form-label">Driver phone</label>
          <input class="report-controls__input" id="f-driver-phone" value="${escapeHtml(bus.driver?.phone || "")}" type="tel" />
        </div>
        <div class="form-row">
          <label class="form-label">Incharge name</label>
          <input class="report-controls__input" id="f-incharge-name" value="${escapeHtml(bus.incharge?.name || "")}" />
        </div>
        <div class="form-row">
          <label class="form-label">Incharge phone</label>
          <input class="report-controls__input" id="f-incharge-phone" value="${escapeHtml(bus.incharge?.phone || "")}" type="tel" />
        </div>
      </div>

      <div class="card" style="margin-bottom:var(--space-4);">
        <h4 style="margin-bottom:var(--space-3);">Stops (${stops.length})</h4>
        <p class="status">Stop order is preserved from the Excel import. Edit names/times here if needed.</p>
        <div class="summary-table-wrap">
          <table class="summary-table" id="stops-table">
            <thead><tr><th>#</th><th>Stop No.</th><th>Stop Name</th><th>Time</th><th>km</th></tr></thead>
            <tbody>
              ${stops.map((s) => `
                <tr data-idx="${s._idx}">
                  <td style="color:var(--color-text-muted);">${s._idx + 1}</td>
                  <td><input class="stop-input" data-field="stopNo" data-idx="${s._idx}" value="${escapeHtml(String(s.stopNo ?? ""))}" style="width:3.5rem;" /></td>
                  <td><input class="stop-input" data-field="stopName" data-idx="${s._idx}" value="${escapeHtml(s.stopName || "")}" style="min-width:10rem;" /></td>
                  <td><input class="stop-input" data-field="time" data-idx="${s._idx}" value="${escapeHtml(s.time || "")}" style="width:5rem;" /></td>
                  <td><input class="stop-input" data-field="km" data-idx="${s._idx}" value="${escapeHtml(String(s.km ?? ""))}" style="width:3.5rem;" /></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <div id="bus-form-msg"></div>
      <div class="summary-actions">
        <button class="btn" id="save-bus-btn">💾 Save Bus</button>
      </div>
    `;

    el.querySelector("#back-to-buses").addEventListener("click", () => renderBusList());

    el.querySelector("#save-bus-btn").addEventListener("click", async () => {
      const msgEl = el.querySelector("#bus-form-msg");
      msgEl.innerHTML = `<p class="status">Saving…</p>`;

      // Read all stop input values back
      const updatedStops = [...stops];
      el.querySelectorAll(".stop-input").forEach((inp) => {
        const idx = Number(inp.dataset.idx);
        const field = inp.dataset.field;
        updatedStops[idx] = { ...updatedStops[idx], [field]: isNaN(Number(inp.value)) ? inp.value : Number(inp.value) };
      });

      try {
        await setDoc(doc(db, "buses", busId), {
          ...bus,
          driver: {
            name: el.querySelector("#f-driver-name").value.trim(),
            phone: el.querySelector("#f-driver-phone").value.trim(),
          },
          incharge: {
            name: el.querySelector("#f-incharge-name").value.trim(),
            phone: el.querySelector("#f-incharge-phone").value.trim(),
          },
          stops: updatedStops.map(({ _idx, ...s }) => s),
          updatedAt: serverTimestamp(),
        });
        msgEl.innerHTML = `<div class="msg msg--ok">Saved.</div>`;
      } catch (err) {
        msgEl.innerHTML = `<div class="msg msg--err">${escapeHtml(err.message)}</div>`;
      }
    });
  }
}

// ================================================================
// SECTION: Holidays
// ================================================================
//
// Per-category holiday calendar (bus / class / hostel are tracked
// independently — see shared/attendance.js header for why). Admin
// picks a category, picks a date, optionally labels it (e.g.
// "Pongal"), and it shows up greyed-out in that category's Monthly
// view and blocks marker PIN-keypad access for that day.

function mountHolidaysSection(el) {
  let category = "class";
  let holidays = [];

  render();

  async function render() {
    el.innerHTML = `
      <h3>Holidays</h3>
      <p class="status">Holidays are tracked separately per category — marking a class holiday won't affect buses or the hostel.</p>

      <div class="card" style="margin-bottom:var(--space-4);">
        <div class="form-row">
          <label class="form-label">Category</label>
          <select class="report-controls__input" id="h-category">
            <option value="class"  ${category === "class"  ? "selected" : ""}>Class</option>
            <option value="bus"    ${category === "bus"    ? "selected" : ""}>Bus</option>
            <option value="hostel" ${category === "hostel" ? "selected" : ""}>Hostel</option>
          </select>
        </div>
        <div class="form-row">
          <label class="form-label">Date</label>
          <input class="report-controls__input" id="h-date" type="date" value="${escapeHtml(todayLocalDate())}" />
        </div>
        <div class="form-row">
          <label class="form-label">Label (optional)</label>
          <input class="report-controls__input" id="h-label" placeholder="e.g. Pongal, Republic Day" />
        </div>
        <div id="h-msg"></div>
        <div class="summary-actions">
          <button class="btn" id="h-add-btn">📅 Mark Holiday</button>
        </div>
      </div>

      <h4 style="margin-bottom:var(--space-3);">Marked holidays — ${capitalize(category)}</h4>
      <div id="h-list"><p class="status">Loading…</p></div>
    `;

    el.querySelector("#h-category").addEventListener("change", (e) => {
      category = e.target.value;
      render();
    });

    el.querySelector("#h-add-btn").addEventListener("click", async () => {
      const msgEl = el.querySelector("#h-msg");
      const date = el.querySelector("#h-date").value;
      const label = el.querySelector("#h-label").value.trim();
      if (!date) {
        msgEl.innerHTML = `<div class="msg msg--err">Pick a date first.</div>`;
        return;
      }
      msgEl.innerHTML = `<p class="status">Checking…</p>`;
      try {
        const scopesWithData = await fetchScopesWithAttendance({ category, date });
        if (scopesWithData.length > 0) {
          const proceed = confirm(
            `⚠ ${scopesWithData.length} ${scopesWithData.length === 1 ? "scope" : "scopes"} already ` +
            `${scopesWithData.length === 1 ? "has" : "have"} attendance marked for ${date} ` +
            `(${scopesWithData.map(formatScopeIdShort).join(", ")}).\n\n` +
            `Marking it a holiday will hide that data from Monthly reports and exclude it from ` +
            `attendance % — the underlying records are NOT deleted, but the report will look like ` +
            `nothing was marked. Continue?`
          );
          if (!proceed) {
            msgEl.innerHTML = "";
            return;
          }
        }
        msgEl.innerHTML = `<p class="status">Saving…</p>`;
        await setHoliday({ category, date, label, createdBy: { uid: auth.currentUser?.uid || null } });
        msgEl.innerHTML = `<div class="msg msg--ok">Marked ${escapeHtml(date)} as a holiday.</div>`;
        await loadList();
      } catch (err) {
        msgEl.innerHTML = `<div class="msg msg--err">${escapeHtml(err.message)}</div>`;
      }
    });

    await loadList();
  }

  async function loadList() {
    const listEl = el.querySelector("#h-list");
    listEl.innerHTML = `<p class="status">Loading…</p>`;
    try {
      holidays = await fetchAllHolidays({ category });
    } catch (err) {
      listEl.innerHTML = `<div class="msg msg--err">${escapeHtml(err.message)}</div>`;
      return;
    }

    if (holidays.length === 0) {
      listEl.innerHTML = `<p class="status">No holidays marked yet for ${capitalize(category)}.</p>`;
      return;
    }

    const today = todayLocalDate();
    listEl.innerHTML = holidays.map((h) => `
      <div class="card" style="display:flex; align-items:center; justify-content:space-between; gap:var(--space-3); margin-bottom:var(--space-2); ${h.date < today ? "opacity:0.6;" : ""}">
        <div>
          <div style="font-weight:700;">${escapeHtml(h.date)}</div>
          ${h.label ? `<div class="status" style="margin:0;">${escapeHtml(h.label)}</div>` : ""}
        </div>
        <button class="btn btn--secondary h-delete-btn" style="min-height:auto; padding:var(--space-2) var(--space-4);" data-date="${escapeHtml(h.date)}">Remove</button>
      </div>
    `).join("");

    listEl.querySelectorAll(".h-delete-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm(`Remove ${btn.dataset.date} as a holiday for ${capitalize(category)}?`)) return;
        btn.disabled = true;
        try {
          await deleteHoliday({ category, date: btn.dataset.date });
          await loadList();
        } catch (err) {
          alert("Error: " + err.message);
          btn.disabled = false;
        }
      });
    });
  }
}

/**
 * Returns the distinct scopeIds that already have an attendanceRecords
 * doc for this category+date — used to warn an admin before they bury
 * already-marked data under a holiday. Both fields are equality
 * filters so this works off the existing automatic indexes (no
 * composite index needed).
 */
async function fetchScopesWithAttendance({ category, date }) {
  const snap = await getDocs(query(
    collection(db, "attendanceRecords"),
    where("category", "==", category),
    where("date", "==", date)
  ));
  const scopeIds = new Set();
  snap.forEach((d) => scopeIds.add(d.data().scopeId));
  return [...scopeIds];
}

function formatScopeIdShort(scopeId) {
  if (scopeId === "hostel_main") return "Hostel";
  if (scopeId.startsWith("bus_"))   return `Bus ${scopeId.replace(/^bus_/, "")}`;
  if (scopeId.startsWith("class_")) return scopeId.replace(/^class_/, "").replace(/_/g, " ");
  return scopeId;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// ================================================================
// SECTION 4: College
// ================================================================

async function mountCollegeSection(el) {
  el.innerHTML = `<h3>College Info</h3><p class="status">Loading…</p>`;

  let college = {};
  try {
    const snap = await getDoc(doc(db, "college", "main"));
    if (snap.exists()) college = snap.data();
  } catch (err) {
    el.innerHTML = `<h3>College Info</h3><div class="msg msg--err">${escapeHtml(err.message)}</div>`;
    return;
  }

  // Detect the "split into 5+5 digit halves" corruption pattern (e.g.
  // 91591 / 09090 stored as two separate phone entries instead of one
  // 9159109090 entry) so we can offer a one-click fix for existing
  // bad data, in addition to the parser-level fix for future imports.
  const existingPhones = college.phones || [];

  function detectSplitPairs(list) {
    return list.some(
      (p, i) =>
        (p?.digits || "").length === 5 &&
        i + 1 < list.length &&
        (list[i + 1]?.digits || "").length === 5
    );
  }

  let phones = existingPhones.length ? existingPhones.map((p) => ({ ...p })) : [{ digits: "" }];
  let logoDataUrl = college.logoDataUrl || null;
  let logoError = "";

  // Resizes/compresses an uploaded image client-side before it's
  // stored as a base64 data URL on college/main. A header logo never
  // needs to render larger than ~200px tall in the app or PDF, but a
  // phone-camera photo of a college seal can easily be 4000px and
  // several MB — well past Firestore's 1MB-per-document limit and
  // pointless to keep at full resolution. Capping the longest edge to
  // 400px and re-encoding as JPEG at moderate quality keeps the
  // result comfortably under ~100KB in virtually all cases while
  // still looking sharp at the small sizes it's actually displayed.
  function resizeImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read the file."));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("That file doesn't look like a valid image."));
        img.onload = () => {
          const MAX_EDGE = 400;
          const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          // White backing so a transparent-PNG logo doesn't turn black
          // when re-encoded as JPEG (JPEG has no alpha channel).
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.85));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function renderPhoneRows() {
    return phones
      .map(
        (p, i) => `
        <div class="form-row phone-row" data-row-idx="${i}" style="display:flex; align-items:center; gap:8px;">
          <input class="report-controls__input phone-input" data-idx="${i}"
            type="tel" inputmode="numeric" maxlength="10"
            value="${escapeHtml(p.digits || "")}" placeholder="10-digit number, e.g. 9159109090"
            style="${p.flagged ? "border-color: var(--color-warning-text);" : ""}" />
          <button type="button" class="btn btn--secondary btn--sm remove-phone-btn" data-idx="${i}" title="Remove this number" style="flex:0 0 auto;">✕</button>
          ${p.flagged ? `<span class="status" style="display:inline; margin:0; color:var(--color-warning-text); white-space:nowrap;">⚠ Not 10 digits</span>` : ""}
        </div>
      `
      )
      .join("");
  }

  function renderForm() {
    el.innerHTML = `
      <h3>College Info</h3>
      <div class="card">
        <div class="form-row">
          <label class="form-label">College Logo</label>
          <div style="display:flex; align-items:center; gap:var(--space-3); flex-wrap:wrap;">
            <div style="width:72px; height:72px; border:1px solid var(--color-border); border-radius:var(--radius-md); display:flex; align-items:center; justify-content:center; overflow:hidden; background:var(--color-surface); flex:0 0 auto;">
              ${logoDataUrl
                ? `<img src="${logoDataUrl}" alt="College logo" style="max-width:100%; max-height:100%; object-fit:contain;" />`
                : `<span class="status" style="margin:0; font-size:var(--font-size-sm);">No logo</span>`}
            </div>
            <div style="display:flex; flex-direction:column; gap:6px;">
              <input type="file" accept="image/png,image/jpeg,image/webp" id="c-logo-input" style="display:none;" />
              <div style="display:flex; gap:8px;">
                <button type="button" class="btn btn--secondary btn--sm" id="c-logo-upload-btn">${logoDataUrl ? "Replace logo" : "Upload logo"}</button>
                ${logoDataUrl ? `<button type="button" class="btn btn--secondary btn--sm" id="c-logo-remove-btn">Remove</button>` : ""}
              </div>
              <span class="status" style="margin:0; font-size:var(--font-size-sm);">PNG or JPG, will be resized automatically. Appears beside the college name everywhere — on screen and in PDF reports.</span>
              ${logoError ? `<span class="status" style="margin:0; color:var(--color-danger-text); font-size:var(--font-size-sm);">${escapeHtml(logoError)}</span>` : ""}
            </div>
          </div>
        </div>
        <div class="form-row">
          <label class="form-label">College Name</label>
          <input class="report-controls__input" id="c-name" value="${escapeHtml(college.name || "")}" placeholder="Full institution name" />
        </div>
        <div class="form-row">
          <label class="form-label">Address</label>
          <textarea class="report-controls__input" id="c-address" rows="2" placeholder="Full address">${escapeHtml(college.address || "")}</textarea>
        </div>
        <label class="form-label">Phone numbers (10 digits each)</label>
        ${detectSplitPairs(phones) ? `
          <div class="msg msg--warn" style="margin-bottom:8px;">
            ⚠ It looks like some numbers got split into two 5-digit halves (e.g. "91591" + "09090").
            <button type="button" class="btn" id="auto-fix-phones-btn" style="margin-left:8px;">🔧 Auto-fix now</button>
          </div>
        ` : ""}
        <div id="phone-rows">${renderPhoneRows()}</div>
        <div style="margin: 8px 0 16px;">
          <button type="button" class="btn btn--secondary" id="add-phone-btn">+ Add phone number</button>
        </div>
        <div class="form-row">
          <label class="form-label">Website</label>
          <input class="report-controls__input" id="c-website" value="${escapeHtml(college.website || "")}" placeholder="e.g. www.khpcollege.edu.in" />
        </div>
        <div id="college-msg"></div>
        <div class="summary-actions">
          <button class="btn" id="save-college-btn">💾 Save</button>
        </div>
      </div>
    `;
    attachHandlers();
  }

  function attachHandlers() {
    // Sanitize phone inputs as you type: digits only, max 10 chars.
    el.querySelectorAll(".phone-input").forEach((inp) => {
      inp.addEventListener("input", () => {
        inp.value = inp.value.replace(/\D/g, "").slice(0, 10);
      });
    });

    el.querySelectorAll(".remove-phone-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        phones.splice(idx, 1);
        if (phones.length === 0) phones.push({ digits: "" });
        renderForm();
      });
    });

    el.querySelector("#add-phone-btn").addEventListener("click", () => {
      phones.push({ digits: "" });
      renderForm();
    });

    const autoFixBtn = el.querySelector("#auto-fix-phones-btn");
    if (autoFixBtn) {
      autoFixBtn.addEventListener("click", () => {
        const merged = [];
        for (let i = 0; i < phones.length; i++) {
          const cur = (phones[i].digits || "").replace(/\D/g, "");
          const next = i + 1 < phones.length ? (phones[i + 1].digits || "").replace(/\D/g, "") : "";
          if (cur.length === 5 && next.length === 5) {
            merged.push({ digits: cur + next });
            i++;
          } else {
            merged.push({ digits: cur });
          }
        }
        phones = merged;
        renderForm();
      });
    }

    const logoInput = el.querySelector("#c-logo-input");
    const logoUploadBtn = el.querySelector("#c-logo-upload-btn");
    if (logoUploadBtn) {
      logoUploadBtn.addEventListener("click", () => logoInput.click());
    }
    if (logoInput) {
      logoInput.addEventListener("change", async () => {
        const file = logoInput.files?.[0];
        if (!file) return;
        logoError = "";
        try {
          logoDataUrl = await resizeImageFile(file);
        } catch (err) {
          logoError = err.message || "Could not process that image.";
        }
        renderForm();
      });
    }
    const logoRemoveBtn = el.querySelector("#c-logo-remove-btn");
    if (logoRemoveBtn) {
      logoRemoveBtn.addEventListener("click", () => {
        logoDataUrl = null;
        logoError = "";
        renderForm();
      });
    }

    el.querySelector("#save-college-btn").addEventListener("click", async () => {
      const msgEl = el.querySelector("#college-msg");
      msgEl.innerHTML = `<p class="status">Saving…</p>`;

      const updatedPhones = [];
      el.querySelectorAll(".phone-input").forEach((inp) => {
        const digits = inp.value.replace(/\D/g, "").slice(0, 10);
        if (digits) updatedPhones.push({ digits, flagged: digits.length !== 10 });
      });

      try {
        // merge: true so saving here never clobbers fields this form
        // doesn't own (there are none today, but keeps this resilient
        // if another tool ever writes other fields to this doc).
        await setDoc(doc(db, "college", "main"), {
          name: el.querySelector("#c-name").value.trim(),
          address: el.querySelector("#c-address").value.trim(),
          phones: updatedPhones,
          website: el.querySelector("#c-website").value.trim(),
          logoDataUrl: logoDataUrl || null,
          updatedAt: serverTimestamp(),
        }, { merge: true });
        invalidateCollegeCache();
        msgEl.innerHTML = `<div class="msg msg--ok">College info saved.</div>`;
      } catch (err) {
        msgEl.innerHTML = `<div class="msg msg--err">${escapeHtml(err.message)}</div>`;
      }
    });
  }

  renderForm();
}

// ================================================================
// Utilities
// ================================================================

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true });
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}

// ================================================================
// CAPACITY SECTION — set bus & class student capacity limits
// Stored in Firestore: buses/{id}.capacity (number)
//                      classes/{id}.capacity (number)
// ================================================================
async function mountCapacitySection(el) {
  let activeTab = "bus";  // "bus" | "class"

  async function render() {
    el.innerHTML = `
      <div class="cap-wrap">
        <h3 style="margin-bottom:var(--space-3);">📐 Student Capacity</h3>
        <p class="status" style="margin-bottom:var(--space-3);">
          Set the maximum student capacity for each bus and class.
          These values appear as comparison bars on the dashboard charts.
        </p>
        <div class="cap-tabs">
          <button class="cap-tab ${activeTab==="bus"?"cap-tab--active":""}" data-tab="bus">🚌 Buses</button>
          <button class="cap-tab ${activeTab==="class"?"cap-tab--active":""}" data-tab="class">🎓 Classes</button>
        </div>
        <div id="cap-list"><p class="status">Loading…</p></div>
      </div>
    `;

    el.querySelectorAll(".cap-tab").forEach(btn =>
      btn.addEventListener("click", () => { activeTab = btn.dataset.tab; render(); })
    );

    await renderCapList(el.querySelector("#cap-list"), activeTab);
  }

  async function renderCapList(listEl, tab) {
    try {
      const colName = tab === "bus" ? "buses" : "classes";
      const snap = await getDocs(collection(db, colName));
      const items = [];
      snap.forEach(d => items.push({ id: d.id, ...d.data() }));
      items.sort((a, b) => naturalSort(a.id, b.id));

      listEl.innerHTML = `
        <form id="cap-form">
          <table class="cap-table">
            <thead>
              <tr>
                <th>${tab === "bus" ? "Bus" : "Class"}</th>
                <th class="cap-num-col">Capacity</th>
                <th class="cap-num-col">Students</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(item => {
                const lbl = tab === "bus" ? busLabelDb(item.id) : classLabelDb(item.id);
                const stuCount = item.studentCount ?? "—";
                return `
                  <tr>
                    <td class="cap-name">${escapeHtml(lbl)}</td>
                    <td class="cap-num-col">
                      <input class="cap-input" type="number" min="0" max="500" step="1"
                        name="cap_${escapeHtml(item.id)}"
                        value="${item.capacity ?? ""}"
                        placeholder="—" />
                    </td>
                    <td class="cap-num-col cap-actual">${stuCount}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
          <div style="margin-top:var(--space-4); display:flex; gap:var(--space-3); align-items:center;">
            <button type="submit" class="btn" id="cap-save-btn">💾 Save All</button>
            <span id="cap-msg" style="font-size:var(--font-size-sm);"></span>
          </div>
        </form>
      `;

      listEl.querySelector("#cap-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const btn = listEl.querySelector("#cap-save-btn");
        const msgEl = listEl.querySelector("#cap-msg");
        btn.disabled = true;
        btn.textContent = "Saving…";
        msgEl.textContent = "";
        try {
          const colName2 = tab === "bus" ? "buses" : "classes";
          const inputs = listEl.querySelectorAll(".cap-input");
          const writes = [];
          inputs.forEach(inp => {
            const id  = inp.name.replace(/^cap_/, "");
            const val = inp.value === "" ? null : parseInt(inp.value, 10);
            writes.push(updateDoc(doc(db, colName2, id), { capacity: val }));
          });
          await Promise.all(writes);
          msgEl.style.color = "#0d5c28";
          msgEl.textContent = "✓ Saved successfully";
        } catch (err) {
          msgEl.style.color = "#9e1b18";
          msgEl.textContent = "Error: " + err.message;
        } finally {
          btn.disabled = false;
          btn.textContent = "💾 Save All";
        }
      });

    } catch (err) {
      listEl.innerHTML = `<div class="msg msg--err">${escapeHtml(err.message)}</div>`;
    }
  }

  function busLabelDb(id) {
    const nums = id.match(/\d+/g);
    return nums ? "Bus " + nums.join(" ") : id;
  }
  function classLabelDb(id) {
    const ORDINALS = { first:"I", second:"II", third:"III", fourth:"IV", fifth:"V", sixth:"VI" };
    const parts = id.replace(/^class_/, "").split("_");
    const roman = ORDINALS[(parts[0]||"").toLowerCase()];
    const dept  = parts.slice(roman ? 1 : 0).join(" ").toUpperCase();
    return roman ? roman + " - " + dept : dept;
  }

  await render();
}

