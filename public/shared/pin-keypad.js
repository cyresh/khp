// shared/pin-keypad.js
//
// Reusable Staff ID + PIN entry component with a large-touch-target
// on-screen numeric keypad, used by both apps' login screens. Calling
// code supplies the actual auth call (loginWithPin) via a callback,
// so this module has zero Firebase dependency itself — it's pure UI.
//
// Usage:
//   import { mountPinLogin } from "../shared/pin-keypad.js";
//   mountPinLogin(document.getElementById("login-mount"), {
//     pinLength: 6, // 6 digits for every role (admin AND marker) per
//                   // the security trade-off documented in README.md
//     onSubmit: async ({ staffId, pin }) => {
//       const { uid, profile } = await loginWithPin(staffId, pin);
//       // ... navigate, etc. Throw an Error to show it in the UI.
//     },
//   });

/**
 * @param {HTMLElement} container
 * @param {{
 *   pinLength?: number,
 *   onSubmit: (args: {staffId: string, pin: string}) => Promise<void>,
 *   submitLabel?: string,
 * }} options
 */
export function mountPinLogin(container, options) {
  if (!container) return;
  const pinLength = options.pinLength || 6;
  const submitLabel = options.submitLabel || "Login";
  const staffIdPlaceholder = options.staffIdPlaceholder || "e.g. admin01";

  let staffId = "";
  let pin = "";
  let submitting = false;
  let lastError = "";
  let countdownInterval = null; // P9: lockout countdown timer

  // Touch devices (phones/tablets) pop the native on-screen keyboard
  // the moment the PIN input gets focus — which then covers the
  // custom numeric keypad and the Login button beneath it, blocking
  // taps. Detected up front so both the markup (hint text) and the
  // input's attributes (set further below) stay consistent.
  const isTouchDevice = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  const pinHint = isTouchDevice ? "(use keypad below)" : "(type or use keypad below)";

  container.innerHTML = `
    <div class="pin-login">
      <div class="field">
        <label for="pin-login-staffid">Staff ID</label>
        <input id="pin-login-staffid" type="text" autocomplete="username"
               inputmode="text" placeholder="${escapeHtml(staffIdPlaceholder)}" />
      </div>

      <div class="field">
        <label for="pin-login-pin-hidden">PIN <span style="font-size:0.8em; font-weight:400; opacity:0.7;">${pinHint}</span></label>
        <input id="pin-login-pin-hidden" type="password" autocomplete="current-password"
               inputmode="numeric" placeholder="••••••" maxlength="${pinLength}"
               style="letter-spacing:0.3em; font-size:1.2em;" />
      </div>

      <div class="pin-login__dots" id="pin-login-dots" aria-live="polite"></div>

      <div class="keypad" id="pin-login-keypad"></div>

      <div id="pin-login-msg"></div>

      <button class="btn btn--full btn--lg" id="pin-login-submit" style="margin-top:var(--space-3);" disabled>${escapeHtml(submitLabel)}</button>
    </div>
  `;

  const staffIdInput = container.querySelector("#pin-login-staffid");
  const pinHiddenInput = container.querySelector("#pin-login-pin-hidden");
  const dotsEl = container.querySelector("#pin-login-dots");
  const keypadEl = container.querySelector("#pin-login-keypad");
  const msgEl = container.querySelector("#pin-login-msg");
  const submitBtn = container.querySelector("#pin-login-submit");

  // Touch devices: suppress the native keyboard on the hidden PIN
  // input (see isTouchDevice computed above). `inputmode="none"` is
  // the standard signal mobile browsers honor to hide the virtual
  // keyboard while keeping the field focusable and still able to
  // receive programmatic value updates — but it isn't honored by
  // every mobile browser/OS combination, so `readonly` is added as a
  // second, more universally-respected layer: it reliably blocks the
  // native keyboard from appearing on focus everywhere, while still
  // letting JS (the on-screen keypad, autofill, renderDots) set the
  // field's value normally. Only direct typing is blocked, which is
  // fine since typing isn't the intended input path on a touch device.
  if (isTouchDevice) {
    pinHiddenInput.setAttribute("inputmode", "none");
    pinHiddenInput.setAttribute("readonly", "readonly");
  }

  staffIdInput.addEventListener("input", (e) => {
    staffId = e.target.value;
    updateSubmitEnabled();
  });

  // Browser-autofill backstop: some browsers' saved-password autofill
  // sets an input's .value without firing a normal `input` event (or
  // fires it late, after the page is already interacted with), which
  // left `staffId`/`pin` stuck at their initial empty strings even
  // though the field visually showed the filled-in value — Enter
  // would then silently no-op since attemptSubmit() saw pin.length
  // !== pinLength, while clicking elsewhere (e.g. the Login button)
  // happened to flush the deferred event just before the click ran.
  // `change` fires reliably for autofill across browsers, so syncing
  // from it too closes that gap regardless of which event actually fires.
  staffIdInput.addEventListener("change", (e) => {
    staffId = e.target.value;
    updateSubmitEnabled();
  });

  // Hidden PIN input: allow direct keyboard entry of PIN digits
  pinHiddenInput.addEventListener("input", (e) => {
    // Strip non-digits and enforce length
    const digits = e.target.value.replace(/\D/g, "").slice(0, pinLength);
    pin = digits;
    // Keep the input value in sync (show only digits entered)
    e.target.value = digits;
    renderDots();
    updateSubmitEnabled();
  });

  pinHiddenInput.addEventListener("change", (e) => {
    const digits = e.target.value.replace(/\D/g, "").slice(0, pinLength);
    pin = digits;
    e.target.value = digits;
    renderDots();
    updateSubmitEnabled();
  });

  // One more autofill backstop: re-sync both fields whenever focus
  // leaves either of them (e.g. autofill fills both fields and the
  // user's next action is to tab to — or click — the Login button,
  // without ever typing a key that would have fired input/change).
  // This keeps the submit button's visual disabled state honest, on
  // top of attemptSubmit()'s own re-sync which guarantees Enter/click
  // work correctly regardless of whether this ever runs.
  function syncFromDomAndRefresh() {
    staffId = staffIdInput.value;
    pin = pinHiddenInput.value.replace(/\D/g, "").slice(0, pinLength);
    renderDots();
    updateSubmitEnabled();
  }
  staffIdInput.addEventListener("focusout", syncFromDomAndRefresh);
  pinHiddenInput.addEventListener("focusout", syncFromDomAndRefresh);

  // Tab from Staff ID moves focus to the hidden PIN input naturally

  renderDots();
  renderKeypad();
  updateSubmitEnabled();

  function renderDots() {
    dotsEl.innerHTML = Array.from({ length: pinLength })
      .map((_, i) => `<span class="pin-login__dot${i < pin.length ? " pin-login__dot--filled" : ""}"></span>`)
      .join("");
    // Keep the hidden input in sync with keypad presses
    if (pinHiddenInput) pinHiddenInput.value = pin;
  }

  function renderKeypad() {
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "✓"];
    keypadEl.innerHTML = keys
      .map((k) => {
        const isBackspace = k === "⌫";
        const isSubmitKey = k === "✓";
        const extraClass = isBackspace ? "keypad__key--backspace" : isSubmitKey ? "keypad__key--submit" : "";
        return `<button type="button" class="keypad__key ${extraClass}" data-key="${k}" aria-label="${isBackspace ? "Backspace" : isSubmitKey ? "Submit" : k}">${k}</button>`;
      })
      .join("");

    keypadEl.querySelectorAll(".keypad__key").forEach((btn) => {
      btn.addEventListener("click", () => handleKey(btn.dataset.key));
    });
  }

  // ── Keyboard support ──────────────────────────────────────────────
  // Allow digits 0-9, Backspace/Delete, and Enter/NumpadEnter so
  // users on a physical keyboard (desktop or Bluetooth) don't have
  // to tap the on-screen keypad.  We listen on the document so the
  // shortcut fires regardless of which element is focused, but we
  // only intercept digit keys when the Staff ID field is NOT focused
  // (otherwise the user couldn't type their staff ID freely).
  function handleKeyDown(e) {
    // Never intercept when a modifier key is held (browser shortcuts).
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const staffIdFocused = document.activeElement === staffIdInput;
    const pinInputFocused = document.activeElement === pinHiddenInput;

    if (e.key === "Backspace" || e.key === "Delete") {
      // Let the hidden PIN input handle its own backspace natively
      if (pinInputFocused) return;
      // Only eat the Backspace for the PIN when the Staff ID field is
      // NOT focused; otherwise let the browser handle normal text editing.
      if (!staffIdFocused) {
        e.preventDefault();
        handleKey("⌫");
      }
      return;
    }

    if (e.key === "Enter" || e.key === "NumpadEnter") {
      // Submit on Enter from anywhere (Staff ID field or keypad area).
      e.preventDefault();
      handleKey("✓");
      return;
    }

    // Digit keys — let the hidden PIN input handle them natively;
    // for other focused elements (or no focus), route through handleKey.
    if (pinInputFocused) return; // input event on pinHiddenInput handles it
    if (!staffIdFocused && /^[0-9]$/.test(e.key)) {
      e.preventDefault();
      handleKey(e.key);
    }
  }

  document.addEventListener("keydown", handleKeyDown);

  let _destroyed = false;
  function destroy() {
    if (_destroyed) return;
    _destroyed = true;
    document.removeEventListener("keydown", handleKeyDown);
    _observer.disconnect();
    if (countdownInterval) clearInterval(countdownInterval);
  }

  // Fallback safety net: also clean up if the container is ever
  // actually removed from the DOM (not just hidden via display:none).
  // Callers should still call destroy() explicitly after a successful
  // login — display:none does NOT detach the container, so this
  // observer alone is not sufficient (that was the original bug:
  // the global keydown listener kept stealing digit/backspace input
  // from every other input field in the app after login because the
  // login screen is only hidden, never removed).
  const _observer = new MutationObserver(() => {
    if (!document.contains(container)) destroy();
  });
  _observer.observe(document.body, { childList: true, subtree: true });
  // ─────────────────────────────────────────────────────────────────

  function handleKey(key) {
    if (submitting) return;
    if (key === "⌫") {
      pin = pin.slice(0, -1);
    } else if (key === "✓") {
      attemptSubmit();
      return;
    } else if (pin.length < pinLength) {
      pin += key;
    }
    renderDots();
    updateSubmitEnabled();
  }

  function updateSubmitEnabled() {
    submitBtn.disabled = submitting || !staffId.trim() || pin.length !== pinLength;
  }

  async function attemptSubmit() {
    // Final safety net, on top of the input/change listeners above:
    // re-read straight from the DOM right before checking anything,
    // in case a browser's autofill set these fields' values through a
    // path that never fired either event at all (rare, but seen on
    // some mobile browsers' saved-password autofill). This makes
    // Enter-to-submit and click-to-submit behave identically — no
    // more depending on whichever interaction happened to be the one
    // that "woke up" a stale value.
    staffId = staffIdInput.value;
    const digits = pinHiddenInput.value.replace(/\D/g, "").slice(0, pinLength);
    pin = digits;

    if (submitting || !staffId.trim() || pin.length !== pinLength) return;
    submitting = true;
    updateSubmitEnabled();
    keypadEl.classList.add("keypad--disabled");
    msgEl.innerHTML = "";

    try {
      await options.onSubmit({ staffId: staffId.trim(), pin });
      // On success, calling code is expected to navigate away; we
      // don't reset state here since the component is about to be
      // torn down by that navigation.
    } catch (err) {
      lastError = err.message || "Something went wrong. Please try again.";

      // P9: detect lockout message ("Try again in N minute(s)") and
      // start a live countdown so the user can see exactly when they
      // can try again without refreshing the page.
      const lockoutMatch = lastError.match(/Try again in (\d+) minute/);
      if (lockoutMatch) {
        const lockMs = parseInt(lockoutMatch[1], 10) * 60 * 1000;
        const unlockAt = Date.now() + lockMs;

        if (countdownInterval) clearInterval(countdownInterval);

        function renderLockout() {
          const remaining = Math.max(0, unlockAt - Date.now());
          const mins = Math.floor(remaining / 60000);
          const secs = Math.floor((remaining % 60000) / 1000);
          const timeStr = mins > 0
            ? `${mins}m ${String(secs).padStart(2, "0")}s`
            : `${secs}s`;

          msgEl.innerHTML = `
            <div class="msg msg--err" style="text-align:center;">
              <div style="font-size:1.1em; font-weight:600; margin-bottom:6px;">🔒 Account temporarily locked</div>
              <div style="font-size:0.9em;">Too many incorrect attempts.</div>
              <div style="font-size:1.5em; font-weight:700; margin:8px 0; letter-spacing:0.05em;">${timeStr}</div>
              <div style="font-size:0.85em; color:inherit; opacity:0.85;">Contact your admin if you've forgotten your PIN.</div>
            </div>
          `;

          if (remaining <= 0) {
            clearInterval(countdownInterval);
            countdownInterval = null;
            msgEl.innerHTML = `<div class="msg msg--warn" style="text-align:center;">You can try again now.</div>`;
          }
        }

        renderLockout();
        countdownInterval = setInterval(renderLockout, 1000);
      } else {
        msgEl.innerHTML = `<div class="msg msg--err">${escapeHtml(lastError)}</div>`;
      }

      pin = "";
      renderDots();
    } finally {
      submitting = false;
      keypadEl.classList.remove("keypad--disabled");
      updateSubmitEnabled();
    }
  }

  submitBtn.addEventListener("click", attemptSubmit);

  return { destroy };
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}
