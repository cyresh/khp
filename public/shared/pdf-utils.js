// shared/pdf-utils.js
//
// PDF generation utilities for attendance reports (P5).
// Uses jsPDF + jspdf-autotable loaded via CDN (no bundler needed).
//
// Every PDF has the same structure:
//   1. College header block (name, address, phones from college/main)
//   2. Report title, scope label, date / date range, session (if relevant)
//   3. Table body (daily: student rows; monthly: grid)
//   4. Footer row (totals, marked-by, generated timestamp)
//
// Call loadPdfLibs() once on page load (or lazily before first use)
// so the CDN scripts are ready when the user taps the PDF button.

/** CDN URLs — pinned minor versions for stability. */
const JSPDF_CDN = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
const AUTOTABLE_CDN = "https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js";

let libsLoaded = false;
let libsLoadPromise = null;

/**
 * Dynamically loads jsPDF + autotable from CDN. Safe to call multiple
 * times — subsequent calls return the same cached promise.
 */
export function loadPdfLibs() {
  if (libsLoaded) return Promise.resolve();
  if (libsLoadPromise) return libsLoadPromise;

  libsLoadPromise = new Promise((resolve, reject) => {
    function loadScript(src, onLoad) {
      const s = document.createElement("script");
      s.src = src;
      s.onload = onLoad;
      s.onerror = () => reject(new Error(`Failed to load: ${src}`));
      document.head.appendChild(s);
    }
    loadScript(JSPDF_CDN, () => {
      loadScript(AUTOTABLE_CDN, () => {
        libsLoaded = true;
        resolve();
      });
    });
  });

  return libsLoadPromise;
}

/**
 * Returns a consistent college-header block rendered at the top of
 * every PDF page. Mutates the jsPDF `doc` object.
 *
 * @param {object} doc - jsPDF instance
 * @param {object} college - { name, address, phones: [{digits}], website, logoDataUrl }
 * @returns {number} Y cursor position after the header (px from top)
 */
function addCollegeHeader(doc, college) {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  const startY = 14;
  let y = startY;

  // Logo, if set, sits at the left margin with the text block stacked
  // to its right (rather than the old fully-centered layout) — once a
  // logo is present, centering 1–4 lines of varying width next to a
  // fixed-position image stops looking balanced, so the whole block
  // switches to a left-aligned letterhead style whenever a logo
  // exists. With no logo, text stays centered exactly as before.
  const hasLogo = !!college?.logoDataUrl;

  // Tight, compact line pitch — just enough to clear each font size's
  // own height, not the old looser spacing that left visible air
  // between lines (and, with a fixed logo size, below the last line).
  const NAME_STEP = 6;
  const LINE_STEP = 4.2;

  const hasAddress = !!college?.address;
  const phones = (college?.phones || []).filter((p) => p?.digits);
  const hasPhones = phones.length > 0;
  const hasWebsite = !!college?.website;

  // Compute the text block's real height up front so the logo can be
  // scaled to match it exactly — no fixed logo size that ends up
  // taller or shorter than however many lines this college actually
  // has, which is what left a gap (or a cramped overlap) before.
  const lineCount = 1 + (hasAddress ? 1 : 0) + (hasPhones ? 1 : 0) + (hasWebsite ? 1 : 0);
  const textBlockHeight = NAME_STEP + (lineCount - 1) * LINE_STEP;
  const logoSize = hasLogo ? Math.max(14, textBlockHeight) : 0;
  const textX = hasLogo ? margin + logoSize + 5 : pageW / 2;
  const textAlign = hasLogo ? "left" : "center";

  if (hasLogo) {
    try {
      // Vertically center the logo against the text block rather than
      // top-aligning it, so it doesn't look like it's hanging high
      // above shorter text blocks (e.g. name-only, no address/phone).
      const logoY = startY - 3 + (textBlockHeight - logoSize) / 2;
      doc.addImage(college.logoDataUrl, "JPEG", margin, logoY, logoSize, logoSize);
    } catch (_) {
      // Corrupt/unsupported image data — fall back to text-only header.
    }
  }

  // College name — large, bold
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(30, 30, 30);
  doc.text(college?.name || "Kongu Hi-Tek Polytechnic College", textX, y, { align: textAlign });
  y += NAME_STEP;

  // Address line
  if (hasAddress) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(90, 90, 90);
    doc.text(college.address, textX, y, { align: textAlign });
    y += LINE_STEP;
  }

  // Phones — same font/size/color as the address line above, so the
  // two lines look visually consistent. Uses a plain ASCII label
  // instead of the ☎ unicode glyph, since jsPDF's built-in helvetica
  // font has no telephone glyph and silently falls back to a
  // different font/box for it.
  if (hasPhones) {
    const phoneStr = "Ph: " + phones.map((p) => formatPhone(p.digits)).join("  |  ");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(90, 90, 90);
    doc.text(phoneStr, textX, y, { align: textAlign });
    y += LINE_STEP;
  }

  // Website — blue, to read as a link even though it isn't clickable.
  if (hasWebsite) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(31, 111, 235);
    doc.text(college.website, textX, y, { align: textAlign });
  }

  // y is currently sitting at the BASELINE of the last text line drawn
  // (jsPDF's text y-coordinate is baseline, not line-top) — note there
  // is deliberately no "y += LINE_STEP" after the final line above,
  // since that would just be dead space with no text to fill it. A
  // small fixed clearance below the baseline is enough room for the
  // line's descenders before the divider.
  y += 2.5;

  // Whichever is taller — the text block or the logo — decides where
  // the divider goes; no leftover gap from a fixed-size logo that
  // happened to be shorter than the text it sits beside.
  if (hasLogo) {
    y = Math.max(y, startY - 3 + logoSize + 3);
  }

  // Divider
  doc.setDrawColor(200, 200, 200);
  doc.setTextColor(30, 30, 30);
  doc.line(margin, y, pageW - margin, y);
  y += 4;

  return y;
}

