// admin/app.js
//
// P6: Admin app — live dashboard, daily reports, monthly reports.
//
// Navigation model: a simple top nav bar with three sections:
//   Dashboard | Daily | Monthly
//
// Dashboard uses onSnapshot for real-time updates. Daily and Monthly
// views use one-time getDocs queries (admin can re-fetch manually).
//
// Entry point: mountAdminApp(container, user, options)

import { db } from "../shared/firebase-init.js";
import {
  collection,
  query,
  where,
  getDocs,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  updateDoc,
  writeBatch,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { todayLocalDate, buildRecordId, fetchHolidaysForMonth, getHoliday } from "../shared/attendance.js";
import { loadPdfLibs, generateDailyPdf, generateMonthlyPdf, formatPhone } from "../shared/pdf-utils.js";
import { mountDbManager } from "./db-manager.js";
import { mountUserManager } from "./user-manager.js";
import {
  shareReport,
  triggerDownload,
  buildDailyWhatsAppText,
  buildMonthlyWhatsAppText,
} from "../shared/share-utils.js";

import { mountOfflineBanner } from "../shared/offline-banner.js";

loadPdfLibs().catch(() => {});

// ----------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------

export async function mountAdminApp(container, user, options = {}) {
  // P9: offline indicator — mounted once, survives screen changes
  mountOfflineBanner();

  // Verify admin role
  const profileSnap = await getDoc(doc(db, "users", user.uid));
  if (!profileSnap.exists()) {
    container.innerHTML = `<div class="page page--wide"><div class="msg msg--err">Your account profile could not be loaded.</div></div>`;
    return;
  }
  const profile = profileSnap.data();
  if (profile.role !== "admin" && profile.role !== "manager") {
    container.innerHTML = `<div class="page page--wide"><div class="msg msg--err">Access denied — admin accounts only.</div></div>`;
    return;
  }

  const state = {
    screen: "dashboard", // "dashboard" | "daily" | "monthly"
    profile,
    user,
    // cleanup functions for active onSnapshot listeners
    unsubscribers: [],
  };

  render();

  function render() {
    stopListeners(state);

    container.innerHTML = `
      <div class="admin-layout">
        <nav class="admin-nav">
          <div class="admin-nav__toprow">
            <span class="admin-nav__brand">KHTPC Admin</span>
            <div class="admin-nav__actions">
              <button class="admin-nav__action-btn" id="nav-refresh-btn" title="Force live refresh">🔄 Refresh</button>
              <button class="admin-nav__action-btn admin-nav__action-btn--logout" id="nav-logout-btn">Logout</button>
            </div>
          </div>
          <div class="admin-nav__tabrow">
            <button class="admin-nav__tab ${state.screen === "dashboard" ? "admin-nav__tab--active" : ""}" data-screen="dashboard">📊 Dashboard</button>
            <button class="admin-nav__tab ${state.screen === "daily" ? "admin-nav__tab--active" : ""}" data-screen="daily">📋 Daily</button>
            <button class="admin-nav__tab ${state.screen === "monthly" ? "admin-nav__tab--active" : ""}" data-screen="monthly">📅 Monthly</button>
            ${state.profile.role === "admin" ? `
            <button class="admin-nav__tab ${state.screen === "database" ? "admin-nav__tab--active" : ""}" data-screen="database">🗄 Database</button>
            <button class="admin-nav__tab ${state.screen === "users" ? "admin-nav__tab--active" : ""}" data-screen="users">👥 Users</button>` : ""}
          </div>
        </nav>
        <main class="admin-main" id="admin-main">
          <p class="status" style="padding: var(--space-4);">Loading…</p>
        </main>
      </div>
    `;

    container.querySelectorAll(".admin-nav__tab[data-screen]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.screen = btn.dataset.screen;
        render();
      });
    });
    container.querySelector("#nav-logout-btn").addEventListener("click", () => options.onLogout?.());
    container.querySelector("#nav-refresh-btn").addEventListener("click", (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = "🔄 Refreshing…";
      render();
      // render() rebuilds #admin-main and replaces this nav entirely,
      // but guard with a timeout reset in case the screen render throws
      // before reaching that point.
      setTimeout(() => {
        if (document.body.contains(btn)) {
          btn.disabled = false;
          btn.textContent = original;
        }
      }, 1500);
    });

    const main = container.querySelector("#admin-main");
    if (state.screen === "dashboard") renderDashboard(main, state);
    else if (state.screen === "daily") renderDailyScreen(main, state);
    else if (state.screen === "monthly") renderMonthlyScreen(main, state);
    else if (state.screen === "database" && state.profile.role === "admin") mountDbManager(main);
    else if (state.screen === "users" && state.profile.role === "admin") mountUserManager(main, state.user, state.profile);
    else { state.screen = "dashboard"; renderDashboard(main, state); }
  }
}

function stopListeners(state) {
  state.unsubscribers.forEach((fn) => fn());
  state.unsubscribers = [];
}

// ================================================================
// DASHBOARD
// ================================================================

async function renderDashboard(main, state) {
  if (!state.summaryDate) state.summaryDate = todayLocalDate();

  main.innerHTML = `
    <div class="page page--wide">
      <div class="row row--between" style="margin-bottom: var(--space-4); flex-wrap:wrap; gap:var(--space-3);">
        <div>
          <h2 style="margin:0;" id="dashboard-title">Live Dashboard</h2>
          <p class="status" style="margin:0;">${formatDate(todayLocalDate())}</p>
        </div>
        <div style="display:flex; gap:var(--space-2); flex-wrap:wrap;">
          <button class="btn btn--secondary" id="finalize-day-btn">🔒 Finalize Day</button>
          <button class="btn" id="master-pdf-btn">📄 Full Report</button>
        </div>
      </div>
      <div id="finalize-msg"></div>

      <div class="row row--between" style="margin-bottom: var(--space-4); flex-wrap:wrap; gap:var(--space-3);">
        <h3 class="combined-summary__title">📊 Attendance Summary</h3>
        <div class="date-nav">
          <span class="date-nav__caption">Viewing</span>
          <button class="btn btn--secondary date-nav__btn" id="summary-day-prev">‹</button>
          <span class="date-nav__label" id="summary-day-label">${formatDate(state.summaryDate)}</span>
          <button class="btn btn--secondary date-nav__btn" id="summary-day-next"
            ${state.summaryDate >= todayLocalDate() ? "disabled" : ""}>›</button>
        </div>
      </div>

      <div class="combined-summary">
        <div id="combined-summary-body">
          <p class="status">Loading summary…</p>
        </div>
      </div>

      <div id="dashboard-grid" class="dashboard-grid">
        <p class="status">Loading scopes…</p>
      </div>
    </div>
  `;

  main.querySelector("#summary-day-prev").addEventListener("click", () => {
    state.summaryDate = shiftDate(state.summaryDate, -1);
    refreshDashboardForDate(main, state);
  });
  const nextBtn = main.querySelector("#summary-day-next");
  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      if (state.summaryDate >= todayLocalDate()) return;
      state.summaryDate = shiftDate(state.summaryDate, 1);
      refreshDashboardForDate(main, state);
    });
  }

  // Finalize Day always operates on TODAY specifically (locking
  // historical records is a separate, riskier action this button was
  // never meant for) — wired once here, outside refreshDashboardForDate,
  // so flipping the date picker around doesn't rebind it to whatever
  // past date happens to be selected.
  const today = todayLocalDate();

  main.querySelector("#master-pdf-btn").addEventListener("click", async () => {
    const btn = main.querySelector("#master-pdf-btn");
    const reportDate = state.summaryDate;
    if (state.viewedCardDataDate !== reportDate || !state.viewedCardData) {
      alert("This date's scopes are still loading — try again in a moment.");
      return;
    }
    await withLoadingBtn(btn, "Generating…", async () => {
      const college = await fetchCollege();
      await generateMasterPdf(state.viewedCardData, college, reportDate);
    });
  });

  main.querySelector("#finalize-day-btn").addEventListener("click", async () => {
    const btn = main.querySelector("#finalize-day-btn");
    const msgEl = main.querySelector("#finalize-msg");

    if (!confirm(
      `Lock all of today's attendance records (${formatDate(today)})?\n\n` +
      `Markers will no longer be able to edit them. Admins can still override.\n\n` +
      `This cannot be undone from the marker app.`
    )) return;

    await withLoadingBtn(btn, "Locking…", async () => {
      msgEl.innerHTML = "";
      try {
        const q = query(
          collection(db, "attendanceRecords"),
          where("date", "==", today)
        );
        const snap = await getDocs(q);
        if (snap.empty) {
          msgEl.innerHTML = `<div class="msg msg--warn" style="margin-bottom:var(--space-3);">No attendance records found for today — nothing to lock.</div>`;
          return;
        }

        const docs = snap.docs.filter((d) => !d.data().locked);
        if (docs.length === 0) {
          msgEl.innerHTML = `<div class="msg msg--ok" style="margin-bottom:var(--space-3);">✓ All records for today are already locked.</div>`;
          return;
        }

        const BATCH_SIZE = 400;
        for (let i = 0; i < docs.length; i += BATCH_SIZE) {
          const batch = writeBatch(db);
          docs.slice(i, i + BATCH_SIZE).forEach((d) => {
            batch.update(d.ref, { locked: true, lockedAt: Timestamp.now() });
          });
          await batch.commit();
        }

        msgEl.innerHTML = `<div class="msg msg--ok" style="margin-bottom:var(--space-3);">✓ ${docs.length} record${docs.length === 1 ? "" : "s"} locked for ${formatDate(today)}. Dashboard cards will update shortly.</div>`;
      } catch (err) {
        msgEl.innerHTML = `<div class="msg msg--err" style="margin-bottom:var(--space-3);">Failed to lock records: ${escapeHtml(err.message)}</div>`;
      }
    });
  });

  await refreshDashboardForDate(main, state);
}

let cachedCollege = null;
async function fetchCollege() {
  if (cachedCollege) return cachedCollege;
  const snap = await getDoc(doc(db, "college", "main"));
  cachedCollege = snap.exists() ? snap.data() : null;
  return cachedCollege;
}

/**
 * Refreshes both the Combined Summary and the live scope grid for
 * state.summaryDate — called on initial load and every time the
 * shared date-nav changes. Always stops any existing onSnapshot
 * listeners first: without this, flipping from today to a past date
 * would leave today's listeners running and stomping the static
 * past-date view the moment anything changes live.
 */
async function refreshDashboardForDate(main, state) {
  stopListeners(state);

  const date = state.summaryDate;
  const isToday = date >= todayLocalDate();

  const labelEl = main.querySelector("#summary-day-label");
  const nextBtn = main.querySelector("#summary-day-next");
  if (labelEl) labelEl.textContent = formatDate(date);
  if (nextBtn) nextBtn.disabled = isToday;

  const titleEl = main.querySelector("#dashboard-title");
  if (titleEl) titleEl.textContent = isToday ? "Live Dashboard" : "Dashboard — " + formatDate(date);

  await Promise.all([
    renderCombinedSummary(main, state, date),
    renderLiveGrid(main, state, date, isToday),
  ]);
}

/**
 * Renders the per-scope card grid for `date`. When `date` is today,
 * cards stay live via onSnapshot (today's attendance can still
 * change). For any past date, this is a one-shot fetch instead —
 * past records never change, so a listener would just sit open for
 * no benefit while still counting against the open-listener budget.
 */
