const SUPABASE_URL = "https://dlapwemckfhxklytbqkk.supabase.co";
const SUPABASE_KEY = "sb_publishable_VeeQLARNn-sULZ4snvp3HA_Hd78H5RN";
const SESSION_KEY = "haviko-admin-session";

const $ = (id) => document.getElementById(id);

const app = {
  session: null,
  restaurants: [],
};

function saveSession(session) {
  app.session = session;
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch {}
}

function readStoredSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
}

function clearSession() {
  app.session = null;
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

async function authFetch(path, options = {}) {
  if (app.session?.expires_at && app.session.expires_at < Math.floor(Date.now() / 1000) + 30) {
    await refreshSession();
  }
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${app.session?.access_token || SUPABASE_KEY}`,
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  return fetch(`${SUPABASE_URL}${path}`, { ...options, headers });
}

async function refreshSession() {
  if (!app.session?.refresh_token) return;
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: app.session.refresh_token }),
    });
  } catch {
    // Network hiccup - keep the (soon-to-expire) session as-is rather than
    // wiping it; the next authFetch will just retry the refresh.
    return;
  }
  if (!response.ok) {
    // Only a real 4xx from Supabase means the refresh token itself is
    // actually invalid/revoked - anything else (5xx, etc.) shouldn't nuke
    // a session that might still be perfectly usable.
    if (response.status >= 400 && response.status < 500) {
      clearSession();
    }
    return;
  }
  const data = await response.json();
  data.expires_at = Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600);
  saveSession(data);
}

function apiError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function rpc(name, body = {}) {
  let response;
  try {
    response = await authFetch(`/rest/v1/rpc/${name}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch {
    // Network hiccup (offline, DNS blip, CORS preflight timeout, etc.) -
    // never treated as an auth failure, so callers can retry without
    // losing a perfectly good session.
    throw apiError("Netzwerkfehler. Bitte erneut versuchen.", 0);
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw apiError(data?.message || data?.error || "Anfrage fehlgeschlagen.", response.status);
  }
  return data;
}

async function invokeFunction(name, body = {}) {
  const response = await authFetch(`/functions/v1/${name}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.error || "Anfrage fehlgeschlagen.");
  }
  return data;
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}

function escapeAttr(value) {
  return escapeHTML(value).replace(/`/g, "&#96;");
}

function showScreen(loggedIn) {
  $("login-screen").classList.toggle("hidden", loggedIn);
  $("app-screen").classList.toggle("hidden", !loggedIn);
}

async function login(email, password) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error_description || data?.msg || "Anmeldung fehlgeschlagen.");
  }
  data.expires_at = Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600);
  saveSession(data);
}

async function boot() {
  const stored = readStoredSession();
  if (stored) {
    app.session = stored;
    // Show the app immediately on a stored session rather than waiting on
    // the network - a valid session shouldn't flash back to the login
    // screen just because the first data fetch is slow. Only an actual
    // auth failure (401, e.g. a truly expired/revoked session) forces a
    // fresh login; any other error (offline, transient 5xx, CORS hiccup)
    // just shows a retryable error in the list.
    $("admin-email").textContent = stored.user?.email || "";
    showScreen(true);
    try {
      await loadRestaurants();
    } catch (error) {
      if (error.status === 401) {
        clearSession();
        showScreen(false);
      } else {
        $("list-error").textContent = error.message;
        $("list-error").classList.remove("hidden");
      }
    }
    return;
  }
  showScreen(false);
}

const SUSPENSION_REASON_PRESETS = [
  "Wiederholte Verstöße gegen die Haviko-Richtlinien",
  "Falsche oder irreführende Angaben zum Restaurant",
  "Unangemessenes Verhalten gegenüber Gästen oder Support",
  "Verdacht auf Missbrauch der Plattform (Fake-Bestellungen, Betrug)",
  "Verstoß gegen geltendes Recht (z. B. Lebensmittelsicherheit)",
];

function restaurantStatusBadges(r) {
  const badges = [];
  if (r.deleted_at) {
    badges.push(`<span class="badge status-rejected">Gelöscht (bis ${new Date(r.scheduled_purge_at).toLocaleDateString("de-DE")})</span>`);
    return badges.join(" ");
  }
  if (r.suspension_reason) {
    badges.push(`<span class="badge status-suspended">Gesperrt</span>`);
  }
  if (r.needs_review) {
    badges.push(`<span class="badge status-pending">Prüfung nötig</span>`);
  } else if (r.is_activated) {
    badges.push(`<span class="badge status-approved">Freigeschaltet</span>`);
  }
  if (r.claim_review_status === "rejected") {
    badges.push(`<span class="badge status-rejected">Antrag abgelehnt</span>`);
  }
  badges.push(`<span class="badge activated-${r.is_activated}">${r.is_activated ? "Aktiv" : "Nicht aktiv"}</span>`);
  return badges.join(" ");
}

async function loadRestaurants() {
  $("list-error").classList.add("hidden");
  const data = await rpc("admin_list_restaurants");
  app.restaurants = data || [];
  renderList();
}