/**
 * Adds a report title block below the college header.
 *
 * @param {object} doc
 * @param {number} startY
 * @param {object} opts - { title, scopeLabel, dateLabel, session? }
 * @returns {number} Y cursor after the title block
 */
function addReportTitle(doc, startY, { title, scopeLabel, dateLabel, session }) {
  let y = startY;
  const pageW = doc.internal.pageSize.getWidth();

  // Title — bold, dark
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(30, 30, 30);
  doc.text(title, pageW / 2, y, { align: "center" });
  y += 7;

  // Scope label — bold blue
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(26, 115, 232);
  doc.text(scopeLabel, pageW / 2, y, { align: "center" });
  y += 5;

  // Date (and session) — normal blue
  const datePart = [dateLabel, session ? capitalize(session) + " Session" : null]
    .filter(Boolean).join("  ·  ");
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(26, 115, 232);
  doc.text(datePart, pageW / 2, y, { align: "center" });
  doc.setTextColor(30, 30, 30);
  y += 8;

  return y;
}

/**
 * Generates a daily attendance PDF and returns it as a Blob.
 *
 * @param {object} opts
 * @param {object} opts.college - Firestore college/main document data
 * @param {string} opts.scopeLabel - Human-readable scope name (e.g. "Bus 11 — Erode")
 * @param {string} opts.date - "YYYY-MM-DD"
 * @param {string|null} opts.session - "morning" | "evening" | null
 * @param {Array} opts.records - attendance records [{name, regNo, status, remarks}]
 * @param {object} opts.markedBy - { name, staffId }
 * @param {number} opts.presentCount
 * @param {number} opts.absentCount
 * @param {number} opts.totalCount
 * @returns {Blob} PDF blob
 */
/** Shared didParseCell for daily tables — colours Present green, Absent red in body rows */
function dailyCellStyle(data) {
  if (data.section === "body" && data.column.index === 3) {
    if (data.cell.raw === "Present") {
      data.cell.styles.textColor = [34, 139, 34];
      data.cell.styles.fontStyle = "bold";
    } else if (data.cell.raw === "Absent") {
      data.cell.styles.textColor = [197, 34, 31];
      data.cell.styles.fontStyle = "bold";
    }
  }
}

/** Shared didParseCell for monthly grids — P green, A red in body rows */
function monthlyCellStyle(data) {
  if (data.section === "body") {
    if (data.cell.raw === "P") {
      data.cell.styles.textColor = [34, 139, 34];
      data.cell.styles.fontStyle = "bold";
    } else if (data.cell.raw === "A") {
      data.cell.styles.textColor = [197, 34, 31];
      data.cell.styles.fontStyle = "bold";
    }
  }
}

