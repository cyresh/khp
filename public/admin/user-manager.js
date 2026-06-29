// admin/user-manager.js
//
// P8: Admin app — PIN & user management.
//
// Mounted by admin/app.js when the user taps "👥 Users" in the nav.
// Four sub-sections accessed via a sidebar:
//
//   📋 Marker List   — table of all users, edit + active toggle
//   ➕ Create Marker — form to create a new marker or admin
//   🔑 Reset PIN     — select a user, issue a new PIN
//   👤 My Profile    — current admin's details + change own PIN
//
// All auth operations delegate to shared/auth.js exports.
// Firestore reads use the db instance from shared/firebase-init.js.

import { db } from "../shared/firebase-init.js";
import {
  collection,
  getDocs,
  query,
  where,
  orderBy,
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  adminCreateUser,
  adminResetPin,
  setUserActive,
  changeOwnPin,
} from "../shared/auth.js";

// ----------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------

export function mountUserManager(container, currentUser, currentProfile) {
  let activeSection = "list";

  const sections = [
    { id: "list",    label: "📋 Marker List" },
    { id: "create",  label: "➕ Create Marker" },
    { id: "reset",   label: "🔑 Reset PIN" },
    { id: "profile", label: "👤 My Profile" },
  ];

  function render() {
    container.innerHTML = `
      <div class="page page--wide">
        <div class="db-layout">
          <nav class="db-sidenav">
            ${sections.map((s) => `
              <button class="db-sidenav__btn ${activeSection === s.id ? "db-sidenav__btn--active" : ""}"
                data-section="${s.id}">${s.label}</button>
            `).join("")}
          </nav>
          <div class="db-content" id="um-content">
            <p class="status">Loading…</p>
          </div>
        </div>
      </div>
    `;

    container.querySelectorAll(".db-sidenav__btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        activeSection = btn.dataset.section;
        render();
      });
    });

    const content = container.querySelector("#um-content");
    if (activeSection === "list")    mountListSection(content);
    if (activeSection === "create")  mountCreateSection(content);
    if (activeSection === "reset")   mountResetSection(content);
    if (activeSection === "profile") mountProfileSection(content, currentUser, currentProfile);
  }

  render();
}

// ================================================================
// SECTION: Marker List
// ================================================================

async function mountListSection(el) {
  el.innerHTML = `<p class="status">Loading users…</p>`;

  let users = [], buses = [], classes = [];
  try {
    const [usersResult, busSnap, classSnap] = await Promise.all([
      fetchAllActiveUsers(),
      getDocs(collection(db, "buses")),
      getDocs(collection(db, "classes")),
    ]);
    users = usersResult;
    busSnap.forEach((d) => buses.push({ id: d.id, ...d.data() }));
    buses.sort((a, b) => naturalSort(a.id, b.id));
    classSnap.forEach((d) => classes.push({ id: d.id, ...d.data() }));
    classes.sort((a, b) => naturalSort(a.id, b.id));
  } catch (err) {
    el.innerHTML = `<div class="msg msg--err">${escapeHtml(err.message)}</div>`;
    return;
  }

  renderList(el, users, null, buses, classes);
}