async function renderLiveGrid(main, state, date, isToday) {
  const grid = main.querySelector("#dashboard-grid");
  if (!grid) return;
  grid.innerHTML = `<p class="status">Loading scopes…</p>`;

  let buses = [], classes = [];
  let holidays = { hostel: null, bus: null, class: null };
  try {
    const [busSnap, classSnap, hostelHoliday, busHoliday, classHoliday] = await Promise.all([
      getDocs(collection(db, "buses")),
      getDocs(collection(db, "classes")),
      getHoliday({ category: "hostel", date }),
      getHoliday({ category: "bus", date }),
      getHoliday({ category: "class", date }),
    ]);
    busSnap.forEach((d) => buses.push({ id: d.id, ...d.data() }));
    buses.sort((a, b) => naturalSort(a.id, b.id));
    classSnap.forEach((d) => classes.push({ id: d.id, ...d.data() }));
    // Only show branches that actually have students enrolled. A class
    // doc can be left behind with studentCount explicitly 0 (e.g. a
    // branch dropped in a later Excel re-upload) — skip those so the
    // dashboard doesn't display an empty branch (like "Not yet marked"
    // for a course nobody is enrolled in). Docs missing the field
    // entirely (legacy/manual entries) are kept, since we can't tell
    // whether they're genuinely empty.
    classes = classes.filter((c) => c.studentCount !== 0);
    classes.sort((a, b) => naturalSort(a.id, b.id));
    holidays = { hostel: hostelHoliday, bus: busHoliday, class: classHoliday };
  } catch (err) {
    if (state.summaryDate !== date) return; // stale — a newer date is now selected
    grid.innerHTML = `<div class="msg msg--err">Could not load scopes: ${escapeHtml(err.message)}</div>`;
    return;
  }

  if (state.summaryDate !== date) return; // stale — a newer date is now selected

  // Build the card DOM upfront with loading state
  const scopeDefs = [
    { category: "hostel", scopeId: "hostel_main", label: "Hostel", sessions: [null] },
    ...buses.map((b) => ({
      category: "bus",
      scopeId: b.id,
      label: busLabel(b.id),
      sessions: [null],
    })),
    ...classes.map((c) => ({
      category: "class",
      scopeId: c.id,
      label: classLabel(c.id),
      sessions: [null],
    })),
  ];

  // Group scopes by category for the sectioned dashboard layout
  const groups = [
    { key: "hostel", title: "🏠 Hostel",  scopes: scopeDefs.filter((s) => s.category === "hostel") },
    { key: "bus",    title: "🚌 Buses",   scopes: scopeDefs.filter((s) => s.category === "bus")    },
    { key: "class",  title: "🎓 Classes", scopes: scopeDefs.filter((s) => s.category === "class")  },
  ].filter((g) => g.scopes.length > 0);

  grid.innerHTML = groups
    .map(
      (g) => `
      <div class="dash-group">
        <h3 class="dash-group__title">${g.title}</h3>
        <div class="dash-group__cards">
          ${g.scopes
            .map(
              (s) => `
            <div class="dash-card" id="card-${cssId(s.scopeId)}">
              <div class="dash-card__label">${escapeHtml(s.label)}</div>
              ${s.sessions
                .map(
                  (sess) => `
                <div class="dash-card__session" id="card-${cssId(s.scopeId)}-${sess || "only"}">
                  ${sess ? `<span class="dash-card__session-label">${capitalize(sess)}</span>` : ""}
                  ${holidays[s.category]
                    ? `<span class="dash-card__state dash-card__state--holiday">🗓️ Holiday</span>`
                    : `<span class="dash-card__state dash-card__state--loading">…</span>`}
                </div>
              `
                )
                .join("")}
            </div>
          `
            )
            .join("")}
        </div>
      </div>
    `
    )
    .join("");

  // Per-scope card data, collected below and stashed on state for
  // the Full Report PDF (see state.viewedCardData assignment further
  // down, after this map is fully populated).
  const cardData = new Map(); // scopeId+session → record data

  // Pre-populate holiday-category scopes with a holiday marker so the
  // master PDF can render a "Holiday" row for them — these never get
  // a data entry below otherwise, so without this they'd be silently
  // missing from the report instead of showing as a holiday.
  for (const scope of scopeDefs) {
    if (!holidays[scope.category]) continue;
    for (const sess of scope.sessions) {
      cardData.set(`${scope.scopeId}:${sess}`, { scope, data: null, holiday: true });
    }
  }

  // For TODAY: attach real-time onSnapshot listeners (skipping any
  // holiday-category scope — no attendance doc will ever appear for
  // it today, so there's nothing to watch; its card already shows
  // the static "Holiday" badge above).
  //
  // For a PAST date: do a single one-shot getDoc per scope instead.
  // Past records never change, so a live listener would just sit
  // open for no benefit — and since this grid is rebuilt from
  // scratch on every date change, leaving old listeners attached
  // would otherwise leak one per scope every time the user pages
  // through several days.
  for (const scope of scopeDefs) {
    if (holidays[scope.category]) continue;
    for (const sess of scope.sessions) {
      const recordId = buildRecordId({
        category: scope.category,
        scopeId: scope.scopeId,
        date,
      });
      const cardEl = grid.querySelector(`#card-${cssId(scope.scopeId)}-${sess || "only"}`);
      if (!cardEl) continue;

      if (isToday) {
        const unsub = onSnapshot(
          doc(db, "attendanceRecords", recordId),
          (snap) => {
            const recData = snap.exists() ? snap.data() : null;
            cardData.set(`${scope.scopeId}:${sess}`, { scope, data: recData });
            updateDashCard(cardEl, recData, sess);
          },
          (err) => {
            if (cardEl) cardEl.querySelector(".dash-card__state").textContent = "Error";
          }
        );
        state.unsubscribers.push(unsub);
      } else {
        getDoc(doc(db, "attendanceRecords", recordId))
          .then((snap) => {
            // Guard against a stale resolve: if the user has since
            // paged to a different date, this grid has already been
            // torn down and rebuilt — writing into it now would hit
            // the wrong date's DOM nodes.
            if (state.summaryDate !== date) return;
            const recData = snap.exists() ? snap.data() : null;
            cardData.set(`${scope.scopeId}:${sess}`, { scope, data: recData });
            updateDashCard(cardEl, recData, sess);
          })
          .catch(() => {
            if (state.summaryDate !== date) return;
            if (cardEl) cardEl.querySelector(".dash-card__state").textContent = "Error";
          });
      }
    }
  }

  // Stash this date's per-scope card data on state so the Full
  // Report button can build its detailed listing page from whatever
  // date is currently being viewed — not just today.
  state.viewedCardData = cardData;
  state.viewedCardDataDate = date;
}

// ================================================================
// COMBINED SUMMARY — three grouped boxes (Hostel / Buses / Classes)
// on the dashboard, for a single picked date (defaults to today).
// Unlike the live cards above (which use onSnapshot for "right now"),
// this is a one-shot getDocs query re-run whenever the date changes,
// since past dates never change and today's numbers updating a few
// seconds late is an acceptable tradeoff for one query instead of
// a listener per scope.
// ================================================================

const HOSTEL_TYPE_ORDER = ["Hindi", "Tamil"];

/**
 * Fetches every attendanceRecords doc for `date` plus the day's
 * holiday flags per category, de-duped and bucketed by category.
 * Pulled out of renderCombinedSummary so the "Full Report"
 * PDF can pull the exact same data the on-screen Combined Summary
 * is built from, rather than maintaining a second query path that
 * could drift out of sync with it.
 */
async function fetchCombinedSummaryData(date) {
  let allRecords = [];
  const [snap, hostelHoliday, busHoliday, classHoliday] = await Promise.all([
    getDocs(query(collection(db, "attendanceRecords"), where("date", "==", date))),
    getHoliday({ category: "hostel", date }),
    getHoliday({ category: "bus", date }),
    getHoliday({ category: "class", date }),
  ]);
  snap.forEach((d) => allRecords.push(d.data()));
  const holidays = { hostel: hostelHoliday, bus: busHoliday, class: classHoliday };

  // Defensive de-dup: this is a raw "every doc for this date" query,
  // not a per-scope getDoc by the deterministic record ID, so it can
  // surface more than one document for the same category+scopeId —
  // e.g. an old-format doc left over from before the record-ID scheme
  // changed (session segment removed), sitting alongside the current
  // one. Collapse those down to a single row per scope here so a
  // leftover/legacy doc never renders as a duplicate (like two
  // "Bus 11" rows) — keep whichever was updated most recently.
  allRecords = dedupeRecordsByScope(allRecords);

  const byCategory = { hostel: [], bus: [], class: [] };
  for (const r of allRecords) {
    if (byCategory[r.category]) byCategory[r.category].push(r);
  }

  return { byCategory, holidays };
}

async function renderCombinedSummary(main, state, date) {
  const bodyEl = main.querySelector("#combined-summary-body");
  if (!bodyEl) return;

  bodyEl.innerHTML = `<p class="status">Loading summary…</p>`;

  let byCategory, holidays;
  try {
    ({ byCategory, holidays } = await fetchCombinedSummaryData(date));
  } catch (err) {
    if (state.summaryDate !== date) return; // stale — a newer date is now selected
    bodyEl.innerHTML = `<div class="msg msg--err">Could not load summary: ${escapeHtml(err.message)}</div>`;
    return;
  }

  if (state.summaryDate !== date) return; // stale — a newer date is now selected

  bodyEl.innerHTML = `
    <div class="combined-summary__grid">
      ${renderHostelBox(byCategory.hostel, holidays.hostel)}
      ${renderBusBox(byCategory.bus, holidays.bus)}
      ${renderClassBox(byCategory.class, holidays.class)}
    </div>
    <div class="dash-charts" id="dash-charts">
      <div class="dash-chart-card">
        <div class="dash-chart-card__title">Students by Year</div>
        <canvas id="chart-year" class="dash-chart-canvas"></canvas>
      </div>
      <div class="dash-chart-card">
        <div class="dash-chart-card__title">Transport Grouping</div>
        <canvas id="chart-transport" class="dash-chart-canvas"></canvas>
      </div>
      <div class="dash-chart-card">
        <div class="dash-chart-card__title">Hostel — Hindi / Tamil</div>
        <canvas id="chart-hostel" class="dash-chart-canvas"></canvas>
      </div>
    </div>
    <div class="dash-section-label">📋 Today's Attendance</div>
    <div class="dash-bar-row" id="dash-attendance">
      <div class="dash-bar-card">
        <div class="dash-chart-card__title">Bus — Present / Absent</div>
        <canvas id="chart-bus-attend" class="dash-bar-canvas"></canvas>
      </div>
      <div class="dash-bar-card">
        <div class="dash-chart-card__title">Class — Present / Absent</div>
        <canvas id="chart-class-attend" class="dash-bar-canvas"></canvas>
      </div>
    </div>
    <div class="dash-section-label">📐 Enrollment vs Capacity</div>
    <div class="dash-bar-row" id="dash-strength">
      <div class="dash-bar-card">
        <div class="dash-chart-card__title">Bus — Enrolled vs Capacity</div>
        <canvas id="chart-bus-strength" class="dash-bar-canvas"></canvas>
      </div>
      <div class="dash-bar-card">
        <div class="dash-chart-card__title">Class — Enrolled vs Capacity</div>
        <canvas id="chart-class-strength" class="dash-bar-canvas"></canvas>
      </div>
    </div>
  `;

  // Render charts after DOM is set
  // Defer chart rendering until after browser layout so offsetWidth is valid
  setTimeout(() => renderDashCharts(byCategory, holidays).catch(e => console.warn("chart err", e)), 200);
}