function renderList() {
  const query = $("search-input").value.trim().toLowerCase();
  const statusFilter = $("status-filter").value;
  const filtered = app.restaurants.filter((r) => {
    if (statusFilter === "needs_review" && !r.needs_review) return false;
    if (statusFilter === "activated" && !r.is_activated) return false;
    if (statusFilter === "suspended" && !r.suspension_reason) return false;
    if (statusFilter === "deleted" && !r.deleted_at) return false;
    if (!query) return true;
    return [r.name, r.code, r.owner_username, r.owner_display_name, r.recovery_email, r.phone_number]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(query));
  });

  $("restaurant-list").innerHTML = filtered.length
    ? filtered.map((r) => `
      <div class="restaurant-row" data-id="${escapeAttr(r.restaurant_id)}">
        <div class="restaurant-row-main">
          <div class="restaurant-row-name">${escapeHTML(r.name)} <span class="muted">(${escapeHTML(r.code)})</span></div>
          <div class="restaurant-row-meta">${escapeHTML(r.owner_display_name || r.owner_username || "—")} · ${escapeHTML(r.recovery_email || "keine E-Mail")}${r.recovery_email ? (r.recovery_email_verified ? " ✓" : " · unbestätigt") : ""} · ${r.member_count} Mitglieder</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end;">
          ${restaurantStatusBadges(r)}
        </div>
      </div>`).join("")
    : `<p class="muted">Keine Restaurants gefunden.</p>`;

  $("restaurant-list").querySelectorAll(".restaurant-row").forEach((row) => {
    row.addEventListener("click", () => openDetail(row.dataset.id));
  });
}

let currentDetail = null;

async function openDetail(restaurantId) {
  $("list-view").classList.add("hidden");
  $("detail-view").classList.remove("hidden");
  $("detail-content").innerHTML = `<p class="muted">Lädt …</p>`;
  try {
    const detail = await rpc("admin_get_restaurant_detail", { p_restaurant_id: restaurantId });
    currentDetail = { restaurantId, detail };
    let menu = { categories: [], products: [] };
    try { menu = await rpc("admin_list_menu", { p_restaurant_id: restaurantId }); } catch {}
    renderDetail(restaurantId, detail, menu);
  } catch (error) {
    $("detail-content").innerHTML = `<p class="form-error">${escapeHTML(error.message)}</p>`;
  }
}

async function refreshDetail() {
  if (!currentDetail) return;
  await openDetail(currentDetail.restaurantId);
}

