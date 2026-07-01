// shared/auth.js
//
// Spark-plan PIN authentication.
//
// WHY THIS LOOKS DIFFERENT FROM A TYPICAL "Cloud Functions + bcrypt"
// DESIGN: Cloud Functions cannot be deployed at all on the Spark plan
// (deploying a function requires a billing account, even at zero
// usage). So instead of hashing PINs ourselves and minting custom
// tokens server-side, we let Firebase Authentication's own
// email/password provider do the secure credential storage for us
// (Google already hashes/stores these safely — we never see or store
// a password hash ourselves). A deterministic, salted transform turns
// "staffId + 4-or-6-digit PIN" into a throwaway email/password pair
// behind the scenes; the human only ever sees a numeric PIN keypad.
//
// KNOWN LIMITATIONS vs. the original Cloud Functions spec (see README
// "Known limitations" for full detail):
//   1. adminResetPin() deactivates the old account and issues a new
//      one rather than mutating a PIN in place. End result for the
//      marker is identical (old PIN stops working, new PIN works).
//   2. The 5-fail/15-minute lockout is enforced by app convention via
//      Firestore, not by a trusted server gating Firebase Auth itself.
//      Fine for an internal staff tool; not a substitute for a real
//      rate-limiter if this were ever public-facing.

import { auth, db } from "./firebase-init.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
  onAuthStateChanged,
  getAuth,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  runTransaction,
  writeBatch,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const APP_EMAIL_DOMAIN = "kongu-bus-app.local";
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const GENERIC_LOGIN_ERROR = "Staff ID or PIN is incorrect.";

// ---------------------------------------------------------------- //
// Internal helpers
// ---------------------------------------------------------------- //

function sanitizeStaffId(staffId) {
  return String(staffId).trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function deriveCredentials(staffId, pin, authVersion = 1) {
  const sid = sanitizeStaffId(staffId);
  const email = authVersion > 1 ? `${sid}-v${authVersion}@${APP_EMAIL_DOMAIN}` : `${sid}@${APP_EMAIL_DOMAIN}`;
  const fullHash = await sha256Hex(`${sid}:${pin}:${authVersion}:bus-attendance-static-salt`);
  return { email, password: fullHash.slice(0, 32) };
}

// A throwaway secondary Firebase App instance lets the currently
// signed-in admin create ANOTHER Firebase Auth account without being
// signed out of their own session (createUserWithEmailAndPassword
// always signs in as the new user on whichever Auth instance it's
// called against).
async function createAuthAccountWithoutSigningOutCurrentUser(email, password) {
  const secondaryApp = initializeApp(firebaseConfig, `secondary-${Date.now()}`);
  const secondaryAuth = getAuth(secondaryApp);
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    return cred.user.uid;
  } finally {
    await signOut(secondaryAuth).catch(() => {});
    await deleteApp(secondaryApp).catch(() => {});
  }
}

async function recordFailedAttempt(staffId) {
  const ref = doc(db, "loginAttempts", staffId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists() ? snap.data() : { failCount: 0, lockedUntil: 0 };
    const failCount = (cur.failCount || 0) + 1;
    const lockedUntil = failCount >= LOCKOUT_THRESHOLD ? Date.now() + LOCKOUT_MS : cur.lockedUntil || 0;
    const payload = { failCount, lockedUntil, lastAttemptAt: serverTimestamp() };
    if (snap.exists()) tx.update(ref, payload);
    else tx.set(ref, payload);
  });
}

async function clearAttempts(staffId) {
  await setDoc(doc(db, "loginAttempts", staffId), {
    failCount: 0,
    lockedUntil: 0,
    lastAttemptAt: serverTimestamp(),
  }).catch(() => {});
}

async function getLockoutState(staffId) {
  const snap = await getDoc(doc(db, "loginAttempts", staffId));
  return snap.exists() ? snap.data() : { failCount: 0, lockedUntil: 0 };
}

function assertNotLocked(lock) {
  if (lock.lockedUntil && lock.lockedUntil > Date.now()) {
    const mins = Math.ceil((lock.lockedUntil - Date.now()) / 60000);
    throw new Error(`Too many incorrect attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`);
  }
}

// ---------------------------------------------------------------- //
// Public API
// ---------------------------------------------------------------- //