async function renderDashCharts(byCategory, holidays) {
  // ── Colour palette ────────────────────────────────────────────────────
  const ACCENT    = "#c0391b";
  const GREENS    = ["#0d5c28","#1e8449","#27ae60","#52be80","#abebc6"];
  const REDS      = ["#9e1b18","#c0392b","#e74c3c","#f1948a","#fadbd8"];
  const BLUES     = ["#1a3a8c","#2e6da4","#3498db","#7fb3d3","#d6eaf8"];
  const ORANGES   = ["#c0391b","#d35400","#e67e22","#f0a500","#f8c471"];
  const PURPLES   = ["#6c3483","#8e44ad","#a569bd","#d2b4de"];
  const TRANSPORT = [GREENS[1], REDS[1], BLUES[1]];    // bus, hostel, own
  const HOSTEL_C  = [ORANGES[0], BLUES[0]];             // Hindi, Tamil
  const YEAR_C    = [GREENS[0], BLUES[0], REDS[0], PURPLES[0], ORANGES[0]];

  // ── Derive totals from records + Firestore student counts ───────────────
  const YEAR_ORDER_CHART = ["first","second","third","fourth"];
  const YEAR_LABEL_CHART = { first:"I Year", second:"II Year", third:"III Year", fourth:"IV Year" };

  // All student totals come from meta/lastImportStats (set during Excel import).
  // Attendance records only reflect who was marked on a given day — not total strength.
  let busTotal = 0, hostelTotal = 0, ownVehicleTotal = 0;
  const yearMap = new Map();
  try {
    const statsSnap = await getDoc(doc(db, "meta", "lastImportStats"));
    if (statsSnap.exists()) {
      const sd = statsSnap.data();
      busTotal        = sd.byBus   || 0;
      hostelTotal     = sd.byHostel || 0;
      ownVehicleTotal = sd.byOwn   || 0;
      for (const [y, n] of Object.entries(sd.byYear || {})) yearMap.set(y, n);
    }
  } catch(_) {}

  // Fallback: derive from attendance records if import stats not yet saved
  if (busTotal === 0 && hostelTotal === 0) {
    busTotal    = byCategory.bus.reduce((s,r)    => s + (r.totalCount ?? 0), 0);
    hostelTotal = byCategory.hostel.reduce((s,r) => s + (r.totalCount ?? 0), 0);
  }
  if (yearMap.size === 0) {
    for (const r of byCategory.class) {
      const { year } = parseClassScopeId(r.scopeId);
      const y = year || "Other";
      yearMap.set(y, (yearMap.get(y) || 0) + (r.totalCount ?? 0));
    }
  }

  const yearLabels = [...YEAR_ORDER_CHART.filter(y => yearMap.has(y)), ...[...yearMap.keys()].filter(y => !YEAR_ORDER_CHART.includes(y))];
  const yearVals   = yearLabels.map(y => yearMap.get(y) || 0);

  // Hostel Hindi/Tamil split from hostel records' .records[] entries
  const hostelAll = byCategory.hostel.flatMap(r => r.records || []);
  const hindiCount  = hostelAll.filter(r => (r.hostelType || "").toLowerCase() === "hindi").length;
  const tamilCount  = hostelAll.filter(r => (r.hostelType || "").toLowerCase() === "tamil").length;
  const otherHostel = hostelTotal - hindiCount - tamilCount;

  // Bus strengths bar chart — fetch capacity from Firestore bus docs
  const busRecords = [...byCategory.bus].sort((a,b) => naturalSort(a.scopeId, b.scopeId));
  const busBarLabels   = busRecords.map(r => busLabel(r.scopeId));
  const busBarPresent  = busRecords.map(r => r.presentCount ?? 0);
  const busBarAbsent   = busRecords.map(r => r.absentCount  ?? 0);
  const busBarVals     = busRecords.map(r => r.totalCount   ?? 0);
  let busCapacities    = busRecords.map(() => null);
  let classCapacities  = [];
  let busEnrolled      = busRecords.map(() => null);
  let classEnrolled    = [];

  // Class strengths bar chart — group label + count
  const classRecords    = [...byCategory.class].sort((a,b) => naturalSort(a.scopeId, b.scopeId));
  const classBarLabels  = classRecords.map(r => classLabel(r.scopeId));
  const classBarPresent = classRecords.map(r => r.presentCount ?? 0);
  const classBarAbsent  = classRecords.map(r => r.absentCount  ?? 0);
  const classBarVals    = classRecords.map(r => r.totalCount   ?? 0);

  // Load capacities in parallel (best-effort — charts render without them too)
  try {
    const [busSnaps, classSnaps] = await Promise.all([
      Promise.all(busRecords.map(r => getDoc(doc(db, "buses", r.scopeId)))),
      Promise.all(classRecords.map(r => getDoc(doc(db, "classes", r.scopeId)))),
    ]);
    busCapacities        = busSnaps.map(s   => s.exists() ? (s.data().capacity    ?? null) : null);
    classCapacities      = classSnaps.map(s => s.exists() ? (s.data().capacity    ?? null) : null);
    // True enrolled strength from studentCount field set during Excel import
    busEnrolled          = busSnaps.map(s   => s.exists() ? (s.data().studentCount ?? null) : null);
    classEnrolled        = classSnaps.map(s => s.exists() ? (s.data().studentCount ?? null) : null);
  } catch(_) {}

  // ── Mini pie/donut helper ─────────────────────────────────────────────
  // Layout: donut centred in top 65% of canvas; legend stacked below
  function drawDonut(canvasId, labels, values, colors) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const activeIdx = values.map((v,i) => v > 0 ? i : -1).filter(i => i >= 0);
    const total = values.reduce((a,b) => a+b, 0);
    if (total === 0) { canvas.style.display = "none"; return; }
    const dpr  = window.devicePixelRatio || 1;
    const W    = canvas.offsetWidth || canvas.parentElement?.offsetWidth || 220;
    const legH = activeIdx.length * 22 + 8;   // 22px per legend row
    const H    = Math.round(W * 0.82) + legH;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + "px";
    canvas.style.height = H + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    // Donut in upper zone
    const pieH = H - legH;
    const cx   = W / 2, cy = pieH / 2;
    const r    = Math.min(W, pieH) * 0.40;
    const ri   = r * 0.55;
    let angle  = -Math.PI / 2;
    activeIdx.forEach(i => {
      const slice = (values[i] / total) * 2 * Math.PI;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, angle, angle + slice);
      ctx.closePath();
      ctx.fillStyle = colors[i % colors.length];
      ctx.fill();
      // thin gap between slices
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      angle += slice;
    });
    // Hole
    ctx.beginPath();
    ctx.arc(cx, cy, ri, 0, 2 * Math.PI);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    // Centre label
    ctx.fillStyle = "#111";
    ctx.font = "bold " + Math.round(r * 0.52) + "px system-ui,sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(total, cx, cy);

    // Legend — one row per active slice, left-aligned block centred under donut
    const lh = 18, lx = 12, legTop = pieH + 8;
    activeIdx.forEach((i, row) => {
      const y = legTop + row * lh;
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(lx, y + 2, 12, 12);
      ctx.fillStyle = "#333";
      ctx.font = "12px system-ui,sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(labels[i] + "  " + values[i], lx + 16, y + 1);
    });
  }

  // ── Horizontal bar chart helper ───────────────────────────────────────
  // Top bar = Actual (vivid), bottom bar = Capacity (muted)
  // Footer = Total actual / cap + coloured % fill progress bar
  // Legend moved to top-left above first row (no overlap with bars)
  // ── Attendance bar: present (green) + absent (red), stacked ─────────────
  function drawAttendBar(canvasId, labels, present, absent, enrolled) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const C_P="#1e8449", C_A="#c0392b";
    const fs=12, barH=18, gap=10, padL=90, padR=8, padT=32;
    const totalRowH=44;
    const grandP=present.reduce((a,b)=>a+b,0);
    const grandA=absent.reduce((a,b)=>a+b,0);
    const grandT=enrolled.reduce((a,b)=>a+b,0);
    const maxVal=Math.max(...enrolled,1);
    const W=canvas.offsetWidth||canvas.parentElement?.offsetWidth||340;
    const barArea=W-padL-padR;
    const H=padT+(barH+gap)*labels.length+totalRowH+8;
    const dpr=window.devicePixelRatio||1;
    canvas.width=W*dpr; canvas.height=H*dpr;
    canvas.style.width=W+"px"; canvas.style.height=H+"px";
    const ctx=canvas.getContext("2d");
    ctx.scale(dpr,dpr);
    // Legend
    let lx=padL;
    [[C_P,"Present"],[C_A,"Absent"]].forEach(([c,lbl])=>{
      ctx.fillStyle=c; ctx.fillRect(lx,8,11,11);
      ctx.fillStyle="#222"; ctx.font="bold 10px system-ui,sans-serif";
      ctx.textAlign="left"; ctx.textBaseline="top";
      ctx.fillText(lbl,lx+14,9);
      lx+=14+ctx.measureText(lbl).width+18;
    });
    function seg(color,x,y,w,h){
      if(w<=0)return; ctx.fillStyle=color;
      ctx.beginPath();if(ctx.roundRect)ctx.roundRect(x,y,Math.max(w,2),h,3);else ctx.rect(x,y,Math.max(w,2),h);ctx.fill();
    }
    function numLbl(val,x,y,bw,bh,bold){
      if(!val)return; const txt=String(val);
      ctx.font=(bold?"bold ":"")+fs+"px system-ui,sans-serif";
      const tw=ctx.measureText(txt).width;
      if(bw>=tw+8){ctx.fillStyle="#fff";ctx.textAlign="right";ctx.textBaseline="middle";ctx.fillText(txt,x+bw-4,y+bh/2);}
      else{ctx.fillStyle="#111";ctx.textAlign="left";ctx.textBaseline="middle";ctx.fillText(txt,x+bw+4,y+bh/2);}
    }
    labels.forEach((lbl,i)=>{
      const y=padT+i*(barH+gap);
      const enrl=enrolled[i]||0,p=present[i]||0;
      const enrlW=Math.round((enrl/maxVal)*barArea);
      const pW=enrl>0?Math.round((p/enrl)*enrlW):0;
      const aW=enrlW-pW;
      ctx.fillStyle="#222"; ctx.font="bold "+fs+"px system-ui,sans-serif";
      ctx.textAlign="right"; ctx.textBaseline="middle";
      ctx.fillText(lbl,padL-8,y+barH/2);
      seg(C_P,padL,y,pW,barH); seg(C_A,padL+pW,y,aW,barH);
      numLbl(p,padL,y,pW,barH,true); numLbl(absent[i]||0,padL+pW,y,aW,barH,true);
    });
    // Footer
    const ty=padT+labels.length*(barH+gap)+4;
    ctx.fillStyle="#e6e6e6"; ctx.fillRect(0,ty,W,totalRowH);
    ctx.fillStyle="#ccc"; ctx.fillRect(0,ty,W,1);
    ctx.font="bold "+(fs+1)+"px system-ui,sans-serif";
    ctx.textAlign="right"; ctx.textBaseline="middle"; ctx.fillStyle="#222";
    ctx.fillText("Total",padL-8,ty+14);
    ctx.textAlign="left";
    ctx.fillStyle=C_P; ctx.fillText("P:"+grandP,padL+4,ty+14);
    const pw=ctx.measureText("P:"+grandP).width+8;
    ctx.fillStyle=C_A; ctx.fillText("A:"+grandA,padL+4+pw,ty+14);
    const aw=ctx.measureText("A:"+grandA).width+8;
    ctx.fillStyle="#333"; ctx.fillText("T:"+grandT,padL+4+pw+aw,ty+14);
    if(grandT>0){
      const pct=Math.round((grandP/grandT)*100);
      const bY=ty+26,bH2=12,bW=W-padL-10;
      ctx.fillStyle="#d0d0d0";
      ctx.beginPath();if(ctx.roundRect)ctx.roundRect(padL,bY,bW,bH2,6);else ctx.rect(padL,bY,bW,bH2);ctx.fill();
      const fw=Math.round((pct/100)*bW);
      ctx.fillStyle=pct>=90?C_P:pct>=75?"#e67e22":C_A;
      if(fw>0){ctx.beginPath();if(ctx.roundRect)ctx.roundRect(padL,bY,fw,bH2,6);else ctx.rect(padL,bY,fw,bH2);ctx.fill();}
      ctx.fillStyle="#fff"; ctx.font="bold 10px system-ui,sans-serif";
      ctx.textAlign="center"; ctx.textBaseline="middle";
      ctx.fillText(pct+"% present",padL+bW/2,bY+bH2/2);
    }
  }

  // ── Strength bar: enrolled vs capacity, two bars per row ─────────────────
  function drawStrengthBar(canvasId, labels, enrolled, capacities) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const caps=capacities||labels.map(()=>null);
    const hasCap=caps.some(c=>c!=null&&c>0);
    const C_ENR="#2e6da4", C_CAP="#b0c4de";
    const fs=12, barH=14, gap=10, padL=90, padR=48;
    const padT=hasCap?28:10, totalRowH=hasCap?66:32;
    const rowH=hasCap?barH*2+6:barH+4;
    const grandE=enrolled.reduce((a,b)=>a+b,0);
    const grandC=hasCap?caps.reduce((a,b)=>a+(b||0),0):null;
    const fillPct=grandC?Math.round((grandE/grandC)*100):null;
    const maxVal=Math.max(...enrolled,...(hasCap?caps.map(c=>c||0):[]),1);
    // Walk up DOM to find a container with a real width
    let W = canvas.offsetWidth;
    if (!W) W = canvas.parentElement?.offsetWidth;
    if (!W) W = canvas.parentElement?.parentElement?.offsetWidth;
    if (!W) W = 400;
    const barArea=W-padL-padR;
    const H=padT+(rowH+gap)*labels.length+totalRowH+12;
    const dpr=window.devicePixelRatio||1;
    canvas.width=W*dpr; canvas.height=H*dpr;
    canvas.style.width=W+"px"; canvas.style.height=H+"px";
    const ctx=canvas.getContext("2d");
    ctx.scale(dpr,dpr);
    if(hasCap){
      let lx=padL;
      [[C_ENR,"Enrolled"],[C_CAP,"Capacity"]].forEach(([c,lbl])=>{
        ctx.fillStyle=c; ctx.fillRect(lx,7,11,11);
        ctx.fillStyle="#222"; ctx.font="bold 10px system-ui,sans-serif";
        ctx.textAlign="left"; ctx.textBaseline="top";
        ctx.fillText(lbl,lx+14,8); lx+=14+ctx.measureText(lbl).width+18;
      });
    }
    function numLbl(val,x,y,bw,bh,ins){
      if(!val)return; const txt=String(val);
      ctx.font=(ins?"bold ":"")+fs+"px system-ui,sans-serif";
      const tw=ctx.measureText(txt).width;
      if(ins&&bw>=tw+8){ctx.fillStyle="#fff";ctx.textAlign="right";ctx.textBaseline="middle";ctx.fillText(txt,x+bw-4,y+bh/2);}
      else{ctx.fillStyle="#222";ctx.textAlign="left";ctx.textBaseline="middle";ctx.fillText(txt,x+bw+4,y+bh/2);}
    }
    labels.forEach((lbl,i)=>{
      const rowY=padT+i*(rowH+gap);
      const enrl=enrolled[i]||0,cap=caps[i]||0;
      const eW=Math.max(Math.round((enrl/maxVal)*barArea),3);
      ctx.fillStyle="#222"; ctx.font="bold "+fs+"px system-ui,sans-serif";
      ctx.textAlign="right"; ctx.textBaseline="middle";
      ctx.fillText(lbl,padL-8,rowY+rowH/2);
      if(hasCap&&cap>0){
        const cW=Math.max(Math.round((cap/maxVal)*barArea),3);
        ctx.fillStyle=C_ENR;
        ctx.beginPath();if(ctx.roundRect)ctx.roundRect(padL,rowY,eW,barH,3);else ctx.rect(padL,rowY,eW,barH);ctx.fill();
        numLbl(enrl,padL,rowY,eW,barH,true);
        const capY=rowY+barH+6;
        ctx.fillStyle=C_CAP;
        ctx.beginPath();if(ctx.roundRect)ctx.roundRect(padL,capY,cW,barH,3);else ctx.rect(padL,capY,cW,barH);ctx.fill();
        numLbl(cap,padL,capY,cW,barH,false);
      } else {
        ctx.fillStyle=C_ENR;
        ctx.beginPath();if(ctx.roundRect)ctx.roundRect(padL,rowY,eW,rowH,3);else ctx.rect(padL,rowY,eW,rowH);ctx.fill();
        numLbl(enrl,padL,rowY,eW,rowH,true);
      }
    });
    // ── Total summary card ────────────────────────────────────────────
    // Rounded panel, clear "N enrolled / M capacity" line, and a slim
    // pill progress bar with a status colour + label above it instead
    // of cramped text stuffed inside a thin bar.
    function rr(x,y,w,h,r){ctx.beginPath();if(ctx.roundRect)ctx.roundRect(x,y,w,h,r);else ctx.rect(x,y,w,h);}
    const ty=padT+labels.length*(rowH+gap)+6;
    const panelH=totalRowH-6, panelR=10;
    rr(2,ty,W-4,panelH,panelR); ctx.fillStyle="#f5f7fa"; ctx.fill();
    rr(2,ty,W-4,panelH,panelR); ctx.strokeStyle="#e3e7ec"; ctx.lineWidth=1; ctx.stroke();

    const innerX=16;
    const line1Y=hasCap?ty+18:ty+panelH/2;
    ctx.textAlign="left"; ctx.textBaseline="middle";
    ctx.font="bold 10px system-ui,sans-serif"; ctx.fillStyle="#8a8f98";
    ctx.fillText("TOTAL",innerX,line1Y);
    const totalLblW=ctx.measureText("TOTAL").width;

    ctx.font="bold 15px system-ui,sans-serif"; ctx.fillStyle=C_ENR;
    const enrTxt=String(grandE);
    ctx.fillText(enrTxt,innerX+totalLblW+10,line1Y);
    const enrW=ctx.measureText(enrTxt).width;

    let cursorX=innerX+totalLblW+10+enrW;
    ctx.font="12px system-ui,sans-serif"; ctx.fillStyle="#5a6270";
    const enrolledWord=hasCap?" enrolled":" students";
    ctx.fillText(enrolledWord,cursorX,line1Y);
    cursorX+=ctx.measureText(enrolledWord).width;

    if(hasCap&&grandC){
      ctx.fillStyle="#c3c8d1"; ctx.fillText("  /  ",cursorX,line1Y);
      cursorX+=ctx.measureText("  /  ").width;
      ctx.font="bold 15px system-ui,sans-serif"; ctx.fillStyle="#444";
      const capTxt=String(grandC);
      ctx.fillText(capTxt,cursorX,line1Y);
      cursorX+=ctx.measureText(capTxt).width;
      ctx.font="12px system-ui,sans-serif"; ctx.fillStyle="#5a6270";
      ctx.fillText(" capacity",cursorX,line1Y);

      // Status pill on the right: OK / Nearly Full / Over Capacity
      const overBy=grandE-grandC;
      const status = fillPct>=100 ? {t:(overBy>0?"OVER BY "+overBy:"FULL"), bg:"#fdecea", fg:"#c0392b"}
                    : fillPct>=80 ? {t:fillPct+"% FULL", bg:"#fef3e6", fg:"#b9660a"}
                    : {t:fillPct+"% FULL", bg:"#eaf6ee", fg:"#1e8449"};
      ctx.font="bold 10px system-ui,sans-serif";
      const stW=ctx.measureText(status.t).width+16;
      const stX=W-10-stW, stY=line1Y-9;
      rr(stX,stY,stW,18,9); ctx.fillStyle=status.bg; ctx.fill();
      ctx.fillStyle=status.fg; ctx.textAlign="center"; ctx.textBaseline="middle";
      ctx.fillText(status.t,stX+stW/2,line1Y);
      ctx.textAlign="left";

      // Progress bar (capped visually at 100%, colour reflects status)
      const bY=ty+34,bH2=10,bW=W-innerX*2;
      rr(innerX,bY,bW,bH2,bH2/2); ctx.fillStyle="#e1e5eb"; ctx.fill();
      const pctCapped=Math.min(fillPct,100), fw=Math.round((pctCapped/100)*bW);
      if(fw>0){
        rr(innerX,bY,fw,bH2,bH2/2);
        const grad=ctx.createLinearGradient(innerX,0,innerX+bW,0);
        if(fillPct>=100){grad.addColorStop(0,"#e57368");grad.addColorStop(1,"#c0392b");}
        else if(fillPct>=80){grad.addColorStop(0,"#f0a94e");grad.addColorStop(1,"#e67e22");}
        else{grad.addColorStop(0,"#3fae6a");grad.addColorStop(1,"#1e8449");}
        ctx.fillStyle=grad; ctx.fill();
      }
    }
  }

  // ── Draw all charts ───────────────────────────────────────────────────
  drawDonut("chart-year", yearLabels.map(y => YEAR_LABEL_CHART[y] || y), yearVals, YEAR_C);
  drawDonut("chart-transport", ["Bus", "Hostel", "Own Vehicle"], [busTotal, hostelTotal, ownVehicleTotal], TRANSPORT);
  const hostelPieLabels = ["Hindi", "Tamil"];
  const hostelPieVals   = [hindiCount, tamilCount];
  if (otherHostel > 0) { hostelPieLabels.push("Other"); hostelPieVals.push(otherHostel); }
  drawDonut("chart-hostel", hostelPieLabels, hostelPieVals, HOSTEL_C);

  drawAttendBar("chart-bus-attend",   busBarLabels,   busBarPresent,   busBarAbsent,   busBarVals);
  drawAttendBar("chart-class-attend", classBarLabels, classBarPresent, classBarAbsent, classBarVals);
  // Use enrolled strength (from studentCount in Firestore) — falls back to attendance totalCount
  const busStrengthVals   = busEnrolled.map((v, i)   => v ?? busBarVals[i]);
  const classStrengthVals = classEnrolled.map((v, i) => v ?? classBarVals[i]);
  drawStrengthBar("chart-bus-strength",   busBarLabels,   busStrengthVals,   busCapacities);
  drawStrengthBar("chart-class-strength", classBarLabels, classStrengthVals, classCapacities);

  // Resize parent cards to fit canvas height
  // Set card heights after all canvases are drawn
  ["chart-bus-attend","chart-class-attend","chart-bus-strength","chart-class-strength"].forEach(id => {
    const c = document.getElementById(id);
    if (c && c.style.height) c.parentElement.style.minHeight = c.style.height;
  });
}

