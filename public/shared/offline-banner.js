// shared/offline-banner.js
//
// Offline indicator: inserts a fixed banner when navigator.onLine is
// false, auto-hides on reconnect. Works in both marker and admin apps.
// Call once per app shell (not per screen — it mounts itself on <body>).

export function mountOfflineBanner() {
  const BANNER_ID = "offline-banner";

  // Avoid double-mounting
  if (document.getElementById(BANNER_ID)) return;

  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.style.cssText = `
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 9999;
    background: #b45309;
    color: #fff;
    text-align: center;
    padding: 8px 16px;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: 0.01em;
    box-shadow: 0 2px 6px rgba(0,0,0,0.3);
    transition: opacity 0.3s ease;
  `;
  banner.textContent = "⚡ You're offline — changes will not save until reconnected.";
  document.body.prepend(banner);

  function update() {
    if (!navigator.onLine) {
      banner.style.display = "block";
      banner.style.opacity = "1";
      // Nudge body down so content isn't hidden under the banner
      document.body.style.paddingTop = "36px";
    } else {
      banner.style.opacity = "0";
      setTimeout(() => {
        banner.style.display = "none";
        document.body.style.paddingTop = "";
      }, 300);
    }
  }

  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update(); // Reflect current state immediately
}