function renderDetail(restaurantId, detail, menu) {
  const restaurant = detail.restaurant;
  const credential = detail.credential || {};
  const members = detail.members || [];
  const isDeleted = Boolean(restaurant.deleted_at);

  const duplicates = findPossibleDuplicates(
    { restaurant_id: restaurantId, name: restaurant.name, address: detail.location?.address },
    app.restaurants
  );

  $("detail-content").innerHTML = `
    ${isDeleted ? `
      <div class="detail-card" style="border-color:var(--red);background:var(--red-soft);">
        <strong style="color:var(--red);">Gelöscht</strong>
        <p class="muted">Wird endgültig gelöscht am ${new Date(restaurant.scheduled_purge_at).toLocaleString("de-DE")}, sofern sich der Besitzer nicht vorher anmeldet.</p>
      </div>
    ` : ""}
    ${duplicates.length ? `
      <div class="duplicate-warning" style="margin-top:0;margin-bottom:14px;">
        ⚠️ Möglicherweise bereits bekannt / Betrugsverdacht: ähnelt ${duplicates.map((d) => `"${escapeHTML(d.name)}" (${escapeHTML(d.code)})`).join(", ")}
      </div>
    ` : ""}

    <div class="detail-card">
      <h2>${escapeHTML(restaurant.name)}</h2>
      <p class="muted">Kennung ${escapeHTML(restaurant.code)} · erstellt ${new Date(restaurant.created_at).toLocaleString("de-DE")}</p>
      <div class="detail-row"><span>Status</span><span>${restaurantStatusBadges({ ...restaurant, restaurant_id: restaurant.id, is_activated: restaurant.is_activated, needs_review: !restaurant.is_activated && !restaurant.deleted_at, deleted_at: restaurant.deleted_at, scheduled_purge_at: restaurant.scheduled_purge_at, claim_review_status: restaurant.claim_review_status })}</span></div>

      <form id="form-restaurant" style="margin-top:14px;">
        <label class="field"><span>Name</span><input name="name" value="${escapeAttr(restaurant.name)}"></label>
        <label class="field"><span>Betriebsart</span><input name="restaurant_type" value="${escapeAttr(restaurant.restaurant_type || "")}"></label>
        <button class="confirm" type="submit">Restaurant-Daten speichern</button>
      </form>

      <div class="detail-actions">
        ${!restaurant.is_activated ? `<button class="confirm" data-action="activate">Freischalten</button>` : `<button class="danger" data-action="deactivate">Freischaltung entfernen</button>`}
        ${restaurant.claim_review_status !== "rejected" ? `<button class="danger" data-action="reject-claim">Beanspruchungs-Antrag ablehnen</button>` : `<button class="confirm" data-action="approve-claim">Beanspruchungs-Antrag freigeben</button>`}
      </div>
    </div>

    <div class="detail-card" ${restaurant.suspension_reason ? `style="border-color:var(--red);"` : ""}>
      <h3 style="margin-top:0;${restaurant.suspension_reason ? "color:var(--red);" : ""}">Sperrung</h3>
      ${restaurant.suspension_reason ? `
        <p class="muted">Aktueller Grund:</p>
        <p style="margin:4px 0 14px;">${escapeHTML(restaurant.suspension_reason)}</p>
        <div class="detail-actions">
          <button class="confirm" data-action="lift-suspension">Entsperren</button>
        </div>
      ` : `
        <form id="form-suspend">
          <div class="reason-presets">
            ${SUSPENSION_REASON_PRESETS.map((reason, i) => `
              <label><input type="radio" name="reasonPreset" value="${escapeAttr(reason)}" ${i === 0 ? "checked" : ""}> ${escapeHTML(reason)}</label>
            `).join("")}
            <label><input type="radio" name="reasonPreset" value="__custom__"> Eigener Grund:</label>
          </div>
          <label class="field"><span>Eigener Grund (falls ausgewählt)</span><textarea name="customReason" rows="2" style="font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;"></textarea></label>
          <button class="danger" type="submit">Restaurant sperren</button>
        </form>
      `}
      ${renderSuspensionHistory(detail.suspensionHistory || [])}
    </div>

    ${renderLegalInfoCard(detail.legalInfo)}
    ${renderLocationCard(detail.location)}
    ${renderAnalyticsCard(detail.analytics)}

    <div class="detail-card">
      <h3 style="margin-top:0;">Restaurantleitung</h3>
      <form id="form-owner">
        <label class="field"><span>Anzeigename</span><input name="displayName" value="${escapeAttr(credential.displayName || "")}"></label>
        <label class="field"><span>Benutzername</span><input name="username" value="${escapeAttr(credential.username || "")}"></label>
        <label class="field"><span>Wiederherstellungs-E-Mail</span><input name="recoveryEmail" type="email" value="${escapeAttr(credential.recoveryEmail || "")}"></label>
        <label class="field"><span>Telefonnummer</span><input name="phoneNumber" value="${escapeAttr(credential.phoneNumber || "")}"></label>
        <label class="field" style="flex-direction:row;align-items:center;gap:8px;">
          <input type="checkbox" name="markVerified" ${credential.recoveryEmailVerifiedAt ? "checked" : ""} style="width:auto;">
          <span>E-Mail als bestätigt markieren</span>
        </label>
        <button class="confirm" type="submit">Restaurantleitung speichern</button>
      </form>
      <p class="muted" style="margin-top:8px;">Muss Passwort ändern: ${credential.mustChangePassword ? "Ja" : "Nein"} · 2FA: ${credential.twoFactorEnabled ? "Aktiv" : "Aus"}</p>
    </div>

    <div class="detail-card">
      <h3 style="margin-top:0;">Team (${members.length})</h3>
      <div class="member-list">
        ${members.map((m) => `
          <form class="member-edit-form" data-username="${escapeAttr(m.username)}" style="display:flex;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--page);flex-wrap:wrap;">
            <input name="displayName" value="${escapeAttr(m.displayName)}" style="flex:1;min-width:120px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;">
            <span class="muted">(${escapeHTML(m.username)})</span>
            <select name="role" style="padding:6px 8px;border:1px solid var(--line);border-radius:6px;">
              ${["restaurant_manager", "management", "service", "kitchen", "bar", "Station"].map((role) => `<option value="${role}" ${m.role === role ? "selected" : ""}>${role}</option>`).join("")}
            </select>
            <label style="display:flex;align-items:center;gap:4px;font-size:12px;"><input type="checkbox" name="isActive" ${m.isActive ? "checked" : ""}> aktiv</label>
            <button class="secondary small" type="submit">Speichern</button>
          </form>
        `).join("") || `<p class="muted">Kein Team.</p>`}
      </div>
    </div>

    <div class="detail-card">
      <h3 style="margin-top:0;">Speisekarte</h3>
      <div id="menu-editor">
        ${renderMenuEditor(menu)}
      </div>
    </div>

    <div class="detail-card" style="border-color:var(--red);">
      <h3 style="margin-top:0;color:var(--red);">Löschen</h3>
      ${isDeleted
        ? `<p class="muted">Dieses Restaurant ist bereits zur Löschung vorgemerkt.</p>`
        : `
          <p class="muted">Normale Löschung: 30 Tage Frist, der Besitzer kann sich in der Zeit anmelden und alles wiederherstellen. Endgültige Löschung: sofort und unwiderruflich, inklusive aller Daten.</p>
          <div class="detail-actions">
            <button class="danger" data-action="soft-delete">Normal löschen (30 Tage Frist)</button>
            <button class="danger" data-action="hard-delete">Endgültig löschen (sofort)</button>
          </div>
        `}
    </div>
  `;

  $("detail-content").querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => handleDetailAction(restaurantId, button.dataset.action, restaurant.name));
  });

  $("form-restaurant").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await rpc("admin_update_restaurant", {
        p_restaurant_id: restaurantId,
        p_name: form.get("name"),
        p_restaurant_type: form.get("restaurant_type"),
      });
      await loadRestaurants();
      await refreshDetail();
    } catch (error) {
      alert(error.message);
    }
  });

  $("form-owner").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await rpc("admin_update_owner_credential", {
        p_restaurant_id: restaurantId,
        p_display_name: form.get("displayName"),
        p_username: form.get("username"),
        p_recovery_email: form.get("recoveryEmail"),
        p_phone_number: form.get("phoneNumber"),
        p_mark_email_verified: form.get("markVerified") === "on",
      });
      await loadRestaurants();
      await refreshDetail();
    } catch (error) {
      alert(error.message);
    }
  });

  $("detail-content").querySelectorAll(".member-edit-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      try {
        await rpc("admin_update_team_member", {
          p_restaurant_id: restaurantId,
          p_username: form.dataset.username,
          p_display_name: data.get("displayName"),
          p_role: data.get("role"),
          p_is_active: data.get("isActive") === "on",
        });
        await refreshDetail();
      } catch (error) {
        alert(error.message);
      }
    });
  });

  $("form-suspend")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const preset = form.get("reasonPreset");
    const reason = preset === "__custom__" ? String(form.get("customReason") || "").trim() : preset;
    if (!reason) {
      alert("Bitte einen Grund angeben.");
      return;
    }
    if (!confirm(`"${restaurant.name}" wirklich sperren?\n\nGrund: ${reason}`)) return;
    try {
      await rpc("admin_suspend_restaurant", { p_restaurant_id: restaurantId, p_reason: reason });
      await loadRestaurants();
      await refreshDetail();
    } catch (error) {
      alert(error.message);
    }
  });

  wireMenuEditor(restaurantId, menu);
}