// Collapses a list of attendanceRecords docs (all for the same date)
// down to at most one per category+scopeId. Normally there's already
// only one — the deterministic record ID guarantees that for any
// SINGLE save path — but this query fetches every doc for the date
// regardless of ID, so it can pick up a stray duplicate left over
// from a past ID-scheme change, a manual Firestore edit, etc. When
// two docs do collide on the same scope, keep the one with the most
// recent updatedAt (falling back to createdAt, then to "first seen")
// so the freshest attendance always wins rather than silently
// double-listing the scope.
function dedupeRecordsByScope(records) {
  const bestByKey = new Map();
  for (const r of records) {
    const key = `${r.category}:${r.scopeId}`;
    const existing = bestByKey.get(key);
    if (!existing || recordTimestampMs(r) > recordTimestampMs(existing)) {
      bestByKey.set(key, r);
    }
  }
  return Array.from(bestByKey.values());
}

function recordTimestampMs(r) {
  const ts = r.updatedAt || r.createdAt;
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  return 0;
}

function summaryBoxShell(icon, title, holiday, bodyHtml, headCount = null) {
  const countBadge = headCount !== null ? `<span class="summary-box__head-count">${headCount} total</span>` : "";
  if (holiday) {
    return `
      <div class="summary-box card">
        <div class="summary-box__head">${icon} ${title}${countBadge}</div>
        <div class="summary-box__holiday">
          🗓️ Holiday${holiday.label ? ` · ${escapeHtml(holiday.label)}` : ""}
        </div>
      </div>
    `;
  }
  return `
    <div class="summary-box card">
      <div class="summary-box__head">${icon} ${title}${countBadge}</div>
      <div class="summary-box__body">${bodyHtml}</div>
    </div>
  `;
}

