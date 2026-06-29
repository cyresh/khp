# KHTPC Bus Attendance App — P9 (Complete)

Two PWAs (marker + admin) sharing one Firebase backend, built on the
**Spark (free) plan** — no Cloud Functions required.

## Quick links

| App | URL after deploy |
|-----|-----------------|
| Marker (bus/hostel staff) | `https://<your-project>.web.app/marker/` |
| Admin | `https://<your-project>.web.app/admin/` |
| Landing page | `https://<your-project>.web.app/` |

---

## One-time Firebase Console setup

1. **console.firebase.google.com → Add project** — stay on **Spark** plan.
2. **Build → Firestore → Create database** — Native mode, closest region.
3. **Build → Authentication → Sign-in method → Email/Password** → Enable.
   (Staff never see an email — the PIN login builds on top of this provider.)
4. **Build → Hosting → Get started** (click through; deploy via CLI below).
5. **Project settings → General → Your apps → Add app → Web** → copy the
   `firebaseConfig` object.

---

## Local setup

```bash
npm install -g firebase-tools     # one-time

firebase login

cp public/shared/firebase-config.example.js public/shared/firebase-config.js
# paste your real firebaseConfig values into firebase-config.js

cp .firebaserc.example .firebaserc
# replace YOUR-FIREBASE-PROJECT-ID with your real project ID
```

---

## Deploy

```bash
# Full first deploy (rules + indexes + hosting)
firebase deploy

# Hosting-only re-deploy (after JS/CSS edits)
firebase deploy --only hosting

# Rules/indexes only (after security-rule or index changes)
firebase deploy --only firestore
```

**`firebase.json` rewrites** — both apps are covered:

```
/marker/**  →  /marker/index.html   (marker PWA, client-side routing)
/admin/**   →  /admin/index.html    (admin PWA, client-side routing)
**          →  /index.html          (landing page fallback)
```

---

## Bootstrap first admin

Run this **once**, right after deploying, before sharing the URL:

1. Open `https://<your-project>.web.app/admin/`
2. You'll see the bootstrap screen (only shown before any admin exists).
3. Enter a name, staff ID, and a **6-digit PIN**.
4. Click "Create Admin Account".
5. Confirm success → the bootstrap screen will not appear again.

> **Tip:** Use a 6-digit PIN for every role. A 4-digit PIN can be
> brute-forced against Firebase Auth directly (see Known Limitations).

---

## Re-upload / update student/bus data (Excel)

1. Log in to the admin app → **Database** tab.
2. Click **Re-upload Excel** → select your `.xlsx` file.
3. The import pipeline validates, diffs against existing Firestore data,
   and writes only the changed docs (add/update/deactivate). It never
   hard-deletes — removed students are marked `active: false` so
   historical attendance records stay meaningful.
4. New buses appear in the dashboard automatically on next load.
5. New students appear in marker rosters immediately after import.

---

## Managing users (admin app → Users tab)

| Action | How |
|--------|-----|
| Create a new marker | Users → **Create Marker** |
| Reset a marker's PIN | Users → find marker → **Reset PIN** |
| Deactivate a marker | Users → find marker → **Deactivate** |
| Change your own PIN | Users → **My Profile** → Change PIN |

---

## P9 features

### Record locking — "Finalize Day"

Dashboard → **🔒 Finalize Day** button batch-locks **all** of today's
`attendanceRecords` in one operation (Firestore batch writes, 400 docs/
batch). Once locked:

- Marker app shows a locked banner and the Save button is disabled.
- Admin daily report shows a locked banner with an **🔓 Unlock (Admin
  Override)** button — only admins can lift the lock.
- The dashboard card shows a 🔒 badge next to the counts.

### Lockout countdown (login screen)

After 5 failed PIN attempts the account is locked for 15 minutes. The
login screen now shows a live countdown (`14m 59s … 0s`) so the user
can see exactly when they can try again without refreshing.

### Offline indicator

A fixed amber banner appears automatically when `navigator.onLine` is
false and auto-hides (fade) on reconnect. Both apps share the same
`offline-banner.js` module.

### Empty roster handling

If no students are assigned to a scope, both the marker app and the
admin daily report show a friendly card (icon + title + hint) instead
of a blank screen or raw error.

---

## Known limitations

1. **PIN "reset" is a deactivate-old + issue-new cycle.** Firebase's
   client SDK can't change another user's password — `adminResetPin()`
   creates a fresh Auth account with the new PIN. Old account becomes a
   permanently-deactivated orphan in Firebase Auth (harmless).
2. **Lockout is app-enforced, not server-enforced.** The 5-fail /
   15-min lockout writes to Firestore; a sophisticated attacker who
   reads the JS could script around it. Acceptable for an internal
   ~30-staff tool; not for a public-facing system.
3. **Bootstrap race-condition window.** If two people ran the
   bootstrap flow simultaneously, both could create admin accounts
   before either flips the flag. Run it yourself, once, right after
   deploy.
4. Upgrading to Blaze (same free quota, just needs a card on file) and
   adding Cloud Functions would close all three gaps without any
   structural changes — `shared/auth.js` is the clean seam to swap.

---

## File map (P9 complete)

```
firebase.json                     Hosting + Firestore config
firestore.rules                   Security rules
firestore.indexes.json            Composite indexes (incl. date+locked for Finalize Day)
.firebaserc.example               → copy to .firebaserc
package.json

public/
  index.html                      Landing page

  shared/
    firebase-config.example.js    → copy to firebase-config.js
    firebase-config.js            (gitignored — your real keys)
    firebase-init.js              Shared app / auth / db instances
    auth.js                       bootstrapFirstAdmin, loginWithPin,
                                  changeOwnPin, adminCreateUser,
                                  adminResetPin, setUserActive
    attendance.js                 fetchRoster, loadRecord, saveRecord,
                                  todayLocalDate, buildRecordId
    excel-import.js               Excel → Firestore import pipeline
    firestore-commit.js           Batch-write helpers
    pdf-utils.js                  jsPDF daily + monthly report generators
    share-utils.js                WhatsApp share + trigger-download helpers
    design-system.css             Shared design tokens + component styles
    college-header.js             College name/logo header component
    pin-keypad.js                 Staff ID + PIN login component
                                  (P9: lockout countdown timer)
    offline-banner.js             P9: fixed offline indicator banner

  marker/
    index.html                    Marker PWA shell + login screen
    app.js                        Home / session / roster screens
                                  (P9: empty-roster friendly card)
    summary.js                    Daily + monthly summary screens
    sw.js                         Service worker (PWA offline shell)
    manifest.json

  admin/
    index.html                    Admin PWA shell + login screen
    app.js                        Dashboard (P9: Finalize Day, offline banner),
                                  Daily report (P9: admin unlock override,
                                  empty-record friendly card),
                                  Monthly report
    db-manager.js                 P7: Excel re-upload, student/bus/college CRUD
    user-manager.js               P8: Marker list, Create, Reset PIN, My Profile
    sw.js
    manifest.json

docs/
  PHASES.md                       Phase-by-phase build plan
```