/** Returns an array of all day numbers from 1 to end-of-month, merging in recorded days */
function fullMonthDays(year, month, recordedDays) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const allDays = new Set(recordedDays);
  for (let d = 1; d <= daysInMonth; d++) allDays.add(d);
  return [...allDays].sort((a, b) => a - b);
}

export function generateDailyPdf({
  college, scopeLabel, date, session, records, markedBy, presentCount, absentCount, totalCount,
}) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  let y = addCollegeHeader(doc, college);
  y = addReportTitle(doc, y, { title: "Daily Attendance Report", scopeLabel, dateLabel: formatDate(date), session });

  const tableRows = records.map((r, i) => [
    i + 1, r.name, r.regNo,
    r.status === "present" ? "Present" : "Absent",
    r.remarks || "",
  ]);

  doc.autoTable({
    startY: y,
    head: [["#", "Name", "Reg. No.", "Status", "Remarks"]],
    body: tableRows,
    foot: [[
      "",
      { content: `Present: ${presentCount}`, styles: { textColor: [34, 139, 34], fontStyle: "bold" } },
      { content: `Absent: ${absentCount}`, styles: { textColor: [197, 34, 31], fontStyle: "bold" } },
      { content: `Total: ${totalCount}`, styles: { textColor: [26, 115, 232], fontStyle: "bold" } },
      { content: `Marked by: ${markedBy?.name || "—"}`, styles: { textColor: [26, 115, 232], fontStyle: "bold" } },
    ]],
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [26, 115, 232], textColor: 255, fontStyle: "bold" },
    footStyles: { fillColor: [240, 240, 240] },
    columnStyles: { 0: { cellWidth: 10 }, 3: { cellWidth: 22 }, 4: { cellWidth: 36 } },
    didParseCell: dailyCellStyle,
    showFoot: "lastPage",
    margin: { left: 14, right: 14 },
  });

  addGeneratedTimestamp(doc);
  return doc.output("blob");
}

/**
 * Generates a monthly attendance PDF (grid: students × days) and
 * returns it as a Blob. Uses landscape A4 for space.
 *
 * @param {object} opts
 * @param {object} opts.college
 * @param {string} opts.scopeLabel
 * @param {string} opts.monthLabel - e.g. "June 2026"
 * @param {string|null} opts.session
 * @param {Array<{regNo, name}>} opts.students - ordered list of students
 * @param {number[]} opts.days - day numbers that have records, e.g. [1,2,3,…]
 * @param {Map<string, Map<number, 'present'|'absent'|null>>} opts.statusGrid
 *   statusGrid.get(regNo).get(dayNumber) → status or null (no record)
 * @param {Map<string, {present, absent, pct}>} opts.studentTotals
 *   per-student aggregates: .get(regNo) → {present, absent, pct}
 * @param {object} opts.dayTotals - { [day]: {present, absent} }
 * @param {object} opts.markedBy - { name } (or null for "all scopes" monthly)
 */