function renderList(el, users, editingUid = null, buses = [], classes = []) {
  el.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:var(--space-4); flex-wrap:wrap; gap:var(--space-3);">
      <h2 style="margin:0;">Marker List</h2>
      <input type="search" id="um-search" class="report-controls__input" placeholder="Search name or staff ID…"
        style="max-width:240px;" />
    </div>

    <div id="um-list-wrap">
      ${renderUserTable(users, editingUid, buses, classes)}
    </div>
  `;

  const searchEl = el.querySelector("#um-search");
  const wrapEl   = el.querySelector("#um-list-wrap");

  searchEl.addEventListener("input", () => {
    const q = searchEl.value.trim().toLowerCase();
    const filtered = q
      ? users.filter((u) =>
          u.name?.toLowerCase().includes(q) ||
          u.staffId?.toLowerCase().includes(q)
        )
      : users;
    wrapEl.innerHTML = renderUserTable(filtered, editingUid, buses, classes);
    attachListHandlers(el, users, buses, classes);
  });

  attachListHandlers(el, users, buses, classes);
}

// Labels for each section header
const SECTION_LABELS = {
  active_admin:  "Admins",
  active_bus:    "Bus Markers",
  active_hostel: "Hostel Markers",
  active_class:  "Class Markers",
  active_other:  "Other",
  inactive:      "Deactivated",
};

function sectionKey(u) {
  if (u.active === false) return "inactive";
  const cat = u.category || "other";
  return `active_${cat}`;
}

function renderUserTable(users, editingUid, buses = [], classes = []) {
  if (!users.length) {
    return `<div class="msg msg--warn">No users found.</div>`;
  }

  const activeUsers   = users.filter(u => u.active !== false);
  const inactiveUsers = users.filter(u => u.active === false);

  let lastSection = null;
  const activeRows = activeUsers.map((u) => {
    const sec = sectionKey(u);
    let header = "";
    if (sec !== lastSection) {
      lastSection = sec;
      const label = SECTION_LABELS[sec] || capitalize(sec);
      header = `
        <tr class="um-section-header">
          <td colspan="7" style="
            padding: 6px 12px 4px;
            font-size: 0.72em;
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--color-primary, #c0392b);
            background: var(--color-primary-bg, #fdf3f2);
            border-top: 2px solid var(--color-primary, #c0392b);
          ">${escapeHtml(label)}</td>
        </tr>`;
    }
    const row = editingUid === u.uid
      ? renderEditRow(u, buses, classes)
      : renderDisplayRow(u);
    return header + row;
  }).join("");

  const inactiveRows = inactiveUsers.map((u) =>
    editingUid === u.uid
      ? renderEditRow(u, buses, classes)
      : renderDisplayRow(u)
  ).join("");

  const inactiveCount = inactiveUsers.length;
  const inactiveSection = inactiveCount === 0 ? "" : `
    <tbody>
      <tr class="um-section-header um-deactivated-toggle" style="cursor:pointer;" onclick="
        var tb = this.closest('table').querySelector('.um-deactivated-body');
        var icon = this.querySelector('.um-toggle-icon');
        var hidden = tb.style.display === 'none';
        tb.style.display = hidden ? '' : 'none';
        icon.textContent = hidden ? '\u25b2' : '\u25bc';
      ">
        <td colspan="7" style="
          padding: 6px 12px 4px;
          font-size: 0.72em;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--color-text-muted, #999);
          background: var(--color-surface-raised, #f5f5f5);
          border-top: 2px solid var(--color-border, #ddd);
          user-select: none;
        ">Deactivated (${inactiveCount}) <span class="um-toggle-icon" style="font-size:0.85em;">\u25bc</span></td>
      </tr>
    </tbody>
    <tbody class="um-deactivated-body" style="display:none;">
      ${inactiveRows}
    </tbody>`;

  return `
    <div class="student-table-wrap">
      <table class="summary-table user-manager-table">
        <thead>
          <tr>
            <th style="vertical-align:middle;">Name</th>
            <th style="vertical-align:middle;">Staff ID</th>
            <th style="vertical-align:middle;">Category</th>
            <th style="vertical-align:middle;">Scope(s)</th>
            <th style="vertical-align:middle;">Role</th>
            <th style="vertical-align:middle;">Status</th>
            <th style="vertical-align:middle;">Actions</th>
          </tr>
        </thead>
        <tbody>${activeRows}</tbody>
        ${inactiveSection}
      </table>
    </div>
  `;
}

function renderDisplayRow(u) {
  const isActive = u.active !== false;
  return `
    <tr data-uid="${escapeHtml(u.uid)}" class="${isActive ? "" : "row--inactive"}">
      <td style="vertical-align:middle;">${escapeHtml(u.name || "—")}</td>
      <td style="vertical-align:middle;"><code>${escapeHtml(u.staffId || "—")}</code></td>
      <td style="vertical-align:middle;">${escapeHtml(capitalize(u.category || "—"))}</td>
      <td style="vertical-align:middle; white-space:normal; min-width:140px; max-width:220px;">
        <div style="display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4;">${escapeHtml(formatScopes(u.scopeIds))}</div>
      </td>
      <td style="vertical-align:middle;"><span class="role-badge role-badge--${u.role}">${escapeHtml(capitalize(u.role || "marker"))}</span></td>
      <td style="vertical-align:middle;">
        <label class="toggle-wrap" title="${isActive ? "Active — click to deactivate" : "Inactive — click to reactivate"}">
          <input type="checkbox" class="toggle-active" data-staffid="${escapeHtml(u.staffId)}" data-uid="${escapeHtml(u.uid)}"
            ${isActive ? "checked" : ""} />
          <span class="toggle-label">${isActive ? "Active" : "Inactive"}</span>
        </label>
      </td>
      <td style="white-space:nowrap; vertical-align:middle;">
        <button class="btn btn--sm btn-edit-user" data-uid="${escapeHtml(u.uid)}">Edit</button>
      </td>
    </tr>
  `;
}

function renderEditRow(u, buses = [], classes = []) {
  const cat = u.category || "bus";
  const isAdmin = cat === "admin";

  function scopeCheckboxes(category) {
    if (category === "admin") return "";
    if (category === "bus") {
      return buses.map((b) => {
        const label = `Bus ${b.id.replace(/^bus_/, "")}${b.name ? ` — ${b.name}` : ""}`;
        const checked = (u.scopeIds || []).includes(b.id) ? "checked" : "";
        return `<label class="scope-check-label" style="display:inline-flex;align-items:center;gap:4px;margin-right:8px;font-size:0.85em;">
          <input type="checkbox" class="edit-scope-chk" value="${escapeHtml(b.id)}" ${checked} />
          ${escapeHtml(label)}
        </label>`;
      }).join("") || `<span class="status">No buses configured.</span>`;
    }
    if (category === "hostel") {
      const checked = (u.scopeIds || []).includes("hostel_main") ? "checked" : "";
      return `<label class="scope-check-label" style="display:inline-flex;align-items:center;gap:4px;font-size:0.85em;">
        <input type="checkbox" class="edit-scope-chk" value="hostel_main" ${checked} />
        Hostel (Main)
      </label>`;
    }
    if (category === "class") {
      return classes.map((c) => {
        const label = c.id.replace(/^class_/, "").replace(/_/g, " ");
        const checked = (u.scopeIds || []).includes(c.id) ? "checked" : "";
        return `<label class="scope-check-label" style="display:inline-flex;align-items:center;gap:4px;margin-right:8px;font-size:0.85em;">
          <input type="checkbox" class="edit-scope-chk" value="${escapeHtml(c.id)}" ${checked} />
          ${escapeHtml(label)}
        </label>`;
      }).join("") || `<span class="status">No classes configured.</span>`;
    }
    return "";
  }

  return `
    <tr data-uid="${escapeHtml(u.uid)}" class="row--editing" style="vertical-align:top;">
      <td style="min-width:120px;">
        <input type="text" class="edit-name report-controls__input" value="${escapeHtml(u.name || "")}" style="width:100%;" />
      </td>
      <td><code>${escapeHtml(u.staffId || "—")}</code></td>
      <td style="min-width:110px;">
        <select class="edit-category report-controls__input" style="width:100%;">
          <option value="bus"    ${cat === "bus"    ? "selected" : ""}>Bus</option>
          <option value="hostel" ${cat === "hostel" ? "selected" : ""}>Hostel</option>
          <option value="class"  ${cat === "class"  ? "selected" : ""}>Class</option>
          <option value="admin"  ${cat === "admin"  ? "selected" : ""}>Admin</option>
        </select>
      </td>
      <td style="min-width:160px; max-width:280px;">
        <div class="edit-scope-wrap" style="flex-wrap:wrap;gap:4px;padding:4px 0;${isAdmin ? "display:none;" : "display:flex;"}">
          ${scopeCheckboxes(cat)}
        </div>
        <span class="edit-scope-none" style="${isAdmin ? "" : "display:none;"}color:var(--color-text-muted);font-size:0.85em;">—</span>
      </td>
      <td style="min-width:90px;">
        <select class="edit-role report-controls__input" style="width:100%;">
          <option value="marker"  ${u.role === "marker"  ? "selected" : ""}>Marker</option>
          <option value="manager" ${u.role === "manager" ? "selected" : ""}>Manager</option>
          <option value="admin"   ${u.role === "admin"   ? "selected" : ""}>Admin</option>
        </select>
      </td>
      <td>—</td>
      <td style="white-space:nowrap; vertical-align:top; padding-top:8px;">
        <button class="btn btn--sm btn-save-user" data-uid="${escapeHtml(u.uid)}" data-staffid="${escapeHtml(u.staffId)}">Save</button>
        <button class="btn btn--sm btn--secondary btn-cancel-edit" style="margin-left:4px;">Cancel</button>
      </td>
    </tr>
    <tr class="row--edit-footer" data-for-uid="${escapeHtml(u.uid)}" style="background:var(--color-surface-raised, #fafafa);">
      <td colspan="7" style="padding:2px var(--space-4, 16px) 6px; border-top:none;">
        <span class="edit-err msg msg--err" style="display:none;"></span>
        <span class="edit-dirty-hint" style="display:none; font-size:0.8em; color:var(--color-text-muted, #888);">● Unsaved changes</span>
      </td>
    </tr>
  `;
}

function attachListHandlers(el, allUsers, buses = [], classes = []) {
  // ── helpers scoped to this handler attach ──────────────────────
  function getFooterRow(uid) {
    return el.querySelector(`.row--edit-footer[data-for-uid="${uid}"]`);
  }
  function getErrEl(uid) {
    const f = getFooterRow(uid);
    return f ? f.querySelector(".edit-err") : null;
  }
  function getDirtyHint(uid) {
    const f = getFooterRow(uid);
    return f ? f.querySelector(".edit-dirty-hint") : null;
  }
  function markDirty(uid) {
    const hint = getDirtyHint(uid);
    if (hint) hint.style.display = "";
    // highlight the edit row itself
    const editRow = el.querySelector(`tr.row--editing[data-uid="${uid}"]`);
    if (editRow) editRow.style.outline = "2px solid var(--color-warning, #f5a623)";
  }
  function clearDirty(uid) {
    const hint = getDirtyHint(uid);
    if (hint) hint.style.display = "none";
    const editRow = el.querySelector(`tr.row--editing[data-uid="${uid}"]`);
    if (editRow) editRow.style.outline = "";
  }
  function snapshotRow(uid) {
    const row = el.querySelector(`tr.row--editing[data-uid="${uid}"]`);
    if (!row) return null;
    return {
      name: row.querySelector(".edit-name")?.value ?? "",
      role: row.querySelector(".edit-role")?.value ?? "",
      category: row.querySelector(".edit-category")?.value ?? "",
      scopes: Array.from(row.querySelectorAll(".edit-scope-chk:checked")).map(c => c.value).sort().join(","),
    };
  }

  // Edit buttons — capture initial snapshot for dirty detection
  el.querySelectorAll(".btn-edit-user").forEach((btn) => {
    btn.addEventListener("click", () => {
      const uid = btn.dataset.uid;
      renderList(el, allUsers, uid, buses, classes);
    });
  });

  // Cancel edit — guard if dirty
  el.querySelectorAll(".btn-cancel-edit").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest("tr");
      const uid = row.dataset.uid;
      const hint = getDirtyHint(uid);
      const isDirty = hint && hint.style.display !== "none";
      if (isDirty) {
        if (!confirm("You have unsaved changes. Discard them?")) return;
      }
      renderList(el, allUsers, null, buses, classes);
    });
  });

  // Attach dirty-detection listeners to all editable fields in the edit row
  el.querySelectorAll("tr.row--editing").forEach((row) => {
    const uid = row.dataset.uid;
    const u = allUsers.find((x) => x.uid === uid);
    if (!u) return;
    const initial = {
      name: u.name || "",
      role: u.role || "marker",
      category: u.category || "bus",
      scopes: (u.scopeIds || []).slice().sort().join(","),
    };

    function checkDirty() {
      const current = snapshotRow(uid);
      if (!current) return;
      const dirty =
        current.name !== initial.name ||
        current.role !== initial.role ||
        current.category !== initial.category ||
        current.scopes !== initial.scopes;
      if (dirty) markDirty(uid);
      else clearDirty(uid);
    }

    row.querySelector(".edit-name")?.addEventListener("input", checkDirty);
    row.querySelector(".edit-role")?.addEventListener("change", checkDirty);
    row.querySelector(".edit-category")?.addEventListener("change", checkDirty);
    // scope checkboxes: delegate on the row since wrap may be re-rendered on category change
    row.addEventListener("change", (e) => {
      if (e.target.classList.contains("edit-scope-chk")) checkDirty();
    });
  });

  // Category change → refresh scope checkboxes inline
  el.querySelectorAll(".edit-category").forEach((catEl) => {
    catEl.addEventListener("change", () => {
      const row = catEl.closest("tr");
      const uid = row.dataset.uid;
      const user = allUsers.find((x) => x.uid === uid);
      const newCat = catEl.value;
      const scopeWrap = row.querySelector(".edit-scope-wrap");
      const scopeNone = row.querySelector(".edit-scope-none");
      const roleEl = row.querySelector(".edit-role");

      // Sync role when admin category chosen
      if (newCat === "admin") {
        roleEl.value = "admin";
        scopeWrap.style.display = "none";
        scopeNone.style.display = "";
      } else {
        scopeWrap.style.display = "";
        scopeNone.style.display = "none";
        // Rebuild checkboxes for new category (no pre-selection since category changed)
        let html = "";
        if (newCat === "bus") {
          html = buses.map((b) => {
            const label = `Bus ${b.id.replace(/^bus_/, "")}${b.name ? ` — ${b.name}` : ""}`;
            return `<label class="scope-check-label" style="display:inline-flex;align-items:center;gap:4px;margin-right:8px;font-size:0.85em;">
              <input type="checkbox" class="edit-scope-chk" value="${escapeHtml(b.id)}" />
              ${escapeHtml(label)}
            </label>`;
          }).join("") || `<span class="status">No buses configured.</span>`;
        } else if (newCat === "hostel") {
          html = `<label class="scope-check-label" style="display:inline-flex;align-items:center;gap:4px;font-size:0.85em;">
            <input type="checkbox" class="edit-scope-chk" value="hostel_main" />
            Hostel (Main)
          </label>`;
        } else if (newCat === "class") {
          html = classes.map((c) => {
            const label = c.id.replace(/^class_/, "").replace(/_/g, " ");
            return `<label class="scope-check-label" style="display:inline-flex;align-items:center;gap:4px;margin-right:8px;font-size:0.85em;">
              <input type="checkbox" class="edit-scope-chk" value="${escapeHtml(c.id)}" />
              ${escapeHtml(label)}
            </label>`;
          }).join("") || `<span class="status">No classes configured.</span>`;
        }
        scopeWrap.innerHTML = html;
      }
    });
  });

  // Save edits (name + role + category + scopeIds)
  el.querySelectorAll(".btn-save-user").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row   = btn.closest("tr");
      const uid   = btn.dataset.uid;
      const errEl = getErrEl(uid);
      const nameEl = row.querySelector(".edit-name");
      const roleEl = row.querySelector(".edit-role");
      const catEl  = row.querySelector(".edit-category");
      const name     = nameEl.value.trim();
      const role     = roleEl.value;
      const category = catEl.value;

      const scopeIds = category === "admin"
        ? []
        : Array.from(row.querySelectorAll(".edit-scope-chk:checked")).map((c) => c.value);

      if (errEl) hideMsg(errEl);

      if (!name) {
        if (errEl) showErr(errEl, "Name cannot be empty.");
        nameEl.focus();
        return;
      }
      if (category !== "admin" && scopeIds.length === 0) {
        if (errEl) showErr(errEl, "Select at least one scope.");
        return;
      }

      await withLoadingBtn(btn, "Saving…", async () => {
        try {
          const { updateDoc, doc: firestoreDoc } = await import(
            "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
          );
          await updateDoc(firestoreDoc(db, "users", uid), { name, role, category, scopeIds });
          // Patch local list
          const u = allUsers.find((x) => x.uid === uid);
          if (u) { u.name = name; u.role = role; u.category = category; u.scopeIds = scopeIds; }
          clearDirty(uid);
          // Brief success flash before collapsing back to display row
          row.style.background = "var(--color-success-bg, #edfdf0)";
          row.style.transition = "background 0.6s";
          await new Promise((r) => setTimeout(r, 600));
          renderList(el, allUsers, null, buses, classes);
        } catch (err) {
          if (errEl) showErr(errEl, err.message);
        }
      });
    });
  });

  // Active toggles
  el.querySelectorAll(".toggle-active").forEach((chk) => {
    chk.addEventListener("change", async () => {
      const { staffId, uid } = chk.dataset;
      const active = chk.checked;
      const label = chk.nextElementSibling;
      chk.disabled = true;
      try {
        await setUserActive(staffId, active, uid);
        label.textContent = active ? "Active" : "Inactive";
        const u = allUsers.find((x) => x.staffId === staffId);
        if (u) u.active = active;
        const row = chk.closest("tr");
        if (active) row.classList.remove("row--inactive");
        else        row.classList.add("row--inactive");
      } catch (err) {
        // Revert checkbox AND label together so the row never shows a
        // mismatched state (e.g. unchecked box still labeled "Active").
        chk.checked = !active;
        label.textContent = !active ? "Active" : "Inactive";
        alert("Error: " + err.message);
      } finally {
        chk.disabled = false;
      }
    });
  });
}

// ================================================================
// SECTION: Create Marker
// ================================================================

async function mountCreateSection(el) {
  el.innerHTML = `<p class="status">Loading scopes…</p>`;

  let buses = [], classes = [];
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
    el.innerHTML = `<div class="msg msg--err">${escapeHtml(err.message)}</div>`;
    return;
  }

  renderCreateForm(el, buses, classes);
}

function renderCreateForm(el, buses, classes, prefill = {}) {
  const selectedCategory = prefill.category || "bus";

  const scopeOptions = buildScopeOptions(selectedCategory, buses, classes, prefill.scopeIds || []);
  const pinLen = 6;

  el.innerHTML = `
    <h2 style="margin-bottom:var(--space-4);">Create Marker / Admin</h2>

    <div class="card" style="max-width:520px;">
      <div class="form-field">
        <label class="form-label">Full Name *</label>
        <input type="text" id="cf-name" class="report-controls__input" value="${escapeHtml(prefill.name || "")}"
          placeholder="e.g. Rajesh Kumar" autocomplete="off" />
      </div>

      <div class="form-field">
        <label class="form-label">Staff ID *</label>
        <input type="text" id="cf-staffid" class="report-controls__input" value="${escapeHtml(prefill.staffId || "")}"
          placeholder="e.g. staff123" autocomplete="off" />
        <div class="form-hint">Letters, numbers, dots, hyphens only. Cannot be changed later.</div>
      </div>

      <div class="form-field">
        <label class="form-label">Role *</label>
        <select id="cf-role" class="report-controls__input">
          <option value="marker">Marker</option>
          <option value="manager">Manager</option>
          <option value="admin">Admin</option>
        </select>
      </div>

      <div class="form-field" id="cf-category-wrap">
        <label class="form-label">Category *</label>
        <select id="cf-category" class="report-controls__input">
          <option value="bus"    ${selectedCategory === "bus"    ? "selected" : ""}>Bus</option>
          <option value="hostel" ${selectedCategory === "hostel" ? "selected" : ""}>Hostel</option>
          <option value="class"  ${selectedCategory === "class"  ? "selected" : ""}>Class</option>
          <option value="admin"  ${selectedCategory === "admin"  ? "selected" : ""}>Admin (no scope)</option>
        </select>
      </div>

      <div class="form-field" id="cf-scope-wrap" ${selectedCategory === "admin" ? 'style="display:none;"' : ""}>
        <label class="form-label">Scope(s) *</label>
        <div id="cf-scope-list" class="scope-checklist">
          ${scopeOptions}
        </div>
        <div class="form-hint">Select all scopes this marker covers.</div>
      </div>

      <div class="form-field">
        <label class="form-label">PIN <span id="cf-pin-hint">(${pinLen}-digit)</span> *</label>
        <div class="pin-row">
          <input type="text" id="cf-pin" class="report-controls__input pin-input"
            maxlength="${pinLen}" inputmode="numeric" pattern="[0-9]*"
            placeholder="${"•".repeat(pinLen)}" autocomplete="off" />
          <button type="button" class="btn btn--secondary" id="cf-gen-pin">Generate</button>
        </div>
        <div class="form-hint" id="cf-pin-hint-msg">6 digits, for every role.</div>
      </div>

      <div id="cf-err" class="msg msg--err" style="display:none; margin-top:var(--space-3);"></div>
      <div id="cf-ok"  class="msg msg--ok"  style="display:none; margin-top:var(--space-3);"></div>

      <div style="margin-top:var(--space-4); display:flex; gap:var(--space-3);">
        <button class="btn" id="cf-submit">Create User</button>
        <button class="btn btn--secondary" id="cf-clear">Clear</button>
      </div>
    </div>
  `;

  const nameEl     = el.querySelector("#cf-name");
  const staffIdEl  = el.querySelector("#cf-staffid");
  const roleEl     = el.querySelector("#cf-role");
  const categoryEl = el.querySelector("#cf-category");
  const scopeWrap  = el.querySelector("#cf-scope-wrap");
  const scopeList  = el.querySelector("#cf-scope-list");
  const pinEl      = el.querySelector("#cf-pin");
  const pinHint    = el.querySelector("#cf-pin-hint");
  const genBtn     = el.querySelector("#cf-gen-pin");
  const submitBtn  = el.querySelector("#cf-submit");
  const clearBtn   = el.querySelector("#cf-clear");
  const errEl      = el.querySelector("#cf-err");
  const okEl       = el.querySelector("#cf-ok");

  function currentPinLen() {
    return 6;
  }

  function updatePinLen() {
    const len = currentPinLen();
    pinEl.maxLength = len;
    pinHint.textContent = `(${len}-digit)`;
    if (pinEl.value.length > len) pinEl.value = pinEl.value.slice(0, len);
  }

  const categoryWrap = el.querySelector("#cf-category-wrap");

  function updateScopeVisibility() {
    const cat  = categoryEl.value;
    const role = roleEl.value;
    const isManager = role === "manager";
    const isAdmin   = cat === "admin" || role === "admin";

    // Manager: hide both category and scope fields
    if (categoryWrap) categoryWrap.style.display = isManager ? "none" : "";
    if (isManager || isAdmin) {
      scopeWrap.style.display = "none";
    } else {
      scopeWrap.style.display = "";
      scopeList.innerHTML = buildScopeOptions(cat, buses, classes, []);
    }
    // Sync category to admin when admin role chosen
    if (role === "admin") categoryEl.value = "admin";
    updatePinLen();
  }

  roleEl.addEventListener("change", () => {
    updateScopeVisibility();
  });

  categoryEl.addEventListener("change", updateScopeVisibility);

  genBtn.addEventListener("click", () => {
    const len = currentPinLen();
    pinEl.value = generatePin(len);
  });

  pinEl.addEventListener("input", () => {
    pinEl.value = pinEl.value.replace(/\D/g, "").slice(0, currentPinLen());
  });

  clearBtn.addEventListener("click", () => renderCreateForm(el, buses, classes));

  submitBtn.addEventListener("click", async () => {
    hideMsg(errEl); hideMsg(okEl);

    const name    = nameEl.value.trim();
    const staffId = staffIdEl.value.trim();
    const role    = roleEl.value;
    const pin     = pinEl.value.trim();
    const len     = currentPinLen();

    const isManagerRole = role === "manager";
    const category = isManagerRole ? "admin" : (categoryEl.value === "admin" ? "admin" : categoryEl.value);
    const scopeIds = (category === "admin")
      ? []
      : Array.from(el.querySelectorAll(".cf-scope-chk:checked")).map((c) => c.value);

    // Validate
    if (!name)    return showErr(errEl, "Name is required.");
    if (!staffId) return showErr(errEl, "Staff ID is required.");
    if (!/^[a-z0-9._-]+$/i.test(staffId)) return showErr(errEl, "Staff ID can only contain letters, numbers, dots, hyphens.");
    if (category !== "admin" && !scopeIds.length) return showErr(errEl, "Select at least one scope.");
    if (!/^\d+$/.test(pin) || pin.length !== len) return showErr(errEl, `PIN must be exactly ${len} digits.`);

    await withLoadingBtn(submitBtn, "Creating…", async () => {
      try {
        await adminCreateUser({ name, staffId, category, scopeIds, pin, role });
        showMsg(okEl, `✅ User "${name}" (${staffId}) created successfully.`);
        renderCreateForm(el, buses, classes);
      } catch (err) {
        showErr(errEl, err.message);
      }
    });
  });
}

function buildScopeOptions(category, buses, classes, selected = []) {
  if (category === "admin") return "";
  if (category === "bus") {
    return buses.map((b) => {
      const label = `Bus ${b.id.replace(/^bus_/, "")}${b.name ? ` — ${b.name}` : ""}`;
      return checkItem(b.id, label, selected.includes(b.id));
    }).join("") || `<p class="status">No buses configured.</p>`;
  }
  if (category === "hostel") {
    return checkItem("hostel_main", "Hostel (Main)", selected.includes("hostel_main"));
  }
  if (category === "class") {
    return classes.map((c) => {
      const label = c.id.replace(/^class_/, "").replace(/_/g, " ");
      return checkItem(c.id, label, selected.includes(c.id));
    }).join("") || `<p class="status">No classes configured.</p>`;
  }
  return "";
}

function checkItem(value, label, checked) {
  return `
    <label class="scope-check-label">
      <input type="checkbox" class="cf-scope-chk" value="${escapeHtml(value)}" ${checked ? "checked" : ""} />
      ${escapeHtml(label)}
    </label>
  `;
}

// ================================================================
// SECTION: Reset PIN
// ================================================================

async function mountResetSection(el) {
  el.innerHTML = `<p class="status">Loading users…</p>`;

  let users = [];
  try {
    users = await fetchAllActiveUsers();
  } catch (err) {
    el.innerHTML = `<div class="msg msg--err">${escapeHtml(err.message)}</div>`;
    return;
  }

  renderResetForm(el, users);
}

function renderResetForm(el, users, selectedStaffId = "") {
  const activeUsers = users.filter(u => u.active !== false);

  // Group and sort users: Admins → Managers → Markers (sub-grouped by category)
  function sortById(a, b) { return (a.staffId || "").localeCompare(b.staffId || ""); }
  const admins   = activeUsers.filter(u => u.role === "admin").sort(sortById);
  const managers = activeUsers.filter(u => u.role === "manager").sort(sortById);
  const markers  = activeUsers.filter(u => u.role === "marker" || !u.role);
  const markerCatOrder = ["bus", "class", "hostel", "other"];
  const markerCatLabel = { bus: "🚌 Bus Markers", class: "🎓 Class Markers", hostel: "🏠 Hostel Markers", other: "Markers" };
  const markersBycat = {};
  markers.forEach(u => {
    const cat = u.category || "other";
    const key = markerCatOrder.includes(cat) ? cat : "other";
    if (!markersBycat[key]) markersBycat[key] = [];
    markersBycat[key].push(u);
  });
  markerCatOrder.forEach(k => { if (markersBycat[k]) markersBycat[k].sort(sortById); });

  function opt(u) {
    return `<option value="${escapeHtml(u.staffId)}" data-role="${escapeHtml(u.role || "marker")}"
      ${selectedStaffId === u.staffId ? "selected" : ""}>
      ${escapeHtml(u.staffId)} — ${escapeHtml(u.name)}
    </option>`;
  }

  const adminGroup   = admins.length   ? `<optgroup label="⚙️ Admins">${admins.map(opt).join("")}</optgroup>` : "";
  const managerGroup = managers.length ? `<optgroup label="👔 Managers">${managers.map(opt).join("")}</optgroup>` : "";
  const markerGroups = markerCatOrder
    .filter(k => markersBycat[k]?.length)
    .map(k => `<optgroup label="${markerCatLabel[k]}">${markersBycat[k].map(opt).join("")}</optgroup>`)
    .join("");

  el.innerHTML = `
    <h2 style="margin-bottom:var(--space-4);">Reset PIN</h2>
    <div class="msg msg--warn" style="margin-bottom:var(--space-4);">
      ⚠ This will invalidate the user's current PIN immediately. They will need the new PIN to log in next time.
    </div>

    <div class="card" style="max-width:460px;">
      <div class="form-field">
        <label class="form-label">Select User *</label>
        <select id="rp-user" class="report-controls__input" size="1">
          <option value="">— choose a user —</option>
          ${adminGroup}${managerGroup}${markerGroups}
        </select>
      </div>

      <div class="form-field">
        <label class="form-label">New PIN <span id="rp-pin-hint">(6-digit)</span> *</label>
        <div class="pin-row">
          <input type="text" id="rp-pin" class="report-controls__input pin-input"
            maxlength="6" inputmode="numeric" pattern="[0-9]*"
            placeholder="••••" autocomplete="off" />
          <button type="button" class="btn btn--secondary" id="rp-gen">Generate</button>
        </div>
      </div>

      <div id="rp-new-pin-display" class="pin-display" style="display:none;"></div>

      <div id="rp-err" class="msg msg--err" style="display:none; margin-top:var(--space-3);"></div>
      <div id="rp-ok"  class="msg msg--ok"  style="display:none; margin-top:var(--space-3);"></div>

      <button class="btn" id="rp-submit" style="margin-top:var(--space-4);">Reset PIN</button>
    </div>
  `;

  const userEl    = el.querySelector("#rp-user");
  const pinEl     = el.querySelector("#rp-pin");
  const pinHint   = el.querySelector("#rp-pin-hint");
  const genBtn    = el.querySelector("#rp-gen");
  const submitBtn = el.querySelector("#rp-submit");
  const errEl     = el.querySelector("#rp-err");
  const okEl      = el.querySelector("#rp-ok");
  const pinDisplay = el.querySelector("#rp-new-pin-display");

  function selectedRole() {
    const opt = userEl.selectedOptions[0];
    return opt ? opt.dataset.role : "marker";
  }

  function currentPinLen() {
    return 6;
  }

  function updatePinHint() {
    const len = currentPinLen();
    pinHint.textContent = `(${len}-digit)`;
    pinEl.maxLength = len;
  }

  userEl.addEventListener("change", () => {
    hideMsg(errEl); hideMsg(okEl);
    pinDisplay.style.display = "none";
    updatePinHint();
  });

  if (selectedStaffId) updatePinHint();

  pinEl.addEventListener("input", () => {
    pinEl.value = pinEl.value.replace(/\D/g, "").slice(0, currentPinLen());
  });

  genBtn.addEventListener("click", () => {
    const pin = generatePin(currentPinLen());
    pinEl.value = pin;
  });

  submitBtn.addEventListener("click", async () => {
    hideMsg(errEl); hideMsg(okEl);
    pinDisplay.style.display = "none";

    const staffId = userEl.value;
    const pin     = pinEl.value.trim();
    const len     = currentPinLen();

    if (!staffId) return showErr(errEl, "Please select a user.");
    if (!/^\d+$/.test(pin) || pin.length !== len) return showErr(errEl, `PIN must be exactly ${len} digits.`);

    await withLoadingBtn(submitBtn, "Resetting…", async () => {
      try {
        await adminResetPin(staffId, pin);
        const userName = userEl.selectedOptions[0]?.text?.split(" (")[0] || staffId;
        showMsg(okEl, `✅ PIN reset for ${escapeHtml(userName)}.`);
        pinDisplay.innerHTML = `
          <div style="margin-top:var(--space-3); padding:var(--space-3); background:var(--color-surface-raised);
            border:2px dashed var(--color-border); border-radius:var(--radius-md); text-align:center;">
            <div class="status" style="margin:0 0 4px;">New PIN for ${escapeHtml(userName)}</div>
            <div style="font-size:var(--font-size-2xl); font-weight:700; letter-spacing:0.2em; font-family:monospace;">${escapeHtml(pin)}</div>
            <div class="status" style="margin:4px 0 0; font-size:var(--font-size-sm);">Share securely then dismiss</div>
          </div>
        `;
        pinDisplay.style.display = "";
        pinEl.value = "";
      } catch (err) {
        showErr(errEl, err.message);
      }
    });
  });
}

// ================================================================
// SECTION: My Profile
// ================================================================

function mountProfileSection(el, currentUser, currentProfile) {
  el.innerHTML = `
    <h2 style="margin-bottom:var(--space-4);">My Profile</h2>

    <div class="card" style="max-width:460px; margin-bottom:var(--space-4);">
      <div class="profile-row">
        <span class="form-label" style="margin:0;">Name</span>
        <span>${escapeHtml(currentProfile?.name || "—")}</span>
      </div>
      <div class="profile-row">
        <span class="form-label" style="margin:0;">Staff ID</span>
        <code>${escapeHtml(currentProfile?.staffId || "—")}</code>
      </div>
      <div class="profile-row">
        <span class="form-label" style="margin:0;">Role</span>
        <span class="role-badge role-badge--admin">Admin</span>
      </div>
    </div>

    <div class="card" style="max-width:460px;">
      <h3 style="margin:0 0 var(--space-4);">Change My PIN</h3>

      <div class="form-field">
        <label class="form-label">Current PIN (6-digit) *</label>
        <input type="password" id="mp-current" class="report-controls__input pin-input"
          maxlength="6" inputmode="numeric" placeholder="••••••" autocomplete="current-password" />
      </div>

      <div class="form-field">
        <label class="form-label">New PIN (6-digit) *</label>
        <div class="pin-row">
          <input type="text" id="mp-new" class="report-controls__input pin-input"
            maxlength="6" inputmode="numeric" placeholder="••••••" autocomplete="new-password" />
          <button type="button" class="btn btn--secondary" id="mp-gen">Generate</button>
        </div>
      </div>

      <div class="form-field">
        <label class="form-label">Confirm New PIN *</label>
        <input type="text" id="mp-confirm" class="report-controls__input pin-input"
          maxlength="6" inputmode="numeric" placeholder="••••••" autocomplete="new-password" />
      </div>

      <div id="mp-err" class="msg msg--err" style="display:none; margin-top:var(--space-3);"></div>
      <div id="mp-ok"  class="msg msg--ok"  style="display:none; margin-top:var(--space-3);"></div>

      <button class="btn" id="mp-submit" style="margin-top:var(--space-4);">Update PIN</button>
    </div>
  `;

  const currentEl = el.querySelector("#mp-current");
  const newEl     = el.querySelector("#mp-new");
  const confirmEl = el.querySelector("#mp-confirm");
  const genBtn    = el.querySelector("#mp-gen");
  const submitBtn = el.querySelector("#mp-submit");
  const errEl     = el.querySelector("#mp-err");
  const okEl      = el.querySelector("#mp-ok");

  // Sanitise to digits only
  [newEl, confirmEl].forEach((input) => {
    input.addEventListener("input", () => {
      input.value = input.value.replace(/\D/g, "").slice(0, 6);
    });
  });
  currentEl.addEventListener("input", () => {
    currentEl.value = currentEl.value.replace(/\D/g, "").slice(0, 6);
  });

  genBtn.addEventListener("click", () => {
    const pin = generatePin(6);
    newEl.value = pin;
    confirmEl.value = "";
    newEl.focus();
  });

  submitBtn.addEventListener("click", async () => {
    hideMsg(errEl); hideMsg(okEl);

    const current = currentEl.value.trim();
    const next    = newEl.value.trim();
    const confirm = confirmEl.value.trim();

    if (!current || current.length !== 6) return showErr(errEl, "Enter your current 6-digit PIN.");
    if (!next    || next.length !== 6)    return showErr(errEl, "New PIN must be exactly 6 digits.");
    if (next !== confirm)                 return showErr(errEl, "New PIN and confirmation do not match.");
    if (current === next)                 return showErr(errEl, "New PIN must be different from the current PIN.");

    await withLoadingBtn(submitBtn, "Updating…", async () => {
      try {
        await changeOwnPin(currentProfile.staffId, current, next);
        showMsg(okEl, "✅ PIN updated successfully.");
        currentEl.value = "";
        newEl.value     = "";
        confirmEl.value = "";
      } catch (err) {
        showErr(errEl, "Failed: " + err.message);
      }
    });
  });
}

// ================================================================
// Firestore helpers
// ================================================================

async function fetchAllActiveUsers() {
  // Fetch users collection — we want ALL (active + inactive) for management
  const snap = await getDocs(collection(db, "users"));
  const users = [];
  snap.forEach((d) => users.push({ uid: d.id, ...d.data() }));

  // Category display order
  const CAT_ORDER = { admin: 0, bus: 1, hostel: 2, class: 3 };

  users.sort((a, b) => {
    // 1. Active before inactive
    const aActive = a.active !== false ? 0 : 1;
    const bActive = b.active !== false ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;

    // 2. Category order (admin → bus → hostel → class)
    const aCat = CAT_ORDER[a.category] ?? 9;
    const bCat = CAT_ORDER[b.category] ?? 9;
    if (aCat !== bCat) return aCat - bCat;

    // 3. Within category, sort by first scope naturally (bus_11 < bus_12, etc.)
    const aScope = (a.scopeIds || [])[0] || "";
    const bScope = (b.scopeIds || [])[0] || "";
    const scopeCmp = aScope.localeCompare(bScope, undefined, { numeric: true });
    if (scopeCmp !== 0) return scopeCmp;

    // 4. Alphabetical by name as tiebreaker
    return (a.name || "").localeCompare(b.name || "");
  });

  return users;
}

// ================================================================
// Utility helpers
// ================================================================

function generatePin(len) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b % 10).join("");
}

function formatScopes(scopeIds) {
  if (!Array.isArray(scopeIds) || !scopeIds.length) return "—";
  return scopeIds
    .map((s) => {
      if (s === "hostel_main") return "Hostel";
      if (s.startsWith("bus_"))   return `Bus ${s.replace(/^bus_/, "")}`;
      if (s.startsWith("class_")) return s.replace(/^class_/, "").replace(/_/g, " ");
      return s;
    })
    .join(", ");
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function naturalSort(a, b) {
  return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s ?? "";
  return div.innerHTML;
}

function showErr(el, msg) {
  el.textContent = msg;
  el.style.display = "";
}

function showMsg(el, msg) {
  el.textContent = msg;
  el.style.display = "";
}

function hideMsg(el) {
  el.style.display = "none";
  el.textContent = "";
}

async function withLoadingBtn(btn, label, action) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { await action(); } finally { btn.disabled = false; btn.textContent = orig; }
}