// ---- Hostel box: group records by hostelType, then by year ----
// buildHostelGroups returns the pure data ({groups, grandTotal}) with
// no HTML, so both the on-screen Combined Summary and the "Today's
// Full Report" PDF can render identical numbers from one source of
// truth instead of the PDF re-deriving its own grouping.
function buildHostelGroups(records) {
  // A single hostel record holds every student in its `records[]`
  // array (one scope total, unlike buses/classes which are one scope
  // each) — so group that one record's roster snapshot by type/year.
  const all = records.flatMap((r) => r.records || []);

  const byType = new Map();
  for (const r of all) {
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

  const groups = typeKeys.map((type) => {
    const list = byType.get(type);
    const byYear = new Map();
    for (const r of list) {
      const key = r.year || "Other";
      if (!byYear.has(key)) byYear.set(key, []);
      byYear.get(key).push(r);
    }
    const yearKeys = Array.from(byYear.keys()).sort(yearKeyComparator);
    const children = yearKeys.map((year) => {
      const yl = byYear.get(year);
      return {
        label: yearGroupLabel(year),
        present: yl.filter((r) => r.status === "present").length,
        absent: yl.filter((r) => r.status === "absent").length,
        total: yl.length,
      };
    });
    const present = children.reduce((s, c) => s + c.present, 0);
    const absent = children.reduce((s, c) => s + c.absent, 0);
    const total = children.reduce((s, c) => s + c.total, 0);
    return { label: `${type} Hostel`, present, absent, total, children };
  });

  const grandPresent = groups.reduce((s, g) => s + g.present, 0);
  const grandAbsent = groups.reduce((s, g) => s + g.absent, 0);
  const grandTotal = groups.reduce((s, g) => s + g.total, 0);

  return { groups, grandTotal: { present: grandPresent, absent: grandAbsent, total: grandTotal } };
}

function renderHostelBox(records, holiday) {
  if (holiday) return summaryBoxShell("🏠", "Hostel", holiday, "");
  if (records.length === 0) {
    return summaryBoxShell("🏠", "Hostel", null, `<p class="summary-box__empty">Not yet marked</p>`);
  }
  const { groups, grandTotal } = buildHostelGroups(records);
  return summaryBoxShell("🏠", "Hostel", null, summaryTable(groups, grandTotal), grandTotal.total);
}

// ---- Bus box: flat list, one row per bus scope (no sub-groups) ----
function buildBusGroups(records) {
  const groups = records
    .slice()
    .sort((a, b) => naturalSort(a.scopeId, b.scopeId))
    .map((r) => ({
      label: busLabel(r.scopeId),
      present: r.presentCount ?? 0,
      absent: r.absentCount ?? 0,
      total: r.totalCount ?? 0,
      children: [],
    }));

  const grandPresent = groups.reduce((s, r) => s + r.present, 0);
  const grandAbsent = groups.reduce((s, r) => s + r.absent, 0);
  const grandTotal = groups.reduce((s, r) => s + r.total, 0);

  return { groups, grandTotal: { present: grandPresent, absent: grandAbsent, total: grandTotal } };
}

function renderBusBox(records, holiday) {
  if (holiday) return summaryBoxShell("🚌", "Buses", holiday, "");
  if (records.length === 0) {
    return summaryBoxShell("🚌", "Buses", null, `<p class="summary-box__empty">Not yet marked</p>`);
  }
  const { groups, grandTotal } = buildBusGroups(records);
  return summaryBoxShell("🚌", "Buses", null, summaryTable(groups, grandTotal), grandTotal.total);
}

// ---- Class box: each scope IS one year+dept — group by year, ----
// ---- one child row per dept within that year ----
function buildClassGroups(records) {
  const byYear = new Map();
  for (const r of records) {
    const { year, dept } = parseClassScopeId(r.scopeId);
    const key = year || "Other";
    if (!byYear.has(key)) byYear.set(key, []);
    byYear.get(key).push({ dept, r });
  }
  const yearKeys = Array.from(byYear.keys()).sort(yearKeyComparator);

  const groups = yearKeys.map((year) => {
    const list = byYear.get(year).slice().sort((a, b) => a.dept.localeCompare(b.dept));
    const children = list.map(({ dept, r }) => ({
      label: dept,
      present: r.presentCount ?? 0,
      absent: r.absentCount ?? 0,
      total: r.totalCount ?? 0,
    }));
    const present = children.reduce((s, c) => s + c.present, 0);
    const absent = children.reduce((s, c) => s + c.absent, 0);
    const total = children.reduce((s, c) => s + c.total, 0);
    return { label: yearGroupLabel(year), present, absent, total, children };
  });

  const grandPresent = groups.reduce((s, g) => s + g.present, 0);
  const grandAbsent = groups.reduce((s, g) => s + g.absent, 0);
  const grandTotal = groups.reduce((s, g) => s + g.total, 0);

  return { groups, grandTotal: { present: grandPresent, absent: grandAbsent, total: grandTotal } };
}

function renderClassBox(records, holiday) {
  if (holiday) return summaryBoxShell("🎓", "Classes", holiday, "");
  if (records.length === 0) {
    return summaryBoxShell("🎓", "Classes", null, `<p class="summary-box__empty">Not yet marked</p>`);
  }
  const { groups, grandTotal } = buildClassGroups(records);
  return summaryBoxShell("🎓", "Classes", null, summaryTable(groups, grandTotal), grandTotal.total);
}

/**
 * Renders the shared summary-box table markup: a header row, one
 * bold group row + indented child rows per group, a Total footer,
 * and a % footer (T always 100, P/A as their share of the day's
 * total — i.e. P% + A% sum to 100, not to each row's own total).
 * `groups` is [{ label, present, absent, total, children }], where
 * `children` (possibly empty) is [{ label, present, absent, total }].
 */
function summaryTable(groups, grandTotal) {
  const pct = (n, t) => (t > 0 ? Math.round((n / t) * 100) : 0);
  const pPct = pct(grandTotal.present, grandTotal.total);
  const aPct = pct(grandTotal.absent, grandTotal.total);

  return `
    <table class="summary-box__table">
      <colgroup>
        <col class="summary-box__col--label" />
        <col class="summary-box__col--num" />
        <col class="summary-box__col--num" />
        <col class="summary-box__col--num" />
      </colgroup>
      <thead>
        <tr><th>Scope</th><th>T</th><th>P</th><th>A</th></tr>
      </thead>
      <tbody>
        ${groups
          .map((g) => {
            const hasChildren = (g.children || []).length > 0;
            return `
            <tr class="${hasChildren ? "summary-box__row--group" : "summary-box__row--leaf"}">
              <td>${escapeHtml(g.label)}</td>
              <td class="summary-box__num summary-box__num--total">${g.total}</td>
              <td class="summary-box__num summary-box__num--present">${g.present}</td>
              <td class="summary-box__num summary-box__num--absent">${g.absent}</td>
            </tr>
            ${(g.children || [])
              .map((c) => `
                <tr class="summary-box__row--child">
                  <td>${escapeHtml(c.label)}</td>
                  <td class="summary-box__num summary-box__num--total">${c.total}</td>
                  <td class="summary-box__num summary-box__num--present">${c.present}</td>
                  <td class="summary-box__num summary-box__num--absent">${c.absent}</td>
                </tr>
              `)
              .join("")}
          `;
          })
          .join("")}
      </tbody>
      <tfoot>
        <tr class="summary-box__row--total">
          <td>Total</td>
          <td class="summary-box__num summary-box__num--total">${grandTotal.total}</td>
          <td class="summary-box__num summary-box__num--present">${grandTotal.present}</td>
          <td class="summary-box__num summary-box__num--absent">${grandTotal.absent}</td>
        </tr>
        <tr class="summary-box__row--pct">
          <td colspan="4">
            <div class="summary-box__pctbar-wrap">
              <div class="summary-box__pctbar">
                <div class="summary-box__pctbar-present" style="width:${pPct}%"></div>
                <div class="summary-box__pctbar-absent" style="width:${aPct}%"></div>
              </div>
              <div class="summary-box__pctbar-legend">
                <span class="present">● Present ${pPct}%</span>
                <span class="absent">● Absent ${aPct}%</span>
              </div>
            </div>
          </td>
        </tr>
      </tfoot>
    </table>
  `;
}

// "first_cse" / "class_first_cse" → { year: "first", dept: "CSE" }
function parseClassScopeId(scopeId) {
  const bare = scopeId.replace(/^class_/, "");
  const parts = bare.split("_");
  const yearWord = (parts[0] || "").toLowerCase();
  if (ORDINAL_MAP[yearWord]) {
    return { year: yearWord, dept: parts.slice(1).join(" ").toUpperCase() };
  }
  return { year: null, dept: bare.replace(/_/g, " ").toUpperCase() };
}

function yearGroupLabel(year) {
  const roman = ORDINAL_MAP[(year || "").toLowerCase()];
  return roman ? `${roman} Year` : year;
}

function yearKeyComparator(a, b) {
  const ra = ORDINAL_MAP[(a || "").toLowerCase()];
  const rb = ORDINAL_MAP[(b || "").toLowerCase()];
  const order = Object.keys(ORDINAL_MAP);
  if (ra && rb) return order.indexOf(a.toLowerCase()) - order.indexOf(b.toLowerCase());
  if (ra) return -1;
  if (rb) return 1;
  return (a || "").localeCompare(b || "");
}

/** Adds (or subtracts) whole days to a YYYY-MM-DD string, built from
 * local y/m/d components (not `new Date(dateStr)`, which parses as
 * UTC midnight and can land on the wrong day for IST users). */
function shiftDate(dateStr, deltaDays) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const next = new Date(y, m - 1, d + deltaDays);
  const yyyy = next.getFullYear();
  const mm = String(next.getMonth() + 1).padStart(2, "0");
  const dd = String(next.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function updateDashCard(cardEl, data, session) {
  const stateEl = cardEl.querySelector(".dash-card__state");
  if (!stateEl) return;

  if (!data) {
    stateEl.className = "dash-card__state dash-card__state--pending";
    stateEl.textContent = "Not yet marked";
    return;
  }

  const { presentCount, absentCount, totalCount, markedBy, updatedAt, locked } = data;
  const updatedStr = updatedAt?.toDate
    ? updatedAt.toDate().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
    : "";

  stateEl.className = "dash-card__state dash-card__state--done";
  stateEl.innerHTML = `
    <span class="dash-count dash-count--present">P: ${presentCount}</span>
    <span class="dash-count dash-count--absent">A: ${absentCount}</span>
    <span class="dash-count dash-count--total">/ ${totalCount}</span>
    ${locked ? `<span class="dash-badge dash-badge--locked">🔒</span>` : ""}
    <div class="dash-card__meta">
      ${markedBy ? escapeHtml(markedBy.name) : ""}
      ${updatedStr ? `· ${updatedStr}` : ""}
    </div>
  `;
}

async function generateMasterPdf(cardData, college, reportDate) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  let y = 16;

  // Logo, if set, sits at the left margin with the text block stacked
  // to its right — mirrors shared/pdf-utils.js's addCollegeHeader so
  // every PDF in the app (Daily, Monthly, Full Report) uses the same
  // letterhead layout.
  // Logo, if set, sits at the left margin with the text block stacked
  // to its right — mirrors shared/pdf-utils.js's addCollegeHeader so
  // every PDF in the app (Daily, Monthly, Full Report) uses the same
  // compact letterhead layout.
  const NAME_STEP = 6;
  const LINE_STEP = 4.2;

  function drawCollegeHeader() {
    const startY = y;
    const hasLogo = !!college?.logoDataUrl;
    const hasAddress = !!college?.address;
    const phones = (college?.phones || []).filter((p) => p?.digits);
    const hasPhones = phones.length > 0;
    const hasWebsite = !!college?.website;

    const lineCount = 1 + (hasAddress ? 1 : 0) + (hasPhones ? 1 : 0) + (hasWebsite ? 1 : 0);
    const textBlockHeight = NAME_STEP + (lineCount - 1) * LINE_STEP;
    const logoSize = hasLogo ? Math.max(14, textBlockHeight) : 0;
    const textX = hasLogo ? margin + logoSize + 5 : pageW / 2;
    const textAlign = hasLogo ? "left" : "center";

    if (hasLogo) {
      try {
        const logoY = startY - 3 + (textBlockHeight - logoSize) / 2;
        doc.addImage(college.logoDataUrl, "JPEG", margin, logoY, logoSize, logoSize);
      } catch (_) {
        // Corrupt/unsupported image data — fall back to text-only header.
      }
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(30, 30, 30);
    doc.text(college?.name || "Kongu Hi-Tek Polytechnic College", textX, y, { align: textAlign });
    y += NAME_STEP;

    if (hasAddress) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(90, 90, 90);
      doc.text(college.address, textX, y, { align: textAlign });
      y += LINE_STEP;
    }

    if (hasPhones) {
      const phoneStr = "Ph: " + phones.map((p) => formatPhone(p.digits)).join("  |  ");
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(90, 90, 90);
      doc.text(phoneStr, textX, y, { align: textAlign });
      y += LINE_STEP;
    }

    if (hasWebsite) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(31, 111, 235);
      doc.text(college.website, textX, y, { align: textAlign });
    }

    // y is currently sitting at the BASELINE of the last text line
    // drawn (jsPDF's text y-coordinate is baseline, not line-top) —
    // no "y += LINE_STEP" after the final line, since that would just
    // be dead space with no text to fill it. A small fixed clearance
    // below the baseline covers the line's descenders before the
    // divider.
    y += 2.5;

    if (hasLogo) {
      y = Math.max(y, startY - 3 + logoSize + 3);
    }

    doc.setDrawColor(200, 200, 200);
    doc.setTextColor(30, 30, 30);
    doc.line(margin, y, pageW - margin, y);
    y += 4;
  }

  // jsPDF's standard fonts (helvetica/times/courier) only support
  // WinAnsi-encodable characters, so emoji here render as garbled
  // glyphs (e.g. "Ø<ßà") rather than failing loudly — keep these
  // labels plain-text only. The emoji versions are still used on the
  // live HTML dashboard above, where the browser renders them fine.
  const CATEGORY_LABELS = {
    hostel: "Hostel",
    bus: "Buses",
    class: "Classes",
  };

  // ----------------------------------------------------------------
  // PAGE 1 — Combined Summary, mirroring the dashboard's three boxes
  // (Hostel / Buses / Classes) exactly: same grouping, same Total
  // and % footer rows, built from the same fetchCombinedSummaryData
  // + buildXGroups helpers the on-screen Combined Summary uses.
  // ----------------------------------------------------------------
  drawCollegeHeader();
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14.4);
  doc.text("Combined Summary — " + formatDate(reportDate), pageW / 2, y, { align: "center" });
  y += 9;

  let summaryByCategory, summaryHolidays;
  try {
    ({ byCategory: summaryByCategory, holidays: summaryHolidays } = await fetchCombinedSummaryData(reportDate));
  } catch {
    summaryByCategory = { hostel: [], bus: [], class: [] };
    summaryHolidays = { hostel: null, bus: null, class: null };
  }

  const summaryBoxes = [
    { key: "hostel", label: "Hostel", holiday: summaryHolidays.hostel,
      data: summaryByCategory.hostel.length ? buildHostelGroups(summaryByCategory.hostel) : null },
    { key: "bus", label: "Buses", holiday: summaryHolidays.bus,
      data: summaryByCategory.bus.length ? buildBusGroups(summaryByCategory.bus) : null },
    { key: "class", label: "Classes", holiday: summaryHolidays.class,
      data: summaryByCategory.class.length ? buildClassGroups(summaryByCategory.class) : null },
  ];

  const pageH = doc.internal.pageSize.getHeight();
  for (const box of summaryBoxes) {
    // Guard against a box heading landing right at the bottom edge of
    // the page with no room for its table — start a fresh page instead.
    if (y > pageH - 40) {
      doc.addPage();
      y = 16;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(30, 30, 30);
    doc.text(box.label, margin, y);
    y += 5;

    if (box.holiday) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10.8);
      doc.setTextColor(120, 120, 120);
      doc.text(`Holiday${box.holiday.label ? " · " + box.holiday.label : ""}`, margin, y + 3);
      y += 12;
      continue;
    }
    if (!box.data) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10.8);
      doc.setTextColor(150, 150, 150);
      doc.text("Not yet marked", margin, y + 3);
      y += 12;
      continue;
    }

    const { groups, grandTotal } = box.data;
    const pct = (n, t) => (t > 0 ? Math.round((n / t) * 100) : 0);

    const summaryRows = [];
    for (const g of groups) {
      const hasChildren = (g.children || []).length > 0;
      summaryRows.push([
        { content: g.label, styles: hasChildren ? { fontStyle: "bold" } : {} },
        g.total, g.present, g.absent,
      ]);
      for (const c of g.children || []) {
        summaryRows.push([{ content: `    ${c.label}` }, c.total, c.present, c.absent]);
      }
    }
    summaryRows.push([
      { content: "Total", styles: { fontStyle: "bold" } },
      { content: grandTotal.total, styles: { fontStyle: "bold" } },
      { content: grandTotal.present, styles: { fontStyle: "bold" } },
      { content: grandTotal.absent, styles: { fontStyle: "bold" } },
    ]);
    summaryRows.push([
      "%", "100%", `${pct(grandTotal.present, grandTotal.total)}%`, `${pct(grandTotal.absent, grandTotal.total)}%`,
    ]);

    doc.autoTable({
      startY: y,
      head: [[
        "Scope",
        { content: "T", styles: { halign: "right" } },
        { content: "P", styles: { halign: "right" } },
        { content: "A", styles: { halign: "right", cellPadding: { top: 2.5, right: 6, bottom: 2.5, left: 2.5 } } },
      ]],
      body: summaryRows,
      styles: { fontSize: 10.2, cellPadding: 2.5 },
      headStyles: { fillColor: [216, 67, 21], textColor: 255, fontStyle: "bold" },
      columnStyles: {
        0: { cellWidth: 110 },
        1: { cellWidth: 22, halign: "right" },
        2: { cellWidth: 22, halign: "right", textColor: [46, 125, 50] },
        // Extra right padding on the last column (A) so its numbers
        // sit a little inside the table's right border instead of
        // running flush against the edge. All four sides set
        // explicitly (not just `right`) so top/bottom spacing isn't
        // left to chance on whether unset sides inherit the table's
        // base cellPadding or default to zero.
        3: { cellWidth: 28, halign: "right", textColor: [198, 40, 40], cellPadding: { top: 2.5, right: 6, bottom: 2.5, left: 2.5 } },
      },
      margin: { left: margin, right: margin },
      didParseCell: (hookData) => {
        if (hookData.section !== "body") return;
        const isLast = hookData.row.index === summaryRows.length - 1;
        const isSecondLast = hookData.row.index === summaryRows.length - 2;
        if (isLast || isSecondLast) {
          hookData.cell.styles.fontStyle = "bold";
          hookData.cell.styles.fillColor = [250, 240, 235];
        }
      },
    });

    y = doc.lastAutoTable.finalY + 8;
  }

  // ----------------------------------------------------------------
  // PAGE 2+ — detailed per-scope listing for reportDate: every scope
  // including ones not yet marked, regardless of category.
  // ----------------------------------------------------------------
  doc.addPage();
  y = 16;
  drawCollegeHeader();
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("Attendance at a Glance — " + formatDate(reportDate), pageW / 2, y, { align: "center" });
  y += 10;

  // Group entries by category, preserving order
  const grouped = new Map(); // category → [{scope, data}]
  for (const [, entry] of cardData) {
    const cat = entry.scope.category || "other";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat).push(entry);
  }

  const rows = [];
  for (const [cat, entries] of grouped) {
    // Section header row
    rows.push([
      { content: CATEGORY_LABELS[cat] || cat, colSpan: 5, styles: {
        fillColor: [245, 124, 80], textColor: [255, 255, 255],
        fontStyle: "bold", fontSize: 9, cellPadding: { top: 3, bottom: 3, left: 4, right: 4 },
      }},
    ]);
    for (const { scope, data, holiday } of entries) {
      if (holiday) {
        rows.push([scope.label, "Holiday", "—", "—", "—"]);
      } else if (!data) {
        rows.push([scope.label, "Not marked", "—", "—", "—"]);
      } else {
        rows.push([scope.label, "Marked", data.presentCount, data.absentCount, data.totalCount]);
      }
    }
  }

  doc.autoTable({
    startY: y,
    head: [["Scope", "Status", "Present", "Absent", "Total"]],
    body: rows,
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [216, 67, 21], textColor: 255, fontStyle: "bold" },
    columnStyles: { 0: { cellWidth: 55 } },
    didParseCell: (hookData) => {
      if (hookData.section !== "body") return;
      // Section header rows have a colSpan object in cell.raw
      if (hookData.cell.raw && typeof hookData.cell.raw === "object" && hookData.cell.raw.colSpan) return;
      // Dim "Not marked" / "Holiday" status text
      if (hookData.column.index === 1 && (hookData.cell.raw === "Not marked" || hookData.cell.raw === "Holiday")) {
        hookData.cell.styles.textColor = [150, 150, 150];
      }
    },
    margin: { left: margin, right: margin },
  });

  const ts = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const footerPageH = doc.internal.pageSize.getHeight();
  doc.setFontSize(7);
  doc.setTextColor(160, 160, 160);
  doc.text(`Generated: ${ts} IST`, pageW - margin, footerPageH - 6, { align: "right" });

  triggerDownload(doc.output("blob"), `attendance-report-${reportDate}.pdf`);
}

