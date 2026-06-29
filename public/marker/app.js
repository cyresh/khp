// marker/app.js
//
// Marker app main logic (P4 + P5): home screen with scope picker and
// session toggle, then the roster screen for marking attendance and
// saving. Saving now reveals a "View Summary" button that mounts the
// P5 daily/monthly summary screens. This file owns all the
// screen-switching state; auth itself is handled by marker/index.html
// (login screen) before this module ever mounts the app shell.

import { db } from "../shared/firebase-init.js";
import { doc, getDoc, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  fetchRoster,
  loadRecord,
  saveRecord,
  todayLocalDate,
  buildRecordId,
  getHoliday,
  fetchHolidaysForMonth,
} from "../shared/attendance.js";
import { mountSummary } from "./summary.js";
import {
  shareReport,
  triggerDownload,
  buildDailyWhatsAppText,
} from "../shared/share-utils.js";
import { loadPdfLibs, generateDailyPdf, generateAllClassesPdf, generateAllClassesMonthlyPdf, generateHostelDailyPdf, generateHostelMonthlyPdf } from "../shared/pdf-utils.js";

// ── Scope label helpers ───────────────────────────────────────────
const ORDINAL_MAP = {
  first: "I", second: "II", third: "III", fourth: "IV", fifth: "V", sixth: "VI",
};

