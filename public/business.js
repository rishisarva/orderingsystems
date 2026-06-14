// ===========================================================================
//  business.js — Dashboard (Money + WhatsApp)
//  Reads live orders from app.js (window.App). Keeps records in the browser.
//  Profit rule: PREPAID profit counts immediately. PARTIAL profit counts only
//  once delivery is collected — the ₹150 upfront is shipping, never profit.
// ===========================================================================
(function () {
  const $ = (id) => document.getElementById(id);
  const LSget = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const LSset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  const store = {
    sales: LSget("od_sales", []),
    ads: LSget("od_ads", []),
    expenses: LSget("od_expenses", []),
    wa: LSget("od_wa", []),
    ratio: LSget("od_ratio", { savings: 30, expense: 20, ad: 50 }),
  };
  const save = () => { LSset("od_sales", store.sales); LSset("od_ads", store.ads); LSset("od_expenses", store.expenses); LSset("od_wa", store.wa); LSset("od_ratio", store.ratio); };

  const num = (x) => parseFloat(x) || 0;
  const money = (n) => "₹" + (Math.round(n * 100) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const realized = (s) => s.mode === "prepaid" || s.deliveryPaid; // profit counts?

  let win = "week";
  let sub = "money";
  function inWindow(iso) {
    if (win === "all") return true;
    const t = new Date(iso).getTime(), now = Date.now();
    if (win === "today") return startOfDay(t) === startOfDay(now);
    if (win === "week") return t >= now - 7 * 86400000;
    if (win === "month") return t >= now - 30 * 86400000;
    return true;
  }
  const winLabel = () => ({ today: "today", week: "last 7 days", month: "last 30 days", all: "all time" }[win]);
  const recordedIds = () => new Set(store.sales.map((s) => String(s.id)));

  function renderDashboard() { sub === "whatsapp" ? renderWhatsapp() : renderMoney(); }

  // ---- MONEY ---------------------------------------------------------------
  function renderMoney() {
    // "Record these" queue — processing orders not yet logged
    const done = recordedIds();
    const toRecord = (window.App.getPaidOrders() || []).filter((o) => !done.has(String(o.id)));
    $("toRecordSection").style.display = toRecord.length ? "" : "none";
    $("toRecordCount").textContent = toRecord.length ? `(${toRecord.length})` : "";
    $("toRecordList").innerHTML = toRecord.map((o) => `
      <div class="sale-row">
        <div class="sale-main"><span class="name">${o.customerName}</span> <span class="ordno">#${o.number}</span>
          <span class="badge b-prepaid">paid · ${o.status}</span></div>
        <div class="sale-nums"><span>total ${o.currencySymbol}${o.total}</span><span>jersey ${o.currencySymbol}${o.delivery}</span></div>
        <div class="sale-foot"><button class="btn primary" data-record="${o.id}" style="padding:6px 12px">Record this</button></div>
      </div>`).join("");

    const sales = store.sales.filter((s) => inWindow(s.completedAt));
    const ads = store.ads.filter((a) => inWindow(a.date + "T12:00:00"));
    const expenses = store.expenses.filter((e) => inWindow(e.date + "T12:00:00"));

    // Profit counts as soon as a sale is logged. The ₹150 shipping on a partial
    // is NEVER part of revenue/profit (revenue = jersey − discount only).
    const revenue = sales.reduce((s, x) => s + num(x.revenue), 0);
    const cogs = sales.reduce((s, x) => s + num(x.cost), 0);
    const grossProfit = revenue - cogs;
    const expenseTotal = expenses.reduce((s, x) => s + num(x.amount), 0);
    const netProfit = grossProfit - expenseTotal;
    const adSpend = ads.reduce((s, x) => s + num(x.amount), 0);
    const orders = sales.length;
    const roas = adSpend > 0 ? revenue / adSpend : 0;
    const cpo = orders > 0 ? adSpend / orders : 0;
    const pendingPartials = store.sales.filter((s) => s.mode === "partial" && !s.deliveryPaid);
    const pendingAmt = pendingPartials.reduce((s, x) => s + num(x.pending), 0);

    const card = (label, val, sub) =>
      `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-val">${val}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ""}</div>`;
    $("moneyStats").innerHTML =
      card("Orders closed", orders, winLabel()) +
      card("Revenue", money(revenue), "jersey, after discount") +
      card("Jersey cost", money(cogs), "what stock cost you") +
      card("Gross profit", money(grossProfit), "revenue − jersey cost") +
      card("Expenses", money(expenseTotal), winLabel()) +
      card("Net profit", money(netProfit), "gross profit − expenses") +
      card("Ad spend", money(adSpend), winLabel()) +
      card("Profit after ads", money(netProfit - adSpend), netProfit - adSpend < 0 ? "running at a loss" : "") +
      card("ROAS", adSpend > 0 ? roas.toFixed(2) + "×" : "—", "revenue ÷ ad spend") +
      card("Cost / order", adSpend > 0 && orders ? money(cpo) : "—", "ad spend ÷ orders") +
      (pendingAmt > 0 ? card("Awaiting delivery", money(pendingAmt), pendingPartials.length + " partial order(s)") : "");

    // split — applied to NET profit (what's actually left to allocate)
    const profit = netProfit;
    const r = store.ratio, sum = num(r.savings) + num(r.expense) + num(r.ad);
    $("rSavings").value = r.savings; $("rExpense").value = r.expense; $("rAd").value = r.ad;
    $("ratioSum").textContent = "Total: " + sum + "%";
    $("ratioWarn").textContent = (sum === 100 ? "" : "(should add up to 100%) ") + "— split of net profit";
    const acc = (label, pct, cls) =>
      `<div class="account ${cls}"><div class="acc-pct">${pct}%</div><div class="acc-label">${label}</div><div class="acc-val">${money(profit * pct / 100)}</div></div>`;
    $("accounts").innerHTML = acc("Savings", num(r.savings), "a-save") + acc("Expense", num(r.expense), "a-exp") + acc("Ad account", num(r.ad), "a-ad");

    // ad list
    $("adList").innerHTML = store.ads.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8)
      .map((a) => `<div class="mini-row"><span>${a.date}</span><span>${money(num(a.amount))}</span><button class="linkbtn" data-del-ad="${a.id}">remove</button></div>`)
      .join("") || `<div class="muted small">No ad spend logged yet.</div>`;

    // expense list
    $("expList").innerHTML = store.expenses.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8)
      .map((e) => `<div class="mini-row"><span>${e.date}</span><span>${money(num(e.amount))}</span><span class="muted" style="flex:1">${e.note || ""}</span><button class="linkbtn" data-del-exp="${e.id}">remove</button></div>`)
      .join("") || `<div class="muted small">No expenses logged yet.</div>`;

    // sales list
    const list = sales.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
    $("salesCount").textContent = list.length ? `(${list.length})` : "";
    $("salesEmpty").classList.toggle("hidden", list.length > 0);
    $("salesList").innerHTML = list.map((s) => `
      <div class="sale-row">
        <div class="sale-main">
          <span class="name">${s.customerName || "Customer"}</span> <span class="ordno">#${s.number}</span>
          <span class="badge ${s.mode === "partial" ? "b-partial" : "b-prepaid"}">${s.mode}</span>
          ${s.mode === "partial" && !s.deliveryPaid ? `<span class="badge b-partial">awaiting delivery</span>` : ""}
        </div>
        <div class="sale-nums">
          <span>rev ${money(num(s.revenue))}</span>
          <span>cost ${money(num(s.cost))}</span>
          <span class="profit">profit ${money(num(s.profit))}</span>
          ${s.mode === "partial" && !s.deliveryPaid ? `<span class="pending">+₹${num(s.shipping || 150)} shipping in · to collect ${money(num(s.pending))}</span>` : ""}
        </div>
        <div class="sale-foot">
          <span class="muted small">${new Date(s.completedAt).toLocaleString()}</span>
          ${s.mode === "partial" && !s.deliveryPaid ? `<button class="linkbtn" data-collect="${s.id}">mark delivery collected → count profit</button>` : ""}
          <button class="linkbtn" data-undo-sale="${s.id}">remove</button>
        </div>
      </div>`).join("");
  }

  // ---- WHATSAPP ------------------------------------------------------------
  function renderWhatsapp() {
    const list = store.wa.slice().sort((a, b) => b.date.localeCompare(a.date));
    const totalJoins = list.reduce((s, x) => s + Math.max(0, num(x.after) - num(x.before)), 0);
    const totalSpend = list.reduce((s, x) => s + num(x.spend), 0);
    const avg = totalJoins > 0 ? totalSpend / totalJoins : 0;
    const card = (label, val, sub) => `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-val">${val}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ""}</div>`;
    $("waStats").innerHTML = card("New joins", totalJoins, "all entries") + card("Ad spend", money(totalSpend), "on these days") + card("Avg cost / join", totalJoins ? money(avg) : "—", "spend ÷ new joins");
    $("waEmpty").classList.toggle("hidden", list.length > 0);
    $("waList").innerHTML = list.map((w) => {
      const joins = Math.max(0, num(w.after) - num(w.before)), cpj = joins > 0 ? num(w.spend) / joins : 0;
      return `<div class="sale-row">
        <div class="sale-main"><span class="name">${w.date}</span><span class="badge b-prepaid">${joins} joins</span></div>
        <div class="sale-nums"><span>${w.before} → ${w.after}</span><span>spend ${money(num(w.spend))}</span><span class="profit">${joins ? money(cpj) + "/join" : "—"}</span></div>
        <div class="sale-foot"><button class="linkbtn" data-del-wa="${w.id}">remove</button></div>
      </div>`;
    }).join("");
  }

  // ---- Add / record paid order modal --------------------------------------
  let picked = null;
  function openPaid() { picked = null; $("paidStep1").classList.remove("hidden"); $("paidStep2").classList.add("hidden"); $("paidSearch").value = ""; $("shipNote").textContent = window.App.getShipping(); renderPickList(""); show(); }
  function show() { $("paidOverlay").classList.remove("hidden"); $("paidModal").classList.remove("hidden"); }
  function closePaid() { $("paidOverlay").classList.add("hidden"); $("paidModal").classList.add("hidden"); }
  function recordable() { const done = recordedIds(); return (window.App.getRecordableOrders() || []).filter((o) => !done.has(String(o.id))); }
  function renderPickList(q) {
    const ql = q.toLowerCase();
    const list = recordable().filter((o) => `${o.customerName} ${o.number} ${o.rawPhone} ${o.phone}`.toLowerCase().includes(ql));
    $("paidPickList").innerHTML = list.length ? list.map((o) => `
      <div class="pick-item" data-pick="${o.id}">
        <div><span class="name">${o.customerName}</span> <span class="ordno">#${o.number}</span> <span class="badge ${o.status === "processing" ? "b-prepaid" : "b-partial"}">${o.status}</span></div>
        <div class="muted small">total ${o.currencySymbol}${o.total} · jersey ${o.currencySymbol}${o.delivery}</div>
      </div>`).join("") : `<div class="muted small" style="padding:14px">No matching orders.</div>`;
  }
  function selectOrder(id) {
    const o = recordable().find((x) => String(x.id) === String(id));
    if (!o) return;
    picked = o;
    $("paidStep1").classList.add("hidden"); $("paidStep2").classList.remove("hidden");
    $("paidPicked").innerHTML = `<span class="name">${o.customerName}</span> <span class="ordno">#${o.number}</span><br>
      <span class="muted small">Total ${o.currencySymbol}${o.total} · jersey ${o.currencySymbol}${o.delivery}${num(o.discount) ? " (after " + o.currencySymbol + o.discount + " discount)" : ""}</span>`;
    $("paidCost").value = "";
    // default mode: processing orders are usually prepaid
    document.querySelector('input[name="paidMode"][value="prepaid"]').checked = true;
    updateProfitPreview();
  }
  function recordOrder(id) { show(); selectOrder(id); }
  function updateProfitPreview() {
    if (!picked) return;
    const revenue = num(picked.delivery), cost = num($("paidCost").value), profit = revenue - cost;
    const mode = document.querySelector('input[name="paidMode"]:checked').value;
    const ship = num(window.App.getShipping());
    if (mode === "prepaid") {
      $("profitPreview").innerHTML =
        `<div class="pp-row"><span>Revenue (jersey)</span><b>${money(revenue)}</b></div>
         <div class="pp-row"><span>Jersey cost</span><b>−${money(cost)}</b></div>
         <div class="pp-row pp-profit"><span>Profit (counts now)</span><b>${money(profit)}</b></div>`;
    } else {
      $("profitPreview").innerHTML =
        `<div class="pp-row muted"><span>Collected now</span><b>${money(ship)} shipping (not profit)</b></div>
         <div class="pp-row"><span>To collect on delivery</span><b>${money(revenue)}</b></div>
         <div class="pp-row"><span>Jersey cost</span><b>−${money(cost)}</b></div>
         <div class="pp-row pp-profit"><span>Profit (counts after delivery)</span><b>${money(profit)}</b></div>`;
    }
  }
  function savePaid() {
    if (!picked) return;
    const mode = document.querySelector('input[name="paidMode"]:checked').value;
    const revenue = num(picked.delivery), cost = num($("paidCost").value);
    const ship = num(window.App.getShipping());
    store.sales.unshift({
      id: picked.id, number: picked.number, customerName: picked.customerName,
      mode, revenue, cost, profit: revenue - cost,
      shipping: ship,
      collectedNow: mode === "prepaid" ? num(picked.total) : ship,
      pending: mode === "prepaid" ? 0 : revenue,
      deliveryPaid: mode === "prepaid",   // prepaid is fully realized at once
      completedAt: new Date().toISOString(),
    });
    save();
    window.App.markOrderPaid(picked.id);
    closePaid();
    renderMoney();
  }

  // ---- events --------------------------------------------------------------
  $("dashSeg").addEventListener("click", (e) => {
    const s = e.target.getAttribute("data-sub"); if (!s) return;
    sub = s;
    [...$("dashSeg").children].forEach((c) => c.classList.toggle("active", c === e.target));
    $("moneySub").classList.toggle("hidden", s !== "money");
    $("whatsappSub").classList.toggle("hidden", s !== "whatsapp");
    renderDashboard();
  });
  $("moneySeg").addEventListener("click", (e) => {
    const w = e.target.getAttribute("data-win"); if (!w) return;
    win = w; [...$("moneySeg").children].forEach((c) => c.classList.toggle("active", c === e.target)); renderMoney();
  });
  $("addPaidBtn").addEventListener("click", openPaid);
  $("paidClose").addEventListener("click", closePaid);
  $("paidOverlay").addEventListener("click", closePaid);
  $("paidBack").addEventListener("click", () => { $("paidStep2").classList.add("hidden"); $("paidStep1").classList.remove("hidden"); });
  $("paidSearch").addEventListener("input", (e) => renderPickList(e.target.value.trim()));
  $("paidPickList").addEventListener("click", (e) => { const i = e.target.closest("[data-pick]"); if (i) selectOrder(i.getAttribute("data-pick")); });
  $("paidCost").addEventListener("input", updateProfitPreview);
  document.querySelectorAll('input[name="paidMode"]').forEach((r) => r.addEventListener("change", updateProfitPreview));
  $("paidSave").addEventListener("click", savePaid);
  $("toRecordList").addEventListener("click", (e) => { const id = e.target.getAttribute("data-record"); if (id) recordOrder(id); });

  ["rSavings", "rExpense", "rAd"].forEach((id) => $(id).addEventListener("input", () => {
    store.ratio = { savings: num($("rSavings").value), expense: num($("rExpense").value), ad: num($("rAd").value) }; save(); renderMoney();
  }));

  $("adDate").value = todayStr();
  $("adSaveBtn").addEventListener("click", () => {
    const date = $("adDate").value || todayStr(), amount = num($("adAmount").value); if (!amount) return;
    store.ads.unshift({ id: Date.now(), date, amount }); save(); $("adAmount").value = ""; renderMoney();
  });
  $("adList").addEventListener("click", (e) => { const id = e.target.getAttribute("data-del-ad"); if (!id) return; store.ads = store.ads.filter((a) => String(a.id) !== String(id)); save(); renderMoney(); });

  $("expDate").value = todayStr();
  $("expSaveBtn").addEventListener("click", () => {
    const date = $("expDate").value || todayStr(), amount = num($("expAmount").value), note = $("expNote").value.trim();
    if (!amount) return;
    store.expenses.unshift({ id: Date.now(), date, amount, note }); save();
    $("expAmount").value = ""; $("expNote").value = ""; renderMoney();
  });
  $("expList").addEventListener("click", (e) => { const id = e.target.getAttribute("data-del-exp"); if (!id) return; store.expenses = store.expenses.filter((x) => String(x.id) !== String(id)); save(); renderMoney(); });
  $("salesList").addEventListener("click", (e) => {
    const collect = e.target.getAttribute("data-collect"), undo = e.target.getAttribute("data-undo-sale");
    if (collect) { const s = store.sales.find((x) => String(x.id) === String(collect)); if (s) { s.deliveryPaid = true; save(); renderMoney(); } }
    else if (undo) { store.sales = store.sales.filter((x) => String(x.id) !== String(undo)); save(); window.App.unmarkPaid(Number(undo)); window.App.unmarkPaid(undo); renderMoney(); }
  });

  $("waDate").value = todayStr();
  $("waAddBtn").addEventListener("click", () => {
    const date = $("waDate").value || todayStr(), before = num($("waBefore").value), after = num($("waAfter").value), spend = num($("waSpend").value);
    if (!after && !spend) return;
    store.wa.unshift({ id: Date.now(), date, before, after, spend }); save();
    $("waBefore").value = ""; $("waAfter").value = ""; $("waSpend").value = ""; renderWhatsapp();
  });
  $("waList").addEventListener("click", (e) => { const id = e.target.getAttribute("data-del-wa"); if (!id) return; store.wa = store.wa.filter((w) => String(w.id) !== String(id)); save(); renderWhatsapp(); });

  window.Business = {
    renderDashboard, renderMoney, renderWhatsapp,
    setPaidOrders: () => { renderMoney(); }, // refresh the "record these" queue
  };
})();