export function generateMonthlyPdf({
  college, scopeLabel, monthLabel, session, students, days,
  statusGrid, studentTotals, dayTotals, year, month, holidays,
}) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

  let y = addCollegeHeader(doc, college);
  y = addReportTitle(doc, y, { title: "Monthly Attendance Report", scopeLabel, dateLabel: monthLabel, session });

  // Extend days to cover full month
  const allDays = (year && month) ? fullMonthDays(year, month, days) : days;
  const holidayMap = holidays || new Map();

  const head = [["Name", "Reg. No.", ...allDays.map(String), "P", "A", "%"]];
  const body = students.map((s) => {
    const dayCells = allDays.map((d) => {
      if (holidayMap.has(d)) return "H";
      const status = statusGrid.get(s.regNo)?.get(d);
      if (status === "present") return "P";
      if (status === "absent") return "A";
      return "—";
    });
    const totals = studentTotals.get(s.regNo) || { present: 0, absent: 0, pct: 0 };
    return [s.name, s.regNo, ...dayCells, totals.present, totals.absent, `${totals.pct}%`];
  });

  const footPresent = ["Present", "", ...allDays.map((d) => holidayMap.has(d) ? "" : (dayTotals[d]?.present ?? "—")), "", "", ""];
  const footAbsent  = ["Absent",  "", ...allDays.map((d) => holidayMap.has(d) ? "" : (dayTotals[d]?.absent  ?? "—")), "", "", ""];

  doc.autoTable({
    startY: y, head, body,
    foot: [footPresent, footAbsent],
    styles: { fontSize: 7, cellPadding: 1.5, halign: "center" },
    headStyles: { fillColor: [26, 115, 232], textColor: 255, fontStyle: "bold" },
    footStyles: { fillColor: [240, 240, 240] },
    columnStyles: { 0: { halign: "left", cellWidth: 36 }, 1: { halign: "left", cellWidth: 22 } },
    didParseCell: (data) => {
      monthlyCellStyle(data);
      // Day columns start at index 2; grey-fill any column that's a holiday,
      // across header, body, and footer rows alike.
      const dayIdx = data.column.index - 2;
      if (dayIdx >= 0 && dayIdx < allDays.length && holidayMap.has(allDays[dayIdx])) {
        data.cell.styles.fillColor = [210, 210, 210];
        if (data.section === "body") {
          data.cell.styles.textColor = [120, 120, 120];
          data.cell.styles.fontStyle = "normal";
        }
      }
      // Footer: Present row green, Absent row red
      if (data.section === "foot") {
        if (data.row.index === 0 && data.column.index === 0) { data.cell.styles.textColor = [34, 139, 34]; data.cell.styles.fontStyle = "bold"; }
        if (data.row.index === 1 && data.column.index === 0) { data.cell.styles.textColor = [197, 34, 31]; data.cell.styles.fontStyle = "bold"; }
      }
    },
    showFoot: "lastPage",
    margin: { left: 10, right: 10 },
  });

  addGeneratedTimestamp(doc);
  return doc.output("blob");
}

/**
 * Generates a single merged PDF for all classes' daily attendance.
 * Page 1: Summary table (all classes, P/A/Total + grand total).
 * Pages 2+: One page per class with full student roster.
 */
export function generateAllClassesPdf({ college, date, classes }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  // ── Page 1: Summary ─────────────────────────────────────────────
  let y = addCollegeHeader(doc, college);
  y = addReportTitle(doc, y, {
    title: "Daily Attendance — Summary",
    scopeLabel: `${classes.length} Classes`,
    dateLabel: formatDate(date),
    session: null,
  });

  const grandPresent = classes.reduce((s, c) => s + c.presentCount, 0);
  const grandAbsent  = classes.reduce((s, c) => s + c.absentCount,  0);
  const grandTotal   = classes.reduce((s, c) => s + c.totalCount,   0);

  doc.autoTable({
    startY: y,
    head: [["Class", "Present", "Absent", "Total"]],
    body: classes.map((c) => [c.scopeLabel, c.presentCount, c.absentCount, c.totalCount]),
    foot: [["Combined Total", grandPresent, grandAbsent, grandTotal]],
    styles: { fontSize: 10, cellPadding: 4, halign: "center" },
    headStyles: { fillColor: [26, 115, 232], textColor: 255, fontStyle: "bold" },
    footStyles: { fillColor: [26, 115, 232], textColor: 255, fontStyle: "bold" },
    columnStyles: { 0: { halign: "left" } },
    didParseCell: (data) => {
      if (data.section === "body") {
        if (data.column.index === 1) { data.cell.styles.textColor = [34, 139, 34]; data.cell.styles.fontStyle = "bold"; }
        if (data.column.index === 2) { data.cell.styles.textColor = [197, 34, 31]; data.cell.styles.fontStyle = "bold"; }
        if (data.column.index === 3) { data.cell.styles.textColor = [26, 115, 232]; data.cell.styles.fontStyle = "bold"; }
      }
    },
    showFoot: "lastPage",
    margin: { left: 14, right: 14 },
  });

  // ── Pages 2+: One page per class ────────────────────────────────
  classes.forEach(({ scopeLabel, records, markedBy, presentCount, absentCount, totalCount }) => {
    doc.addPage();
    let y = addCollegeHeader(doc, college);
    y = addReportTitle(doc, y, { title: "Daily Attendance Report", scopeLabel, dateLabel: formatDate(date), session: null });

    const tableRows = records.map((r, i) => [
      i + 1, r.name, r.regNo,
      r.status === "present" ? "Present" : "Absent",
      r.remarks || "",
    ]);

    doc.autoTable({
      startY: y,
      head: [["#", "Name", "Reg. No.", "Status", "Remarks"]],
      body: tableRows,
      foot: [[
        "",
        { content: `Present: ${presentCount}`, styles: { textColor: [34, 139, 34], fontStyle: "bold" } },
        { content: `Absent: ${absentCount}`, styles: { textColor: [197, 34, 31], fontStyle: "bold" } },
        { content: `Total: ${totalCount}`, styles: { textColor: [26, 115, 232], fontStyle: "bold" } },
        { content: `Marked by: ${markedBy?.name || "—"}`, styles: { textColor: [26, 115, 232], fontStyle: "bold" } },
      ]],
      styles: { fontSize: 9, cellPadding: 3 },
      headStyles: { fillColor: [26, 115, 232], textColor: 255, fontStyle: "bold" },
      footStyles: { fillColor: [240, 240, 240] },
      columnStyles: { 0: { cellWidth: 10 }, 3: { cellWidth: 22 }, 4: { cellWidth: 36 } },
      didParseCell: dailyCellStyle,
      showFoot: "lastPage",
      margin: { left: 14, right: 14 },
    });
  });

  addGeneratedTimestamp(doc);
  return doc.output("blob");
}