function scopeLabel(scopeId) {
  if (scopeId === "hostel_main") return "Hostel";
  if (scopeId.startsWith("bus_")) {
    const raw = scopeId.replace(/^bus_/, "").replace(/[_-]/g, " ");
    return "Bus " + raw.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  // Class scope IDs from the real import pipeline are bare
  // "<ordinal>_<dept>" strings (e.g. "first_ai", "first_cse") with
  // NO "class_" prefix, unlike bus_/hostel_ scopes. Detect them by
  // whether the first underscore-separated token is a known ordinal.
  const bareParts = scopeId.split("_");
  const bareRoman = ORDINAL_MAP[(bareParts[0] || "").toLowerCase()];
  if (bareRoman) {
    const dept = bareParts.slice(1).join(" ").toUpperCase();
    return dept ? `${bareRoman} - ${dept}` : bareRoman;
  }
  // Fallback: still support an explicit "class_" prefix if that
  // format is ever used instead.
  if (scopeId.startsWith("class_")) {
    const parts = scopeId.replace(/^class_/, "").split("_");
    const roman = ORDINAL_MAP[(parts[0] || "").toLowerCase()];
    const dept = parts.slice(roman !== undefined ? 1 : 0).join(" ").toUpperCase();
    return roman ? `${roman} - ${dept}` : dept;
  }
  return scopeId;
}

/**
 * Groups hostel students by year ("First", "Second", ...), ordered
 * using the same ORDINAL_MAP as scopeLabel so groups appear in
 * natural academic order (I, II, III...) rather than alphabetically
 * ("Fifth" would otherwise sort before "First"). Students with a
 * missing/unrecognized year are bucketed last under "Other" rather
 * than silently dropped.
 */
function groupByYear(students) {
  const byYear = new Map();
  for (const s of students) {
    const key = s.year || "Other";
    if (!byYear.has(key)) byYear.set(key, []);
    byYear.get(key).push(s);
  }
  const groups = Array.from(byYear.entries()).map(([year, group]) => ({ year, students: group }));
  groups.sort((a, b) => {
    const ra = ORDINAL_MAP[a.year.toLowerCase()];
    const rb = ORDINAL_MAP[b.year.toLowerCase()];
    if (ra && rb) return Object.values(ORDINAL_MAP).indexOf(ra) - Object.values(ORDINAL_MAP).indexOf(rb);
    if (ra) return -1; // known years before "Other"
    if (rb) return 1;
    return a.year.localeCompare(b.year);
  });
  for (const g of groups) {
    g.students.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }
  return groups;
}

function yearGroupLabel(year) {
  const roman = ORDINAL_MAP[year.toLowerCase()];
  return roman ? `${roman} Year` : year;
}

/**
 * Groups hostel students first by hostel type (Hindi / Tamil), then
 * by year within each type — e.g. Hindi → First/Second/Third, then
 * Tamil → First/Second/Third. Students with a missing/unrecognized
 * hostelType are bucketed last under "Other" rather than dropped.
 * Order: Hindi, Tamil, then any other values alphabetically.
 */
const HOSTEL_TYPE_ORDER = ["Hindi", "Tamil"];

function groupByHostelTypeAndYear(students) {
  const byType = new Map();
  for (const s of students) {
    const key = s.hostelType || "Other";
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(s);
  }
  const types = Array.from(byType.keys()).sort((a, b) => {
    const ia = HOSTEL_TYPE_ORDER.indexOf(a);
    const ib = HOSTEL_TYPE_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
  return types.map((type) => ({
    type,
    yearGroups: groupByYear(byType.get(type)),
  }));
}

/**
 * Mounts the full post-login marker workflow into `container`.
 * Called once, after onAuthChange confirms a signed-in user.
 *
 * @param {HTMLElement} container
 * @param {{uid: string}} user - the Firebase Auth user object
 */
export async function mountMarkerApp(container, user, options = {}) {
  const profileSnap = await getDoc(doc(db, "users", user.uid));
  if (!profileSnap.exists()) {
    container.innerHTML = `<div class="page"><div class="msg msg--err">Your account profile could not be loaded. Contact your admin.</div></div>`;
    return;
  }
  const profile = profileSnap.data();

  const state = {
    profile,
    selectedScopeId: profile.scopeIds.length === 1 ? profile.scopeIds[0] : null,
    selectedSession: null,
    screen: profile.scopeIds.length === 1 ? "roster" : "home",
    lastSavedDate: null,
    allSummaryDailyDate: null, // persists selected date in View All Summary daily tab
  };

  render();

  function render() {
    if (state.screen === "home") return renderHome();
    if (state.screen === "roster") return renderRosterLoading();
    if (state.screen === "summary") return renderSummaryScreen();
    if (state.screen === "allsummary") return renderAllSummaryScreen();
    if (state.screen === "hostelsummary") return renderHostelSummaryScreen();
  }

  function renderSummaryScreen() {
    mountSummary(container, {
      profile,
      scopeId: state.selectedScopeId,
      session: state.selectedSession,
      date: state.lastSavedDate || todayLocalDate(),
      onBack: () => {
        state.screen = "roster";
        render();
      },
    });
  }

  function renderHome() {
    const showViewAll = profile.category === "class" && profile.scopeIds.length > 1;
    container.innerHTML = `
      <div class="page">
        <div class="row row--between">
          <h2 style="margin:0;">Hi, ${escapeHtml(profile.name)}</h2>
          <button class="btn btn--secondary" id="logout-btn-home" style="min-height:auto; padding: var(--space-2) var(--space-3); font-size: var(--font-size-sm);">Logout</button>
        </div>
        <p class="status">${formatDateDMY(todayLocalDate())} · ${capitalize(profile.category)} marker</p>
        <h3 style="margin-top: var(--space-5);">Choose a class</h3>
        <div class="scope-list" id="scope-list"></div>
        ${showViewAll ? `
          <div style="margin-top: var(--space-5);">
            <button class="btn btn--full" id="view-all-btn" style="background:#1a73e8;">
              📊 View All Classes Summary
            </button>
          </div>
        ` : ""}
      </div>
    `;
    container.querySelector("#logout-btn-home").addEventListener("click", () => options.onLogout());
    const listEl = container.querySelector("#scope-list");
    listEl.innerHTML = profile.scopeIds
      .map((scopeId) => `<div class="scope-list__item" data-scope="${escapeHtml(scopeId)}">${escapeHtml(scopeLabel(scopeId))} <span>→</span></div>`)
      .join("");
    listEl.querySelectorAll(".scope-list__item").forEach((el) => {
      el.addEventListener("click", () => {
        state.selectedScopeId = el.dataset.scope;
        state.screen = "roster";
        render();
      });
    });
    if (showViewAll) {
      container.querySelector("#view-all-btn").addEventListener("click", () => {
        state.screen = "allsummary";
        render();
      });
    }
  }

  // ── Combined "All Classes" summary screen (Daily + Monthly tabs) ───

  function renderAllSummaryScreen() {
    const today = new Date();
    let activeTab = "daily";
    let monthState = { year: today.getFullYear(), month: today.getMonth() + 1 };
    // Use state so date persists when navigating back and returning
    if (!state.allSummaryDailyDate) state.allSummaryDailyDate = todayLocalDate();

    function prevDay(iso) {
      const [y, m, d] = iso.split("-").map(Number);
      const dt = new Date(y, m - 1, d - 1);
      return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
    }
    function nextDay(iso) {
      const [y, m, d] = iso.split("-").map(Number);
      const dt = new Date(y, m - 1, d + 1);
      return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
    }

    function renderShell() {
      container.innerHTML = `
        <div class="page summary-page" style="padding-bottom:6rem;">
          <div class="row row--between" style="margin-bottom:var(--space-4);">
            <button class="btn btn--secondary" id="all-back-btn"
              style="min-height:auto; padding:var(--space-2) var(--space-3); font-size:var(--font-size-sm);">
              ← Back
            </button>
            <span class="status" style="margin:0;">All Classes</span>
          </div>
          <div class="summary-tabs" role="tablist">
            <button class="summary-tab ${activeTab === "daily" ? "summary-tab--active" : ""}"
              data-tab="daily" role="tab">Daily</button>
            <button class="summary-tab ${activeTab === "monthly" ? "summary-tab--active" : ""}"
              data-tab="monthly" role="tab">Monthly</button>
          </div>
          <div id="all-tab-content"><p class="status">Loading…</p></div>
        </div>
      `;
      container.querySelector("#all-back-btn").addEventListener("click", () => {
        state.screen = "home";
        render();
      });
      container.querySelectorAll(".summary-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
          activeTab = btn.dataset.tab;
          renderShell();
        });
      });
      const tabContent = container.querySelector("#all-tab-content");
      if (activeTab === "daily") renderAllDaily(tabContent);
      else renderAllMonthly(tabContent);
    }

    renderShell();

    // ── Daily tab ───────────────────────────────────────────────────
    function renderAllDaily(el) {
      const today = todayLocalDate();
      const isToday = state.allSummaryDailyDate >= today;

      el.innerHTML = `
        <div class="month-nav" style="margin-bottom:var(--space-3);">
          <button class="btn btn--secondary month-nav__btn" id="all-day-prev">‹</button>
          <span class="month-nav__label" id="all-day-label">${formatDateDMY(state.allSummaryDailyDate)}</span>
          <button class="btn btn--secondary month-nav__btn" id="all-day-next"
            ${isToday ? "disabled" : ""}
            style="${isToday ? "opacity:0.4; cursor:not-allowed;" : ""}">›</button>
        </div>
        <div id="all-daily-records"><p class="status">Loading…</p></div>
      `;

      el.querySelector("#all-day-prev").addEventListener("click", () => {
        state.allSummaryDailyDate = prevDay(state.allSummaryDailyDate);
        renderAllDaily(el);
      });
      el.querySelector("#all-day-next").addEventListener("click", () => {
        const t = todayLocalDate();
        if (state.allSummaryDailyDate < t) {
          state.allSummaryDailyDate = nextDay(state.allSummaryDailyDate);
          renderAllDaily(el);
        }
      });

      loadAllDailyRecords(el.querySelector("#all-daily-records"), state.allSummaryDailyDate);
    }

    async function loadAllDailyRecords(el, date) {
      el.innerHTML = `<p class="status">Loading all class records…</p>`;
      try {
        const [collegeSnap, holiday, ...recordSnaps] = await Promise.all([
          getDoc(doc(db, "college", "main")),
          getHoliday({ category: profile.category, date }),
          ...profile.scopeIds.map(async (scopeId) => {
            const recordId = buildRecordId({ category: profile.category, scopeId, date });
            const snap = await getDoc(doc(db, "attendanceRecords", recordId));
            return { scopeId, record: snap.exists() ? snap.data() : null };
          }),
        ]);
        const college = collegeSnap.exists() ? collegeSnap.data() : null;
        const found   = recordSnaps.filter((c) => c.record !== null);
        const missing = recordSnaps.filter((c) => c.record === null).map((c) => scopeLabel(c.scopeId));

        if (holiday) {
          el.innerHTML = `
            <div class="msg msg--holiday" style="display:flex; align-items:center; gap:var(--space-2);">
              <span style="font-weight:700;">H — Holiday</span>${holiday.label ? `<span>· ${escapeHtml(holiday.label)}</span>` : ""}
            </div>
          `;
          return;
        }

        if (found.length === 0) {
          el.innerHTML = `<div class="msg msg--warn">No records saved yet for today.<br>Mark each class first, then come back here.</div>`;
          return;
        }

        let grandPresent = 0, grandAbsent = 0, grandTotal = 0;
        for (const { record } of found) {
          grandPresent += record.presentCount || 0;
          grandAbsent  += record.absentCount  || 0;
          grandTotal   += record.totalCount   || 0;
        }

        // Summary card (shown at top of PDF page 1, and on screen)
        const summaryRowsHtml = found.map(({ scopeId, record }) => `
          <tr>
            <td style="font-weight:600;">${escapeHtml(scopeLabel(scopeId))}</td>
            <td style="text-align:center; color:var(--color-success-text); font-weight:700;">${record.presentCount || 0}</td>
            <td style="text-align:center; color:var(--color-danger-text); font-weight:700;">${record.absentCount || 0}</td>
            <td style="text-align:center; font-weight:700;">${record.totalCount || 0}</td>
          </tr>`).join("");

        const summaryTableHtml = `
          <div class="card" style="margin-bottom:var(--space-5); background:var(--color-surface-raised);">
            <h3 style="margin-bottom:var(--space-3); text-align:center;">📊 All Classes — ${formatDateDMY(date)}</h3>
            <div class="summary-table-wrap">
              <table class="summary-table">
                <thead><tr><th>Class</th><th>Present</th><th>Absent</th><th>Total</th></tr></thead>
                <tbody>${summaryRowsHtml}</tbody>
                <tfoot>
                  <tr style="font-weight:700; background:var(--color-surface);">
                    <td>Combined</td>
                    <td style="text-align:center; color:var(--color-success-text);">${grandPresent}</td>
                    <td style="text-align:center; color:var(--color-danger-text);">${grandAbsent}</td>
                    <td style="text-align:center;">${grandTotal}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            ${missing.length > 0 ? `<p class="status" style="margin-top:var(--space-2); color:var(--color-warning-text);">⚠️ Not yet marked: ${missing.map(escapeHtml).join(", ")}</p>` : ""}
          </div>`;

        // Per-class detail tables
        const classTablesHtml = found.map(({ scopeId, record }) => {
          const label = scopeLabel(scopeId);
          const { presentCount = 0, absentCount = 0, totalCount = 0, records = [], markedBy } = record;
          const rows = records.map((r, i) => `
            <tr class="${r.status === "absent" ? "summary-row--absent" : ""}">
              <td>${i + 1}</td>
              <td>${escapeHtml(r.name)}</td>
              <td>${escapeHtml(r.regNo)}</td>
              <td class="summary-status summary-status--${r.status}">${r.status === "present" ? "Present" : "Absent"}</td>
              <td>${escapeHtml(r.remarks || "")}</td>
            </tr>`).join("");
          return `
            <div style="margin-bottom:var(--space-6);">
              <h3 style="margin-bottom:var(--space-2);">${escapeHtml(label)}</h3>
              <div class="summary-counts card" style="display:flex; gap:var(--space-5); justify-content:center; text-align:center; margin-bottom:var(--space-3);">
                <div><div style="font-size:var(--font-size-2xl); font-weight:700; color:var(--color-success-text);">${presentCount}</div><div style="font-size:var(--font-size-sm); color:var(--color-text-muted);">Present</div></div>
                <div><div style="font-size:var(--font-size-2xl); font-weight:700; color:var(--color-danger-text);">${absentCount}</div><div style="font-size:var(--font-size-sm); color:var(--color-text-muted);">Absent</div></div>
                <div><div style="font-size:var(--font-size-2xl); font-weight:700; color:var(--color-text-muted);">${totalCount}</div><div style="font-size:var(--font-size-sm); color:var(--color-text-muted);">Total</div></div>
              </div>
              <div class="summary-table-wrap">
                <table class="summary-table">
                  <thead><tr><th>#</th><th>Name</th><th>Reg. No.</th><th>Status</th><th>Remarks</th></tr></thead>
                  <tbody>${rows}</tbody>
                </table>
              </div>
              ${markedBy ? `<p class="status" style="margin-top:var(--space-2);">Marked by: ${escapeHtml(markedBy.name)} (${escapeHtml(markedBy.staffId)})</p>` : ""}
            </div>`;
        }).join(`<hr style="margin:var(--space-4) 0; border:none; border-top:2px solid var(--color-border);">`);

        el.innerHTML = `
          ${summaryTableHtml}
          <hr style="margin:var(--space-4) 0; border:none; border-top:2px solid var(--color-border);">
          ${classTablesHtml}
          <div class="summary-actions" style="margin-top:var(--space-5);">
            <button class="btn" id="all-daily-pdf-btn">📄 Save PDF</button>
            <button class="btn btn--whatsapp" id="all-daily-wa-btn">📤 Share via WhatsApp</button>
          </div>
        `;

        loadPdfLibs().catch(() => {});

        el.querySelector("#all-daily-pdf-btn").addEventListener("click", async () => {
          await withLoadingBtn(el.querySelector("#all-daily-pdf-btn"), "Generating…", async () => {
            await loadPdfLibs();
            const blob = generateAllClassesPdf({
              college, date,
              classes: found.map(({ scopeId, record }) => ({
                scopeLabel: scopeLabel(scopeId),
                records: record.records || [],
                markedBy: record.markedBy,
                presentCount: record.presentCount || 0,
                absentCount: record.absentCount || 0,
                totalCount: record.totalCount || 0,
              })),
            });
            triggerDownload(blob, `attendance-all-classes-${date}.pdf`);
          });
        });

        el.querySelector("#all-daily-wa-btn").addEventListener("click", async () => {
          await withLoadingBtn(el.querySelector("#all-daily-wa-btn"), "Sharing…", async () => {
            const lines = [`📋 *Attendance Report*`, `Date: ${formatDateDMY(date)}`, ``];
            for (const { scopeId, record } of found) {
              const { presentCount = 0, absentCount = 0, totalCount = 0, records = [] } = record;
              const absentList = records.filter((r) => r.status === "absent");
              lines.push(`*${scopeLabel(scopeId)}*`);
              lines.push(`Present: ${presentCount} / ${totalCount}   Absent: ${absentCount}`);
              absentList.forEach((s, i) => {
                const remark = s.remarks ? ` (${s.remarks})` : "";
                lines.push(`  ${i + 1}. ${s.name} — ${s.regNo}${remark}`);
              });
              lines.push(``);
            }
            lines.push(`─────────────────`);
            lines.push(`*📊 Combined Total (${found.length} classes)*`);
            lines.push(`Present: ${grandPresent} / ${grandTotal}`);
            lines.push(`Absent:  ${grandAbsent} / ${grandTotal}`);
            if (missing.length > 0) lines.push(``, `⚠️ Not yet marked: ${missing.join(", ")}`);
            window.open(`https://wa.me/?text=${encodeURIComponent(lines.join("\n"))}`, "_blank", "noopener,noreferrer");
          });
        });

      } catch (err) {
        el.innerHTML = `<div class="msg msg--err">Could not load records: ${escapeHtml(err.message)}</div>`;
      }
    }

    // ── Monthly tab ─────────────────────────────────────────────────
    function renderAllMonthly(el) {
      function mLabel(ms) {
        return new Date(ms.year, ms.month - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
      }
      function prevM(ms) { return ms.month === 1 ? { year: ms.year - 1, month: 12 } : { year: ms.year, month: ms.month - 1 }; }
      function nextM(ms) { return ms.month === 12 ? { year: ms.year + 1, month: 1 } : { year: ms.year, month: ms.month + 1 }; }

      el.innerHTML = `
        <div class="month-nav">
          <button class="btn btn--secondary month-nav__btn" id="all-month-prev">‹</button>
          <span class="month-nav__label" id="all-month-label">${mLabel(monthState)}</span>
          <button class="btn btn--secondary month-nav__btn" id="all-month-next">›</button>
        </div>
        <div id="all-monthly-grid"><p class="status">Loading…</p></div>
      `;
      el.querySelector("#all-month-prev").addEventListener("click", () => {
        monthState = prevM(monthState);
        el.querySelector("#all-month-label").textContent = mLabel(monthState);
        loadAllMonthlyGrid(el.querySelector("#all-monthly-grid"));
      });
      el.querySelector("#all-month-next").addEventListener("click", () => {
        monthState = nextM(monthState);
        el.querySelector("#all-month-label").textContent = mLabel(monthState);
        loadAllMonthlyGrid(el.querySelector("#all-monthly-grid"));
      });
      loadAllMonthlyGrid(el.querySelector("#all-monthly-grid"));
    }

    async function loadAllMonthlyGrid(gridEl) {
      gridEl.innerHTML = `<p class="status">Loading…</p>`;
      const { year, month } = monthState;
      const padM = String(month).padStart(2, "0");
      const monthPrefix = `${year}-${padM}-`;
      const mLabelStr = new Date(year, month - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

      try {
        const [collegeSnap, holidays, ...scopeResults] = await Promise.all([
          getDoc(doc(db, "college", "main")),
          fetchHolidaysForMonth({ category: profile.category, year, month }),
          ...profile.scopeIds.map(async (scopeId) => {
            const q = query(
              collection(db, "attendanceRecords"),
              where("category", "==", profile.category),
              where("scopeId", "==", scopeId)
            );
            const [snap, rosterResult] = await Promise.all([
              getDocs(q),
              fetchRoster({ category: profile.category, scopeId }),
            ]);
            const records = [];
            snap.forEach((d) => {
              const data = d.data();
              if (data.date && data.date.startsWith(monthPrefix)) records.push(data);
            });
            const students = rosterResult.students || rosterResult.groups?.flatMap((g) => g.students) || [];
            return { scopeId, records, students };
          }),
        ]);
        const college = collegeSnap.exists() ? collegeSnap.data() : null;

        // Collect all unique days across all scopes, unioned with
        // holiday days so a holiday with zero marked attendance still
        // shows up greyed out instead of vanishing entirely.
        const allDays = [...new Set([
          ...scopeResults.flatMap(({ records }) => records.map((r) => Number(r.date.slice(8)))),
          ...holidays.keys(),
        ])].sort((a, b) => a - b);

        if (allDays.length === 0) {
          gridEl.innerHTML = `<div class="msg msg--warn" style="margin-top:var(--space-4);">No records found for ${mLabelStr}.</div>`;
          return;
        }

        // Build per-scope grids and totals
        const scopeGrids = scopeResults.map(({ scopeId, records, students }) => {
          const statusGrid = new Map();
          for (const s of students) statusGrid.set(s.regNo, new Map());
          for (const rec of records) {
            const day = Number(rec.date.slice(8));
            for (const entry of rec.records || []) {
              statusGrid.get(entry.regNo)?.set(day, entry.status);
            }
          }
          const studentTotals = new Map();
          for (const s of students) {
            let present = 0, absent = 0;
            for (const day of allDays) {
              if (holidays.has(day)) continue; // holidays don't count toward % denominator
              const st = statusGrid.get(s.regNo)?.get(day);
              if (st === "present") present++;
              else if (st === "absent") absent++;
            }
            const total = present + absent;
            studentTotals.set(s.regNo, { present, absent, pct: total > 0 ? Math.round((present / total) * 100) : 0 });
          }
          return { scopeId, students, statusGrid, studentTotals };
        });

        // Build combined day totals
        const combinedDayTotals = {};
        for (const day of allDays) {
          if (holidays.has(day)) continue;
          let p = 0, a = 0;
          for (const { students, statusGrid } of scopeGrids) {
            for (const s of students) {
              const st = statusGrid.get(s.regNo)?.get(day);
              if (st === "present") p++;
              else if (st === "absent") a++;
            }
          }
          combinedDayTotals[day] = { present: p, absent: a };
        }

        // Build HTML: one section per class
        const classGridsHtml = scopeGrids.map(({ scopeId, students, statusGrid, studentTotals }) => {
          const label = scopeLabel(scopeId);
          const dayTotals = {};
          for (const day of allDays) {
            if (holidays.has(day)) continue;
            let p = 0, a = 0;
            for (const s of students) {
              const st = statusGrid.get(s.regNo)?.get(day);
              if (st === "present") p++;
              else if (st === "absent") a++;
            }
            dayTotals[day] = { present: p, absent: a };
          }
          const rows = students.map((s) => {
            const cells = allDays.map((d) => {
              if (holidays.has(d)) return `<td class="monthly-cell--holiday" title="${escapeHtml(holidays.get(d).label || "Holiday")}">H</td>`;
              const st = statusGrid.get(s.regNo)?.get(d);
              if (st === "present") return `<td class="monthly-cell--present">P</td>`;
              if (st === "absent")  return `<td class="monthly-cell--absent">A</td>`;
              return `<td class="monthly-cell--none">—</td>`;
            }).join("");
            const tot = studentTotals.get(s.regNo) || { present: 0, absent: 0, pct: 0 };
            return `<tr>
              <td class="monthly-col--name">${escapeHtml(s.name)}</td>
              <td class="monthly-col--reg">${escapeHtml(s.regNo)}</td>
              ${cells}
              <td class="monthly-col--total" style="color:var(--color-success-text); font-weight:700;">${tot.present}</td>
              <td class="monthly-col--total" style="color:var(--color-danger-text); font-weight:700;">${tot.absent}</td>
              <td class="monthly-col--total ${tot.pct < 75 ? "monthly-pct--low" : ""}">${tot.pct}%</td>
            </tr>`;
          }).join("");

          return `
            <div style="margin-bottom:var(--space-6);">
              <h3 style="margin-bottom:var(--space-3);">${escapeHtml(label)}</h3>
              <div class="monthly-table-wrap">
                <table class="summary-table monthly-table">
                  <thead>
                    <tr>
                      <th class="monthly-col--name">Name</th>
                      <th class="monthly-col--reg">Reg</th>
                      ${allDays.map((d) => `<th class="monthly-col--day ${holidays.has(d) ? "monthly-col--holiday" : ""}" ${holidays.has(d) ? `title="${escapeHtml(holidays.get(d).label || "Holiday")}"` : ""}>${d}</th>`).join("")}
                      <th class="monthly-col--total">P</th>
                      <th class="monthly-col--total">A</th>
                      <th class="monthly-col--total">%</th>
                    </tr>
                  </thead>
                  <tbody>${rows}</tbody>
                  <tfoot>
                    <tr>
                      <td colspan="2" style="font-weight:700; font-size:var(--font-size-sm);">Present</td>
                      ${allDays.map((d) => holidays.has(d) ? `<td class="monthly-cell--holiday"></td>` : `<td class="monthly-cell--present">${dayTotals[d]?.present ?? "—"}</td>`).join("")}
                      <td colspan="3"></td>
                    </tr>
                    <tr>
                      <td colspan="2" style="font-weight:700; font-size:var(--font-size-sm);">Absent</td>
                      ${allDays.map((d) => holidays.has(d) ? `<td class="monthly-cell--holiday"></td>` : `<td class="monthly-cell--absent">${dayTotals[d]?.absent ?? "—"}</td>`).join("")}
                      <td colspan="3"></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>`;
        }).join(`<hr style="margin:var(--space-4) 0; border:none; border-top:2px solid var(--color-border);">`);

        // Combined day totals footer table
        const combinedFooterHtml = `
          <div class="card" style="margin:var(--space-4) 0; background:var(--color-surface-raised);">
            <h3 style="margin-bottom:var(--space-3); text-align:center;">📊 Combined Daily Totals — ${mLabelStr}</h3>
            <div class="monthly-table-wrap">
              <table class="summary-table monthly-table">
                <thead>
                  <tr>
                    <th style="text-align:left;">Status</th>
                    ${allDays.map((d) => `<th class="monthly-col--day ${holidays.has(d) ? "monthly-col--holiday" : ""}">${d}</th>`).join("")}
                    <th class="monthly-col--total">Total</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style="font-weight:700; color:var(--color-success-text);">Present</td>
                    ${allDays.map((d) => holidays.has(d) ? `<td class="monthly-cell--holiday"></td>` : `<td class="monthly-cell--present">${combinedDayTotals[d]?.present ?? "—"}</td>`).join("")}
                    <td class="monthly-col--total" style="font-weight:700; color:var(--color-success-text);">
                      ${allDays.reduce((s, d) => s + (combinedDayTotals[d]?.present || 0), 0)}
                    </td>
                  </tr>
                  <tr>
                    <td style="font-weight:700; color:var(--color-danger-text);">Absent</td>
                    ${allDays.map((d) => holidays.has(d) ? `<td class="monthly-cell--holiday"></td>` : `<td class="monthly-cell--absent">${combinedDayTotals[d]?.absent ?? "—"}</td>`).join("")}
                    <td class="monthly-col--total" style="font-weight:700; color:var(--color-danger-text);">
                      ${allDays.reduce((s, d) => s + (combinedDayTotals[d]?.absent || 0), 0)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>`;

        gridEl.innerHTML = `
          ${classGridsHtml}
          <hr style="margin:var(--space-4) 0; border:none; border-top:2px solid var(--color-border);">
          ${combinedFooterHtml}
          <div class="summary-actions" style="margin-top:var(--space-4);">
            <button class="btn" id="all-monthly-pdf-btn">📄 Save PDF</button>
            <button class="btn btn--whatsapp" id="all-monthly-wa-btn">📤 Share via WhatsApp</button>
          </div>
        `;

        loadPdfLibs().catch(() => {});

        gridEl.querySelector("#all-monthly-pdf-btn").addEventListener("click", async () => {
          await withLoadingBtn(gridEl.querySelector("#all-monthly-pdf-btn"), "Generating…", async () => {
            await loadPdfLibs();
            const blob = generateAllClassesMonthlyPdf({
              college,
              monthLabel: mLabelStr,
              scopeGrids,
              allDays,
              combinedDayTotals,
              year,
              month,
              holidays,
            });
            triggerDownload(blob, `attendance-all-classes-${year}-${padM}.pdf`);
          });
        });

        gridEl.querySelector("#all-monthly-wa-btn").addEventListener("click", async () => {
          await withLoadingBtn(gridEl.querySelector("#all-monthly-wa-btn"), "Sharing…", async () => {
            const lines = [`📊 *Monthly Attendance — ${mLabelStr}*`, `Working days: ${allDays.length}`, ``];
            for (const { scopeId, students, studentTotals } of scopeGrids) {
              lines.push(`*${scopeLabel(scopeId)}* (${students.length} students)`);
              const low = students
                .map((s) => ({ ...s, ...(studentTotals.get(s.regNo) || {}) }))
                .filter((s) => s.pct < 75)
                .sort((a, b) => a.pct - b.pct);
              if (low.length > 0) {
                lines.push(`Below 75%:`);
                low.forEach((s, i) => lines.push(`  ${i + 1}. ${s.name} — ${s.pct}%`));
              } else {
                lines.push(`✅ All above 75%`);
              }
              lines.push(``);
            }
            lines.push(`─────────────────`);
            const totalP = allDays.reduce((s, d) => s + (combinedDayTotals[d]?.present || 0), 0);
            const totalA = allDays.reduce((s, d) => s + (combinedDayTotals[d]?.absent || 0), 0);
            lines.push(`*📊 Combined (${scopeGrids.length} classes)*`);
            lines.push(`Total Present: ${totalP}   Total Absent: ${totalA}`);
            window.open(`https://wa.me/?text=${encodeURIComponent(lines.join("\n"))}`, "_blank", "noopener,noreferrer");
          });
        });

      } catch (err) {
        gridEl.innerHTML = `<div class="msg msg--err">Could not load: ${escapeHtml(err.message)}</div>`;
      }
    }
  }

  function renderHostelSummaryScreen() {
    const today = new Date();
    let activeTab = "daily";
    let monthState = { year: today.getFullYear(), month: today.getMonth() + 1 };
    const hostelScopeId = profile.scopeIds[0];
    if (!state.hostelSummaryDailyDate) state.hostelSummaryDailyDate = todayLocalDate();

    function prevDay(iso) {
      const [y, m, d] = iso.split("-").map(Number);
      const dt = new Date(y, m - 1, d - 1);
      return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
    }
    function nextDay(iso) {
      const [y, m, d] = iso.split("-").map(Number);
      const dt = new Date(y, m - 1, d + 1);
      return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
    }

    function renderShell() {
      container.innerHTML = `
        <div class="page summary-page" style="padding-bottom:6rem;">
          <div class="row row--between" style="margin-bottom:var(--space-4);">
            <button class="btn btn--secondary" id="hostel-back-btn"
              style="min-height:auto; padding:var(--space-2) var(--space-3); font-size:var(--font-size-sm);">
              ← Back
            </button>
            <span class="status" style="margin:0;">Hostel</span>
          </div>
          <div class="summary-tabs" role="tablist">
            <button class="summary-tab ${activeTab === "daily" ? "summary-tab--active" : ""}"
              data-tab="daily" role="tab">Daily</button>
            <button class="summary-tab ${activeTab === "monthly" ? "summary-tab--active" : ""}"
              data-tab="monthly" role="tab">Monthly</button>
          </div>
          <div id="hostel-tab-content"><p class="status">Loading…</p></div>
        </div>
      `;
      container.querySelector("#hostel-back-btn").addEventListener("click", () => {
        state.screen = "roster";
        render();
      });
      container.querySelectorAll(".summary-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
          activeTab = btn.dataset.tab;
          renderShell();
        });
      });
      const tabContent = container.querySelector("#hostel-tab-content");
      if (activeTab === "daily") renderHostelDaily(tabContent);
      else renderHostelMonthly(tabContent);
    }

    renderShell();

    // ── Daily tab ───────────────────────────────────────────────────
    function renderHostelDaily(el) {
      const today = todayLocalDate();
      const isToday = state.hostelSummaryDailyDate >= today;

      el.innerHTML = `
        <div class="month-nav" style="margin-bottom:var(--space-3);">
          <button class="btn btn--secondary month-nav__btn" id="hostel-day-prev">‹</button>
          <span class="month-nav__label" id="hostel-day-label">${formatDateDMY(state.hostelSummaryDailyDate)}</span>
          <button class="btn btn--secondary month-nav__btn" id="hostel-day-next"
            ${isToday ? "disabled" : ""}
            style="${isToday ? "opacity:0.4; cursor:not-allowed;" : ""}">›</button>
        </div>
        <div id="hostel-daily-records"><p class="status">Loading…</p></div>
      `;

      el.querySelector("#hostel-day-prev").addEventListener("click", () => {
        state.hostelSummaryDailyDate = prevDay(state.hostelSummaryDailyDate);
        renderHostelDaily(el);
      });
      el.querySelector("#hostel-day-next").addEventListener("click", () => {
        const t = todayLocalDate();
        if (state.hostelSummaryDailyDate < t) {
          state.hostelSummaryDailyDate = nextDay(state.hostelSummaryDailyDate);
          renderHostelDaily(el);
        }
      });

      loadHostelDailyRecord(el.querySelector("#hostel-daily-records"), state.hostelSummaryDailyDate);
    }

    async function loadHostelDailyRecord(el, date) {
      el.innerHTML = `<p class="status">Loading hostel record…</p>`;
      try {
        const recordId = buildRecordId({ category: "hostel", scopeId: hostelScopeId, date });
        const [collegeSnap, recordSnap] = await Promise.all([
          getDoc(doc(db, "college", "main")),
          getDoc(doc(db, "attendanceRecords", recordId)),
        ]);
        const college = collegeSnap.exists() ? collegeSnap.data() : null;

        if (!recordSnap.exists()) {
          el.innerHTML = `<div class="msg msg--warn">No record saved yet for ${formatDateDMY(date)}.<br>Mark attendance first, then come back here.</div>`;
          return;
        }
        const record = recordSnap.data();
        const allRecords = record.records || [];

        // Group this single hostel record's students by hostel type
        // (Hindi / Tamil) first, then by year within each type — the
        // hostel equivalent of "one class per scope" in the All
        // Classes summary, since hostel has one scope but the roster
        // is naturally split by type and then by year.
        const byType = new Map();
        for (const r of allRecords) {
          const key = r.hostelType || "Other";
          if (!byType.has(key)) byType.set(key, []);
          byType.get(key).push(r);
        }
        const typeKeys = Array.from(byType.keys()).sort((a, b) => {
          const ia = HOSTEL_TYPE_ORDER.indexOf(a);
          const ib = HOSTEL_TYPE_ORDER.indexOf(b);
          if (ia !== -1 && ib !== -1) return ia - ib;
          if (ia !== -1) return -1;
          if (ib !== -1) return 1;
          return a.localeCompare(b);
        });

        function yearGroupsFor(records) {
          const byYear = new Map();
          for (const r of records) {
            const key = r.year || "Other";
            if (!byYear.has(key)) byYear.set(key, []);
            byYear.get(key).push(r);
          }
          const yearKeys = Array.from(byYear.keys()).sort((a, b) => {
            const ra = ORDINAL_MAP[(a || "").toLowerCase()];
            const rb = ORDINAL_MAP[(b || "").toLowerCase()];
            if (ra && rb) return Object.values(ORDINAL_MAP).indexOf(ra) - Object.values(ORDINAL_MAP).indexOf(rb);
            if (ra) return -1;
            if (rb) return 1;
            return (a || "").localeCompare(b || "");
          });
          return yearKeys.map((year) => {
            const yrecords = byYear.get(year).slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
            const presentCount = yrecords.filter((r) => r.status === "present").length;
            const absentCount = yrecords.filter((r) => r.status === "absent").length;
            return {
              year,
              label: yearGroupLabel(year),
              records: yrecords,
              presentCount,
              absentCount,
              totalCount: yrecords.length,
            };
          });
        }

        // typeGroups: [{ type, label, yearGroups: [...], presentCount, absentCount, totalCount }]
        const typeGroups = typeKeys.map((type) => {
          const yearGroups = yearGroupsFor(byType.get(type));
          const presentCount = yearGroups.reduce((s, g) => s + g.presentCount, 0);
          const absentCount = yearGroups.reduce((s, g) => s + g.absentCount, 0);
          const totalCount = yearGroups.reduce((s, g) => s + g.totalCount, 0);
          return { type, label: type, yearGroups, presentCount, absentCount, totalCount, markedBy: record.markedBy };
        });

        // Flat year-group list with type-qualified labels — used by
        // the PDF (one page per group) and kept for backward-shaped
        // data passing into generateHostelDailyPdf.
        const yearGroups = typeGroups.flatMap((tg) =>
          tg.yearGroups.map((g) => ({ ...g, label: `${tg.label} — ${g.label}`, markedBy: record.markedBy }))
        );

        const grandPresent = record.presentCount ?? typeGroups.reduce((s, g) => s + g.presentCount, 0);
        const grandAbsent  = record.absentCount  ?? typeGroups.reduce((s, g) => s + g.absentCount,  0);
        const grandTotal   = record.totalCount   ?? typeGroups.reduce((s, g) => s + g.totalCount,   0);

        // Summary card — today's hostel-wide totals, type-wise then year-wise
        const summaryRowsHtml = typeGroups.map((tg) => `
          <tr style="background:var(--color-surface-raised);">
            <td style="font-weight:700;">${escapeHtml(tg.label)} Hostel</td>
            <td style="text-align:center; color:var(--color-success-text); font-weight:700;">${tg.presentCount}</td>
            <td style="text-align:center; color:var(--color-danger-text); font-weight:700;">${tg.absentCount}</td>
            <td style="text-align:center; font-weight:700;">${tg.totalCount}</td>
          </tr>
          ${tg.yearGroups.map((g) => `
            <tr>
              <td style="font-weight:600; padding-left:var(--space-4); color:var(--color-text-muted);">${escapeHtml(g.label)}</td>
              <td style="text-align:center; color:var(--color-success-text);">${g.presentCount}</td>
              <td style="text-align:center; color:var(--color-danger-text);">${g.absentCount}</td>
              <td style="text-align:center;">${g.totalCount}</td>
            </tr>`).join("")}
        `).join("");

        const summaryTableHtml = `
          <div class="card" style="margin-bottom:var(--space-5); background:var(--color-surface-raised);">
            <h3 style="margin-bottom:var(--space-3); text-align:center;">📊 Hostel — ${formatDateDMY(date)}</h3>
            <div class="summary-table-wrap">
              <table class="summary-table">
                <thead><tr><th>Type / Year</th><th>Present</th><th>Absent</th><th>Total</th></tr></thead>
                <tbody>${summaryRowsHtml}</tbody>
                <tfoot>
                  <tr style="font-weight:700; background:var(--color-surface);">
                    <td>Combined</td>
                    <td style="text-align:center; color:var(--color-success-text);">${grandPresent}</td>
                    <td style="text-align:center; color:var(--color-danger-text);">${grandAbsent}</td>
                    <td style="text-align:center;">${grandTotal}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>`;

        // Per-type, per-year detail tables
        const yearTablesHtml = typeGroups.map((tg) => `
          <h3 style="margin-bottom:var(--space-3);">${escapeHtml(tg.label)} Hostel</h3>
          ${tg.yearGroups.map((g) => {
            const rows = g.records.map((r, i) => `
              <tr class="${r.status === "absent" ? "summary-row--absent" : ""}">
                <td>${i + 1}</td>
                <td>${escapeHtml(r.name)}</td>
                <td>${escapeHtml(r.regNo)}</td>
                <td class="summary-status summary-status--${r.status}">${r.status === "present" ? "Present" : "Absent"}</td>
                <td>${escapeHtml(r.remarks || "")}</td>
              </tr>`).join("");
            return `
              <div style="margin-bottom:var(--space-6);">
                <h4 style="margin-bottom:var(--space-2);">${escapeHtml(g.label)}</h4>
                <div class="summary-counts card" style="display:flex; gap:var(--space-5); justify-content:center; text-align:center; margin-bottom:var(--space-3);">
                  <div><div style="font-size:var(--font-size-2xl); font-weight:700; color:var(--color-success-text);">${g.presentCount}</div><div style="font-size:var(--font-size-sm); color:var(--color-text-muted);">Present</div></div>
                  <div><div style="font-size:var(--font-size-2xl); font-weight:700; color:var(--color-danger-text);">${g.absentCount}</div><div style="font-size:var(--font-size-sm); color:var(--color-text-muted);">Absent</div></div>
                  <div><div style="font-size:var(--font-size-2xl); font-weight:700; color:var(--color-text-muted);">${g.totalCount}</div><div style="font-size:var(--font-size-sm); color:var(--color-text-muted);">Total</div></div>
                </div>
                <div class="summary-table-wrap">
                  <table class="summary-table">
                    <thead><tr><th>#</th><th>Name</th><th>Reg. No.</th><th>Status</th><th>Remarks</th></tr></thead>
                    <tbody>${rows}</tbody>
                  </table>
                </div>
              </div>`;
          }).join("")}
        `).join(`<hr style="margin:var(--space-4) 0; border:none; border-top:2px solid var(--color-border);">`);

        el.innerHTML = `
          ${summaryTableHtml}
          <hr style="margin:var(--space-4) 0; border:none; border-top:2px solid var(--color-border);">
          ${yearTablesHtml}
          ${record.markedBy ? `<p class="status" style="margin-top:var(--space-2);">Marked by: ${escapeHtml(record.markedBy.name)} (${escapeHtml(record.markedBy.staffId)})</p>` : ""}
          <div class="summary-actions" style="margin-top:var(--space-5);">
            <button class="btn" id="hostel-daily-pdf-btn">📄 Save PDF</button>
            <button class="btn btn--whatsapp" id="hostel-daily-wa-btn">📤 Share via WhatsApp</button>
          </div>
        `;

        loadPdfLibs().catch(() => {});

        el.querySelector("#hostel-daily-pdf-btn").addEventListener("click", async () => {
          await withLoadingBtn(el.querySelector("#hostel-daily-pdf-btn"), "Generating…", async () => {
            await loadPdfLibs();
            const blob = generateHostelDailyPdf({ college, date, yearGroups });
            triggerDownload(blob, `attendance-hostel-${date}.pdf`);
          });
        });

        el.querySelector("#hostel-daily-wa-btn").addEventListener("click", async () => {
          await withLoadingBtn(el.querySelector("#hostel-daily-wa-btn"), "Sharing…", async () => {
            const lines = [`📋 *Hostel Attendance Report*`, `Date: ${formatDateDMY(date)}`, ``];
            for (const tg of typeGroups) {
              lines.push(`*${tg.label} Hostel* — Present: ${tg.presentCount} / ${tg.totalCount}   Absent: ${tg.absentCount}`);
              for (const g of tg.yearGroups) {
                const absentList = g.records.filter((r) => r.status === "absent");
                lines.push(`  *${g.label}* — Present: ${g.presentCount} / ${g.totalCount}   Absent: ${g.absentCount}`);
                absentList.forEach((s, i) => {
                  const remark = s.remarks ? ` (${s.remarks})` : "";
                  lines.push(`    ${i + 1}. ${s.name} — ${s.regNo}${remark}`);
                });
              }
              lines.push(``);
            }
            lines.push(`─────────────────`);
            lines.push(`*📊 Combined Total (${typeGroups.length} hostel types)*`);
            lines.push(`Present: ${grandPresent} / ${grandTotal}`);
            lines.push(`Absent:  ${grandAbsent} / ${grandTotal}`);
            window.open(`https://wa.me/?text=${encodeURIComponent(lines.join("\n"))}`, "_blank", "noopener,noreferrer");
          });
        });

      } catch (err) {
        el.innerHTML = `<div class="msg msg--err">Could not load record: ${escapeHtml(err.message)}</div>`;
      }
    }

    // ── Monthly tab ─────────────────────────────────────────────────
    function renderHostelMonthly(el) {
      function mLabel(ms) {
        return new Date(ms.year, ms.month - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
      }
      function prevM(ms) { return ms.month === 1 ? { year: ms.year - 1, month: 12 } : { year: ms.year, month: ms.month - 1 }; }
      function nextM(ms) { return ms.month === 12 ? { year: ms.year + 1, month: 1 } : { year: ms.year, month: ms.month + 1 }; }

      el.innerHTML = `
        <div class="month-nav">
          <button class="btn btn--secondary month-nav__btn" id="hostel-month-prev">‹</button>
          <span class="month-nav__label" id="hostel-month-label">${mLabel(monthState)}</span>
          <button class="btn btn--secondary month-nav__btn" id="hostel-month-next">›</button>
        </div>
        <div id="hostel-monthly-grid"><p class="status">Loading…</p></div>
      `;
      el.querySelector("#hostel-month-prev").addEventListener("click", () => {
        monthState = prevM(monthState);
        el.querySelector("#hostel-month-label").textContent = mLabel(monthState);
        loadHostelMonthlyGrid(el.querySelector("#hostel-monthly-grid"));
      });
      el.querySelector("#hostel-month-next").addEventListener("click", () => {
        monthState = nextM(monthState);
        el.querySelector("#hostel-month-label").textContent = mLabel(monthState);
        loadHostelMonthlyGrid(el.querySelector("#hostel-monthly-grid"));
      });
      loadHostelMonthlyGrid(el.querySelector("#hostel-monthly-grid"));
    }

    async function loadHostelMonthlyGrid(gridEl) {
      gridEl.innerHTML = `<p class="status">Loading…</p>`;
      const { year, month } = monthState;
      const padM = String(month).padStart(2, "0");
      const monthPrefix = `${year}-${padM}-`;
      const mLabelStr = new Date(year, month - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

      try {
        const [collegeSnap, q, rosterResult] = await Promise.all([
          getDoc(doc(db, "college", "main")),
          getDocs(query(
            collection(db, "attendanceRecords"),
            where("category", "==", "hostel"),
            where("scopeId", "==", hostelScopeId)
          )),
          fetchRoster({ category: "hostel", scopeId: hostelScopeId }),
        ]);
        const college = collegeSnap.exists() ? collegeSnap.data() : null;

        const monthRecords = [];
        q.forEach((d) => {
          const data = d.data();
          if (data.date && data.date.startsWith(monthPrefix)) monthRecords.push(data);
        });

        const allDays = [...new Set(monthRecords.map((r) => Number(r.date.slice(8))))].sort((a, b) => a - b);

        if (allDays.length === 0) {
          gridEl.innerHTML = `<div class="msg msg--warn" style="margin-top:var(--space-4);">No records found for ${mLabelStr}.</div>`;
          return;
        }

        const allStudents = rosterResult.students || [];
        const typeGroupsBase = groupByHostelTypeAndYear(allStudents);

        // Flat list of {year, label, students} — same shape the PDF
        // generator already expects (one page per entry) — but each
        // label is now type-qualified (e.g. "Hindi — First Year") and
        // built in Hindi-then-Tamil-then-year order via
        // groupByHostelTypeAndYear, instead of plain year order.
        const yearGroupsBase = typeGroupsBase.flatMap((tg) =>
          tg.yearGroups.map((g) => ({ ...g, label: `${tg.type} — ${yearGroupLabel(g.year)}`, hostelTypeLabel: tg.type }))
        );

        // Build per-year status grids and totals
        const yearGrids = yearGroupsBase.map(({ year: y, label, hostelTypeLabel, students }) => {
          const statusGrid = new Map();
          for (const s of students) statusGrid.set(s.regNo, new Map());
          for (const rec of monthRecords) {
            const day = Number(rec.date.slice(8));
            for (const entry of rec.records || []) {
              if (statusGrid.has(entry.regNo)) statusGrid.get(entry.regNo).set(day, entry.status);
            }
          }
          const studentTotals = new Map();
          for (const s of students) {
            let present = 0, absent = 0;
            for (const day of allDays) {
              const st = statusGrid.get(s.regNo)?.get(day);
              if (st === "present") present++;
              else if (st === "absent") absent++;
            }
            const total = present + absent;
            studentTotals.set(s.regNo, { present, absent, pct: total > 0 ? Math.round((present / total) * 100) : 0 });
          }
          return { year: y, label, hostelTypeLabel, students, statusGrid, studentTotals };
        });

        // Combined day totals across all years
        const combinedDayTotals = {};
        for (const day of allDays) {
          let p = 0, a = 0;
          for (const { students, statusGrid } of yearGrids) {
            for (const s of students) {
              const st = statusGrid.get(s.regNo)?.get(day);
              if (st === "present") p++;
              else if (st === "absent") a++;
            }
          }
          combinedDayTotals[day] = { present: p, absent: a };
        }

        // Build HTML: one section per year group, with a type-level
        // heading inserted whenever the hostel type changes (Hindi
        // sections all appear before Tamil sections, per group order).
        let lastTypeLabel = null;
        const yearGridsHtml = yearGrids.map(({ label, hostelTypeLabel, students, statusGrid, studentTotals }) => {
          const dayTotals = {};
          for (const day of allDays) {
            let p = 0, a = 0;
            for (const s of students) {
              const st = statusGrid.get(s.regNo)?.get(day);
              if (st === "present") p++;
              else if (st === "absent") a++;
            }
            dayTotals[day] = { present: p, absent: a };
          }
          const rows = students.map((s) => {
            const cells = allDays.map((d) => {
              const st = statusGrid.get(s.regNo)?.get(d);
              if (st === "present") return `<td class="monthly-cell--present">P</td>`;
              if (st === "absent")  return `<td class="monthly-cell--absent">A</td>`;
              return `<td class="monthly-cell--none">—</td>`;
            }).join("");
            const tot = studentTotals.get(s.regNo) || { present: 0, absent: 0, pct: 0 };
            return `<tr>
              <td class="monthly-col--name">${escapeHtml(s.name)}</td>
              <td class="monthly-col--reg">${escapeHtml(s.regNo)}</td>
              ${cells}
              <td class="monthly-col--total" style="color:var(--color-success-text); font-weight:700;">${tot.present}</td>
              <td class="monthly-col--total" style="color:var(--color-danger-text); font-weight:700;">${tot.absent}</td>
              <td class="monthly-col--total ${tot.pct < 75 ? "monthly-pct--low" : ""}">${tot.pct}%</td>
            </tr>`;
          }).join("");

          const typeHeaderHtml = hostelTypeLabel !== lastTypeLabel
            ? `<h2 style="margin: var(--space-5) 0 var(--space-3); padding-bottom:var(--space-2); border-bottom:2px solid var(--accent);">${escapeHtml(hostelTypeLabel)} Hostel</h2>`
            : "";
          lastTypeLabel = hostelTypeLabel;

          return `
            ${typeHeaderHtml}
            <div style="margin-bottom:var(--space-6);">
              <h3 style="margin-bottom:var(--space-3);">${escapeHtml(label)}</h3>
              <div class="monthly-table-wrap">
                <table class="summary-table monthly-table">
                  <thead>
                    <tr>
                      <th class="monthly-col--name">Name</th>
                      <th class="monthly-col--reg">Reg</th>
                      ${allDays.map((d) => `<th class="monthly-col--day">${d}</th>`).join("")}
                      <th class="monthly-col--total">P</th>
                      <th class="monthly-col--total">A</th>
                      <th class="monthly-col--total">%</th>
                    </tr>
                  </thead>
                  <tbody>${rows}</tbody>
                  <tfoot>
                    <tr>
                      <td colspan="2" style="font-weight:700; font-size:var(--font-size-sm);">Present</td>
                      ${allDays.map((d) => `<td class="monthly-cell--present">${dayTotals[d]?.present ?? "—"}</td>`).join("")}
                      <td colspan="3"></td>
                    </tr>
                    <tr>
                      <td colspan="2" style="font-weight:700; font-size:var(--font-size-sm);">Absent</td>
                      ${allDays.map((d) => `<td class="monthly-cell--absent">${dayTotals[d]?.absent ?? "—"}</td>`).join("")}
                      <td colspan="3"></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>`;
        }).join(`<hr style="margin:var(--space-4) 0; border:none; border-top:2px solid var(--color-border);">`);

        // Combined day totals footer table
        const combinedFooterHtml = `
          <div class="card" style="margin:var(--space-4) 0; background:var(--color-surface-raised);">
            <h3 style="margin-bottom:var(--space-3); text-align:center;">📊 Combined Daily Totals — ${mLabelStr}</h3>
            <div class="monthly-table-wrap">
              <table class="summary-table monthly-table">
                <thead>
                  <tr>
                    <th style="text-align:left;">Status</th>
                    ${allDays.map((d) => `<th class="monthly-col--day">${d}</th>`).join("")}
                    <th class="monthly-col--total">Total</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style="font-weight:700; color:var(--color-success-text);">Present</td>
                    ${allDays.map((d) => `<td class="monthly-cell--present">${combinedDayTotals[d]?.present ?? "—"}</td>`).join("")}
                    <td class="monthly-col--total" style="font-weight:700; color:var(--color-success-text);">
                      ${allDays.reduce((s, d) => s + (combinedDayTotals[d]?.present || 0), 0)}
                    </td>
                  </tr>
                  <tr>
                    <td style="font-weight:700; color:var(--color-danger-text);">Absent</td>
                    ${allDays.map((d) => `<td class="monthly-cell--absent">${combinedDayTotals[d]?.absent ?? "—"}</td>`).join("")}
                    <td class="monthly-col--total" style="font-weight:700; color:var(--color-danger-text);">
                      ${allDays.reduce((s, d) => s + (combinedDayTotals[d]?.absent || 0), 0)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>`;

        gridEl.innerHTML = `
          ${yearGridsHtml}
          <hr style="margin:var(--space-4) 0; border:none; border-top:2px solid var(--color-border);">
          ${combinedFooterHtml}
          <div class="summary-actions" style="margin-top:var(--space-4);">
            <button class="btn" id="hostel-monthly-pdf-btn">📄 Save PDF</button>
            <button class="btn btn--whatsapp" id="hostel-monthly-wa-btn">📤 Share via WhatsApp</button>
          </div>
        `;

        loadPdfLibs().catch(() => {});

        gridEl.querySelector("#hostel-monthly-pdf-btn").addEventListener("click", async () => {
          await withLoadingBtn(gridEl.querySelector("#hostel-monthly-pdf-btn"), "Generating…", async () => {
            await loadPdfLibs();
            const blob = generateHostelMonthlyPdf({
              college,
              monthLabel: mLabelStr,
              yearGrids,
              allDays,
              year,
              month,
            });
            triggerDownload(blob, `attendance-hostel-${year}-${padM}.pdf`);
          });
        });

        gridEl.querySelector("#hostel-monthly-wa-btn").addEventListener("click", async () => {
          await withLoadingBtn(gridEl.querySelector("#hostel-monthly-wa-btn"), "Sharing…", async () => {
            const lines = [`📊 *Hostel Monthly Attendance — ${mLabelStr}*`, `Working days: ${allDays.length}`, ``];
            let lastWaType = null;
            for (const { label, hostelTypeLabel, students, studentTotals } of yearGrids) {
              if (hostelTypeLabel !== lastWaType) {
                lines.push(`*── ${hostelTypeLabel} Hostel ──*`);
                lastWaType = hostelTypeLabel;
              }
              lines.push(`*${label}* (${students.length} students)`);
              const low = students
                .map((s) => ({ ...s, ...(studentTotals.get(s.regNo) || {}) }))
                .filter((s) => s.pct < 75)
                .sort((a, b) => a.pct - b.pct);
              if (low.length > 0) {
                lines.push(`Below 75%:`);
                low.forEach((s, i) => lines.push(`  ${i + 1}. ${s.name} — ${s.pct}%`));
              } else {
                lines.push(`✅ All above 75%`);
              }
              lines.push(``);
            }
            lines.push(`─────────────────`);
            const totalP = allDays.reduce((s, d) => s + (combinedDayTotals[d]?.present || 0), 0);
            const totalA = allDays.reduce((s, d) => s + (combinedDayTotals[d]?.absent || 0), 0);
            lines.push(`*📊 Combined (${yearGrids.length} year groups)*`);
            lines.push(`Total Present: ${totalP}   Total Absent: ${totalA}`);
            window.open(`https://wa.me/?text=${encodeURIComponent(lines.join("\n"))}`, "_blank", "noopener,noreferrer");
          });
        });

      } catch (err) {
        gridEl.innerHTML = `<div class="msg msg--err">Could not load: ${escapeHtml(err.message)}</div>`;
      }
    }
  }

  async function withLoadingBtn(btn, loadingLabel, action) {
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = loadingLabel;
    try { await action(); } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }


  function renderRosterLoading() {
    container.innerHTML = `<div class="page"><p class="status">Loading roster…</p></div>`;
    loadRosterAndRecord();
  }

  async function loadRosterAndRecord() {
    let roster, existingRecord, holiday;
    try {
      [roster, existingRecord, holiday] = await Promise.all([
        fetchRoster({ category: profile.category, scopeId: state.selectedScopeId }),
        loadRecord({
          category: profile.category,
          scopeId: state.selectedScopeId,
          date: todayLocalDate(),
        }),
        getHoliday({ category: profile.category, date: todayLocalDate() }),
      ]);
    } catch (err) {
      container.innerHTML = `<div class="page"><div class="msg msg--err">Could not load roster: ${escapeHtml(err.message)}</div></div>`;
      return;
    }

    if (holiday) {
      const multiScope = profile.scopeIds.length > 1;
      container.innerHTML = `
        <div class="page">
          <div style="display:flex; justify-content:flex-end; margin-bottom:var(--space-2);">
            <button class="btn btn--secondary" id="logout-btn-holiday"
              style="min-height:auto; padding:var(--space-2) var(--space-3); font-size:var(--font-size-sm);">
              Logout
            </button>
          </div>
          <h2>${escapeHtml(scopeLabel(state.selectedScopeId))}</h2>
          <div class="msg msg--warn msg--roster-empty">
            <span class="roster-empty__icon">📅</span>
            <div class="roster-empty__title">Today is a holiday</div>
            <div class="roster-empty__hint">${escapeHtml(holiday.label || "Marked as a holiday for " + capitalize(profile.category) + ".")}<br>Attendance marking is disabled for today.</div>
          </div>
          <div style="display:flex; flex-direction:column; gap:var(--space-3); margin-top:var(--space-4);">
            ${multiScope ? `<button class="btn btn--secondary btn--full" id="back-btn-holiday">← Back</button>` : ""}
            <button class="btn btn--full" id="summary-btn-holiday" style="background:#1a73e8;">
              📊 View Attendance Summary
            </button>
          </div>
        </div>
      `;
      container.querySelector("#logout-btn-holiday").addEventListener("click", () => options.onLogout());
      container.querySelector("#summary-btn-holiday").addEventListener("click", () => {
        state.lastSavedDate = todayLocalDate();
        state.screen = "summary";
        render();
      });
      const backBtn = container.querySelector("#back-btn-holiday");
      if (backBtn) {
        backBtn.addEventListener("click", () => {
          state.screen = "home";
          render();
        });
      }
      return;
    }

    // Build the working attendance map: regNo -> {status, remarks}.
    // Default everyone to Present unless an existing record says
    // otherwise (editing a previously-saved record).
    const existingByRegNo = new Map((existingRecord?.records || []).map((r) => [r.regNo, r]));
    const allStudents = profile.category === "bus" ? roster.groups.flatMap((g) => g.students) : roster.students;

    if (allStudents.length === 0) {
      const hasSomewhereToGoBack = profile.scopeIds.length > 1;
      container.innerHTML = `
        <div class="page">
          <h2>${escapeHtml(scopeLabel(state.selectedScopeId))}</h2>
          <div class="msg msg--warn msg--roster-empty">
            <span class="roster-empty__icon">🚌</span>
            <div class="roster-empty__title">No students assigned</div>
            <div class="roster-empty__hint">No students are currently assigned to this scope.<br>Contact an admin if this seems wrong.</div>
          </div>
          ${hasSomewhereToGoBack ? `<button class="btn btn--secondary btn--full" id="back-btn-empty" style="margin-top: var(--space-3);">← Back</button>` : ""}
        </div>
      `;
      const btn = container.querySelector("#back-btn-empty");
      if (btn) {
        btn.addEventListener("click", () => {
          // Single-scope markers never saw a "home" screen, so going
          // "back" from an empty roster means re-showing the session
          // toggle (if this category has one) rather than a screen
          // that was never shown in the first place.
          state.screen = profile.scopeIds.length > 1 ? "home" : "roster"; // no session screen
          render();
        });
      }
      return;
    }

    const working = new Map();
    for (const s of allStudents) {
      const existing = existingByRegNo.get(s.regNo);
      working.set(s.regNo, {
        regNo: s.regNo,
        name: s.name,
        year: s.year || null,
        course: s.course || null,
        hostelType: s.hostelType || null,
        status: existing ? existing.status : "present",
        remarks: existing ? existing.remarks || "" : "",
      });
    }

    renderRoster(roster, working, existingRecord);
  }

  function renderRoster(roster, working, existingRecord) {
    const isLocked = !!existingRecord?.locked;
    // Single-scope class markers skip BOTH the home and session
    // screens entirely (no multi-scope picker needed, no session
    // toggle for class), so the roster screen is the only place they
    // could ever log out from — show it only in that specific case,
    // keeping the "no logout during marking" rule for everyone else.
    // With sessions removed, all single-scope markers land directly on the
    // roster — so we always show the logout button for single-scope markers.
    const isOnlyScreenEverShown = profile.scopeIds.length === 1;
    const hasMultipleScopes = profile.scopeIds.length > 1;

    container.innerHTML = `
      <div class="page" style="padding-bottom: 8rem; padding-top: 0;">
        <div class="marker-top-bar">
          <div class="marker-top-bar__left">
            ${hasMultipleScopes ? `<button class="marker-top-bar__back-btn" id="back-btn-roster">← Back</button>` : ""}
          </div>
          <div class="marker-top-bar__title-block">
            <span class="marker-top-bar__title">${escapeHtml(scopeLabel(state.selectedScopeId))}</span>
            <span class="marker-top-bar__date">${formatDateDMY(todayLocalDate())}</span>
          </div>
          <div class="marker-top-bar__right">
            <button class="marker-top-bar__summary-btn" id="view-summary-btn-roster">📊 Summary</button>
            ${isOnlyScreenEverShown ? `<button class="marker-top-bar__logout-btn" id="logout-btn-roster">Logout</button>` : ""}
          </div>
        </div>
        ${isLocked ? `<div class="locked-banner" style="margin:var(--space-3) var(--space-4) 0;">🔒 This record is locked and can no longer be edited here. Contact an admin if a correction is needed.</div>` : ""}
        <div id="roster-list" style="padding-top:var(--space-3);"></div>
      </div>
      <div class="marker-bottom-bar">
        <div class="marker-bottom-bar__counts">
          <div class="marker-bottom-bar__stat marker-bottom-bar__stat--present">
            <span class="marker-bottom-bar__stat-num" id="count-present-num">0</span>
            <span class="marker-bottom-bar__stat-label">Present</span>
          </div>
          <div class="marker-bottom-bar__divider"></div>
          <div class="marker-bottom-bar__stat marker-bottom-bar__stat--absent">
            <span class="marker-bottom-bar__stat-num" id="count-absent-num">0</span>
            <span class="marker-bottom-bar__stat-label">Absent</span>
          </div>
          <div class="marker-bottom-bar__divider"></div>
          <div class="marker-bottom-bar__stat marker-bottom-bar__stat--total">
            <span class="marker-bottom-bar__stat-num" id="count-total-num">0</span>
            <span class="marker-bottom-bar__stat-label">Total</span>
          </div>
        </div>
        <button class="marker-bottom-bar__save-btn" id="save-btn" ${isLocked ? "disabled" : ""}>
          ${isLocked ? "🔒 Locked" : "💾 Save"}
        </button>
        <div id="save-msg"></div>
      </div>
    `;

    const listEl = container.querySelector("#roster-list");

    if (profile.category === "bus") {
      listEl.innerHTML = roster.groups
        .map(
          (g) => `
            <div class="stop-group">
              <div class="stop-header stop-header--bus">Stop ${g.stopNo ?? "?"} — ${escapeHtml(g.stopName)}</div>
              <div class="stop-group__students">
                ${g.students.map((s) => renderRow(working.get(s.regNo))).join("")}
              </div>
            </div>
          `
        )
        .join("");
    } else if (profile.category === "hostel") {
      const typeGroups = groupByHostelTypeAndYear(roster.students);
      listEl.innerHTML = typeGroups
        .map(
          (tg) => `
            <div class="stop-header" style="background:var(--accent); color:var(--accent-contrast);">${escapeHtml(tg.type)} (${tg.yearGroups.reduce((n, g) => n + g.students.length, 0)})</div>
            ${tg.yearGroups.map(
              (g) => `
                <div class="stop-header">${escapeHtml(yearGroupLabel(g.year))} (${g.students.length})</div>
                ${g.students.map((s) => renderRow(working.get(s.regNo), { showBranch: true })).join("")}
              `
            ).join("")}
          `
        )
        .join("");
    } else {
      listEl.innerHTML = roster.students.map((s) => renderRow(working.get(s.regNo))).join("");
    }

    attachRowHandlers(listEl, working, isLocked);
    updateCounts(working);

    const saveBtn = container.querySelector("#save-btn");
    saveBtn.addEventListener("click", async () => {
      await handleSave(working, existingRecord, isLocked);
    });

    const logoutBtnRoster = container.querySelector("#logout-btn-roster");
    if (logoutBtnRoster) logoutBtnRoster.addEventListener("click", () => options.onLogout());

    const viewSummaryBtnRoster = container.querySelector("#view-summary-btn-roster");
    if (viewSummaryBtnRoster) viewSummaryBtnRoster.addEventListener("click", () => {
      state.screen = hasMultipleScopes ? "allsummary" : (profile.category === "hostel" ? "hostelsummary" : "summary");
      render();
    });

    const backBtnRoster = container.querySelector("#back-btn-roster");
    if (backBtnRoster) backBtnRoster.addEventListener("click", () => {
      state.screen = "home";
      render();
    });
  }

  function renderRow(entry, opts = {}) {
    const isAbsent = entry.status === "absent";
    const showBranch = opts.showBranch && entry.course;
    return `
      <div class="roster-row-wrap" data-regno="${escapeHtml(entry.regNo)}">
        <div class="roster-row${isAbsent ? " roster-row--absent" : ""}" data-regno="${escapeHtml(entry.regNo)}">
          <div class="roster-row__info">
            <span class="roster-row__name">${escapeHtml(entry.name)}</span>
            <span class="roster-row__regno">${escapeHtml(entry.regNo)}</span>
            ${showBranch ? `<span class="roster-row__branch">${escapeHtml(entry.course)}</span>` : ""}
          </div>
          <span class="roster-row__status roster-row__status--${entry.status}">${isAbsent ? "Absent" : "Present"}</span>
        </div>
        ${isAbsent ? `
          <div class="roster-row__remarks">
            <input type="text" placeholder="Remarks (optional)" value="${escapeHtml(entry.remarks || "")}" data-remarks-for="${escapeHtml(entry.regNo)}" />
          </div>
        ` : ""}
      </div>
    `;
  }

  function attachRowHandlers(listEl, working, isLocked) {
    if (isLocked) return; // no interaction at all on a locked record
    // Event delegation: ONE listener on the list container, never
    // re-attached on re-render. Attaching a fresh listener per row
    // every time a single row's outerHTML is replaced (the previous
    // approach) caused listeners to accumulate on every row that
    // was NOT replaced, since their DOM nodes persist across
    // re-renders — confirmed via test to cause a single tap to fire
    // the toggle handler multiple times after a few other rows had
    // already been toggled. Delegation avoids this entirely: rows
    // can be freely replaced without ever touching listener state.
    listEl.addEventListener("click", (e) => {
      if (e.target.tagName === "INPUT") return; // remarks field, handled separately
      const row = e.target.closest(".roster-row");
      if (!row || !listEl.contains(row)) return;
      const regNo = row.dataset.regno;
      const entry = working.get(regNo);
      entry.status = entry.status === "present" ? "absent" : "present";
      if (entry.status === "present") entry.remarks = ""; // clear stale remarks once back to present
      rerenderSingleRow(listEl, working, regNo);
      updateCounts(working);
    });
    attachRemarksHandlers(listEl, working);
  }

  function attachRemarksHandlers(listEl, working) {
    // Also delegated, for the same reason — remarks inputs are
    // recreated whenever their row re-renders (e.g. toggled back to
    // absent after being present), so a direct per-input listener
    // would need constant re-attachment too. The "input" event
    // bubbles, so delegation works here exactly the same way.
    listEl.addEventListener("input", (e) => {
      if (!e.target.matches("[data-remarks-for]")) return;
      const regNo = e.target.dataset.remarksFor;
      working.get(regNo).remarks = e.target.value;
    });
  }

  function rerenderSingleRow(listEl, working, regNo) {
    const wrap = listEl.querySelector(`.roster-row-wrap[data-regno="${cssEscape(regNo)}"]`);
    if (!wrap) return;
    wrap.outerHTML = renderRow(working.get(regNo), { showBranch: profile.category === "hostel" });
    // No handler re-attachment here — the delegated listener on
    // listEl already covers the freshly-inserted row automatically.
  }

  function updateCounts(working) {
    const all = Array.from(working.values());
    const presentCount = all.filter((e) => e.status === "present").length;
    const absentCount = all.filter((e) => e.status === "absent").length;
    const presentEl = container.querySelector("#count-present-num");
    const absentEl = container.querySelector("#count-absent-num");
    const totalEl = container.querySelector("#count-total-num");
    if (presentEl) presentEl.textContent = presentCount;
    if (absentEl) absentEl.textContent = absentCount;
    if (totalEl) totalEl.textContent = all.length;
  }

  async function handleSave(working, existingRecord, isLocked) {
    if (isLocked) return;
    const saveBtn = container.querySelector("#save-btn");
    const saveMsg = container.querySelector("#save-msg");
    saveBtn.disabled = true;
    saveMsg.innerHTML = "";

    try {
      await saveRecord(
        {
          category: profile.category,
          scopeId: state.selectedScopeId,
          date: todayLocalDate(),
          session: state.selectedSession,
          records: Array.from(working.values()),
          markedBy: { uid: user.uid, name: profile.name, staffId: profile.staffId },
        },
        existingRecord,
        profile.role === "admin"
      );
      const savedDate = todayLocalDate();
      state.lastSavedDate = savedDate;
      // Show success message + action buttons
      const hasMultipleScopes = profile.scopeIds.length > 1;
      saveMsg.innerHTML = `
        <div class="marker-bottom-bar__saved">
          <div class="marker-bottom-bar__saved-msg">✓ Saved successfully</div>
          <div class="marker-bottom-bar__saved-actions">
            ${hasMultipleScopes ? `<button class="marker-bottom-bar__action-btn marker-bottom-bar__action-btn--secondary" id="back-to-classes-btn">← Classes</button>` : ""}
            <button class="marker-bottom-bar__action-btn" id="view-summary-btn">View Summary →</button>
          </div>
        </div>
      `;
      const summaryBtn = container.querySelector("#view-summary-btn");
      if (summaryBtn) {
        summaryBtn.addEventListener("click", () => {
          state.screen = hasMultipleScopes ? "allsummary" : (profile.category === "hostel" ? "hostelsummary" : "summary");
          render();
        });
      }
      const backToClassesBtn = container.querySelector("#back-to-classes-btn");
      if (backToClassesBtn) {
        backToClassesBtn.addEventListener("click", () => {
          state.screen = "home";
          render();
        });
      }
    } catch (err) {
      saveMsg.innerHTML = `<div class="msg msg--err">${escapeHtml(err.message)}</div>`;
    } finally {
      saveBtn.disabled = false;
    }
  }


}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Format YYYY-MM-DD → DD-MM-YYYY for display */
function formatDateDMY(isoDate) {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  return `${d}-${m}-${y}`;
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}

function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
