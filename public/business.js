// ===========================================================================
//  business.js — Money dashboard + WhatsApp join tracker
//  Reads the live orders from app.js (window.App) and keeps its own records
//  in the browser (localStorage): sales, ad spend, WhatsApp joins, split ratio.
// ===========================================================================
(function () {
  const $ = (id) => document.getElementById(id);
  const LSget = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const LSset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  const store = {
    sales: LSget("od_sales", []),       // [{id,number,customerName,mode,revenue,cost,profit,collectedNow,pending,deliveryPaid,completedAt}]
    ads: LSget("od_ads", []),           // [{id,date,amount}]
    wa: LSget("od_wa", []),             // [{id,date,before,after,spend}]
    ratio: LSget("od_ratio", { savings: 30, expense: 20, ad: 50 }),
  };
  const save = () => {
    LSset("od_sales", store.sales);
    LSset("od_ads", store.ads);
    LSset("od_wa", store.wa);
    LSset("od_ratio", store.ratio);
  };

  const num = (x) => parseFloat(x) || 0;
  const money = (n) => "₹" + (Math.round(n * 100) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };

  // ---- window filtering ----------------------------------------------------
  let win = "week";
  function inWindow(iso) {
    if (win === "all") return true;
    const t = new Date(iso).getTime();
    const now = Date.now();
    if (win === "today") return startOfDay(t) === startOfDay(now);
    if (win === "week") return t >= now - 7 * 86400000;
    if (win === "month") return t >= now - 30 * 86400000;
    return true;
  }
  const winLabel = () => ({ today: "today", week: "last 7 days", month: "last 30 days", all: "all time" }[win]);

  // ---- MONEY tab -----------------------------------------------------------
  function renderMoney() {
    const sales = store.sales.filter((s) => inWindow(s.completedAt));
    const ads = store.ads.filter((a) => inWindow(a.date + "T12:00:00"));

    const revenue = sales.reduce((s, x) => s + num(x.revenue), 0);
    const cogs = sales.reduce((s, x) => s + num(x.cost), 0);
    const profit = revenue - cogs;
    const adSpend = ads.reduce((s, x) => s + num(x.amount), 0);
    const orders = sales.length;
    const roas = adSpend > 0 ? revenue / adSpend : 0;
    const cpo = orders > 0 ? adSpend / orders : 0;
    const pendingAll = store.sales.filter((s) => s.mode === "partial" && !s.deliveryPaid)
      .reduce((s, x) => s + num(x.pending), 0);

    const card = (label, val, sub) =>
      `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-val">${val}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ""}</div>`;

    $("moneyStats").innerHTML =
      card("Orders closed", orders, winLabel()) +
      card("Revenue", money(revenue), "product, after discount") +
      card("Jersey cost", money(cogs), "what stock cost you") +
      card("Profit", money(profit), "revenue − cost") +
      card("Ad spend", money(adSpend), winLabel()) +
      card("Profit after ads", money(profit - adSpend), profit - adSpend < 0 ? "running at a loss" : "") +
      card("ROAS", adSpend > 0 ? roas.toFixed(2) + "×" : "—", "revenue ÷ ad spend") +
      card("Cost / order", adSpend > 0 && orders ? money(cpo) : "—", "ad spend ÷ orders") +
      (pendingAll > 0 ? card("To collect on delivery", money(pendingAll), "partial orders, all time") : "");

    // account split (of profit)
    const r = store.ratio;
    const sum = num(r.savings) + num(r.expense) + num(r.ad);
    $("rSavings").value = r.savings; $("rExpense").value = r.expense; $("rAd").value = r.ad;
    $("ratioSum").textContent = "Total: " + sum + "%";
    $("ratioWarn").textContent = sum === 100 ? "" : "(should add up to 100%)";
    $("ratioWarn").style.color = sum === 100 ? "" : "var(--amber)";
    const acc = (label, pct, cls) =>
      `<div class="account ${cls}"><div class="acc-pct">${pct}%</div><div class="acc-label">${label}</div><div class="acc-val">${money(profit * pct / 100)}</div></div>`;
    $("accounts").innerHTML =
      acc("Savings", num(r.savings), "a-save") +
      acc("Expense", num(r.expense), "a-exp") +
      acc("Ad account", num(r.ad), "a-ad");

    // ad spend list
    $("adList").innerHTML = store.ads.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8)
      .map((a) => `<div class="mini-row"><span>${a.date}</span><span>${money(num(a.amount))}</span><button class="linkbtn" data-del-ad="${a.id}">remove</button></div>`)
      .join("") || `<div class="muted small">No ad spend logged yet.</div>`;

    // sales list
    const list = store.sales.filter((s) => inWindow(s.completedAt)).sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
    $("salesCount").textContent = list.length ? `(${list.length})` : "";
    $("salesEmpty").classList.toggle("hidden", list.length > 0);
    $("salesList").innerHTML = list.map((s) => `
      <div class="sale-row">
        <div class="sale-main">
          <span class="name">${s.customerName || "Customer"}</span>
          <span class="ordno">#${s.number}</span>
          <span class="badge ${s.mode === "partial" ? "b-partial" : "b-prepaid"}">${s.mode}</span>
        </div>
        <div class="sale-nums">
          <span>rev ${money(num(s.revenue))}</span>
          <span>cost ${money(num(s.cost))}</span>
          <span class="profit">profit ${money(num(s.profit))}</span>
          ${s.mode === "partial" ? `<span class="${s.deliveryPaid ? "muted" : "pending"}">${s.deliveryPaid ? "delivery paid" : "to collect " + money(num(s.pending))}</span>` : ""}
        </div>
        <div class="sale-foot">
          <span class="muted small">${new Date(s.completedAt).toLocaleString()}</span>
          ${s.mode === "partial" && !s.deliveryPaid ? `<button class="linkbtn" data-collect="${s.id}">mark delivery collected</button>` : ""}
          <button class="linkbtn" data-undo-sale="${s.id}">remove</button>
        </div>
      </div>`).join("");
  }

  // ---- WHATSAPP tab --------------------------------------------------------
  function renderWhatsapp() {
    const list = store.wa.slice().sort((a, b) => b.date.localeCompare(a.date));
    const totalJoins = list.reduce((s, x) => s + Math.max(0, num(x.after) - num(x.before)), 0);
    const totalSpend = list.reduce((s, x) => s + num(x.spend), 0);
    const avg = totalJoins > 0 ? totalSpend / totalJoins : 0;

    const card = (label, val, sub) =>
      `<div class="stat-card"><div class="stat-label">${label}</div><div class="stat-val">${val}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ""}</div>`;
    $("waStats").innerHTML =
      card("New joins", totalJoins, "all entries") +
      card("Ad spend", money(totalSpend), "on these days") +
      card("Avg cost / join", totalJoins ? money(avg) : "—", "spend ÷ new joins");

    $("waEmpty").classList.toggle("hidden", list.length > 0);
    $("waList").innerHTML = list.map((w) => {
      const joins = Math.max(0, num(w.after) - num(w.before));
      const cpj = joins > 0 ? num(w.spend) / joins : 0;
      return `<div class="sale-row">
        <div class="sale-main"><span class="name">${w.date}</span><span class="badge b-prepaid">${joins} joins</span></div>
        <div class="sale-nums"><span>${w.before} → ${w.after}</span><span>spend ${money(num(w.spend))}</span><span class="profit">${joins ? money(cpj) + "/join" : "—"}</span></div>
        <div class="sale-foot"><button class="linkbtn" data-del-wa="${w.id}">remove</button></div>
      </div>`;
    }).join("");
  }

  // ---- Add-paid-order modal ------------------------------------------------
  let picked = null;
  function openPaid() {
    picked = null;
    $("paidStep1").classList.remove("hidden");
    $("paidStep2").classList.add("hidden");
    $("paidSearch").value = "";
    $("shipNote").textContent = window.App.getShipping();
    renderPickList("");
    $("paidOverlay").classList.remove("hidden");
    $("paidModal").classList.remove("hidden");
  }
  function closePaid() {
    $("paidOverlay").classList.add("hidden");
    $("paidModal").classList.add("hidden");
  }
  function renderPickList(q) {
    const orders = window.App.getActiveOrders();
    const ql = q.toLowerCase();
    const list = orders.filter((o) =>
      `${o.customerName} ${o.number} ${o.rawPhone} ${o.phone}`.toLowerCase().includes(ql));
    $("paidPickList").innerHTML = list.length ? list.map((o) => `
      <div class="pick-item" data-pick="${o.id}">
        <div><span class="name">${o.customerName}</span> <span class="ordno">#${o.number}</span></div>
        <div class="muted small">${o.currencySymbol}${o.total} · ${o.status} · jersey ${o.currencySymbol}${o.delivery}</div>
      </div>`).join("")
      : `<div class="muted small" style="padding:14px">No matching orders. (Only orders still in Active can be added.)</div>`;
  }
  function selectOrder(id) {
    const o = window.App.getActiveOrders().find((x) => String(x.id) === String(id));
    if (!o) return;
    picked = o;
    $("paidStep1").classList.add("hidden");
    $("paidStep2").classList.remove("hidden");
    $("paidPicked").innerHTML =
      `<span class="name">${o.customerName}</span> <span class="ordno">#${o.number}</span><br>
       <span class="muted small">Total ${o.currencySymbol}${o.total} · jersey amount ${o.currencySymbol}${o.delivery}${num(o.discount) ? " (after " + o.currencySymbol + o.discount + " discount)" : ""}</span>`;
    $("paidCost").value = "";
    updateProfitPreview();
  }
  function updateProfitPreview() {
    if (!picked) return;
    const sym = picked.currencySymbol || "₹";
    const revenue = num(picked.delivery);          // jersey − discount
    const cost = num($("paidCost").value);
    const profit = revenue - cost;
    const mode = document.querySelector('input[name="paidMode"]:checked').value;
    const ship = num(window.App.getShipping());
    const collectedNow = mode === "prepaid" ? num(picked.total) : ship;
    const pending = mode === "prepaid" ? 0 : revenue;
    $("profitPreview").innerHTML =
      `<div class="pp-row"><span>Product revenue</span><b>${money(revenue)}</b></div>
       <div class="pp-row"><span>Jersey cost</span><b>−${money(cost)}</b></div>
       <div class="pp-row pp-profit"><span>Profit</span><b>${money(profit)}</b></div>
       <div class="pp-row muted"><span>Collected now</span><b>${money(collectedNow)}</b></div>
       ${mode === "partial" ? `<div class="pp-row muted"><span>On delivery (in ~7 days)</span><b>${money(pending)}</b></div>` : ""}`;
  }
  function savePaid() {
    if (!picked) return;
    const mode = document.querySelector('input[name="paidMode"]:checked').value;
    const revenue = num(picked.delivery);
    const cost = num($("paidCost").value);
    const ship = num(window.App.getShipping());
    store.sales.unshift({
      id: picked.id, number: picked.number, customerName: picked.customerName,
      mode, revenue, cost, profit: revenue - cost,
      collectedNow: mode === "prepaid" ? num(picked.total) : ship,
      pending: mode === "prepaid" ? 0 : revenue,
      deliveryPaid: false,
      completedAt: new Date().toISOString(),
    });
    save();
    window.App.markOrderPaid(picked.id);   // remove from Active
    closePaid();
    renderMoney();
  }

  // ---- events --------------------------------------------------------------
  $("moneySeg").addEventListener("click", (e) => {
    const w = e.target.getAttribute("data-win"); if (!w) return;
    win = w;
    [...$("moneySeg").children].forEach((c) => c.classList.toggle("active", c === e.target));
    renderMoney();
  });
  $("addPaidBtn").addEventListener("click", openPaid);
  $("paidClose").addEventListener("click", closePaid);
  $("paidOverlay").addEventListener("click", closePaid);
  $("paidBack").addEventListener("click", () => { $("paidStep2").classList.add("hidden"); $("paidStep1").classList.remove("hidden"); });
  $("paidSearch").addEventListener("input", (e) => renderPickList(e.target.value.trim()));
  $("paidPickList").addEventListener("click", (e) => {
    const item = e.target.closest("[data-pick]"); if (item) selectOrder(item.getAttribute("data-pick"));
  });
  $("paidCost").addEventListener("input", updateProfitPreview);
  document.querySelectorAll('input[name="paidMode"]').forEach((r) => r.addEventListener("change", updateProfitPreview));
  $("paidSave").addEventListener("click", savePaid);

  ["rSavings", "rExpense", "rAd"].forEach((id) =>
    $(id).addEventListener("input", () => {
      store.ratio = { savings: num($("rSavings").value), expense: num($("rExpense").value), ad: num($("rAd").value) };
      save(); renderMoney();
    }));

  $("adDate").value = todayStr();
  $("adSaveBtn").addEventListener("click", () => {
    const date = $("adDate").value || todayStr();
    const amount = num($("adAmount").value);
    if (!amount) return;
    store.ads.unshift({ id: Date.now(), date, amount });
    save(); $("adAmount").value = ""; renderMoney();
  });
  $("adList").addEventListener("click", (e) => {
    const id = e.target.getAttribute("data-del-ad"); if (!id) return;
    store.ads = store.ads.filter((a) => String(a.id) !== String(id)); save(); renderMoney();
  });
  $("salesList").addEventListener("click", (e) => {
    const collect = e.target.getAttribute("data-collect");
    const undo = e.target.getAttribute("data-undo-sale");
    if (collect) {
      const s = store.sales.find((x) => String(x.id) === String(collect));
      if (s) { s.deliveryPaid = true; save(); renderMoney(); }
    } else if (undo) {
      store.sales = store.sales.filter((x) => String(x.id) !== String(undo));
      save(); window.App.unmarkPaid(Number(undo)); window.App.unmarkPaid(undo); renderMoney();
    }
  });

  $("waDate").value = todayStr();
  $("waAddBtn").addEventListener("click", () => {
    const date = $("waDate").value || todayStr();
    const before = num($("waBefore").value), after = num($("waAfter").value), spend = num($("waSpend").value);
    if (!after && !spend) return;
    store.wa.unshift({ id: Date.now(), date, before, after, spend });
    save(); $("waBefore").value = ""; $("waAfter").value = ""; $("waSpend").value = ""; renderWhatsapp();
  });
  $("waList").addEventListener("click", (e) => {
    const id = e.target.getAttribute("data-del-wa"); if (!id) return;
    store.wa = store.wa.filter((w) => String(w.id) !== String(id)); save(); renderWhatsapp();
  });

  window.Business = { renderMoney, renderWhatsapp };
})();