/**
 * Generates a single merged PDF for all classes' monthly attendance.
 * One landscape page per class (no summary page).
 */
export function generateAllClassesMonthlyPdf({ college, monthLabel, scopeGrids, allDays, combinedDayTotals, year, month, holidays }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

  // Extend allDays to full month if year+month provided
  const fullDays = (year && month) ? fullMonthDays(year, month, allDays) : allDays;
  const holidayMap = holidays || new Map();

  let firstPage = true;
  for (const { scopeId, students, statusGrid, studentTotals } of scopeGrids) {
    if (!firstPage) doc.addPage();
    firstPage = false;

    const ORDINAL_MAP = { first:"I", second:"II", third:"III", fourth:"IV", fifth:"V", sixth:"VI" };
    const parts = scopeId.split("_");
    const roman = ORDINAL_MAP[(parts[0] || "").toLowerCase()];
    const dept = parts.slice(1).join(" ").toUpperCase();
    const label = roman ? `${roman} - ${dept}` : scopeId;

    let y = addCollegeHeader(doc, college);
    y = addReportTitle(doc, y, { title: "Monthly Attendance Report", scopeLabel: label, dateLabel: monthLabel, session: null });

    const dayTotals = {};
    for (const day of fullDays) {
      if (holidayMap.has(day)) continue;
      let p = 0, a = 0;
      for (const s of students) {
        const st = statusGrid.get(s.regNo)?.get(day);
        if (st === "present") p++;
        else if (st === "absent") a++;
      }
      dayTotals[day] = { present: p, absent: a };
    }

    const head = [["Name", "Reg. No.", ...fullDays.map(String), "P", "A", "%"]];
    const body = students.map((s) => {
      const dayCells = fullDays.map((d) => {
        if (holidayMap.has(d)) return "H";
        const st = statusGrid.get(s.regNo)?.get(d);
        return st === "present" ? "P" : st === "absent" ? "A" : "—";
      });
      const tot = studentTotals.get(s.regNo) || { present: 0, absent: 0, pct: 0 };
      return [s.name, s.regNo, ...dayCells, tot.present, tot.absent, `${tot.pct}%`];
    });

    const footPresent = ["Present", "", ...fullDays.map((d) => holidayMap.has(d) ? "" : (dayTotals[d]?.present || "—")), "", "", ""];
    const footAbsent  = ["Absent",  "", ...fullDays.map((d) => holidayMap.has(d) ? "" : (dayTotals[d]?.absent  || "—")), "", "", ""];

    doc.autoTable({
      startY: y, head, body,
      foot: [footPresent, footAbsent],
      styles: { fontSize: 7, cellPadding: 1.5, halign: "center" },
      headStyles: { fillColor: [26, 115, 232], textColor: 255, fontStyle: "bold" },
      footStyles: { fillColor: [240, 240, 240] },
      columnStyles: { 0: { halign: "left", cellWidth: 36 }, 1: { halign: "left", cellWidth: 22 } },
      didParseCell: (data) => {
        monthlyCellStyle(data);
        const dayIdx = data.column.index - 2;
        if (dayIdx >= 0 && dayIdx < fullDays.length && holidayMap.has(fullDays[dayIdx])) {
          data.cell.styles.fillColor = [210, 210, 210];
          if (data.section === "body") {
            data.cell.styles.textColor = [120, 120, 120];
            data.cell.styles.fontStyle = "normal";
          }
        }
        if (data.section === "foot") {
          if (data.row.index === 0 && data.column.index === 0) { data.cell.styles.textColor = [34, 139, 34]; data.cell.styles.fontStyle = "bold"; }
          if (data.row.index === 1 && data.column.index === 0) { data.cell.styles.textColor = [197, 34, 31]; data.cell.styles.fontStyle = "bold"; }
        }
      },
      showFoot: "lastPage",
      margin: { left: 10, right: 10 },
    });
  }

  addGeneratedTimestamp(doc);
  return doc.output("blob");
}

