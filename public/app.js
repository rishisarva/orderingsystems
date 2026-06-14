// ===========================================================================
//  Order Desk — front-end logic
//  - Background polling that MERGES changes (no full-page rebuild / flicker)
//  - Click WhatsApp -> opens chat, marks order done, moves it to the Done tab
//  - Date/status filters, sorting, search, and an editable message template
// ===========================================================================

const POLL_MS = 20000;     // quiet background refresh
const $ = (id) => document.getElementById(id);

const state = {
  orders: [],   // active orders (full objects incl. message + waLink)
  done: [],     // contacted snapshots
  template: "",
  tokens: [],
  brand: "",
  upi: "",
  shipping: "150",
  tab: "active",
  filters: { date: "all", from: null, to: null, status: "all", sort: "newest", q: "" },
  seen: new Set(),
  locallyDone: new Set(),
  orderMap: new Map(),   // sticky: id -> order (survives a refresh that misses it)
  missing: new Map(),    // id -> consecutive refreshes an order has been absent
  firstLoad: true,
  soundOn: true,
  lastUpdated: null,
};

const cardEls = new Map();  // active order id -> card element

// Local persistence (survives Render free-tier restarts, which wipe the server's data folder)
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
state.template = LS.get("od_template", "");
state.done = LS.get("od_done", []);
state.locallyDone = new Set(state.done.map((o) => o.id));
state.paid = new Set(LS.get("od_paid", []));   // orders recorded as paid (in Money tab)

// ---------- helpers ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "";
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
function statusClass(s) { return "s-" + String(s || "").replace(/[^a-z-]/gi, "").toLowerCase(); }

// ---------- date / filter / sort ----------
function passesDate(o) {
  const f = state.filters;
  if (f.date === "all") return true;
  const d = startOfDay(o.dateCreated).getTime();
  const today = startOfDay(new Date()).getTime();
  const day = 86400000;
  if (f.date === "today") return d === today;
  if (f.date === "yesterday") return d === today - day;
  if (f.date === "custom") {
    const from = f.from ? startOfDay(f.from).getTime() : -Infinity;
    const to = f.to ? startOfDay(f.to).getTime() : Infinity;
    return d >= from && d <= to;
  }
  return true;
}
function filteredActive() {
  const f = state.filters;
  let list = state.orders.filter(passesDate);
  if (f.status !== "all") list = list.filter((o) => o.status === f.status);
  if (f.q) {
    const q = f.q.toLowerCase();
    list = list.filter((o) =>
      `${o.customerName} ${o.number} ${o.phone} ${o.rawPhone} ${o.items}`.toLowerCase().includes(q));
  }
  const num = (o) => parseFloat(o.total) || 0;
  const dt = (o) => new Date(o.dateCreated).getTime() || 0;
  list.sort((a, b) => {
    switch (f.sort) {
      case "oldest": return dt(a) - dt(b);
      case "amount-desc": return num(b) - num(a);
      case "amount-asc": return num(a) - num(b);
      default: return dt(b) - dt(a);
    }
  });
  return list;
}

// ---------- card building ----------
function cardInner(o, isNew) {
  const sc = statusClass(o.status);
  const sendBtn = o.waLink
    ? `<a class="send" data-act="send" href="${esc(o.waLink)}" target="_blank" rel="noopener">Message on WhatsApp →</a>`
    : `<button class="markdone" data-act="markdone">Mark done</button>
       <span class="send disabled" title="No phone number on this order">No phone</span>`;
  return `
    <div class="c-top">
      <span class="ordno">#${esc(o.number)}</span>
      <span class="c-meta">
        ${isNew ? '<span class="newtag">NEW</span>' : ""}
        <span class="pill ${sc}">${esc(o.status)}</span>
        <span class="ago">${esc(timeAgo(o.dateCreated))}</span>
      </span>
    </div>
    <div class="name">${esc(o.customerName)}</div>
    <div class="amount">${esc(o.currencySymbol)}${esc(o.total)}</div>
    ${o.items ? `<div class="items">${esc(o.items)}</div>` : ""}
    ${o.rawPhone ? `<div class="phone">${esc(o.rawPhone)}</div>` : ""}
    <button class="linkbtn peekbtn" data-act="peek">Preview message</button>
    <div class="peek hidden">${esc(o.message)}</div>
    <div class="card-actions">${sendBtn}</div>
  `;
}

