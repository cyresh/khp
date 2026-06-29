// shared/share-utils.js
//
// Sharing utilities for P5 attendance reports.
//
// Strategy (in order of preference):
//   1. Web Share API with file — works on Android Chrome & Safari iOS 15+.
//      Lets the user pick any app (WhatsApp, Email, Drive, etc.).
//   2. wa.me deep-link — opens WhatsApp chat/broadcast with a text
//      summary (no file — WhatsApp's web intent can't attach files).
//      Used as fallback on desktop or where Web Share API isn't available.
//   3. Programmatic download — always works, used on iOS where sharing
//      a file via Web Share opens the system share sheet but some users
//      find it confusing; we also show a "download first, then share"
//      instruction note on iOS.
//
// The caller decides the text content. This module only handles the
// dispatch logic and UI wording — it doesn't know about attendance
// specifics.

/**
 * Shares a PDF blob via the Web Share API (preferred) or falls back
 * to a WhatsApp deep-link + download.
 *
 * @param {object} opts
 * @param {Blob} opts.blob - the PDF blob from pdf-utils.js
 * @param {string} opts.filename - suggested filename (e.g. "daily-bus11-2026-06-19.pdf")
 * @param {string} opts.title - share sheet title
 * @param {string} opts.text - plain-text summary for WhatsApp fallback
 * @param {string} [opts.whatsappPhone] - pre-filled phone (e.g. "919876543210"),
 *   used only when Web Share is not available. Pass "" to open a blank chat.
 * @returns {Promise<{method: 'webshare'|'whatsapp'|'download'}>}
 *   resolves with which sharing method was used, or rejects if the user
 *   cancelled (Web Share) or download failed.
 */
export async function shareReport({ blob, filename, title, text, whatsappPhone = "" }) {
  // --- 1. Web Share API with file ---
  if (canWebShareFile()) {
    const file = new File([blob], filename, { type: "application/pdf" });
    try {
      await navigator.share({ title, text, files: [file] });
      return { method: "webshare" };
    } catch (err) {
      if (err.name === "AbortError") {
        // User dismissed the share sheet — treat as cancellation, not error.
        throw err;
      }
      // Any other error (permission, unsupported by target app, etc.):
      // fall through to WhatsApp fallback.
    }
  }

  // --- 2. WhatsApp deep-link (text only) + trigger download ---
  triggerDownload(blob, filename);

  const encodedText = encodeURIComponent(text);
  const waUrl = whatsappPhone
    ? `https://wa.me/${whatsappPhone}?text=${encodedText}`
    : `https://wa.me/?text=${encodedText}`;
  window.open(waUrl, "_blank", "noopener,noreferrer");

  return { method: "whatsapp" };
}

/**
 * Triggers a browser download of the blob without opening a share sheet.
 * Always works — used as a standalone "Save PDF" action too.
 */
export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a tick so the download starts before the URL is invalidated.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Returns true if the current browser supports Web Share API with
 * file sharing. File sharing is a separate capability from basic
 * navigator.share() and must be checked with navigator.canShare().
 */
export function canWebShareFile() {
  if (!navigator.share || !navigator.canShare) return false;
  try {
    return navigator.canShare({ files: [new File([""], "test.pdf", { type: "application/pdf" })] });
  } catch {
    return false;
  }
}

/**
 * Returns true if this looks like iOS Safari (where Web Share does
 * work but downloads need a manual "Save to Files" step — so we
 * show a hint to the user).
 */
export function isIosSafari() {
  return (
    /iP(hone|ad|od)/.test(navigator.userAgent) &&
    /WebKit/.test(navigator.userAgent) &&
    !/CriOS|FxiOS|OPiOS/.test(navigator.userAgent)
  );
}

/**
 * Builds a plain-text WhatsApp fallback message for a daily attendance report.
 *
 * @param {object} opts
 * @param {string} opts.scopeLabel
 * @param {string} opts.date - "YYYY-MM-DD"
 * @param {string|null} opts.session
 * @param {number} opts.presentCount
 * @param {number} opts.absentCount
 * @param {number} opts.totalCount
 * @param {Array<{name, regNo, remarks}>} opts.absentStudents - absent entries only
 * @returns {string}
 */
export function buildDailyWhatsAppText({
  scopeLabel,
  date,
  session,
  presentCount,
  absentCount,
  totalCount,
  absentStudents,
}) {
  const dateStr = formatDate(date);
  const sessionStr = session ? ` — ${capitalize(session)} Session` : "";
  const lines = [
    `📋 *Attendance Report*`,
    `*${scopeLabel}*${sessionStr}`,
    `Date: ${dateStr}`,
    ``,
    `Present: ${presentCount} / ${totalCount}`,
    `Absent: ${absentCount} / ${totalCount}`,
  ];
  if (absentStudents.length) {
    lines.push(``, `*Absent students:*`);
    absentStudents.forEach((s, i) => {
      const remark = s.remarks ? ` (${s.remarks})` : "";
      lines.push(`${i + 1}. ${s.name} — ${s.regNo}${remark}`);
    });
  }
  return lines.join("\n");
}

/**
 * Builds a plain-text WhatsApp fallback message for a monthly report.
 *
 * @param {object} opts
 * @param {string} opts.scopeLabel
 * @param {string} opts.monthLabel - e.g. "June 2026"
 * @param {string|null} opts.session
 * @param {number} opts.totalStudents
 * @param {number} opts.workingDays - number of days that have records
 * @param {Array<{name, regNo, pct}>} opts.lowAttendance - students below threshold
 * @param {number} [opts.threshold=75] - percentage below which to flag
 * @returns {string}
 */
export function buildMonthlyWhatsAppText({
  scopeLabel,
  monthLabel,
  session,
  totalStudents,
  workingDays,
  lowAttendance,
  threshold = 75,
}) {
  const sessionStr = session ? ` — ${capitalize(session)} Session` : "";
  const lines = [
    `📊 *Monthly Attendance Summary*`,
    `*${scopeLabel}*${sessionStr}`,
    `Month: ${monthLabel}`,
    `Working days recorded: ${workingDays}`,
    `Total students: ${totalStudents}`,
  ];
  if (lowAttendance.length) {
    lines.push(``, `*Below ${threshold}% attendance:*`);
    lowAttendance.forEach((s, i) => {
      lines.push(`${i + 1}. ${s.name} (${s.regNo}) — ${s.pct}%`);
    });
  } else {
    lines.push(``, `✅ All students above ${threshold}% attendance.`);
  }
  return lines.join("\n");
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