/**
 * Generates a single merged PDF for the hostel's daily attendance,
 * grouped by year. Mirrors generateAllClassesPdf's structure (one
 * combined summary page, then one detail page per group) but groups
 * by year instead of by class scope, since hostel has a single scope
 * with students naturally grouped by academic year.
 *
 * Page 1: Combined summary table (one row per year group).
 * Pages 2+: One page per year group with full student roster.
 */
export function generateHostelDailyPdf({ college, date, yearGroups }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  // ── Page 1: Summary ─────────────────────────────────────────────
  let y = addCollegeHeader(doc, college);
  y = addReportTitle(doc, y, {
    title: "Hostel Daily Attendance — Summary",
    scopeLabel: `${yearGroups.length} Group${yearGroups.length === 1 ? "" : "s"}`,
    dateLabel: formatDate(date),
    session: null,
  });

  const grandPresent = yearGroups.reduce((s, g) => s + g.presentCount, 0);
  const grandAbsent  = yearGroups.reduce((s, g) => s + g.absentCount,  0);
  const grandTotal   = yearGroups.reduce((s, g) => s + g.totalCount,   0);

  doc.autoTable({
    startY: y,
    head: [["Type / Year", "Present", "Absent", "Total"]],
    body: yearGroups.map((g) => [g.label, g.presentCount, g.absentCount, g.totalCount]),
    foot: [["Combined Total", grandPresent, grandAbsent, grandTotal]],
    styles: { fontSize: 10, cellPadding: 4, halign: "center" },
    headStyles: { fillColor: [26, 115, 232], textColor: 255, fontStyle: "bold" },
    footStyles: { fillColor: [26, 115, 232], textColor: 255, fontStyle: "bold" },
    columnStyles: { 0: { halign: "left" } },
    didParseCell: (data) => {
      if (data.section === "body") {
        if (data.column.index === 1) { data.cell.styles.textColor = [34, 139, 34]; data.cell.styles.fontStyle = "bold"; }
        if (data.column.index === 2) { data.cell.styles.textColor = [197, 34, 31]; data.cell.styles.fontStyle = "bold"; }
        if (data.column.index === 3) { data.cell.styles.textColor = [26, 115, 232]; data.cell.styles.fontStyle = "bold"; }
      }
    },
    showFoot: "lastPage",
    margin: { left: 14, right: 14 },
  });

  // ── Pages 2+: One page per year group ───────────────────────────
  yearGroups.forEach(({ label, records, markedBy, presentCount, absentCount, totalCount }) => {
    doc.addPage();
    let y = addCollegeHeader(doc, college);
    y = addReportTitle(doc, y, { title: "Daily Attendance Report", scopeLabel: label, dateLabel: formatDate(date), session: null });

    const tableRows = records.map((r, i) => [
      i + 1, r.name, r.regNo,
      r.status === "present" ? "Present" : "Absent",
      r.remarks || "",
    ]);

    doc.autoTable({
      startY: y,
      head: [["#", "Name", "Reg. No.", "Status", "Remarks"]],
      body: tableRows,
      foot: [[
        "",
        { content: `Present: ${presentCount}`, styles: { textColor: [34, 139, 34], fontStyle: "bold" } },
        { content: `Absent: ${absentCount}`, styles: { textColor: [197, 34, 31], fontStyle: "bold" } },
        { content: `Total: ${totalCount}`, styles: { textColor: [26, 115, 232], fontStyle: "bold" } },
        { content: `Marked by: ${markedBy?.name || "—"}`, styles: { textColor: [26, 115, 232], fontStyle: "bold" } },
      ]],
      styles: { fontSize: 9, cellPadding: 3 },
      headStyles: { fillColor: [26, 115, 232], textColor: 255, fontStyle: "bold" },
      footStyles: { fillColor: [240, 240, 240] },
      columnStyles: { 0: { cellWidth: 10 }, 3: { cellWidth: 22 }, 4: { cellWidth: 36 } },
      didParseCell: dailyCellStyle,
      showFoot: "lastPage",
      margin: { left: 14, right: 14 },
    });
  });

  addGeneratedTimestamp(doc);
  return doc.output("blob");
}