function makeCard(o, isNew) {
  const el = document.createElement("article");
  el.className = `card ${statusClass(o.status)} enter${isNew ? " is-new" : ""}`;
  el.dataset.id = String(o.id);
  el.innerHTML = cardInner(o, isNew);
  wireCard(el, o);
  if (isNew) setTimeout(() => el.classList.remove("is-new"), 4000);
  return el;
}

function wireCard(el, o) {
  el.addEventListener("click", (ev) => {
    const act = ev.target.getAttribute("data-act");
    if (act === "peek") {
      const peek = el.querySelector(".peek");
      const hidden = peek.classList.toggle("hidden");
      ev.target.textContent = hidden ? "Preview message" : "Hide message";
    } else if (act === "send" || act === "markdone") {
      // 'send' is an <a> that already opens WhatsApp; we also mark done.
      markDone(o, el);
    }
  });
}

// keyed reconcile: add new, remove gone, reorder — without nuking the DOM
function renderActive() {
  const grid = $("grid");
  const list = filteredActive();
  const wantIds = new Set(list.map((o) => String(o.id)));

  for (const [id, el] of cardEls) {
    if (!wantIds.has(id)) { el.remove(); cardEls.delete(id); }
  }

  let prev = null;
  for (const o of list) {
    const id = String(o.id);
    const isNew = !state.firstLoad && !state.seen.has(o.id);
    let el = cardEls.get(id);
    if (!el) { el = makeCard(o, isNew); cardEls.set(id, el); }
    if (prev) { if (prev.nextSibling !== el) grid.insertBefore(el, prev.nextSibling); }
    else if (grid.firstChild !== el) grid.insertBefore(el, grid.firstChild);
    prev = el;
  }

  $("resultCount").textContent =
    state.orders.length === 0 ? "" :
    list.length === state.orders.length ? `${list.length} shown` :
    `${list.length} of ${state.orders.length} shown`;
  // "All caught up" only when there are genuinely no active orders
  $("emptyActive").classList.toggle("hidden", state.orders.length > 0);
}

// ---------- done list ----------
function renderDone() {
  const wrap = $("donelist");
  wrap.innerHTML = "";
  const list = state.done;
  $("emptyDone").classList.toggle("hidden", list.length > 0);
  for (const o of list) {
    const row = document.createElement("div");
    row.className = "donerow";
    row.innerHTML = `
      <div class="dr-top">
        <span class="name">${esc(o.customerName)}</span>
        <span class="ordno">#${esc(o.number)}</span>
        <span class="dr-amt">${esc(o.currencySymbol || "")}${esc(o.total)}</span>
        <span class="dr-when">messaged ${esc(timeAgo(o.contactedAt))}</span>
      </div>
      ${o.message ? `<div class="dr-msg">${esc(o.message)}</div>` : ""}
      <div class="dr-foot">
        <button class="linkbtn" data-undo="${esc(o.id)}">Move back to active</button>
      </div>`;
    row.querySelector("[data-undo]").addEventListener("click", () => undoDone(o.id));
    wrap.appendChild(row);
  }
}

// ---------- actions ----------
function snapshot(o) {
  return {
    id: o.id, number: o.number, customerName: o.customerName,
    total: o.total, currencySymbol: o.currencySymbol,
    phone: o.phone, rawPhone: o.rawPhone, status: o.status,
  };
}

function markDone(o, el) {
  // optimistic: animate out, move to done locally, persist on server
  state.locallyDone.add(o.id);
  el.classList.add("removing");
  setTimeout(() => { el.remove(); cardEls.delete(String(o.id)); }, 280);
  state.orderMap.delete(o.id);
  state.orders = state.orders.filter((x) => x.id !== o.id);
  state.done.unshift({ ...snapshot(o), message: o.message || "", contactedAt: new Date().toISOString() });
  LS.set("od_done", state.done);
  updateCounts();
  fetch("/api/contact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order: snapshot(o), message: o.message || "" }),
  }).catch(() => {});
}

function undoDone(orderId) {
  state.locallyDone.delete(Number(orderId));
  state.locallyDone.delete(String(orderId));
  state.done = state.done.filter((o) => String(o.id) !== String(orderId));
  LS.set("od_done", state.done);
  renderDone(); updateCounts();
  fetch("/api/uncontact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId }),
  }).then(() => load()).catch(() => {});
}