// ================================================================
// DAILY REPORT
// ================================================================

async function renderDailyScreen(main, state) {
  let selectedDate = todayLocalDate();
  let selectedCategory = null;
  let selectedBusId = null;
  let selectedClassYear = null;
  let selectedClassScopeId = null;
  let buses = [], classes = [];

  main.innerHTML = `<div class="page page--wide"><p class="status">Loading scopes\u2026</p></div>`;
  try {
    const [busSnap, classSnap] = await Promise.all([
      getDocs(collection(db, "buses")),
      getDocs(collection(db, "classes")),
    ]);
    busSnap.forEach((d) => buses.push({ id: d.id, ...d.data() }));
    buses.sort((a, b) => naturalSort(a.id, b.id));
    classSnap.forEach((d) => classes.push({ id: d.id, ...d.data() }));
    classes.sort((a, b) => naturalSort(a.id, b.id));
  } catch (err) {
    main.innerHTML = `<div class="page page--wide"><div class="msg msg--err">${escapeHtml(err.message)}</div></div>`;
    return;
  }

  function classesByYear() {
    const map = new Map();
    classes.forEach(c => {
      const { year } = parseClassScopeId(c.id);
      const y = year || "other";
      if (!map.has(y)) map.set(y, []);
      map.get(y).push(c);
    });
    return map;
  }
  function yearLabel(y) {
    const labels = { first: "I Year", second: "II Year", third: "III Year", fourth: "IV Year" };
    return labels[y] || y.replace(/_/g, " ").toUpperCase();
  }

  function render() {
    const byYear = classesByYear();
    const years = [...byYear.keys()];
    main.innerHTML = `
      <div class="page page--wide rpt-page">
        <h2 class="rpt-title">Daily Report</h2>
        <div class="rpt-date-row">
          <span class="rpt-date-label">Date</span>
          <input type="date" id="rpt-date" class="rpt-date-input" value="${selectedDate}" max="${todayLocalDate()}" />
        </div>
        <div class="rpt-section-label">Select Category</div>
        <div class="rpt-cat-row">
          <button class="rpt-cat-btn ${selectedCategory==="hostel"?"rpt-cat-btn--active":""}" data-cat="hostel">\uD83C\uDFE0<span>Hostel</span></button>
          <button class="rpt-cat-btn ${selectedCategory==="bus"?"rpt-cat-btn--active":""}" data-cat="bus">\uD83D\uDE8C<span>Bus</span></button>
          <button class="rpt-cat-btn ${selectedCategory==="class"?"rpt-cat-btn--active":""}" data-cat="class">\uD83C\uDF93<span>Class</span></button>
        </div>
        ${selectedCategory==="bus"?`
          <div class="rpt-section-label">Select Bus</div>
          <div class="rpt-chip-row">${buses.map(b=>`<button class="rpt-chip ${selectedBusId===b.id?"rpt-chip--active":""}" data-bus="${escapeHtml(b.id)}">${escapeHtml(busLabel(b.id))}</button>`).join("")}</div>
          ${selectedBusId?`<button class="rpt-load-btn" id="rpt-load">Load Report</button>`:""}
        `:""}
        ${selectedCategory==="class"?`
          <div class="rpt-section-label">Select Year</div>
          <div class="rpt-chip-row">${years.map(y=>`<button class="rpt-chip ${selectedClassYear===y?"rpt-chip--active":""}" data-year="${escapeHtml(y)}">${escapeHtml(yearLabel(y))}</button>`).join("")}</div>
          ${selectedClassYear?`
            <div class="rpt-section-label">Select Course</div>
            <div class="rpt-chip-row">${(byYear.get(selectedClassYear)||[]).map(c=>{const{dept}=parseClassScopeId(c.id);return`<button class="rpt-chip ${selectedClassScopeId===c.id?"rpt-chip--active":""}" data-class="${escapeHtml(c.id)}">${escapeHtml(dept)}</button>`;}).join("")}</div>
          `:""}
          ${selectedClassScopeId?`<button class="rpt-load-btn" id="rpt-load">Load Report</button>`:""}
        `:""}
        ${selectedCategory==="hostel"?`<button class="rpt-load-btn" id="rpt-load">Load Hostel Report</button>`:""}
        <div id="daily-result" style="margin-top:var(--space-4);"></div>
      </div>`;
    main.querySelector("#rpt-date").addEventListener("change",e=>{selectedDate=e.target.value;});
    main.querySelectorAll(".rpt-cat-btn").forEach(btn=>btn.addEventListener("click",()=>{selectedCategory=btn.dataset.cat;selectedBusId=null;selectedClassYear=null;selectedClassScopeId=null;render();}));
    main.querySelectorAll(".rpt-chip[data-bus]").forEach(btn=>btn.addEventListener("click",()=>{selectedBusId=btn.dataset.bus;render();}));
    main.querySelectorAll(".rpt-chip[data-year]").forEach(btn=>btn.addEventListener("click",()=>{selectedClassYear=btn.dataset.year;selectedClassScopeId=null;render();}));
    main.querySelectorAll(".rpt-chip[data-class]").forEach(btn=>btn.addEventListener("click",()=>{selectedClassScopeId=btn.dataset.class;render();}));
    const loadBtn=main.querySelector("#rpt-load");
    if(loadBtn){loadBtn.addEventListener("click",()=>{const resultEl=main.querySelector("#daily-result");if(selectedCategory==="hostel")loadDailyReport(resultEl,{category:"hostel",scopeId:"hostel_main",date:selectedDate});else if(selectedCategory==="bus"&&selectedBusId)loadDailyReport(resultEl,{category:"bus",scopeId:selectedBusId,date:selectedDate});else if(selectedCategory==="class"&&selectedClassScopeId)loadDailyReport(resultEl,{category:"class",scopeId:selectedClassScopeId,date:selectedDate});});}
  }
  render();
}