export async function isBootstrapped() {
  const snap = await getDoc(doc(db, "meta", "bootstrap"));
  return snap.exists() && snap.data().bootstrapped === true;
}

/**
 * Creates the very first admin account. Only works while the system
 * has never been bootstrapped before (enforced by Firestore rules,
 * not just this client check).
 */
export async function bootstrapFirstAdmin({ name, staffId, pin }) {
  if (await isBootstrapped()) {
    throw new Error("This system already has an admin account. Ask your admin to create your account.");
  }
  const sid = sanitizeStaffId(staffId);
  const { email, password } = await deriveCredentials(sid, pin, 1);

  const cred = await createUserWithEmailAndPassword(auth, email, password);
  const uid = cred.user.uid;

  await setDoc(doc(db, "staffIndex", sid), { uid, authVersion: 1, active: true });
  await setDoc(doc(db, "users", uid), {
    name,
    staffId: sid,
    role: "admin",
    category: "admin",
    scopeIds: [],
    active: true,
    authVersion: 1,
    createdAt: serverTimestamp(),
  });
  await setDoc(doc(db, "meta", "bootstrap"), {
    bootstrapped: true,
    bootstrappedAt: serverTimestamp(),
    bootstrappedBy: uid,
  });

  return uid;
}

/**
 * Logs a marker or admin in with staffId + PIN.
 * Returns { uid, profile, secret } on success; throws a user-facing
 * Error on failure (wrong PIN, locked out, or deactivated account).
 * `secret` is the derived {email, password} Firebase Auth pair for
 * this staffId+PIN — callers can hand it to
 * shared/biometric-auth.js's enableBiometricLogin() right after a
 * successful login to offer saving it behind a fingerprint gate on
 * this device, without re-deriving it (and re-reading staffIndex) a
 * second time.
 */
export async function loginWithPin(staffIdRaw, pin) {
  const staffId = sanitizeStaffId(staffIdRaw);

  const lock = await getLockoutState(staffId);
  assertNotLocked(lock);

  const idxSnap = await getDoc(doc(db, "staffIndex", staffId));
  if (!idxSnap.exists() || idxSnap.data().active === false) {
    await recordFailedAttempt(staffId);
    throw new Error(GENERIC_LOGIN_ERROR);
  }
  const { authVersion } = idxSnap.data();
  const { email, password } = await deriveCredentials(staffId, pin, authVersion);

  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const profileSnap = await getDoc(doc(db, "users", cred.user.uid));
    if (!profileSnap.exists() || profileSnap.data().active === false) {
      await signOut(auth);
      throw new Error("This account has been deactivated. Contact your admin.");
    }
    await clearAttempts(staffId);
    return { uid: cred.user.uid, profile: profileSnap.data(), secret: { email, password } };
  } catch (err) {
    await recordFailedAttempt(staffId);
    throw new Error(GENERIC_LOGIN_ERROR);
  }
}

/**
 * Signs in using an already-derived {email, password} pair instead of
 * a staffId+PIN — used to complete a fingerprint/biometric login (see
 * shared/biometric-auth.js), where the pair was derived once during a
 * normal PIN login and saved locally behind the device's platform
 * authenticator. Runs the same "is this account still active" check
 * as loginWithPin() so a PIN reset or deactivation since the
 * biometric login was saved is still caught immediately — it just
 * surfaces as a normal sign-in failure rather than a lockout, since
 * there's no staffId here to record a failed attempt against.
 */
export async function signInWithStoredSecret(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  const profileSnap = await getDoc(doc(db, "users", cred.user.uid));
  if (!profileSnap.exists() || profileSnap.data().active === false) {
    await signOut(auth);
    throw new Error("This account has been deactivated. Contact your admin.");
  }
  return { uid: cred.user.uid, profile: profileSnap.data() };
}

export async function logout() {
  await signOut(auth);
}

/** Subscribe to auth state changes. Returns an unsubscribe function. */
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