function updateCounts() {
  $("activeCount").textContent = state.orders.length;
  $("doneCount").textContent = state.done.length;
}

// ---------- tabs ----------
function setTab(tab) {
  state.tab = tab;
  const tabs = { active: "tabActive", done: "tabDone", dashboard: "tabDashboard" };
  const views = { active: "activeView", done: "doneView", dashboard: "dashboardView" };
  for (const [name, id] of Object.entries(tabs)) $(id).classList.toggle("active", name === tab);
  for (const [name, id] of Object.entries(views)) $(id).classList.toggle("hidden", name !== tab);
  $("toolbar").classList.toggle("hidden", tab !== "active");
  if (tab === "done") renderDone();
  if (tab === "dashboard" && window.Business) window.Business.renderDashboard();
}

// Let the business module read current orders (active + done) for its picker
window.OrderDesk = {
  getOrders: () => [...state.orderMap.values()],
  getDone: () => state.done,
  shipping: () => state.shipping,
  currency: () => (state.orders[0]?.currencySymbol || "₹"),
};

// ---------- new-order sound ----------
function ping() {
  if (!state.soundOn) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination); o.type = "sine";
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
    g.gain.setValueAtTime(0.001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.34);
    o.start(); o.stop(ctx.currentTime + 0.35);
  } catch (_) {}
}

// ---------- data load ----------
async function load(manual) {
  if (manual) { $("reIcon").classList.add("spin"); setTimeout(() => $("reIcon").classList.remove("spin"), 700); }
  try {
    const r = await fetch("/api/orders" + (manual ? "?fresh=1" : ""), { cache: "no-store" });
    const data = await r.json();
    if (!r.ok) {
      const msg = (data.hint ? data.hint + "  " : "") +
        (data.redirectedTo ? "[landed at: " + data.redirectedTo + "]  " : "") +
        (data.detail || data.error || `HTTP ${r.status}`);
      throw new Error(msg);
    }
    $("errbox").classList.add("hidden");
    $("livePulse").className = "pulse";

    state.brand = data.brand || state.brand;
    state.upi = data.upi || "";
    state.shipping = data.shipping || state.shipping;
    state.tokens = data.tokens || state.tokens;
    // Keep our locally-saved message if we have one; otherwise take the server's
    if (!state.template) state.template = data.template || "";
    if (data.brand) $("brandName").textContent = data.brand;

    // Merge the server's "done" list into our browser-stored one (browser wins / union)
    const doneMap = new Map(state.done.map((o) => [String(o.id), o]));
    for (const o of (data.done || [])) if (!doneMap.has(String(o.id))) doneMap.set(String(o.id), o);
    state.done = [...doneMap.values()].sort((a, b) => new Date(b.contactedAt) - new Date(a.contactedAt));
    LS.set("od_done", state.done);
    state.locallyDone = new Set(state.done.map((o) => o.id));

    // incoming orders, minus anything already marked done or paid
    state.paid = new Set(LS.get("od_paid", []));
    const incoming = (data.orders || []).filter(
      (o) => !state.locallyDone.has(o.id) && !state.paid.has(o.id));
    const incomingIds = new Set(incoming.map((o) => o.id));

    // count genuinely-new orders (for the ping / highlight)
    let newCount = 0;
    if (!state.firstLoad) for (const o of incoming) if (!state.seen.has(o.id)) newCount++;

    // STICKY merge: build each order's message from OUR saved template (not the
    // server's, which may have reset), then update/insert everything received...
    const MISSING_LIMIT = 3;
    for (const o of incoming) {
      o.message = buildClientMessage(o);
      o.waLink = o.phone ? `https://wa.me/${o.phone}?text=${encodeURIComponent(o.message)}` : null;
      state.orderMap.set(o.id, o);
      state.missing.set(o.id, 0);
    }
    // ...and only drop an order after it's been absent for several refreshes
    for (const id of [...state.orderMap.keys()]) {
      if (state.locallyDone.has(id) || state.paid.has(id)) { state.orderMap.delete(id); state.missing.delete(id); continue; }
      if (!incomingIds.has(id)) {
        const m = (state.missing.get(id) || 0) + 1;
        if (m >= MISSING_LIMIT) { state.orderMap.delete(id); state.missing.delete(id); state.seen.delete(id); }
        else state.missing.set(id, m);
      }
    }
    state.orders = [...state.orderMap.values()];

    // hand the processing/paid orders to the dashboard module
    state.paidOrders = (data.paidOrders || []).filter((o) => !state.paid.has(o.id));
    if (window.Business) window.Business.setPaidOrders(state.paidOrders);

    renderActive();
    if (state.tab === "done") renderDone();
    updateCounts();

    // warnings (skipped / failed statuses)
    const notes = [];
    if (data.skipped) notes.push(`${data.skipped} order${data.skipped > 1 ? "s" : ""} couldn't be read (site error) and ${data.skipped > 1 ? "were" : "was"} skipped`);
    if (data.problems?.length) notes.push("issues: " + data.problems.map((p) => `"${p.status}" — ${p.detail}`).join("; "));
    $("warnbox").classList.toggle("hidden", notes.length === 0);
    if (notes.length) $("warnbox").textContent = notes.join("  ·  ");

    if (newCount > 0) {
      ping();
      if (document.hidden && window.Notification?.permission === "granted") {
        new Notification(`${newCount} new unpaid order${newCount > 1 ? "s" : ""}`);
      }
    }
    for (const o of incoming) state.seen.add(o.id);
    state.firstLoad = false;
    state.lastUpdated = Date.now();
    tickUpdated();
  } catch (err) {
    // If we already have orders on screen, don't wipe them — just flag it quietly
    if (state.orders.length > 0) {
      $("livePulse").className = "pulse stale";
      $("warnbox").classList.remove("hidden");
      $("warnbox").textContent = "Couldn't refresh just now (showing last loaded orders). " +
        "If this keeps happening your store may be rate-limiting — try again in a moment.";
    } else {
      $("livePulse").className = "pulse dead";
      $("errbox").classList.remove("hidden");
      $("errbox").textContent = "Couldn't load orders: " + err.message;
    }
  }
}