/**
 * Generates a single merged PDF for the hostel's monthly attendance,
 * grouped by year. Mirrors generateAllClassesMonthlyPdf (one
 * landscape page per group, no summary page) but groups by year
 * instead of by class scope.
 */
export function generateHostelMonthlyPdf({ college, monthLabel, yearGrids, allDays, year, month }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });

  const fullDays = (year && month) ? fullMonthDays(year, month, allDays) : allDays;

  let firstPage = true;
  for (const { label, students, statusGrid, studentTotals } of yearGrids) {
    if (!firstPage) doc.addPage();
    firstPage = false;

    let y = addCollegeHeader(doc, college);
    y = addReportTitle(doc, y, { title: "Monthly Attendance Report", scopeLabel: label, dateLabel: monthLabel, session: null });

    const dayTotals = {};
    for (const day of fullDays) {
      let p = 0, a = 0;
      for (const s of students) {
        const st = statusGrid.get(s.regNo)?.get(day);
        if (st === "present") p++;
        else if (st === "absent") a++;
      }
      dayTotals[day] = { present: p, absent: a };
    }

    const head = [["Name", "Reg. No.", ...fullDays.map(String), "P", "A", "%"]];
    const body = students.map((s) => {
      const dayCells = fullDays.map((d) => {
        const st = statusGrid.get(s.regNo)?.get(d);
        return st === "present" ? "P" : st === "absent" ? "A" : "—";
      });
      const tot = studentTotals.get(s.regNo) || { present: 0, absent: 0, pct: 0 };
      return [s.name, s.regNo, ...dayCells, tot.present, tot.absent, `${tot.pct}%`];
    });

    const footPresent = ["Present", "", ...fullDays.map((d) => dayTotals[d]?.present || "—"), "", "", ""];
    const footAbsent  = ["Absent",  "", ...fullDays.map((d) => dayTotals[d]?.absent  || "—"), "", "", ""];

    doc.autoTable({
      startY: y, head, body,
      foot: [footPresent, footAbsent],
      styles: { fontSize: 7, cellPadding: 1.5, halign: "center" },
      headStyles: { fillColor: [26, 115, 232], textColor: 255, fontStyle: "bold" },
      footStyles: { fillColor: [240, 240, 240] },
      columnStyles: { 0: { halign: "left", cellWidth: 36 }, 1: { halign: "left", cellWidth: 22 } },
      didParseCell: (data) => {
        monthlyCellStyle(data);
        if (data.section === "foot") {
          if (data.row.index === 0 && data.column.index === 0) { data.cell.styles.textColor = [34, 139, 34]; data.cell.styles.fontStyle = "bold"; }
          if (data.row.index === 1 && data.column.index === 0) { data.cell.styles.textColor = [197, 34, 31]; data.cell.styles.fontStyle = "bold"; }
        }
      },
      showFoot: "lastPage",
      margin: { left: 10, right: 10 },
    });
  }

  addGeneratedTimestamp(doc);
  return doc.output("blob");
}

/** Adds a small generated-at timestamp in the bottom-right of the last page. */
function addGeneratedTimestamp(doc) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const ts = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  doc.setFontSize(7);
  doc.setTextColor(160, 160, 160);
  doc.text(`Generated: ${ts} IST`, pageW - 14, pageH - 6, { align: "right" });
  doc.setTextColor(30, 30, 30);
}

export function formatPhone(digits) {
  if (!digits) return "";
  if (digits.length === 10) return `${digits.slice(0, 5)} ${digits.slice(5)}`;
  return digits;
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

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