/** Any signed-in user changes their own PIN (requires current PIN). */
export async function changeOwnPin(staffIdRaw, currentPin, newPin) {
  const sid = sanitizeStaffId(staffIdRaw);
  const idxSnap = await getDoc(doc(db, "staffIndex", sid));
  if (!idxSnap.exists()) throw new Error("Unknown staff ID.");
  const { authVersion } = idxSnap.data();

  const { email, password: oldPassword } = await deriveCredentials(sid, currentPin, authVersion);
  const { password: newPassword } = await deriveCredentials(sid, newPin, authVersion);

  const credential = EmailAuthProvider.credential(email, oldPassword);
  await reauthenticateWithCredential(auth.currentUser, credential);
  await updatePassword(auth.currentUser, newPassword);
}

/** Admin-only: create a new marker (or admin) account. */
export async function adminCreateUser({ name, staffId, category, scopeIds, pin, role = "marker" }) {
  const sid = sanitizeStaffId(staffId);
  const { email, password } = await deriveCredentials(sid, pin, 1);

  const uid = await createAuthAccountWithoutSigningOutCurrentUser(email, password);

  // Write staffIndex + users together so a dropped connection can't leave
  // one doc written without the other (which is what causes "Unknown
  // staff ID" later, since setUserActive/adminResetPin key off staffIndex).
  const batch = writeBatch(db);
  batch.set(doc(db, "staffIndex", sid), { uid, authVersion: 1, active: true });
  batch.set(doc(db, "users", uid), {
    name,
    staffId: sid,
    role,
    category,
    scopeIds,
    active: true,
    authVersion: 1,
    createdAt: serverTimestamp(),
  });
  await batch.commit();

  return uid;
}

/**
 * Admin-only: "reset" a marker's PIN. Implemented as deactivate-old +
 * issue-new (see file header) since arbitrary password reset for
 * another user isn't possible from a client SDK without Cloud
 * Functions / Admin SDK.
 */
export async function adminResetPin(staffIdRaw, newPin) {
  const sid = sanitizeStaffId(staffIdRaw);
  const idxRef = doc(db, "staffIndex", sid);
  const idxSnap = await getDoc(idxRef);
  if (!idxSnap.exists()) throw new Error("Unknown staff ID.");

  const { uid: oldUid, authVersion: oldVersion } = idxSnap.data();
  const newVersion = (oldVersion || 1) + 1;

  const oldProfileSnap = await getDoc(doc(db, "users", oldUid));
  const profile = oldProfileSnap.data();

  const { email, password } = await deriveCredentials(sid, newPin, newVersion);
  const newUid = await createAuthAccountWithoutSigningOutCurrentUser(email, password);

  // Same reasoning as adminCreateUser: commit the old-user deactivation,
  // new-user creation, and staffIndex re-point as one atomic batch so a
  // dropped connection mid-way can't leave staffIndex pointing at a stale
  // or missing uid.
  const batch = writeBatch(db);
  batch.update(doc(db, "users", oldUid), { active: false });
  batch.set(doc(db, "users", newUid), {
    ...profile,
    active: true,
    authVersion: newVersion,
    createdAt: serverTimestamp(),
  });
  batch.set(idxRef, { uid: newUid, authVersion: newVersion, active: true });
  await batch.commit();
  await clearAttempts(sid);

  return newUid;
}

/**
 * Admin-only: deactivate or reactivate a marker without touching their PIN.
 *
 * `fallbackUid` lets the caller pass the uid it already has on hand (e.g.
 * from the row it's rendering). This makes the operation self-healing: if
 * the staffIndex/{staffId} doc is missing or out of sync (e.g. left over
 * from a partially-failed adminCreateUser/adminResetPin call), we still
 * update the real users/{uid} doc and then re-write staffIndex to match,
 * instead of failing with "Unknown staff ID."
 */
export async function setUserActive(staffIdRaw, active, fallbackUid = null) {
  const sid = sanitizeStaffId(staffIdRaw);
  const idxRef = doc(db, "staffIndex", sid);
  const idxSnap = await getDoc(idxRef);

  const uid = idxSnap.exists() ? idxSnap.data().uid : fallbackUid;
  if (!uid) throw new Error("Unknown staff ID.");

  await updateDoc(doc(db, "users", uid), { active });

  // Self-heal staffIndex: create it if missing, update it if present.
  const authVersion = idxSnap.exists() ? idxSnap.data().authVersion ?? 1 : 1;
  await setDoc(idxRef, { uid, authVersion, active }, { merge: true });
}
