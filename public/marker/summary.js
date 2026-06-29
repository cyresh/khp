// marker/summary.js
//
// P5: Daily and monthly attendance summary screens for the marker app.
//
// Mounted by app.js when the user taps a "View Summary" button after
// saving a record. Both screens share the same entry point —
// mountSummary() — which shows a "Daily / Monthly" tab bar and
// renders the chosen view into the content area.
//
// Screen structure:
//   [Tab bar: Daily | Monthly]
//   [Content area — swapped on tab change]
//
// Daily view:
//   - Scope + date + session header
//   - Roster table: name, reg, status, remarks
//   - Counts bar (Present / Absent / Total)
//   - PDF button + WhatsApp share button
//
// Monthly view:
//   - Month picker (prev/next, defaults to current month)
//   - Grid: students (rows) × days (cols) + totals column + %
//   - Days with no record shown as greyed "—"
//   - PDF button + WhatsApp share button

import { db } from "../shared/firebase-init.js";
import {
  collection,
  query,
  where,
  getDocs,
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { buildRecordId, fetchRoster, todayLocalDate, getHoliday, fetchHolidaysForMonth } from "../shared/attendance.js";
import { loadPdfLibs, generateDailyPdf, generateMonthlyPdf } from "../shared/pdf-utils.js";
import {
  shareReport,
  triggerDownload,
  buildDailyWhatsAppText,
  buildMonthlyWhatsAppText,
} from "../shared/share-utils.js";

// Pre-load PDF libs as soon as this module is imported (background,
// doesn't block the UI). The user almost certainly has a network
// connection at this point (they just saved successfully), and jsPDF
// is ~250KB gzipped — loads in under a second on a typical connection.
loadPdfLibs().catch(() => {
  // Non-fatal: buttons will show "Loading PDF tools…" or fall back gracefully.
});

/**
 * Mounts the summary screens (Daily + Monthly tabs) into `container`.
 *
 * @param {HTMLElement} container
 * @param {object} context - the post-save context from app.js
 *   @param {object} context.profile - marker's Firestore user profile
 *   @param {string} context.scopeId
 *   @param {string|null} context.session
 *   @param {string} context.date - YYYY-MM-DD of the just-saved record
 *   @param {Function} context.onBack - called when user taps "← Back"
 */
export function mountSummary(container, context) {
  const { profile, scopeId, session, onBack } = context;

  // Active tab state: "daily" | "monthly"
  let activeTab = "daily";

  // Daily-tab date state — starts on the just-saved date, but is
  // navigable via prev/next (capped at today) so markers can review
  // any past day's attendance, not just the one they just marked.
  // This mirrors the existing month-nav UX on the Monthly tab and
  // applies uniformly to every scope (class, bus, hostel) since this
  // is the one shared summary component used by all of them.
  let dateState = context.date;

  render();

  function render() {
    container.innerHTML = `
      <div class="page summary-page">
        <div class="row row--between" style="margin-bottom: var(--space-4);">
          <button class="btn btn--secondary" id="summary-back-btn"
            style="min-height:auto; padding: var(--space-2) var(--space-3); font-size: var(--font-size-sm);">
            ← Back
          </button>
          <span class="status" style="margin:0;">${escapeHtml(scopeLabel(scopeId, profile.category))}</span>
        </div>

        <div class="summary-tabs" role="tablist">
          <button class="summary-tab ${activeTab === "daily" ? "summary-tab--active" : ""}"
            data-tab="daily" role="tab" aria-selected="${activeTab === "daily"}">
            Daily
          </button>
          <button class="summary-tab ${activeTab === "monthly" ? "summary-tab--active" : ""}"
            data-tab="monthly" role="tab" aria-selected="${activeTab === "monthly"}">
            Monthly
          </button>
        </div>

        <div id="summary-content" class="summary-content">
          <p class="status">Loading…</p>
        </div>
      </div>
    `;

    container.querySelector("#summary-back-btn").addEventListener("click", onBack);
    container.querySelectorAll(".summary-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeTab = btn.dataset.tab;
        render();
      });
    });

    const contentEl = container.querySelector("#summary-content");
    if (activeTab === "daily") {
      renderDailyTab(contentEl);
    } else {
      renderMonthlyTab(contentEl);
    }
  }

  // ----------------------------------------------------------------
  // Daily tab
  // ----------------------------------------------------------------

  async function renderDailyTab(el) {
    el.innerHTML = `
      <div class="date-nav">
        <button class="btn btn--secondary date-nav__btn" id="date-prev">‹</button>
        <span class="date-nav__label" id="date-label">${formatDate(dateState)}</span>
        <button class="btn btn--secondary date-nav__btn" id="date-next" ${
          dateState >= todayLocalDate() ? "disabled" : ""
        }>›</button>
      </div>
      <div id="daily-content-area"><p class="status">Loading record…</p></div>
    `;

    el.querySelector("#date-prev").addEventListener("click", () => {
      dateState = shiftDate(dateState, -1);
      renderDailyTab(el);
    });
    const nextBtn = el.querySelector("#date-next");
    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        if (dateState >= todayLocalDate()) return;
        dateState = shiftDate(dateState, 1);
        renderDailyTab(el);
      });
    }

    await loadDailyContent(el.querySelector("#daily-content-area"));
  }

  async function loadDailyContent(el) {
    el.innerHTML = `<p class="status">Loading record…</p>`;
    const date = dateState;

    let record, college, holiday;
    try {
      const recordId = buildRecordId({
        category: profile.category,
        scopeId,
        date,
      });
      const [recordSnap, collegeSnap, holidayResult] = await Promise.all([
        getDoc(doc(db, "attendanceRecords", recordId)),
        getDoc(doc(db, "college", "main")),
        getHoliday({ category: profile.category, date }),
      ]);
      record = recordSnap.exists() ? recordSnap.data() : null;
      college = collegeSnap.exists() ? collegeSnap.data() : null;
      holiday = holidayResult;
    } catch (err) {
      el.innerHTML = `<div class="msg msg--err">Could not load: ${escapeHtml(err.message)}</div>`;
      return;
    }

    if (holiday) {
      el.innerHTML = `
        <div class="msg msg--holiday" style="display:flex; align-items:center; gap:var(--space-2);">
          <span style="font-weight:700;">H — Holiday</span>${holiday.label ? `<span>· ${escapeHtml(holiday.label)}</span>` : ""}
        </div>
      `;
      return;
    }

    if (!record) {
      el.innerHTML = `<div class="msg msg--warn">No record found for this date/session.</div>`;
      return;
    }

    const { records = [], presentCount, absentCount, totalCount, markedBy } = record;
    const absentStudents = records.filter((r) => r.status === "absent");

    el.innerHTML = `
      <div class="summary-counts card" style="display:flex; gap:var(--space-5); justify-content:center; text-align:center; margin: var(--space-4) 0;">
        <div>
          <div style="font-size:var(--font-size-2xl); font-weight:700; color:var(--color-success-text);">${presentCount}</div>
          <div style="font-size:var(--font-size-sm); color:var(--color-text-muted);">Present</div>
        </div>
        <div>
          <div style="font-size:var(--font-size-2xl); font-weight:700; color:var(--color-danger-text);">${absentCount}</div>
          <div style="font-size:var(--font-size-sm); color:var(--color-text-muted);">Absent</div>
        </div>
        <div>
          <div style="font-size:var(--font-size-2xl); font-weight:700; color:var(--color-text-muted);">${totalCount}</div>
          <div style="font-size:var(--font-size-sm); color:var(--color-text-muted);">Total</div>
        </div>
      </div>

      <div class="summary-table-wrap">
        <table class="summary-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th>Reg. No.</th>
              <th>Status</th>
              <th>Remarks</th>
            </tr>
          </thead>
          <tbody>
            ${records
              .map(
                (r, i) => `
              <tr class="${r.status === "absent" ? "summary-row--absent" : ""}">
                <td>${i + 1}</td>
                <td>${escapeHtml(r.name)}</td>
                <td>${escapeHtml(r.regNo)}</td>
                <td class="summary-status summary-status--${r.status}">${r.status === "present" ? "Present" : "Absent"}</td>
                <td>${escapeHtml(r.remarks || "")}</td>
              </tr>
            `
              )
              .join("")}
          </tbody>
        </table>
      </div>

      ${markedBy ? `<p class="status" style="margin-top:var(--space-3);">Marked by: ${escapeHtml(markedBy.name)} (${escapeHtml(markedBy.staffId)})</p>` : ""}

      <div class="summary-actions">
        <button class="btn" id="daily-pdf-btn">📄 Save PDF</button>
        <button class="btn btn--whatsapp" id="daily-wa-btn">📤 Share via WhatsApp</button>
      </div>
    `;

    const sLabel = scopeLabel(scopeId, profile.category);
    const filename = `attendance-daily-${scopeId}-${date}.pdf`;

    el.querySelector("#daily-pdf-btn").addEventListener("click", async () => {
      const btn = el.querySelector("#daily-pdf-btn");
      await withLoadingBtn(btn, "Generating…", async () => {
        const blob = generateDailyPdf({
          college,
          scopeLabel: sLabel,
          date,
          session,
          records,
          markedBy,
          presentCount,
          absentCount,
          totalCount,
        });
        triggerDownload(blob, filename);
      });
    });

    el.querySelector("#daily-wa-btn").addEventListener("click", async () => {
      const btn = el.querySelector("#daily-wa-btn");
      await withLoadingBtn(btn, "Sharing…", async () => {
        const text = buildDailyWhatsAppText({
          scopeLabel: sLabel,
          date,
          session,
          presentCount,
          absentCount,
          totalCount,
          absentStudents,
        });
        const blob = generateDailyPdf({
          college,
          scopeLabel: sLabel,
          date,
          session,
          records,
          markedBy,
          presentCount,
          absentCount,
          totalCount,
        });
        try {
          await shareReport({ blob, filename, title: `Attendance — ${sLabel}`, text });
        } catch (err) {
          if (err.name !== "AbortError") {
            console.warn("Share failed:", err);
          }
        }
      });
    });
  }

  // ----------------------------------------------------------------
  // Monthly tab
  // ----------------------------------------------------------------

  // month state: { year, month } (1-indexed month)
  const today = new Date();
  let monthState = { year: today.getFullYear(), month: today.getMonth() + 1 };

  async function renderMonthlyTab(el) {
    el.innerHTML = `
      <div class="month-nav">
        <button class="btn btn--secondary month-nav__btn" id="month-prev">‹</button>
        <span class="month-nav__label" id="month-label">${monthLabel(monthState)}</span>
        <button class="btn btn--secondary month-nav__btn" id="month-next">›</button>
      </div>
      <div id="monthly-grid-area"><p class="status">Loading…</p></div>
    `;

    el.querySelector("#month-prev").addEventListener("click", () => {
      monthState = prevMonth(monthState);
      el.querySelector("#month-label").textContent = monthLabel(monthState);
      loadMonthlyGrid(el.querySelector("#monthly-grid-area"));
    });
    el.querySelector("#month-next").addEventListener("click", () => {
      monthState = nextMonth(monthState);
      el.querySelector("#month-label").textContent = monthLabel(monthState);
      loadMonthlyGrid(el.querySelector("#monthly-grid-area"));
    });

    loadMonthlyGrid(el.querySelector("#monthly-grid-area"));
  }

  async function loadMonthlyGrid(gridEl) {
    gridEl.innerHTML = `<p class="status">Loading…</p>`;

    const { year, month } = monthState;
    const padM = String(month).padStart(2, "0");
    const monthPrefix = `${year}-${padM}-`;

    let records = [], roster, college, holidays;
    try {
      // Fetch all attendanceRecords for this scope+month
      const q = query(
        collection(db, "attendanceRecords"),
        where("category", "==", profile.category),
        where("scopeId", "==", scopeId),
        ...(session ? [where("session", "==", session)] : [])
      );
      const [snap, rosterResult, collegeSnap, holidaysResult] = await Promise.all([
        getDocs(q),
        fetchRoster({ category: profile.category, scopeId }),
        getDoc(doc(db, "college", "main")),
        fetchHolidaysForMonth({ category: profile.category, year, month }),
      ]);
      snap.forEach((d) => {
        const data = d.data();
        // Filter to the current month client-side (Firestore can't
        // range-filter on a string prefix without a composite index
        // that's not guaranteed to exist yet in P5).
        if (data.date && data.date.startsWith(monthPrefix)) {
          records.push(data);
        }
      });
      roster =
        profile.category === "bus"
          ? rosterResult.groups.flatMap((g) => g.students)
          : rosterResult.students;
      college = collegeSnap.exists() ? collegeSnap.data() : null;
      holidays = holidaysResult; // Map<day, { label }>
    } catch (err) {
      gridEl.innerHTML = `<div class="msg msg--err">Could not load: ${escapeHtml(err.message)}</div>`;
      return;
    }

    if (records.length === 0 && holidays.size === 0) {
      gridEl.innerHTML = `<div class="msg msg--warn" style="margin-top:var(--space-4);">No attendance records found for ${monthLabel(monthState)}.</div>`;
      return;
    }

    // Build: sorted day numbers with records, unioned with holiday days
    // so a holiday with zero marked attendance still shows up greyed
    // out instead of vanishing entirely.
    const days = [...new Set([
      ...records.map((r) => Number(r.date.slice(8))),
      ...holidays.keys(),
    ])].sort((a, b) => a - b);

    // statusGrid: regNo → Map<day, 'present'|'absent'>
    const statusGrid = new Map();
    for (const s of roster) statusGrid.set(s.regNo, new Map());
    for (const rec of records) {
      const day = Number(rec.date.slice(8));
      for (const entry of rec.records || []) {
        statusGrid.get(entry.regNo)?.set(day, entry.status);
      }
    }

    // Per-student totals
    const studentTotals = new Map();
    for (const s of roster) {
      let present = 0, absent = 0;
      for (const day of days) {
        if (holidays.has(day)) continue; // holidays don't count toward % denominator
        const st = statusGrid.get(s.regNo)?.get(day);
        if (st === "present") present++;
        else if (st === "absent") absent++;
      }
      const total = present + absent;
      const pct = total > 0 ? Math.round((present / total) * 100) : 0;
      studentTotals.set(s.regNo, { present, absent, pct });
    }

    // Per-day totals
    const dayTotals = {};
    for (const day of days) {
      if (holidays.has(day)) continue;
      let p = 0, a = 0;
      for (const s of roster) {
        const st = statusGrid.get(s.regNo)?.get(day);
        if (st === "present") p++;
        else if (st === "absent") a++;
      }
      dayTotals[day] = { present: p, absent: a };
    }

    const sLabel = scopeLabel(scopeId, profile.category);
    const mLabel = monthLabel(monthState);

    // Render grid table
    gridEl.innerHTML = `
      <div class="monthly-table-wrap">
        <table class="summary-table monthly-table">
          <thead>
            <tr>
              <th class="monthly-col--name">Name</th>
              <th class="monthly-col--reg">Reg</th>
              ${days.map((d) => `<th class="monthly-col--day ${holidays.has(d) ? "monthly-col--holiday" : ""}" ${holidays.has(d) ? `title="${escapeHtml(holidays.get(d).label || "Holiday")}"` : ""}>${d}</th>`).join("")}
              <th class="monthly-col--total">P</th>
              <th class="monthly-col--total">A</th>
              <th class="monthly-col--total">%</th>
            </tr>
          </thead>
          <tbody>
            ${roster
              .map((s) => {
                const dayCells = days
                  .map((d) => {
                    if (holidays.has(d)) return `<td class="monthly-cell--holiday" title="${escapeHtml(holidays.get(d).label || "Holiday")}">H</td>`;
                    const st = statusGrid.get(s.regNo)?.get(d);
                    if (st === "present") return `<td class="monthly-cell--present">P</td>`;
                    if (st === "absent") return `<td class="monthly-cell--absent">A</td>`;
                    return `<td class="monthly-cell--none">—</td>`;
                  })
                  .join("");
                const tot = studentTotals.get(s.regNo) || { present: 0, absent: 0, pct: 0 };
                const lowPct = tot.pct < 75;
                return `
                  <tr>
                    <td class="monthly-col--name">${escapeHtml(s.name)}</td>
                    <td class="monthly-col--reg">${escapeHtml(s.regNo)}</td>
                    ${dayCells}
                    <td class="monthly-col--total" style="color:var(--color-success-text); font-weight:700;">${tot.present}</td>
                    <td class="monthly-col--total" style="color:var(--color-danger-text); font-weight:700;">${tot.absent}</td>
                    <td class="monthly-col--total ${lowPct ? "monthly-pct--low" : ""}">${tot.pct}%</td>
                  </tr>`;
              })
              .join("")}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="2" style="font-weight:700; font-size:var(--font-size-sm);">Present</td>
              ${days.map((d) => holidays.has(d) ? `<td class="monthly-cell--holiday"></td>` : `<td class="monthly-cell--present">${dayTotals[d]?.present ?? "—"}</td>`).join("")}
              <td colspan="3"></td>
            </tr>
            <tr>
              <td colspan="2" style="font-weight:700; font-size:var(--font-size-sm);">Absent</td>
              ${days.map((d) => holidays.has(d) ? `<td class="monthly-cell--holiday"></td>` : `<td class="monthly-cell--absent">${dayTotals[d]?.absent ?? "—"}</td>`).join("")}
              <td colspan="3"></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div class="summary-actions">
        <button class="btn" id="monthly-pdf-btn">📄 Save PDF</button>
        <button class="btn btn--whatsapp" id="monthly-wa-btn">📤 Share via WhatsApp</button>
      </div>
    `;

    const filename = `attendance-monthly-${scopeId}-${year}-${padM}.pdf`;
    const lowAttendance = roster
      .map((s) => ({ ...s, ...(studentTotals.get(s.regNo) || {}) }))
      .filter((s) => s.pct < 75)
      .sort((a, b) => a.pct - b.pct);

    gridEl.querySelector("#monthly-pdf-btn").addEventListener("click", async () => {
      const btn = gridEl.querySelector("#monthly-pdf-btn");
      await withLoadingBtn(btn, "Generating…", async () => {
        const blob = generateMonthlyPdf({
          college,
          scopeLabel: sLabel,
          monthLabel: mLabel,
          session,
          students: roster,
          days,
          statusGrid,
          studentTotals,
          dayTotals,
          year,
          month,
          holidays,
        });
      });
    });

    gridEl.querySelector("#monthly-wa-btn").addEventListener("click", async () => {
      const btn = gridEl.querySelector("#monthly-wa-btn");
      await withLoadingBtn(btn, "Sharing…", async () => {
        const text = buildMonthlyWhatsAppText({
          scopeLabel: sLabel,
          monthLabel: mLabel,
          session,
          totalStudents: roster.length,
          workingDays: days.length,
          lowAttendance,
        });
        const blob = generateMonthlyPdf({
          college,
          scopeLabel: sLabel,
          monthLabel: mLabel,
          session,
          students: roster,
          days,
          statusGrid,
          studentTotals,
          dayTotals,
          year,
          month,
          holidays,
        });
        try {
          await shareReport({ blob, filename, title: `Monthly — ${sLabel}`, text });
        } catch (err) {
          if (err.name !== "AbortError") {
            console.warn("Share failed:", err);
          }
        }
      });
    });
  }
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function scopeLabel(scopeId, category) {
  if (scopeId === "hostel_main") return "Hostel";
  // e.g. "bus_11" → "Bus 11", "class_1A_civil" → "1A Civil"
  if (category === "bus") return `Bus ${scopeId.replace(/^bus_/, "")}`;
  if (category === "class") return scopeId.replace(/^class_/, "").replace(/_/g, " ");
  return scopeId;
}

function monthLabel({ year, month }) {
  return new Date(year, month - 1, 1).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
  });
}

function prevMonth({ year, month }) {
  if (month === 1) return { year: year - 1, month: 12 };
  return { year, month: month - 1 };
}

function nextMonth({ year, month }) {
  if (month === 12) return { year: year + 1, month: 1 };
  return { year, month: month + 1 };
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** Adds (or subtracts, for negative deltaDays) whole days to a
 * YYYY-MM-DD string, returning a new YYYY-MM-DD string. Builds the
 * Date from local y/m/d components (not `new Date(dateStr)`, which
 * parses as UTC midnight and can land on the wrong day for IST
 * users) to stay consistent with todayLocalDate()'s local-time
 * convention used everywhere else in this app. */
function shiftDate(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const next = new Date(y, m - 1, d + deltaDays);
  const yyyy = next.getFullYear();
  const mm = String(next.getMonth() + 1).padStart(2, "0");
  const dd = String(next.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}

/**
 * Disables a button, runs an async action, then re-enables it.
 * Shows a loading label during the action.
 */
async function withLoadingBtn(btn, loadingLabel, action) {
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = loadingLabel;
  try {
    await action();
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}