// ── Hostel grouping helper ───────────────────────────────────────────────
// Returns array of { hostelLabel, years: [{ yearLabel, students }] }
function groupHostelRoster(roster) {
  const HOSTEL_ORDER = ["Hindi", "Tamil"];
  const YEAR_ORDER   = ["first","second","third","fourth"];
  const YEAR_LABEL   = { first:"I Year", second:"II Year", third:"III Year", fourth:"IV Year" };

  const byHostel = new Map();
  for (const s of roster) {
    const h = s.hostelType || "Other";
    if (!byHostel.has(h)) byHostel.set(h, new Map());
    const yearKey = (s.year || "other").toLowerCase();
    const byYear  = byHostel.get(h);
    if (!byYear.has(yearKey)) byYear.set(yearKey, []);
    byYear.get(yearKey).push(s);
  }

  const hostelKeys = [
    ...HOSTEL_ORDER.filter(k => byHostel.has(k)),
    ...[...byHostel.keys()].filter(k => !HOSTEL_ORDER.includes(k)),
  ];

  return hostelKeys.map(h => {
    const byYear = byHostel.get(h);
    const yearKeys = [
      ...YEAR_ORDER.filter(k => byYear.has(k)),
      ...[...byYear.keys()].filter(k => !YEAR_ORDER.includes(k)),
    ];
    return {
      hostelLabel: h + " Hostel",
      years: yearKeys.map(y => ({
        yearLabel: YEAR_LABEL[y] || y,
        students:  byYear.get(y).sort((a,b) => (a.name||"").localeCompare(b.name||"")),
      })),
    };
  });
}

async function loadDailyReport(resultEl, { category, scopeId, date }) {
  resultEl.innerHTML = `<p class="status">Loading…</p>`;

  let record, college;
  try {
    const recordId = buildRecordId({ category, scopeId, date });
    const [recSnap, colSnap] = await Promise.all([
      getDoc(doc(db, "attendanceRecords", recordId)),
      getDoc(doc(db, "college", "main")),
    ]);
    record = recSnap.exists() ? { id: recordId, ...recSnap.data() } : null;
    college = colSnap.exists() ? colSnap.data() : null;
  } catch (err) {
    resultEl.innerHTML = `<div class="msg msg--err">${escapeHtml(err.message)}</div>`;
    return;
  }

  if (!record) {
    resultEl.innerHTML = `
      <div class="msg msg--warn msg--roster-empty" style="margin-top:var(--space-4);">
        <span class="roster-empty__icon">📋</span>
        <div class="roster-empty__title">No record found</div>
        <div class="roster-empty__hint">No attendance was recorded for this scope and date.</div>
      </div>`;
    return;
  }

  const { records = [], presentCount, absentCount, totalCount, markedBy, locked } = record;
  const absentStudents = records.filter((r) => r.status === "absent");
  const sLabel = scopeLabelFrom(category, scopeId);
  const filename = `attendance-daily-${scopeId}-${date}.pdf`;

  resultEl.innerHTML = `
    ${locked ? `
      <div class="locked-banner locked-banner--admin" style="margin-top:var(--space-4); display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:var(--space-2);">
        <span>🔒 This record is locked. Markers cannot edit it.</span>
        <button class="btn btn--sm btn--secondary" id="admin-unlock-btn">🔓 Unlock (Admin Override)</button>
      </div>
    ` : ""}

    <div class="summary-counts card" style="display:flex; gap:var(--space-5); justify-content:center; text-align:center; margin: var(--space-4) 0;">
      <div>
        <div style="font-size:var(--font-size-2xl); font-weight:700; color:var(--color-success-text);">${presentCount}</div>
        <div class="status" style="margin:0;">Present</div>
      </div>
      <div>
        <div style="font-size:var(--font-size-2xl); font-weight:700; color:var(--color-danger-text);">${absentCount}</div>
        <div class="status" style="margin:0;">Absent</div>
      </div>
      <div>
        <div style="font-size:var(--font-size-2xl); font-weight:700; color:var(--color-text-muted);">${totalCount}</div>
        <div class="status" style="margin:0;">Total</div>
      </div>
    </div>

    <div class="summary-table-wrap">
      <table class="summary-table">
        <thead>
          <tr><th>#</th><th>Name</th><th>Reg. No.</th><th>Status</th><th>Remarks</th></tr>
        </thead>
        <tbody>
          ${(() => {
            if (category !== "hostel") {
              return records.map((r, i) => `
                <tr class="${r.status === "absent" ? "summary-row--absent" : ""}">
                  <td>${i + 1}</td>
                  <td>${escapeHtml(r.name)}</td>
                  <td>${escapeHtml(r.regNo)}</td>
                  <td><span class="summary-status summary-status--${r.status}">${r.status === "present" ? "Present" : "Absent"}</span></td>
                  <td>${escapeHtml(r.remarks || "")}</td>
                </tr>`).join("");
            }
            // Hostel: group records by hostelType → year
            const groups = groupHostelRoster(records);
            let serial = 0;
            return groups.map(g =>
              `<tr class="rpt-group-header rpt-hostel-header"><td colspan="5">${escapeHtml(g.hostelLabel)}</td></tr>` +
              g.years.map(yr =>
                `<tr class="rpt-group-header rpt-year-header"><td colspan="5">${escapeHtml(yr.yearLabel)}</td></tr>` +
                yr.students.map(r => {
                  serial++;
                  return `<tr class="${r.status === "absent" ? "summary-row--absent" : ""}">
                    <td>${serial}</td>
                    <td>${escapeHtml(r.name)}</td>
                    <td>${escapeHtml(r.regNo)}</td>
                    <td><span class="summary-status summary-status--${r.status}">${r.status === "present" ? "Present" : "Absent"}</span></td>
                    <td>${escapeHtml(r.remarks || "")}</td>
                  </tr>`;
                }).join("")
              ).join("")
            ).join("");
          })()}
        </tbody>
      </table>
    </div>

    ${markedBy ? `<p class="status">Marked by: ${escapeHtml(markedBy.name)} (${escapeHtml(markedBy.staffId)})</p>` : ""}

    <div class="summary-actions">
      <button class="btn" id="daily-pdf-btn">📄 Save PDF</button>
      <button class="btn btn--whatsapp" id="daily-wa-btn">📤 Share via WhatsApp</button>
    </div>
  `;

  // P9: admin unlock override
  const unlockBtn = resultEl.querySelector("#admin-unlock-btn");
  if (unlockBtn) {
    unlockBtn.addEventListener("click", async () => {
      if (!confirm("Unlock this record? Markers will be able to edit it again.")) return;
      await withLoadingBtn(unlockBtn, "Unlocking…", async () => {
        try {
          await updateDoc(doc(db, "attendanceRecords", record.id), { locked: false });
          // Re-fetch to refresh the view
          resultEl.querySelector(".locked-banner--admin").remove();
          unlockBtn.closest(".locked-banner--admin")?.remove();
          resultEl.querySelector(".locked-banner--admin")?.remove();
          // Show confirmation inline
          const info = document.createElement("div");
          info.className = "msg msg--ok";
          info.style.margin = `var(--space-4) 0`;
          info.textContent = "✓ Record unlocked. Markers can now edit it.";
          resultEl.prepend(info);
        } catch (err) {
          alert(`Failed to unlock: ${err.message}`);
        }
      });
    });
  }

  resultEl.querySelector("#daily-pdf-btn").addEventListener("click", async () => {
    await withLoadingBtn(resultEl.querySelector("#daily-pdf-btn"), "Generating…", async () => {
      const blob = generateDailyPdf({ college, scopeLabel: sLabel, date, session: null, records, markedBy, presentCount, absentCount, totalCount });
      triggerDownload(blob, filename);
    });
  });

  resultEl.querySelector("#daily-wa-btn").addEventListener("click", async () => {
    await withLoadingBtn(resultEl.querySelector("#daily-wa-btn"), "Sharing…", async () => {
      const text = buildDailyWhatsAppText({ scopeLabel: sLabel, date, session: null, presentCount, absentCount, totalCount, absentStudents });
      const blob = generateDailyPdf({ college, scopeLabel: sLabel, date, session: null, records, markedBy, presentCount, absentCount, totalCount });
      try { await shareReport({ blob, filename, title: `Attendance — ${sLabel}`, text }); } catch {}
    });
  });
}


// ================================================================
// MONTHLY REPORT
// ================================================================

