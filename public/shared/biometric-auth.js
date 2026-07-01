// shared/biometric-auth.js
//
// Fingerprint / Face ID quick-login, plus "remember last staff ID".
//
// WHY THIS ISN'T "REAL" SERVER-VERIFIED WEBAUTHN: a proper WebAuthn
// flow has a server hold the public key and verify each assertion's
// signature. This app has no server (Spark plan — no Cloud
// Functions), so instead this uses WebAuthn purely as a LOCAL gate:
//
//   1. Right after a normal successful PIN login, the same derived
//      Firebase email/password pair loginWithPin() already computed
//      (see auth.js's `secret` return value) is stored in this
//      device's localStorage, alongside a WebAuthn platform
//      credential (Touch ID / fingerprint / Face ID / Windows Hello —
//      whatever the device offers).
//   2. Next time, tapping "Login with fingerprint" asks the platform
//      authenticator to verify the user is physically present
//      (fingerprint/face) via navigator.credentials.get(). Nothing
//      about that check is sent anywhere — it happens entirely inside
//      the device's secure hardware.
//   3. If it succeeds, the saved email/password pair is handed to
//      Firebase Auth's normal signInWithEmailAndPassword(), exactly
//      as if the person had retyped their PIN.
//
// This is the same trust model as a browser's "remember my password"
// autofill, just gated by a fingerprint instead of an OS keychain
// prompt — appropriate for an internal staff attendance tool, not a
// substitute for real server-verified WebAuthn on something
// higher-stakes.
//
// Storage is namespaced per app ("admin" / "marker") since each app
// already has its own independent Firebase Auth session on the same
// device (see firebase-init.js). Only one staff account's biometric
// login can be saved per app per device at a time — enabling it for a
// new staffId silently replaces whatever was saved before, since a
// device's fingerprint sensor doesn't distinguish which of several
// saved accounts a print belongs to.

const SECRET_PREFIX = "khp_biometric_";
const LAST_STAFFID_PREFIX = "khp_last_staffid_";
const DECLINED_PREFIX = "khp_biometric_declined_";

function b64encode(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b64decode(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------- //
// Remember last staff ID (works regardless of biometric support)
// ---------------------------------------------------------------- //

export function getLastStaffId(appName) {
  try {
    return localStorage.getItem(LAST_STAFFID_PREFIX + appName) || "";
  } catch {
    return "";
  }
}

export function setLastStaffId(appName, staffId) {
  try {
    localStorage.setItem(LAST_STAFFID_PREFIX + appName, staffId);
  } catch {
    /* ignore — private browsing / storage disabled */
  }
}

// ---------------------------------------------------------------- //
// Platform authenticator availability
// ---------------------------------------------------------------- //

export function isBiometricSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials);
}

export async function isPlatformAuthenticatorAvailable() {
  if (!isBiometricSupported()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- //
// Saved biometric login (per app, per device)
// ---------------------------------------------------------------- //

export function getSavedBiometric(appName) {
  try {
    const raw = localStorage.getItem(SECRET_PREFIX + appName);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearSavedBiometric(appName) {
  try {
    localStorage.removeItem(SECRET_PREFIX + appName);
  } catch {
    /* ignore */
  }
}

function hasDeclined(appName, staffId) {
  try {
    return localStorage.getItem(DECLINED_PREFIX + appName + ":" + staffId) === "1";
  } catch {
    return false;
  }
}

function markDeclined(appName, staffId) {
  try {
    localStorage.setItem(DECLINED_PREFIX + appName + ":" + staffId, "1");
  } catch {
    /* ignore */
  }
}

/**
 * Registers a platform-authenticator (fingerprint/Face ID) credential
 * for this device and saves the derived login secret behind it.
 */
export async function enableBiometricLogin(appName, { staffId, name, email, password }) {
  if (!(await isPlatformAuthenticatorAvailable())) {
    throw new Error("This device doesn't support fingerprint login.");
  }
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));

  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: "KHTPC Attendance", id: location.hostname },
      user: { id: userId, name: staffId, displayName: name || staffId },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },   // ES256
        { type: "public-key", alg: -257 }, // RS256
      ],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
      timeout: 60000,
      attestation: "none",
    },
  });
  if (!cred) throw new Error("Fingerprint setup was cancelled.");

  localStorage.setItem(
    SECRET_PREFIX + appName,
    JSON.stringify({ staffId, name: name || staffId, credentialId: b64encode(cred.rawId), email, password })
  );
}

/**
 * Prompts the device's fingerprint/Face ID check for the credential
 * saved on this device, then returns the stored {staffId, email,
 * password} for the caller to sign in with (see
 * auth.js's signInWithStoredSecret). Throws if nothing is saved, the
 * device can't verify, or the person cancels the prompt.
 */
export async function unlockWithBiometric(appName) {
  const saved = getSavedBiometric(appName);
  if (!saved) throw new Error("No fingerprint login saved on this device yet.");

  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: [{ id: b64decode(saved.credentialId), type: "public-key" }],
      userVerification: "required",
      timeout: 60000,
    },
  });
  if (!assertion) throw new Error("Fingerprint check was cancelled.");

  return { staffId: saved.staffId, email: saved.email, password: saved.password };
}

// ---------------------------------------------------------------- //
// Post-login enrollment banner
// ---------------------------------------------------------------- //

/**
 * Shows a small dismissible banner offering to turn on fingerprint
 * login on this device, inserted at the top of `container`. No-ops
 * silently if the device has no platform authenticator, biometric
 * login is already saved for this staffId on this app, or the person
 * already declined once before for this staffId (so it doesn't nag on
 * every single login).
 */
export async function maybeOfferBiometricEnroll(appName, { staffId, name, email, password }) {
  if (!(await isPlatformAuthenticatorAvailable())) return;
  const existing = getSavedBiometric(appName);
  if (existing && existing.staffId === staffId) return; // already enabled for this account
  if (hasDeclined(appName, staffId)) return;

  const banner = document.createElement("div");
  banner.className = "card";
  banner.style.cssText =
    "display:flex; align-items:center; gap:var(--space-3); border-color:var(--color-info-text); background:var(--color-info-bg);";
  banner.innerHTML = `
    <div style="font-size:1.6em; line-height:1;">🔐</div>
    <div style="flex:1; min-width:0;">
      <div style="font-weight:700; margin-bottom:2px;">Enable fingerprint login?</div>
      <div style="font-size:0.85em; color:var(--color-text-muted);">Skip typing your PIN next time on this device.</div>
    </div>
    <button type="button" class="btn" style="white-space:nowrap;" data-action="enable">Enable</button>
    <button type="button" class="btn btn--secondary" style="white-space:nowrap;" data-action="dismiss">Not now</button>
  `;

  const mount = document.getElementById("app-shell") || document.body;
  mount.insertBefore(banner, mount.firstChild);

  banner.querySelector('[data-action="dismiss"]').addEventListener("click", () => {
    markDeclined(appName, staffId);
    banner.remove();
  });

  banner.querySelector('[data-action="enable"]').addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Enabling…";
    try {
      await enableBiometricLogin(appName, { staffId, name, email, password });
      banner.innerHTML = `<div style="padding:var(--space-2) 0;">✅ Fingerprint login enabled for this device.</div>`;
      setTimeout(() => banner.remove(), 2500);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Enable";
      const msg = document.createElement("div");
      msg.className = "msg msg--err";
      msg.style.marginTop = "var(--space-2)";
      msg.textContent = err.message || "Couldn't enable fingerprint login.";
      banner.appendChild(msg);
    }
  });
}