function tickUpdated() {
  if (!state.lastUpdated) return;
  $("updated").textContent = "updated " + timeAgo(new Date(state.lastUpdated).toISOString());
}

// ---------- editor ----------
function openEditor() {
  $("tplInput").value = state.template || "";
  renderTokens();
  updatePreview();
  $("overlay").classList.remove("hidden");
  $("editor").classList.remove("hidden");
}
function closeEditor() {
  $("overlay").classList.add("hidden");
  $("editor").classList.add("hidden");
}
function renderTokens() {
  const row = $("tokenRow");
  row.innerHTML = "";
  (state.tokens.length ? state.tokens : ["{name}", "{order}", "{total}", "{shipping}", "{delivery}", "{jersey}", "{discount}", "{upi}", "{brand}"])
    .forEach((tk) => {
      const b = document.createElement("button");
      b.className = "token"; b.textContent = tk;
      b.addEventListener("click", () => insertToken(tk));
      row.appendChild(b);
    });
}
function insertToken(tk) {
  const ta = $("tplInput");
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? ta.value.length;
  ta.value = ta.value.slice(0, s) + tk + ta.value.slice(e);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = s + tk.length;
  updatePreview();
}
function updatePreview() {
  // render with the first active order, or a sample
  const o = state.orders[0] || {
    firstName: "Rahul", customerName: "Rahul Verma", number: "1042",
    currencySymbol: "₹", total: "1299.00", jersey: "1149.00", discount: "0.00", delivery: "1149.00",
  };
  const sym = o.currencySymbol || "₹";
  const map = {
    "{name}": o.firstName || o.customerName || "there",
    "{order}": "#" + o.number,
    "{total}": sym + o.total,
    "{shipping}": sym + (state.shipping || "150"),
    "{delivery}": sym + (o.delivery ?? o.total),
    "{jersey}": sym + (o.jersey ?? o.total),
    "{discount}": sym + (o.discount ?? "0.00"),
    "{upi}": state.upi || "(add your UPI ID)",
    "{brand}": state.brand || "our store",
  };
  let out = $("tplInput").value;
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  $("tplPreview").textContent = out;
}
function buildClientMessage(o) {
  const sym = o.currencySymbol || "";
  const map = {
    "{name}": o.firstName || o.customerName || "there",
    "{order}": "#" + o.number,
    "{total}": sym + o.total,
    "{shipping}": sym + (state.shipping || "150"),
    "{delivery}": sym + (o.delivery ?? o.total),
    "{jersey}": sym + (o.jersey ?? o.total),
    "{discount}": sym + (o.discount ?? "0.00"),
    "{upi}": state.upi || "(add your UPI ID)",
    "{brand}": state.brand || "our store",
  };
  let out = state.template || "";
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  return out;
}

