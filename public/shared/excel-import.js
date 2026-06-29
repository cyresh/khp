// shared/excel-import.js
//
// Reusable Excel import/parsing pipeline for the KHTPC bus attendance
// system. Used by both the first-run bootstrap flow (P2) and the
// admin re-upload screen (P7).
//
// DESIGN: this module is pure parsing/transformation — it takes a
// parsed SheetJS workbook and returns structured data plus a list of
// diagnostics (warnings, auto-resolved mismatches, unresolved items
// needing admin input). It does NOT talk to Firestore. The caller
// (bootstrap UI or admin re-upload UI) is responsible for:
//   1. Calling parseWorkbook() to get { college, buses, students, diagnostics }
//   2. Showing diagnostics to the admin, collecting resolutions for
//      any `unresolved` stop mismatches
//   3. Calling diffAgainstExisting() against current Firestore data
//      (re-upload only) to compute new/updated/removed before commit
//   4. Performing the actual batched Firestore writes itself
//
// Expects SheetJS workbook sheets named exactly:
//   "Bus Student List", "Stop List", "Sheet 3"
// (Confirmed against the 2026-27 Bus Stop List R6 source file.)

// ---------------------------------------------------------------- //
// Constants describing the known sheet layout
// ---------------------------------------------------------------- //

const SHEET_NAMES = {
  students: "Bus Student List",
  stops: "Stop List",
  college: "Sheet 3",
};

// Stop List: 8 bus blocks laid out side by side, each block is 5
// columns wide (4 data columns + 1 gap), starting at column B (index 1,
// 0-based) and repeating every 5 columns. Row 2 = bus no/name, row 3 =
// driver, row 4 = driver phone, row 5 = incharge, row 6 = incharge
// phone, row 8 = stop table header, row 9+ = stop rows.
// Column offsets are 0-based from the block's start column.
const STOP_BLOCK_START_COLS_0BASED = [1, 6, 11, 16, 21, 26, 31, 36]; // B,G,L,Q,V,AA,AF,AK
const STOP_BLOCK_COL_OFFSET = {
  stopNo: 0,
  stopName: 1,
  time: 2,
  km: 3,
};
const ROW_BUS_NAME_1BASED = 2;
const ROW_DRIVER_1BASED = 3;
const ROW_DRIVER_PHONE_1BASED = 4;
const ROW_INCHARGE_1BASED = 5;
const ROW_INCHARGE_PHONE_1BASED = 6;
const ROW_CAPACITY_1BASED = 7;          // NEW: capacity entered on row 7 of each bus block
const ROW_STOPS_START_1BASED = 9;

// Bus Student List: fixed column layout (1-based / spreadsheet column
// numbers), confirmed against the real header row.
const STUDENT_COLS = {
  slNo: 2, // B
  year: 3, // C
  course: 4, // D
  regNo: 5, // E
  scholarship: 6, // F
  admnNo: 7, // G
  name: 8, // H
  gender: 9, // I
  refCategory: 10, // J
  reference: 11, // K
  contact1: 12, // L
  contact2: 13, // M
  contact3: 14, // N
  bus: 15, // O
  busStop: 16, // P — also doubles as "Hindi"/"Tamil" hostel-type for hostel-category rows
  busFees: 17, // Q
};
const STUDENT_HEADER_ROW_1BASED = 2;
const STUDENT_DATA_START_ROW_1BASED = 3;

const NON_BUS_CATEGORIES = ["own vehicle", "hostel"];

// ---------------------------------------------------------------- //
// Small generic helpers
// ---------------------------------------------------------------- //

function cellAt(sheet, row1based, col1based) {
  // SheetJS cell addressing is 0-based internally via utils, but it's
  // simplest to build the A1 address ourselves since our layout is
  // fixed and well-known.
  const colLetter = colNumToLetter(col1based);
  const addr = `${colLetter}${row1based}`;
  const cell = sheet[addr];
  return cell ? cell.v : undefined;
}

