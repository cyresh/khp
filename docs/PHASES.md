# Build phases

Adapted for Firebase **Spark** (free) plan — no Cloud Functions anywhere
in this plan; see README "Known limitations" for what that trades off.

- [x] **P1 — Firebase foundation & authentication**
      Client-only PIN auth (no Cloud Functions): bootstrapFirstAdmin,
      loginWithPin, changeOwnPin, adminCreateUser, adminResetPin,
      setUserActive. Firestore rules for auth/bootstrap/lockout.
- [ ] **P2 — Data model & Excel import pipeline**
      Parse the uploaded workbook (Sheet "Bus Student List" → students,
      "Stop List" → buses/stops, "Sheet 3" → college info). Source file
      has messy casing (Year: "Second"/"Second "/"second", Gender:
      "BOY"/"Boy", Bus: "19 Bus"/"19 BUS") — normalization + fuzzy-match
      reconciliation will need to handle this for real.
- [ ] **P3 — Shared UI shell & login screen**
- [ ] **P4 — Marker app: attendance marking**
- [ ] **P5 — Marker app: summaries & sharing (PDF/WhatsApp)**
- [ ] **P6 — Admin app: live dashboard & reports**
- [ ] **P7 — Admin app: database management**
- [ ] **P8 — Admin app: PIN & user management**
      (adminCreateUser/adminResetPin/setUserActive already exist in
      shared/auth.js from P1 — P8 is mostly UI on top of them.)
- [ ] **P9 — Polish, edge cases & deployment**
      Note: "scheduled nightly lock" also needs Cloud Functions
      (Cloud Scheduler + Functions). On Spark this becomes an explicit
      admin "Finalize" button instead of an automatic nightly job.