function applyTemplateLocally() {
  for (const o of state.orderMap.values()) {
    o.message = buildClientMessage(o);
    o.waLink = o.phone ? `https://wa.me/${o.phone}?text=${encodeURIComponent(o.message)}` : null;
  }
  state.orders = [...state.orderMap.values()];
  // rebuild cards so their links + previews use the new message
  for (const el of cardEls.values()) el.remove();
  cardEls.clear();
  renderActive();
}

async function saveTemplate() {
  const template = $("tplInput").value;
  const btn = $("saveEditor");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const r = await fetch("/api/template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template }),
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `HTTP ${r.status}`); }
    // apply instantly in the browser — no slow refetch
    state.template = template;
    LS.set("od_template", template);
    applyTemplateLocally();
    closeEditor();
  } catch (err) {
    alert("Couldn't save the message: " + err.message);
  } finally {
    btn.disabled = false; btn.textContent = "Save message";
  }
}

// ---------- wiring ----------
$("tabActive").addEventListener("click", () => setTab("active"));
$("tabDone").addEventListener("click", () => setTab("done"));
$("tabDashboard").addEventListener("click", () => setTab("dashboard"));
$("refreshBtn").addEventListener("click", () => load(true));
$("editBtn").addEventListener("click", openEditor);
$("closeEditor").addEventListener("click", closeEditor);
$("cancelEditor").addEventListener("click", closeEditor);
$("saveEditor").addEventListener("click", saveTemplate);
$("overlay").addEventListener("click", closeEditor);
$("tplInput").addEventListener("input", updatePreview);

$("soundBtn").addEventListener("click", () => {
  state.soundOn = !state.soundOn;
  $("soundBtn").textContent = state.soundOn ? "🔔" : "🔕";
  $("soundBtn").classList.toggle("off", !state.soundOn);
});

$("dateSeg").addEventListener("click", (e) => {
  const d = e.target.getAttribute("data-date");
  if (!d) return;
  [...$("dateSeg").children].forEach((c) => c.classList.toggle("active", c === e.target));
  state.filters.date = d;
  $("customRange").classList.toggle("hidden", d !== "custom");
  renderActive();
});
$("fromDate").addEventListener("change", (e) => { state.filters.from = e.target.value || null; renderActive(); });
$("toDate").addEventListener("change", (e) => { state.filters.to = e.target.value || null; renderActive(); });
$("statusSel").addEventListener("change", (e) => { state.filters.status = e.target.value; renderActive(); });
$("sortSel").addEventListener("change", (e) => { state.filters.sort = e.target.value; renderActive(); });
$("search").addEventListener("input", (e) => { state.filters.q = e.target.value.trim(); renderActive(); });

if ("Notification" in window && Notification.permission === "default") {
  Notification.requestPermission().catch(() => {});
}

// background poll (seamless) + relative-time ticker
setInterval(() => load(false), POLL_MS);
setInterval(tickUpdated, 30000);
load();

// ---- Bridge for the Money/WhatsApp module (business.js) -------------------
window.App = {
  getActiveOrders: () => state.orders,
  getPaidOrders: () => state.paidOrders || [],
  getRecordableOrders: () => [...(state.orders || []), ...(state.paidOrders || [])],
  getShipping: () => state.shipping || "150",
  // Record an order as paid: remove it from Active (and Done), persist
  markOrderPaid: (id) => {
    state.paid.add(id);
    LS.set("od_paid", [...state.paid]);
    state.orderMap.delete(id);
    state.missing.delete(id);
    state.orders = [...state.orderMap.values()];
    state.done = state.done.filter((o) => String(o.id) !== String(id));
    LS.set("od_done", state.done);
    state.locallyDone = new Set(state.done.map((o) => o.id));
    renderActive();
    updateCounts();
  },
  // Undo a paid order (it returns to Active on the next refresh)
  unmarkPaid: (id) => {
    state.paid.delete(id);
    LS.set("od_paid", [...state.paid]);
  },
};