const SUSPENSION_EVENT_LABEL = {
  suspended: "Gesperrt",
  lifted_by_admin: "Von Admin entsperrt",
  appeal_upheld: "Widerspruch abgelehnt (Sperrung bleibt)",
  appeal_overturned: "Widerspruch angenommen (entsperrt)",
};

function renderSuspensionHistory(history) {
  if (!history.length) return "";
  return `
    <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--page);">
      <h4 style="margin:0 0 8px;font-size:13px;color:var(--muted);text-transform:uppercase;">Verlauf</h4>
      ${history.map((event) => `
        <div style="padding:6px 0;border-bottom:1px solid var(--page);font-size:13px;">
          <strong>${SUSPENSION_EVENT_LABEL[event.eventType] || event.eventType}</strong>
          <span class="muted"> · ${new Date(event.createdAt).toLocaleString("de-DE")}</span>
          ${event.reason ? `<div class="muted" style="margin-top:2px;">${escapeHTML(event.reason)}</div>` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

function renderLegalInfoCard(legalInfo) {
  if (!legalInfo || !legalInfo.legalName) return "";
  const rows = [
    ["Firmierung", legalInfo.legalName],
    ["Rechtsform", legalInfo.legalForm],
    ["Inhaber / Geschäftsführer", legalInfo.representativeName],
    ["Steuernummer", legalInfo.taxNumber],
    ["USt-IdNr.", legalInfo.vatID],
    ["Handelsregisternummer", legalInfo.commercialRegisterNumber],
  ];
  return `
    <div class="detail-card">
      <h3 style="margin-top:0;">Rechtliche Angaben</h3>
      ${rows.map(([label, value]) => value ? `
        <div class="detail-row"><span>${label}</span><span>${escapeHTML(value)}</span></div>
      ` : "").join("")}
    </div>
  `;
}

function renderLocationCard(location) {
  if (!location) return "";
  const hasCoords = location.latitude != null && location.longitude != null;
  const hasAnything = location.address || location.phone || location.website || hasCoords;
  if (!hasAnything) return "";
  const mapsQuery = hasCoords
    ? `${location.latitude},${location.longitude}`
    : location.address;
  const mapsLink = mapsQuery
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`
    : null;
  const priceLabel = location.priceClass ? "€".repeat(location.priceClass) : null;
  return `
    <div class="detail-card">
      <h3 style="margin-top:0;">Standort &amp; öffentlicher Auftritt</h3>
      ${location.address ? `<p style="margin:0 0 6px;">${escapeHTML(location.address)}</p>` : `<p class="muted" style="margin:0 0 6px;">Keine Adresse hinterlegt.</p>`}
      ${location.phone ? `<p class="muted" style="margin:0 0 4px;">Tel. ${escapeHTML(location.phone)}</p>` : ""}
      ${location.email ? `<p class="muted" style="margin:0 0 4px;">${escapeHTML(location.email)}</p>` : ""}
      ${location.website ? `<p class="muted" style="margin:0 0 4px;">${escapeHTML(location.website)}</p>` : ""}
      ${priceLabel ? `<p class="muted" style="margin:0 0 4px;">Preisklasse ${priceLabel}</p>` : ""}
      ${location.openingHoursText ? `<p class="muted" style="margin:0 0 4px;white-space:pre-wrap;">${escapeHTML(location.openingHoursText)}</p>` : ""}
      ${location.description ? `<p style="margin:8px 0 0;">${escapeHTML(location.description)}</p>` : ""}
      <p class="muted" style="margin:8px 0 0;font-size:12.5px;">Online-Reservierung: ${location.bookingEnabled ? "aktiviert" : "nicht aktiviert"}</p>
      ${hasCoords ? `
        <div style="margin-top:10px;border-radius:10px;overflow:hidden;border:1px solid var(--line);">
          <iframe
            width="100%" height="220" style="border:0;display:block;"
            loading="lazy"
            src="https://www.openstreetmap.org/export/embed.html?bbox=${location.longitude - 0.01}%2C${location.latitude - 0.01}%2C${location.longitude + 0.01}%2C${location.latitude + 0.01}&marker=${location.latitude}%2C${location.longitude}"
          ></iframe>
        </div>
      ` : ""}
      ${mapsLink ? `<a href="${escapeAttr(mapsLink)}" target="_blank" rel="noopener" class="muted" style="display:inline-block;margin-top:8px;font-size:13px;">In Google Maps öffnen ↗</a>` : ""}
    </div>
  `;
}

function renderAnalyticsCard(analytics) {
  if (!analytics) return "";
  const rows = [
    ["Produkte", analytics.productCount],
    ["Tische", analytics.tableCount],
    ["Reservierungen gesamt", analytics.reservationCount],
    ["davon abgeschlossen", analytics.completedReservationCount],
    ["Bewertungen", analytics.reviewCount],
    ["Ø Bewertung", analytics.averageRating != null ? `${analytics.averageRating} / 5` : "—"],
    ["Digitale Belege", analytics.receiptCount],
  ];
  return `
    <div class="detail-card">
      <h3 style="margin-top:0;">Analysen</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 20px;">
        ${rows.map(([label, value]) => `
          <div class="detail-row" style="border-bottom:none;padding:4px 0;">
            <span>${label}</span><span><strong>${value ?? "—"}</strong></span>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderMenuEditor(menu) {
  const categories = menu.categories || [];
  const products = menu.products || [];
  const categoryOptions = (selectedId) => categories.map((c) =>
    `<option value="${escapeAttr(c.id)}" ${c.id === selectedId ? "selected" : ""}>${escapeHTML(c.name)}</option>`
  ).join("");

  return `
    <div style="margin-bottom:14px;">
      <h4 style="margin:0 0 8px;font-size:13px;color:var(--muted);text-transform:uppercase;">Kategorien</h4>
      ${categories.map((c) => `
        <form class="category-edit-form" data-id="${escapeAttr(c.id)}" style="display:flex;gap:8px;margin-bottom:6px;">
          <input name="name" value="${escapeAttr(c.name)}" style="flex:1;padding:6px 8px;border:1px solid var(--line);border-radius:6px;">
          <button class="secondary small" type="submit">Speichern</button>
          <button class="danger small" type="button" data-delete-category="${escapeAttr(c.id)}">Löschen</button>
        </form>
      `).join("")}
      <form id="form-new-category" style="display:flex;gap:8px;">
        <input name="name" placeholder="Neue Kategorie" style="flex:1;padding:6px 8px;border:1px solid var(--line);border-radius:6px;">
        <button class="confirm small" type="submit">Hinzufügen</button>
      </form>
    </div>
    <div>
      <h4 style="margin:0 0 8px;font-size:13px;color:var(--muted);text-transform:uppercase;">Produkte</h4>
      ${products.map((p) => `
        <form class="product-edit-form" data-id="${escapeAttr(p.id)}" style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap;">
          <input name="name" value="${escapeAttr(p.name)}" style="flex:1;min-width:100px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;">
          <select name="categoryId" style="padding:6px 8px;border:1px solid var(--line);border-radius:6px;">${categoryOptions(p.categoryId)}</select>
          <input name="price" type="number" step="0.01" value="${p.price}" style="width:80px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;">
          <label style="display:flex;align-items:center;gap:4px;font-size:12px;"><input type="checkbox" name="isAvailable" ${p.isAvailable ? "checked" : ""}> verfügbar</label>
          <button class="secondary small" type="submit">Speichern</button>
          <button class="danger small" type="button" data-delete-product="${escapeAttr(p.id)}">Löschen</button>
        </form>
      `).join("") || `<p class="muted">Keine Produkte.</p>`}
      <form id="form-new-product" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
        <input name="name" placeholder="Neues Produkt" style="flex:1;min-width:100px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;">
        <select name="categoryId" style="padding:6px 8px;border:1px solid var(--line);border-radius:6px;">${categoryOptions(null)}</select>
        <input name="price" type="number" step="0.01" placeholder="Preis" style="width:80px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;">
        <button class="confirm small" type="submit">Hinzufügen</button>
      </form>
    </div>
  `;
}

function wireMenuEditor(restaurantId, menu) {
  $("detail-content").querySelectorAll(".category-edit-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await rpc("admin_upsert_category", {
          p_restaurant_id: restaurantId,
          p_category_id: form.dataset.id,
          p_name: new FormData(form).get("name"),
          p_sort_order: null,
        });
        await refreshDetail();
      } catch (error) { alert(error.message); }
    });
  });
  $("detail-content").querySelectorAll("[data-delete-category]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Kategorie wirklich löschen? Zugehörige Produkte verlieren ihre Kategorie.")) return;
      try {
        await rpc("admin_delete_category", { p_category_id: button.dataset.deleteCategory });
        await refreshDetail();
      } catch (error) { alert(error.message); }
    });
  });
  $("form-new-category")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = new FormData(event.target).get("name");
    if (!name) return;
    try {
      await rpc("admin_upsert_category", { p_restaurant_id: restaurantId, p_category_id: null, p_name: name, p_sort_order: (menu.categories || []).length });
      await refreshDetail();
    } catch (error) { alert(error.message); }
  });

  $("detail-content").querySelectorAll(".product-edit-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const data = new FormData(form);
      try {
        await rpc("admin_upsert_product", {
          p_product_id: form.dataset.id,
          p_restaurant_id: restaurantId,
          p_category_id: data.get("categoryId") || null,
          p_name: data.get("name"),
          p_description: null,
          p_price: Number(data.get("price") || 0),
          p_is_available: data.get("isAvailable") === "on",
        });
        await refreshDetail();
      } catch (error) { alert(error.message); }
    });
  });
  $("detail-content").querySelectorAll("[data-delete-product]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!confirm("Produkt wirklich löschen?")) return;
      try {
        await rpc("admin_delete_product", { p_product_id: button.dataset.deleteProduct });
        await refreshDetail();
      } catch (error) { alert(error.message); }
    });
  });
  $("form-new-product")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    const name = data.get("name");
    if (!name) return;
    try {
      await rpc("admin_upsert_product", {
        p_product_id: null,
        p_restaurant_id: restaurantId,
        p_category_id: data.get("categoryId") || null,
        p_name: name,
        p_description: null,
        p_price: Number(data.get("price") || 0),
        p_is_available: true,
      });
      await refreshDetail();
    } catch (error) { alert(error.message); }
  });
}

async function handleDetailAction(restaurantId, action, restaurantName) {
  try {
    if (action === "activate") {
      await rpc("admin_set_restaurant_activated", { p_restaurant_id: restaurantId, p_activated: true });
    } else if (action === "deactivate") {
      if (!confirm("Freischaltung wirklich entfernen? Das Restaurant sieht dann wieder den Nicht-aktiviert-Banner.")) return;
      await rpc("admin_set_restaurant_activated", { p_restaurant_id: restaurantId, p_activated: false });
    } else if (action === "approve-claim") {
      await rpc("admin_set_restaurant_review_status", { p_restaurant_id: restaurantId, p_status: "approved" });
    } else if (action === "reject-claim") {
      if (!confirm("Beanspruchungs-Antrag wirklich ablehnen?")) return;
      await rpc("admin_set_restaurant_review_status", { p_restaurant_id: restaurantId, p_status: "rejected" });
    } else if (action === "lift-suspension") {
      if (!confirm("Sperrung wirklich aufheben?")) return;
      await rpc("admin_lift_suspension", { p_restaurant_id: restaurantId });
    } else if (action === "soft-delete") {
      if (!confirm(`"${restaurantName}" wirklich löschen? Der Besitzer hat 30 Tage Zeit, sich anzumelden und alles wiederherzustellen.`)) return;
      await invokeFunction("admin-delete-restaurant", { restaurantId, mode: "soft" });
    } else if (action === "hard-delete") {
      const typed = prompt(`ACHTUNG: Das kann NICHT rückgängig gemacht werden. Gib zur Bestätigung den exakten Namen ein:\n\n${restaurantName}`);
      if (typed === null) return;
      if (typed.trim() !== restaurantName) {
        alert("Name stimmt nicht überein. Abgebrochen.");
        return;
      }
      await invokeFunction("admin-delete-restaurant", { restaurantId, mode: "hard", confirmName: typed.trim() });
      await loadRestaurants();
      $("detail-view").classList.add("hidden");
      $("list-view").classList.remove("hidden");
      return;
    }
    await loadRestaurants();
    await refreshDetail();
  } catch (error) {
    alert(error.message);
  }
}

async function loadAppeals() {
  $("appeals-error").classList.add("hidden");
  try {
    const data = await rpc("admin_list_appeals");
    renderAppeals(data || []);
  } catch (error) {
    $("appeals-error").textContent = error.message;
    $("appeals-error").classList.remove("hidden");
  }
}

const APPEAL_STATUS_LABEL = { pending: "Wird geprüft", upheld: "Abgelehnt", overturned: "Angenommen" };

function renderAppeals(appeals) {
  $("appeals-list").innerHTML = appeals.length
    ? appeals.map((a) => `
      <div class="appeal-row appeal-row--big">
        <div class="appeal-row-top">
          <span class="appeal-row-name">${escapeHTML(a.restaurant_name)} <span class="muted">(${escapeHTML(a.restaurant_code)})</span></span>
          <span class="badge status-${a.status}">${APPEAL_STATUS_LABEL[a.status] || a.status}</span>
        </div>
        <p class="appeal-reason">Grund der Sperrung:</p>
        <p class="appeal-text">${escapeHTML(a.reason_snapshot)}</p>
        <p class="appeal-reason">Widerspruchstext:</p>
        <p class="appeal-text">${escapeHTML(a.appeal_text)}</p>
        <p class="muted" style="font-size:12px;">Eingereicht ${new Date(a.created_at).toLocaleString("de-DE")}${a.resolved_at ? ` · Entschieden ${new Date(a.resolved_at).toLocaleString("de-DE")}` : ""}</p>
        <div class="appeal-actions">
          ${a.status === "pending" ? `
            <button class="confirm" data-appeal-id="${escapeAttr(a.appeal_id)}" data-resolve="overturned">Widerspruch annehmen</button>
            <button class="danger" data-appeal-id="${escapeAttr(a.appeal_id)}" data-resolve="upheld">Widerspruch ablehnen</button>
          ` : ""}
          <button class="secondary" data-open-restaurant="${escapeAttr(a.restaurant_id)}">Restaurant-Details ansehen ↗</button>
        </div>
      </div>
    `).join("")
    : `<p class="muted">Keine Widersprüche vorhanden.</p>`;

  $("appeals-list").querySelectorAll("[data-resolve]").forEach((button) => {
    button.addEventListener("click", async () => {
      const status = button.dataset.resolve;
      const confirmText = status === "overturned"
        ? "Widerspruch annehmen? Das Restaurant wird sofort entsperrt."
        : "Widerspruch ablehnen? Die Sperrung bleibt bestehen.";
      if (!confirm(confirmText)) return;
      try {
        await rpc("admin_resolve_appeal", { p_appeal_id: button.dataset.appealId, p_status: status });
        await loadAppeals();
      } catch (error) {
        alert(error.message);
      }
    });
  });

  $("appeals-list").querySelectorAll("[data-open-restaurant]").forEach((button) => {
    button.addEventListener("click", () => {
      showTab("restaurants");
      openDetail(button.dataset.openRestaurant);
    });
  });
}

function showTab(tab) {
  $("list-view").classList.toggle("hidden", tab !== "restaurants");
  $("detail-view").classList.add("hidden");
  $("appeals-view").classList.toggle("hidden", tab !== "appeals");
  $("submissions-view").classList.toggle("hidden", tab !== "submissions");
  $("reports-view").classList.toggle("hidden", tab !== "reports");
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  if (tab === "appeals") loadAppeals();
  if (tab === "submissions") loadSubmissions();
  if (tab === "reports") loadReports();
}

document.querySelectorAll(".tab-button").forEach((button) => {
  button.addEventListener("click", () => showTab(button.dataset.tab));
});

$("appeals-refresh-button").addEventListener("click", () => loadAppeals());

// --- Einreichungen (new-restaurant review queue) ---

function normalizeForCompare(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Deliberately simple (not a real fuzzy-match library): flags a submission
// whose normalized name or address exactly matches, or is a substring of,
// another restaurant's - good enough to catch "same place registered
// twice" or "copied an existing restaurant's details" without false-positiving
// on every restaurant named e.g. "Bella Italia".
function findPossibleDuplicates(candidate, allRestaurants) {
  const candidateName = normalizeForCompare(candidate.name);
  const candidateAddress = normalizeForCompare(candidate.address);
  return allRestaurants.filter((other) => {
    if (other.restaurant_id === candidate.restaurant_id) return false;
    if (other.deleted_at) return false;
    const otherName = normalizeForCompare(other.name);
    const otherAddress = normalizeForCompare(other.address);
    const nameMatches = candidateName.length >= 3 && otherName.length >= 3
      && (candidateName === otherName || otherName.includes(candidateName) || candidateName.includes(otherName));
    const addressMatches = candidateAddress.length >= 6 && otherAddress.length >= 6
      && (candidateAddress === otherAddress || otherAddress.includes(candidateAddress) || candidateAddress.includes(otherAddress));
    return nameMatches || addressMatches;
  });
}

async function loadSubmissions() {
  $("submissions-error").classList.add("hidden");
  try {
    const data = await rpc("admin_list_restaurants");
    app.restaurants = data || [];
    const pending = app.restaurants.filter((r) => r.needs_review && !r.deleted_at);
    renderSubmissions(pending);
  } catch (error) {
    $("submissions-error").textContent = error.message;
    $("submissions-error").classList.remove("hidden");
  }
}

function renderSubmissions(pending) {
  $("submissions-list").innerHTML = pending.length
    ? pending.map((r) => {
        const duplicates = findPossibleDuplicates(r, app.restaurants);
        return `
      <div class="appeal-row appeal-row--big">
        <div class="appeal-row-top">
          <span class="appeal-row-name">${escapeHTML(r.name)} <span class="muted">(${escapeHTML(r.code)})</span></span>
          <span class="badge status-pending">Prüfung nötig</span>
        </div>
        <p class="appeal-reason">Betriebsart · Adresse</p>
        <p class="appeal-text">${escapeHTML(r.restaurant_type || "—")} · ${escapeHTML(r.address || "keine Adresse hinterlegt")}</p>
        <p class="appeal-reason">Restaurantleitung</p>
        <p class="appeal-text">${escapeHTML(r.owner_display_name || r.owner_username || "—")} · ${escapeHTML(r.recovery_email || "keine E-Mail")}${r.recovery_email ? (r.recovery_email_verified ? " ✓ bestätigt" : " · unbestätigt") : ""} · ${escapeHTML(r.phone_number || "keine Telefonnummer")}</p>
        <p class="muted" style="font-size:12px;">Eingereicht ${new Date(r.created_at).toLocaleString("de-DE")} · ${r.member_count} Mitglieder</p>
        ${duplicates.length ? `
          <div class="duplicate-warning">
            ⚠️ Möglicherweise bereits bekannt / Betrugsverdacht: ähnelt ${duplicates.map((d) => `"${escapeHTML(d.name)}" (${escapeHTML(d.code)})`).join(", ")}
          </div>
        ` : ""}
        <div class="appeal-actions">
          <button class="secondary" data-open-restaurant="${escapeAttr(r.restaurant_id)}">Restaurant-Details ansehen ↗</button>
        </div>
      </div>
    `;
      }).join("")
    : `<p class="muted">Keine Einreichungen zu prüfen.</p>`;

  $("submissions-list").querySelectorAll("[data-open-restaurant]").forEach((button) => {
    button.addEventListener("click", () => {
      showTab("restaurants");
      openDetail(button.dataset.openRestaurant);
    });
  });
}

$("submissions-refresh-button").addEventListener("click", () => loadSubmissions());

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-error").classList.add("hidden");
  const submitButton = event.target.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  const originalLabel = submitButton.textContent;
  submitButton.textContent = "Anmelden …";
  try {
    await login($("login-email").value.trim(), $("login-password").value);
  } catch (error) {
    $("login-error").textContent = error.message.includes("Access denied")
      ? "Kein Admin-Zugriff für dieses Konto."
      : error.message;
    $("login-error").classList.remove("hidden");
    clearSession();
    submitButton.disabled = false;
    submitButton.textContent = originalLabel;
    return;
  }
  submitButton.disabled = false;
  submitButton.textContent = originalLabel;
  // The login itself already succeeded and the session is valid at this
  // point - show the app right away. A hiccup in the follow-up restaurant
  // fetch is not a login failure and must never throw away a good session
  // (that was the "works maybe every 10th try" bug: any transient error
  // here used to wipe the session and bounce back to the password form).
  $("admin-email").textContent = app.session.user?.email || "";
  showScreen(true);
  try {
    await loadRestaurants();
  } catch (error) {
    $("list-error").textContent = error.message;
    $("list-error").classList.remove("hidden");
  }
});

$("signout-button").addEventListener("click", () => {
  clearSession();
  showScreen(false);
});

$("refresh-button").addEventListener("click", () => loadRestaurants().catch((error) => {
  $("list-error").textContent = error.message;
  $("list-error").classList.remove("hidden");
}));

$("search-input").addEventListener("input", renderList);
$("status-filter").addEventListener("change", renderList);
$("back-button").addEventListener("click", () => {
  $("detail-view").classList.add("hidden");
  $("list-view").classList.remove("hidden");
});

// --- Meldungen (guest-reported restaurants) ---

const REPORT_STATUS_LABEL = { pending: "Wird geprüft", reviewed: "Geprüft", dismissed: "Verworfen" };

async function loadReports() {
  $("reports-error").classList.add("hidden");
  try {
    const data = await rpc("admin_list_restaurant_reports");
    renderReports(data || []);
  } catch (error) {
    $("reports-error").textContent = error.message;
    $("reports-error").classList.remove("hidden");
  }
}

function renderReports(reports) {
  $("reports-list").innerHTML = reports.length
    ? reports.map((r) => `
      <div class="appeal-row appeal-row--big">
        <div class="appeal-row-top">
          <span class="appeal-row-name">${escapeHTML(r.restaurant_name)} <span class="muted">(${escapeHTML(r.restaurant_code)})</span></span>
          <span class="badge status-${r.status === "pending" ? "pending" : r.status === "reviewed" ? "approved" : "rejected"}">${REPORT_STATUS_LABEL[r.status] || r.status}</span>
        </div>
        <p class="appeal-reason">Grund</p>
        <p class="appeal-text">${escapeHTML(r.reason)}</p>
        ${r.details ? `<p class="appeal-reason">Details</p><p class="appeal-text">${escapeHTML(r.details)}</p>` : ""}
        <p class="muted" style="font-size:12px;">Gemeldet von ${escapeHTML(r.reporter_email || "unbekannt")} · ${new Date(r.created_at).toLocaleString("de-DE")}${r.resolved_at ? ` · Entschieden ${new Date(r.resolved_at).toLocaleString("de-DE")}` : ""}</p>
        <div class="appeal-actions">
          ${r.status === "pending" ? `
            <button class="danger" data-report-id="${escapeAttr(r.report_id)}" data-resolve="reviewed">Als geprüft markieren</button>
            <button class="secondary" data-report-id="${escapeAttr(r.report_id)}" data-resolve="dismissed">Verwerfen</button>
          ` : ""}
          <button class="secondary" data-open-restaurant="${escapeAttr(r.restaurant_id)}">Restaurant-Details ansehen ↗</button>
        </div>
      </div>
    `).join("")
    : `<p class="muted">Keine Meldungen vorhanden.</p>`;

  $("reports-list").querySelectorAll("[data-resolve]").forEach((button) => {
    button.addEventListener("click", async () => {
      const status = button.dataset.resolve;
      if (!confirm(status === "reviewed" ? "Meldung als geprüft markieren?" : "Meldung verwerfen?")) return;
      try {
        await rpc("admin_resolve_restaurant_report", { p_report_id: button.dataset.reportId, p_status: status });
        await loadReports();
      } catch (error) {
        alert(error.message);
      }
    });
  });

  $("reports-list").querySelectorAll("[data-open-restaurant]").forEach((button) => {
    button.addEventListener("click", () => {
      showTab("restaurants");
      openDetail(button.dataset.openRestaurant);
    });
  });
}

$("reports-refresh-button").addEventListener("click", () => loadReports());

boot();