function colNumToLetter(num) {
  let s = "";
  while (num > 0) {
    const rem = (num - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    num = Math.floor((num - 1) / 26);
  }
  return s;
}

function trimmed(v) {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

function normKey(v) {
  return trimmed(v).toLowerCase();
}

function isBlank(v) {
  return v === undefined || v === null || trimmed(v) === "";
}

// ---------------------------------------------------------------- //
// Field normalizers (handle the real messiness found in the source
// data: mixed casing, trailing spaces, etc.)
// ---------------------------------------------------------------- //

function normalizeYear(raw) {
  const t = trimmed(raw);
  if (!t) return null;
  const lower = t.toLowerCase();
  // "Third" / "Second " / "second" / "First" all normalize to
  // Title-case with no surrounding whitespace.
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function normalizeGender(raw) {
  const t = trimmed(raw).toLowerCase();
  if (t === "boy") return "Boy";
  if (t === "girl") return "Girl";
  if (!t) return null;
  // Unknown value — preserve as-is (capitalized) rather than silently
  // dropping it; flagged separately as a diagnostic by the caller if
  // it doesn't match an expected value.
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Normalizes the hostel-type column ("Hindi" / "Tamil") for hostel
 * students. Only meaningful when category === "hostel" — the caller
 * decides whether to flag a missing/unrecognized value as a
 * diagnostic, since it's irrelevant for bus/own-vehicle students. */
function normalizeHostelType(raw) {
  const t = trimmed(raw).toLowerCase();
  if (t === "hindi") return "Hindi";
  if (t === "tamil") return "Tamil";
  if (!t) return null;
  // Unknown value — preserve as-is (capitalized) so it's visible in
  // the UI as an "Other" group rather than silently dropped.
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function normalizeCourse(raw) {
  const t = trimmed(raw);
  if (!t) return null;
  return t.toUpperCase();
}

function normalizeRegNo(raw) {
  // Always cast to string as-is, per decision: 25217846 -> "25217846".
  if (raw === undefined || raw === null) return null;
  return String(raw).trim();
}

/**
 * Derives a stable busId from any of the label variants seen across
 * both sheets: "Bus 11", "11 BUS", "11 Bus", "21 Cruiser", "21 CRUISER".
 * Returns null for non-bus categories (Own Vehicle / Hostel) — caller
 * checks isNonBusCategory() first.
 */
function deriveBusId(rawLabel) {
  const s = trimmed(rawLabel);
  if (!s) return null;
  if (/^21\s*cruiser$/i.test(s)) return "cruiser_21";
  const m = s.match(/(\d+)/);
  if (m) return `bus_${m[1]}`;
  return null;
}

function isNonBusCategory(rawLabel) {
  return NON_BUS_CATEGORIES.includes(normKey(rawLabel));
}

/**
 * Parses a "Contact NN" cell like "9943005871(F)" into
 * { raw, phone, relation } on a best-effort basis. Never throws —
 * malformed entries (missing parens, wrong digit count, placeholder
 * text like "NA"/"TBU", bare numbers with no relation tag) are
 * preserved as `raw` with phone/relation left null, since these are
 * secondary fields and must never block a student import.
 */
function parseContact(raw) {
  if (isBlank(raw) || trimmed(raw) === "-") {
    return { raw: trimmed(raw) || null, phone: null, relation: null };
  }
  const s = trimmed(raw);
  const m = s.match(/^(\d{10})\s*\((\w+)\)$/);
  if (m) {
    return { raw: s, phone: m[1], relation: m[2].toUpperCase() };
  }
  // Bare 10-digit number, no relation tag.
  const bareMatch = s.match(/^(\d{10})$/);
  if (bareMatch) {
    return { raw: s, phone: bareMatch[1], relation: null };
  }
  // Anything else (wrong digit count, "NA", "TBU", typos) — keep raw,
  // flag via diagnostics by the caller if needed.
  return { raw: s, phone: null, relation: null };
}

// ---------------------------------------------------------------- //
// Sheet 3 -> college/main
// ---------------------------------------------------------------- //

function parseCollege(workbook, diagnostics) {
  const sheet = workbook.Sheets[SHEET_NAMES.college];
  if (!sheet) {
    diagnostics.push({
      level: "error",
      area: "college",
      message: `Sheet "${SHEET_NAMES.college}" not found in workbook.`,
    });
    return null;
  }
  const name = trimmed(cellAt(sheet, 1, 1));
  const address = trimmed(cellAt(sheet, 2, 1));
  const phoneLine = trimmed(cellAt(sheet, 3, 1));

  // Phone line format: "Phone: 9159109090     9159209090     9159309090"
  // Also tolerate the number being split into two 5-digit halves with a
  // space in between (e.g. "91591 09090     91592 09090"), which some
  // source sheets use for readability — those halves get merged back
  // into a single 10-digit number below instead of being treated as
  // two separate (invalid) phone numbers.
  const afterLabel = phoneLine.replace(/^phone:?/i, "").trim();
  const tokens = afterLabel.split(/\s+/).filter(Boolean);

  const mergedNumbers = [];
  for (let i = 0; i < tokens.length; i++) {
    const cur = tokens[i].replace(/\D/g, "");
    const next = i + 1 < tokens.length ? tokens[i + 1].replace(/\D/g, "") : "";
    if (cur.length === 5 && next.length === 5) {
      // Two 5-digit halves of one number — merge and skip the next token.
      mergedNumbers.push(cur + next);
      i++;
    } else {
      mergedNumbers.push(cur);
    }
  }

  const phones = mergedNumbers.map((digits) => {
    if (digits.length !== 10) {
      diagnostics.push({
        level: "warning",
        area: "college",
        message: `Phone number "${digits}" is ${digits.length} digits, expected 10. Flagged for admin review.`,
      });
    }
    return { raw: digits, digits, valid: digits.length === 10 };
  });

  if (!name) {
    diagnostics.push({ level: "error", area: "college", message: "College name is blank." });
  }

  // Class capacities: table below college info with header row
  // Layout: col A = Year (First/Second/Third…), col B = Course (AI/CSE…), col C = Capacity
  // Header row is auto-detected and skipped. Blank rows are skipped.
  // classId is built as  year.toLowerCase() + "_" + course.toLowerCase()
  // e.g. First | AI | 60  →  first_ai: 60
  const classCapacities = {};
  const YEAR_WORDS = new Set(["first","second","third","fourth","fifth","sixth"]);
  for (let r = 5; r <= 200; r++) {
    const yearRaw   = trimmed(cellAt(sheet, r, 1));
    const courseRaw = trimmed(cellAt(sheet, r, 2));
    const capValue  = cellAt(sheet, r, 3);
    if (!yearRaw && !courseRaw) continue;          // blank row — skip
    const yearLower = (yearRaw || "").toLowerCase().replace(/\s+/g,"");
    if (!YEAR_WORDS.has(yearLower)) continue;      // header or non-data row
    if (!courseRaw) continue;                      // no course — skip
    const cap = typeof capValue === "number" && capValue > 0
      ? Math.round(capValue) : null;
    if (cap !== null) {
      const classId = yearLower + "_" + courseRaw.toLowerCase().replace(/\s+/g,"");
      classCapacities[classId] = cap;
    }
  }

  return { name, address, phones, classCapacities };
}

// ---------------------------------------------------------------- //
// Stop List -> buses/{busId}
// ---------------------------------------------------------------- //

function excelTimeToHHMM(v) {
  // SheetJS returns time-only cells either as a JS Date (if
  // cellDates:true was used when reading) or as an Excel serial
  // fraction-of-day number. Handle both.
  if (v instanceof Date) {
    const hh = String(v.getHours()).padStart(2, "0");
    const mm = String(v.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  if (typeof v === "number") {
    const totalMinutes = Math.round(v * 24 * 60);
    const hh = String(Math.floor(totalMinutes / 60) % 24).padStart(2, "0");
    const mm = String(totalMinutes % 60).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  return null;
}

function parseStops(workbook, diagnostics) {
  const sheet = workbook.Sheets[SHEET_NAMES.stops];
  if (!sheet) {
    diagnostics.push({
      level: "error",
      area: "buses",
      message: `Sheet "${SHEET_NAMES.stops}" not found in workbook.`,
    });
    return [];
  }

  const buses = [];
  const seenBusIds = new Set();

  for (const blockStartCol0 of STOP_BLOCK_START_COLS_0BASED) {
    const blockStartCol1 = blockStartCol0 + 1; // convert to 1-based
    const nameCol1 = blockStartCol1 + 1;

    const busLabel = trimmed(cellAt(sheet, ROW_BUS_NAME_1BASED, nameCol1));
    if (!busLabel) continue; // empty block, skip

    const busId = deriveBusId(busLabel);
    if (!busId) {
      diagnostics.push({
        level: "error",
        area: "buses",
        message: `Could not derive a busId from label "${busLabel}" (column ${colNumToLetter(nameCol1)}).`,
      });
      continue;
    }
    if (seenBusIds.has(busId)) {
      diagnostics.push({
        level: "error",
        area: "buses",
        message: `Duplicate busId "${busId}" derived from label "${busLabel}" — check for a repeated bus block in the Stop List sheet.`,
      });
      continue;
    }
    seenBusIds.add(busId);

    const capacityRaw = cellAt(sheet, ROW_CAPACITY_1BASED, nameCol1);
    const capacity    = typeof capacityRaw === "number" && capacityRaw > 0
      ? Math.round(capacityRaw) : null;

    const driverName = trimmed(cellAt(sheet, ROW_DRIVER_1BASED, nameCol1));
    const driverPhoneRaw = cellAt(sheet, ROW_DRIVER_PHONE_1BASED, nameCol1);
    const inchargeName = trimmed(cellAt(sheet, ROW_INCHARGE_1BASED, nameCol1));
    const inchargePhoneRaw = cellAt(sheet, ROW_INCHARGE_PHONE_1BASED, nameCol1);

    const stops = [];
    let row = ROW_STOPS_START_1BASED;
    let consecutiveBlankStopRows = 0;
    // Terminate after 3 consecutive blank rows (defensive — in
    // practice a bus's stop list just ends with no gap), or after a
    // generous absolute row cap as a safety valve against malformed
    // input causing an effectively infinite scan.
    while (consecutiveBlankStopRows < 3 && row <= ROW_STOPS_START_1BASED + 200) {
      const stopNoCol1 = blockStartCol1 + STOP_BLOCK_COL_OFFSET.stopNo;
      const stopNameCol1 = blockStartCol1 + STOP_BLOCK_COL_OFFSET.stopName;
      const timeCol1 = blockStartCol1 + STOP_BLOCK_COL_OFFSET.time;
      const kmCol1 = blockStartCol1 + STOP_BLOCK_COL_OFFSET.km;

      const stopName = cellAt(sheet, row, stopNameCol1);
      const stopNoRaw = cellAt(sheet, row, stopNoCol1);

      if (isBlank(stopName) && isBlank(stopNoRaw)) {
        consecutiveBlankStopRows++;
        row++;
        continue;
      }
      consecutiveBlankStopRows = 0;

      if (!isBlank(stopName)) {
        const stopNo = typeof stopNoRaw === "number" ? stopNoRaw : Number(stopNoRaw);
        const timeRaw = cellAt(sheet, row, timeCol1);
        const kmRaw = cellAt(sheet, row, kmCol1);

        if (Number.isNaN(stopNo)) {
          diagnostics.push({
            level: "warning",
            area: "buses",
            busId,
            message: `Stop "${trimmed(stopName)}" has a non-numeric or missing stop number; row preserved with stopNo=null.`,
          });
        }

        stops.push({
          stopNo: Number.isNaN(stopNo) ? null : stopNo,
          // Stop name is stored TRIMMED but case is preserved exactly
          // as entered — case normalization only happens during
          // matching, not in the stored "source of truth" name.
          name: trimmed(stopName),
          time: excelTimeToHHMM(timeRaw),
          km: typeof kmRaw === "number" ? kmRaw : null,
        });
      }
      row++;
      // Safety valve: stop scanning after 60 consecutive rows past
      // the sheet's max row to avoid an infinite loop on malformed
      // input; real buses top out at ~24 stops.
      if (row > ROW_STOPS_START_1BASED + 200) break;
    }

    if (stops.length === 0) {
      diagnostics.push({
        level: "warning",
        area: "buses",
        busId,
        message: `Bus "${busLabel}" (${busId}) has no stops parsed.`,
      });
    }

    buses.push({
      busId,
      label: busLabel,
      capacity,
      driver: { name: driverName || null, phone: cleanPlainPhone(driverPhoneRaw) },
      incharge: { name: inchargeName || null, phone: cleanPlainPhone(inchargePhoneRaw) },
      stops,
    });
  }

  return buses;
}

function cleanPlainPhone(raw) {
  if (isBlank(raw)) return null;
  const digits = String(raw).replace(/\D/g, "");
  return digits || null;
}

// ---------------------------------------------------------------- //
// Stop-name resolution: exact -> normalized -> fuzzy (admin review)
// ---------------------------------------------------------------- //

/**
 * Resolves a student's free-text Bus Stop value against the bus's
 * known stop list, using a three-tier strategy:
 *   1. Exact match (string identical, including case/whitespace)
 *   2. Normalized match (trim + lowercase) — auto-resolved, logged
 *      as an info diagnostic, no admin action needed
 *   3. Fuzzy match (Levenshtein-based similarity) — best guess is
 *      pre-selected but surfaced to the admin as `unresolved` for
 *      confirmation before commit
 * Returns { stopNo, matchedName, tier } or null if even fuzzy
 * matching found nothing reasonable (caller treats as unresolved
 * with no pre-selected guess).
 */
function resolveStopName(rawStopValue, busStops, diagnostics, context) {
  const rawAsString = rawStopValue === undefined || rawStopValue === null ? "" : String(rawStopValue);
  const target = trimmed(rawStopValue);
  if (!target) return null;

  // Tier 1: exact match against the truly raw (untrimmed) value, so
  // a trailing/leading-whitespace-only difference is correctly
  // caught and logged at Tier 2 rather than silently passing here.
  const exact = busStops.find((s) => s.name === rawAsString);
  if (exact) return { stopNo: exact.stopNo, matchedName: exact.name, tier: "exact" };

  // Tier 2: normalized (trim + lowercase) match.
  const targetNorm = normKey(target);
  const normMatch = busStops.find((s) => normKey(s.name) === targetNorm);
  if (normMatch) {
    diagnostics.push({
      level: "info",
      area: "stopMatch",
      message: `Auto-resolved "${target}" -> "${normMatch.name}" (case/whitespace difference only) for ${context}.`,
    });
    return { stopNo: normMatch.stopNo, matchedName: normMatch.name, tier: "normalized" };
  }

  // Tier 3: fuzzy match via Levenshtein distance, relative to string
  // length so short names aren't unfairly penalized.
  let best = null;
  let bestScore = Infinity;
  for (const s of busStops) {
    const dist = levenshtein(targetNorm, normKey(s.name));
    const maxLen = Math.max(targetNorm.length, normKey(s.name).length, 1);
    const score = dist / maxLen;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  // Threshold: within ~40% edit distance is treated as a plausible
  // guess worth surfacing; beyond that we present no pre-selection.
  const FUZZY_THRESHOLD = 0.4;
  const guess = best && bestScore <= FUZZY_THRESHOLD ? best : null;

  diagnostics.push({
    level: "needs_review",
    area: "stopMatch",
    message: `Could not match stop "${target}" for ${context}.${guess ? ` Best guess: "${guess.name}".` : " No close guess found."}`,
    raw: target,
    bestGuess: guess ? { stopNo: guess.stopNo, name: guess.name } : null,
    candidates: busStops.map((s) => ({ stopNo: s.stopNo, name: s.name })),
  });

  return guess ? { stopNo: guess.stopNo, matchedName: guess.name, tier: "fuzzy_unconfirmed" } : null;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

// ---------------------------------------------------------------- //
// Bus Student List -> students/{regNo}
// ---------------------------------------------------------------- //

function parseStudents(workbook, busesById, diagnostics) {
  const sheet = workbook.Sheets[SHEET_NAMES.students];
  if (!sheet) {
    diagnostics.push({
      level: "error",
      area: "students",
      message: `Sheet "${SHEET_NAMES.students}" not found in workbook.`,
    });
    return [];
  }

  const students = [];
  const seenRegNos = new Set();

  // Determine last row by scanning until slNo is blank for 5
  // consecutive rows (defensive against stray trailing formatting).
  let row = STUDENT_DATA_START_ROW_1BASED;
  let consecutiveBlank = 0;
  while (consecutiveBlank < 5) {
    const slNo = cellAt(sheet, row, STUDENT_COLS.slNo);
    if (isBlank(slNo)) {
      consecutiveBlank++;
      row++;
      continue;
    }
    consecutiveBlank = 0;

    const regNoRaw = cellAt(sheet, row, STUDENT_COLS.regNo);
    const regNo = normalizeRegNo(regNoRaw);
    const name = trimmed(cellAt(sheet, row, STUDENT_COLS.name));

    if (!regNo) {
      diagnostics.push({
        level: "error",
        area: "students",
        message: `Row ${row}: missing Reg. No. for student "${name || "(no name)"}" — row skipped.`,
      });
      row++;
      continue;
    }
    if (seenRegNos.has(regNo)) {
      diagnostics.push({
        level: "error",
        area: "students",
        message: `Row ${row}: duplicate Reg. No. "${regNo}" — row skipped, first occurrence kept.`,
      });
      row++;
      continue;
    }
    seenRegNos.add(regNo);

    const year = normalizeYear(cellAt(sheet, row, STUDENT_COLS.year));
    const course = normalizeCourse(cellAt(sheet, row, STUDENT_COLS.course));
    const gender = normalizeGender(cellAt(sheet, row, STUDENT_COLS.gender));

    if (!year || !course) {
      diagnostics.push({
        level: "warning",
        area: "students",
        message: `Row ${row} (${name}): missing year or course — classId derivation will be incomplete for this student.`,
      });
    }

    const busRaw = cellAt(sheet, row, STUDENT_COLS.bus);
    let busId = null;
    let stopNo = null;
    let stopName = null;
    let category = "bus";
    let hostelType = null;

    if (isBlank(busRaw)) {
      diagnostics.push({
        level: "warning",
        area: "students",
        message: `Row ${row} (${name}): BUS column is blank.`,
      });
      category = "unknown";
    } else if (isNonBusCategory(busRaw)) {
      category = normKey(busRaw) === "hostel" ? "hostel" : "own_vehicle";
      if (category === "hostel") {
        // For hostel rows, the Bus Stop column (P) doubles as the
        // hostel-type field — "Hindi" or "Tamil" — rather than an
        // actual stop name, since hostel students don't have stops.
        hostelType = normalizeHostelType(cellAt(sheet, row, STUDENT_COLS.busStop));
        if (!hostelType) {
          diagnostics.push({
            level: "needs_review",
            area: "students",
            message: `Row ${row} (${name}): hostel student has no Hindi/Tamil type set in the Bus Stop column.`,
          });
        }
      }
    } else {
      busId = deriveBusId(busRaw);
      if (!busId || !busesById.has(busId)) {
        diagnostics.push({
          level: "needs_review",
          area: "students",
          message: `Row ${row} (${name}): BUS value "${trimmed(busRaw)}" did not resolve to a known bus.`,
        });
        busId = null;
      } else {
        const busStopRaw = cellAt(sheet, row, STUDENT_COLS.busStop);
        const resolved = resolveStopName(
          busStopRaw,
          busesById.get(busId).stops,
          diagnostics,
          `student "${name}" (Reg. No. ${regNo}) on ${busId}`
        );
        if (resolved) {
          stopNo = resolved.stopNo;
          stopName = resolved.matchedName;
        } else {
          diagnostics.push({
            level: "needs_review",
            area: "students",
            message: `Row ${row} (${name}): Bus Stop "${trimmed(busStopRaw)}" on ${busId} is unresolved.`,
          });
        }
      }
    }

    const classId =
      year && course ? `${year.toLowerCase()}_${course.toLowerCase()}` : null;

    students.push({
      regNo,
      slNo: cellAt(sheet, row, STUDENT_COLS.slNo),
      year,
      course,
      classId,
      admnNo: trimmed(cellAt(sheet, row, STUDENT_COLS.admnNo)) || null,
      name,
      gender,
      scholarship: trimmed(cellAt(sheet, row, STUDENT_COLS.scholarship)) || null,
      refCategory: trimmed(cellAt(sheet, row, STUDENT_COLS.refCategory)) || null,
      reference: trimmed(cellAt(sheet, row, STUDENT_COLS.reference)) || null,
      contacts: {
        contact1: parseContact(cellAt(sheet, row, STUDENT_COLS.contact1)),
        contact2: parseContact(cellAt(sheet, row, STUDENT_COLS.contact2)),
        contact3: parseContact(cellAt(sheet, row, STUDENT_COLS.contact3)),
      },
      category, // "bus" | "hostel" | "own_vehicle" | "unknown"
      hostelType, // "Hindi" | "Tamil" | null — only set when category === "hostel"
      busId,
      stopNo,
      stopName,
      busFees: trimmed(cellAt(sheet, row, STUDENT_COLS.busFees)) || null,
    });

    row++;
  }

  return students;
}

// ---------------------------------------------------------------- //
// classes/{classId} derivation
// ---------------------------------------------------------------- //

function deriveClasses(students) {
  const classes = new Map();
  for (const s of students) {
    if (!s.classId) continue;
    if (!classes.has(s.classId)) {
      classes.set(s.classId, {
        classId: s.classId,
        year: s.year,
        course: s.course,
        studentCount: 0,
      });
    }
    classes.get(s.classId).studentCount++;
  }
  return Array.from(classes.values()).sort((a, b) => a.classId.localeCompare(b.classId));
}

// ---------------------------------------------------------------- //
// Top-level entry point
// ---------------------------------------------------------------- //

/**
 * Parses a full workbook (as produced by SheetJS's `XLSX.read`) into
 * structured data plus a flat diagnostics list. Does not write to
 * Firestore.
 *
 * @param {object} workbook - SheetJS workbook object (XLSX.read result)
 * @returns {{
 *   college: object|null,
 *   buses: object[],
 *   students: object[],
 *   classes: object[],
 *   diagnostics: Array<{level: string, area: string, message: string}>,
 *   summary: { busCount, stopCount, studentCount, classCount, needsReviewCount, errorCount }
 * }}
 */
export function parseWorkbook(workbook) {
  const diagnostics = [];

  const college = parseCollege(workbook, diagnostics);
  const buses = parseStops(workbook, diagnostics);
  const busesById = new Map(buses.map((b) => [b.busId, b]));
  const students = parseStudents(workbook, busesById, diagnostics);
  const classes = deriveClasses(students);

  const stopCount = buses.reduce((sum, b) => sum + b.stops.length, 0);
  const needsReviewCount = diagnostics.filter((d) => d.level === "needs_review").length;
  const errorCount = diagnostics.filter((d) => d.level === "error").length;

  return {
    college,
    buses,
    students,
    classes,
    diagnostics,
    classCapacities: college ? (college.classCapacities || {}) : {},
    summary: {
      busCount: buses.length,
      stopCount,
      studentCount: students.length,
      classCount: classes.length,
      needsReviewCount,
      errorCount,
    },
  };
}

// ---------------------------------------------------------------- //
// Diff against existing Firestore data (for P7 re-upload preview)
// ---------------------------------------------------------------- //

/**
 * Compares freshly-parsed students against a previously-fetched
 * snapshot of existing students (keyed by regNo) to compute a diff
 * for the admin's preview screen before committing.
 *
 * @param {object[]} freshStudents - output of parseWorkbook().students
 * @param {Map<string,object>} existingStudentsByRegNo - current Firestore data
 * @returns {{ added: object[], updated: Array<{regNo, before, after, changedFields}>, removed: object[] }}
 */
export function diffAgainstExisting(freshStudents, existingStudentsByRegNo) {
  const added = [];
  const updated = [];
  const removed = [];
  const freshByRegNo = new Map(freshStudents.map((s) => [s.regNo, s]));

  for (const fresh of freshStudents) {
    const existing = existingStudentsByRegNo.get(fresh.regNo);
    if (!existing) {
      added.push(fresh);
      continue;
    }
    const changedFields = diffFields(existing, fresh, [
      "year",
      "course",
      "classId",
      "name",
      "gender",
      "category",
      "busId",
      "stopNo",
      "stopName",
      "hostelType",
      "admnNo",
      "scholarship",
      "busFees",
    ]);
    if (changedFields.length > 0) {
      updated.push({ regNo: fresh.regNo, before: existing, after: fresh, changedFields });
    }
  }

  for (const [regNo, existing] of existingStudentsByRegNo.entries()) {
    if (!freshByRegNo.has(regNo)) {
      removed.push(existing);
    }
  }

  return { added, updated, removed };
}

function diffFields(before, after, fields) {
  const changed = [];
  for (const f of fields) {
    if (before[f] !== after[f]) changed.push(f);
  }
  return changed;
}