async function renderMonthlyScreen(main, state) {
  const today = new Date();
  let monthState = { year: today.getFullYear(), month: today.getMonth() + 1 };
  let selectedCategory = null;
  let selectedBusId = null;
  let selectedClassYear = null;
  let selectedClassScopeId = null;
  let buses = [], classes = [];

  main.innerHTML = `<div class="page page--wide"><p class="status">Loading scopes\u2026</p></div>`;
  try {
    const [busSnap, classSnap] = await Promise.all([
      getDocs(collection(db, "buses")),
      getDocs(collection(db, "classes")),
    ]);
    busSnap.forEach((d) => buses.push({ id: d.id, ...d.data() }));
    buses.sort((a, b) => naturalSort(a.id, b.id));
    classSnap.forEach((d) => classes.push({ id: d.id, ...d.data() }));
    classes.sort((a, b) => naturalSort(a.id, b.id));
  } catch (err) {
    main.innerHTML = `<div class="page page--wide"><div class="msg msg--err">${escapeHtml(err.message)}</div></div>`;
    return;
  }

  function classesByYear() {
    const map = new Map();
    classes.forEach(c => {
      const { year } = parseClassScopeId(c.id);
      const y = year || "other";
      if (!map.has(y)) map.set(y, []);
      map.get(y).push(c);
    });
    return map;
  }
  function yearLabel(y) {
    const labels = { first: "I Year", second: "II Year", third: "III Year", fourth: "IV Year" };
    return labels[y] || y.replace(/_/g, " ").toUpperCase();
  }

  function render() {
    const byYear = classesByYear();
    const years = [...byYear.keys()];
    const isFuture = monthState.year > today.getFullYear() ||
      (monthState.year === today.getFullYear() && monthState.month > today.getMonth() + 1);
    main.innerHTML = `
      <div class="page page--wide rpt-page">
        <h2 class="rpt-title">Monthly Report</h2>
        <div class="rpt-month-nav">
          <button class="rpt-month-btn" id="m-prev">\u2039</button>
          <span class="rpt-month-label">${monthLabelStr(monthState)}</span>
          <button class="rpt-month-btn" id="m-next" ${isFuture?"disabled":""}>\u203a</button>
        </div>
        <div class="rpt-section-label">Select Category</div>
        <div class="rpt-cat-row">
          <button class="rpt-cat-btn ${selectedCategory==="hostel"?"rpt-cat-btn--active":""}" data-cat="hostel">\uD83C\uDFE0<span>Hostel</span></button>
          <button class="rpt-cat-btn ${selectedCategory==="bus"?"rpt-cat-btn--active":""}" data-cat="bus">\uD83D\uDE8C<span>Bus</span></button>
          <button class="rpt-cat-btn ${selectedCategory==="class"?"rpt-cat-btn--active":""}" data-cat="class">\uD83C\uDF93<span>Class</span></button>
        </div>
        ${selectedCategory==="bus"?`
          <div class="rpt-section-label">Select Bus</div>
          <div class="rpt-chip-row">${buses.map(b=>`<button class="rpt-chip ${selectedBusId===b.id?"rpt-chip--active":""}" data-bus="${escapeHtml(b.id)}">${escapeHtml(busLabel(b.id))}</button>`).join("")}</div>
          ${selectedBusId?`<button class="rpt-load-btn" id="rpt-load">Load Report</button>`:""}
        `:""}
        ${selectedCategory==="class"?`
          <div class="rpt-section-label">Select Year</div>
          <div class="rpt-chip-row">${years.map(y=>`<button class="rpt-chip ${selectedClassYear===y?"rpt-chip--active":""}" data-year="${escapeHtml(y)}">${escapeHtml(yearLabel(y))}</button>`).join("")}</div>
          ${selectedClassYear?`
            <div class="rpt-section-label">Select Course</div>
            <div class="rpt-chip-row">${(byYear.get(selectedClassYear)||[]).map(c=>{const{dept}=parseClassScopeId(c.id);return`<button class="rpt-chip ${selectedClassScopeId===c.id?"rpt-chip--active":""}" data-class="${escapeHtml(c.id)}">${escapeHtml(dept)}</button>`;}).join("")}</div>
          `:""}
          ${selectedClassScopeId?`<button class="rpt-load-btn" id="rpt-load">Load Report</button>`:""}
        `:""}
        ${selectedCategory==="hostel"?`<button class="rpt-load-btn" id="rpt-load">Load Hostel Report</button>`:""}
        <div id="monthly-result" style="margin-top:var(--space-4);"></div>
      </div>`;
    main.querySelector("#m-prev").addEventListener("click",()=>{monthState=prevMonth(monthState);render();});
    main.querySelector("#m-next").addEventListener("click",()=>{if(!isFuture){monthState=nextMonth(monthState);render();}});
    main.querySelectorAll(".rpt-cat-btn").forEach(btn=>btn.addEventListener("click",()=>{selectedCategory=btn.dataset.cat;selectedBusId=null;selectedClassYear=null;selectedClassScopeId=null;render();}));
    main.querySelectorAll(".rpt-chip[data-bus]").forEach(btn=>btn.addEventListener("click",()=>{selectedBusId=btn.dataset.bus;render();}));
    main.querySelectorAll(".rpt-chip[data-year]").forEach(btn=>btn.addEventListener("click",()=>{selectedClassYear=btn.dataset.year;selectedClassScopeId=null;render();}));
    main.querySelectorAll(".rpt-chip[data-class]").forEach(btn=>btn.addEventListener("click",()=>{selectedClassScopeId=btn.dataset.class;render();}));
    const loadBtn=main.querySelector("#rpt-load");
    if(loadBtn){loadBtn.addEventListener("click",()=>{const resultEl=main.querySelector("#monthly-result");if(selectedCategory==="hostel")loadMonthlyReport(resultEl,{category:"hostel",scopeId:"hostel_main",monthState});else if(selectedCategory==="bus"&&selectedBusId)loadMonthlyReport(resultEl,{category:"bus",scopeId:selectedBusId,monthState});else if(selectedCategory==="class"&&selectedClassScopeId)loadMonthlyReport(resultEl,{category:"class",scopeId:selectedClassScopeId,monthState});});}
  }
  render();
}

async function loadMonthlyReport(resultEl, { category, scopeId, monthState }) {
  const session = null; // sessions disabled
  resultEl.innerHTML = `<p class="status">Loading…</p>`;

  const { year, month } = monthState;
  const padM = String(month).padStart(2, "0");
  const monthPrefix = `${year}-${padM}-`;
  const mLabel = monthLabelStr(monthState);
  const sLabel = scopeLabelFrom(category, scopeId);

  let records = [], roster, college, holidays;
  try {
    const qConstraints = [
      where("category", "==", category),
      where("scopeId", "==", scopeId),
    ];
    if (session) qConstraints.push(where("session", "==", session));

    const [snap, rosterResult, collegeSnap, holidaysResult] = await Promise.all([
      getDocs(query(collection(db, "attendanceRecords"), ...qConstraints)),
      fetchRosterFlat({ category, scopeId }),
      getDoc(doc(db, "college", "main")),
      fetchHolidaysForMonth({ category, year, month }),
    ]);

    snap.forEach((d) => {
      const data = d.data();
      if (data.date?.startsWith(monthPrefix)) records.push(data);
    });
    roster = rosterResult;
    college = collegeSnap.exists() ? collegeSnap.data() : null;
    holidays = holidaysResult; // Map<day, { label }>
  } catch (err) {
    resultEl.innerHTML = `<div class="msg msg--err">${escapeHtml(err.message)}</div>`;
    return;
  }

  if (records.length === 0 && holidays.size === 0) {
    resultEl.innerHTML = `<div class="msg msg--warn" style="margin-top:var(--space-4);">No records found for ${mLabel}.</div>`;
    return;
  }

  // Union of days that have attendance records and days marked as a
  // holiday, so a holiday with zero marked attendance still shows up
  // as a grey column instead of vanishing entirely.
  const days = [...new Set([
    ...records.map((r) => Number(r.date.slice(8))),
    ...holidays.keys(),
  ])].sort((a, b) => a - b);

  const statusGrid = new Map();
  for (const s of roster) statusGrid.set(s.regNo, new Map());
  for (const rec of records) {
    const day = Number(rec.date.slice(8));
    for (const entry of rec.records || []) {
      statusGrid.get(entry.regNo)?.set(day, entry.status);
    }
  }

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

  const lowAttendance = roster
    .map((s) => ({ ...s, ...(studentTotals.get(s.regNo) || {}) }))
    .filter((s) => s.pct < 75)
    .sort((a, b) => a.pct - b.pct);

  const filename = `attendance-monthly-${scopeId}-${year}-${padM}.pdf`;

  resultEl.innerHTML = `
    <div class="monthly-table-wrap" style="margin-top:var(--space-4);">
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
          ${(() => {
            const colSpan = days.length + 3;
            function renderStudentRow(s) {
                const dayCells = days.map((d) => {
                  if (holidays.has(d)) return `<td class="monthly-cell--holiday" title="${escapeHtml(holidays.get(d).label || "Holiday")}">H</td>`;
                  const st = statusGrid.get(s.regNo)?.get(d);
                  if (st === "present") return `<td class="monthly-cell--present">P</td>`;
                  if (st === "absent") return `<td class="monthly-cell--absent">A</td>`;
                  return `<td class="monthly-cell--none">—</td>`;
                }).join("");
                const tot = studentTotals.get(s.regNo) || { present: 0, absent: 0, pct: 0 };
                return `<tr>
                  <td class="monthly-col--name">${escapeHtml(s.name)}</td>
                  <td class="monthly-col--reg">${escapeHtml(s.regNo)}</td>
                  ${dayCells}
                  <td class="monthly-col--total" style="color:var(--color-success-text); font-weight:700;">${tot.present}</td>
                  <td class="monthly-col--total" style="color:var(--color-danger-text); font-weight:700;">${tot.absent}</td>
                  <td class="monthly-col--total ${tot.pct < 75 ? "monthly-pct--low" : ""}">${tot.pct}%</td>
                </tr>`;
            }
            if (category !== "hostel") {
              return roster.map(s => renderStudentRow(s)).join("");
            }
            // Hostel: group by hostelType → year
            const groups = groupHostelRoster(roster);
            return groups.map(g =>
              `<tr class="rpt-group-header rpt-hostel-header"><td colspan="${colSpan}">${escapeHtml(g.hostelLabel)}</td></tr>` +
              g.years.map(yr =>
                `<tr class="rpt-group-header rpt-year-header"><td colspan="${colSpan}">${escapeHtml(yr.yearLabel)}</td></tr>` +
                yr.students.map(s => renderStudentRow(s)).join("")
              ).join("")
            ).join("");
          })()}
        </tbody>
        <tfoot>
          <tr class="monthly-foot--present">
            <td colspan="2">Present</td>
            ${days.map((d) => holidays.has(d) ? `<td class="monthly-cell--holiday"></td>` : `<td class="monthly-cell--present">${dayTotals[d]?.present ?? "—"}</td>`).join("")}
            <td colspan="3"></td>
          </tr>
          <tr class="monthly-foot--absent">
            <td colspan="2">Absent</td>
            ${days.map((d) => holidays.has(d) ? `<td class="monthly-cell--holiday"></td>` : `<td class="monthly-cell--absent">${dayTotals[d]?.absent ?? "—"}</td>`).join("")}
            <td colspan="3"></td>
          </tr>
          <tr class="monthly-foot--total">
            <td colspan="2">Total</td>
            ${days.map((d) => {
              if (holidays.has(d)) return `<td class="monthly-cell--holiday"></td>`;
              const p = dayTotals[d]?.present ?? 0;
              const a = dayTotals[d]?.absent ?? 0;
              return `<td>${p + a}</td>`;
            }).join("")}
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

  resultEl.querySelector("#monthly-pdf-btn").addEventListener("click", async () => {
    await withLoadingBtn(resultEl.querySelector("#monthly-pdf-btn"), "Generating…", async () => {
      const blob = generateMonthlyPdf({ college, scopeLabel: sLabel, monthLabel: mLabel, session: null, students: roster, days, statusGrid, studentTotals, dayTotals, year, month, holidays });
      triggerDownload(blob, filename);
    });
  });

  resultEl.querySelector("#monthly-wa-btn").addEventListener("click", async () => {
    await withLoadingBtn(resultEl.querySelector("#monthly-wa-btn"), "Sharing…", async () => {
      const text = buildMonthlyWhatsAppText({ scopeLabel: sLabel, monthLabel: mLabel, session: null, totalStudents: roster.length, workingDays: days.length, lowAttendance });
      const blob = generateMonthlyPdf({ college, scopeLabel: sLabel, monthLabel: mLabel, session, students: roster, days, statusGrid, studentTotals, dayTotals, year, month, holidays });
      try { await shareReport({ blob, filename, title: `Monthly — ${sLabel}`, text }); } catch {}
    });
  });
}

// ================================================================
// Shared helpers
// ================================================================

/** Flat roster (not grouped) for any category — used by admin report views */
async function fetchRosterFlat({ category, scopeId }) {
  const studentsCol = collection(db, "students");
  let q;
  if (category === "bus") q = query(studentsCol, where("busId", "==", scopeId), where("active", "==", true));
  else if (category === "hostel") q = query(studentsCol, where("category", "==", "hostel"), where("active", "==", true));
  else q = query(studentsCol, where("classId", "==", scopeId), where("active", "==", true));
  const snap = await getDocs(q);
  const students = [];
  snap.forEach((d) => students.push({ regNo: d.id, ...d.data() }));
  students.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return students;
}

// ── Label helpers ─────────────────────────────────────────────────
// Bus: "bus_cruiser_21" → "Bus Cruiser 21"  (underscores & hyphens → spaces)
function busLabel(busId) {
  // "bus_19" -> "Bus 19", "bus_cruiser_21" -> "Bus 21"
  const nums = busId.match(/\d+/g);
  if (nums) return "Bus " + nums.join(" ");
  const raw = busId.replace(/^bus_/, "").replace(/[_-]/g, " ");
  return "Bus " + raw.replace(/\w/g, (c) => c.toUpperCase());
}

// Ordinal word → Roman numeral map for class year prefix
const ORDINAL_MAP = {
  first: "I", second: "II", third: "III", fourth: "IV",
  fifth: "V", sixth: "VI",
};

// Class: "class_first_cse" → "I - CSE"  |  "class_second_ai" → "II - AI"
function classLabel(classId) {
  const parts = classId.replace(/^class_/, "").split("_");
  const yearWord = (parts[0] || "").toLowerCase();
  const roman = ORDINAL_MAP[yearWord];
  const dept = parts.slice(roman !== undefined ? 1 : 0).join(" ").toUpperCase();
  return roman ? `${roman} - ${dept}` : dept;
}

function scopeLabelFrom(category, scopeId) {
  if (scopeId === "hostel_main") return "Hostel";
  if (category === "bus")   return busLabel(scopeId);
  if (category === "class") return classLabel(scopeId);
  return scopeId;
}

function monthLabelStr({ year, month }) {
  return new Date(year, month - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

function prevMonth({ year, month }) {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

function nextMonth({ year, month }) {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true });
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}

function cssId(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function withLoadingBtn(btn, label, action) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { await action(); } finally { btn.disabled = false; btn.textContent = orig; }
}
