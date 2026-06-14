// ---------------------------------------------------------------------------
//  Woo → WhatsApp order-recovery dashboard
//  - Talks to your WooCommerce store from the SERVER (keys never reach browser)
//  - Returns unpaid orders + a ready-to-go wa.me link for each customer
// ---------------------------------------------------------------------------

// Load variables from a local .env file if present (no-op on Render, where
// you set env vars in the dashboard instead). Wrapped so it never crashes.
try { require("dotenv").config(); } catch (_) {}

const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");

const app = express();
app.use(express.json({ limit: "1mb" }));

// Where we persist the editable message and the "contacted" list
const DATA_DIR = path.join(__dirname, "data");
const CONTACTED_FILE = path.join(DATA_DIR, "contacted.json");
const TEMPLATE_FILE = path.join(DATA_DIR, "template.txt");
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

// ---- Config (set these as environment variables on Render) ----------------
const CFG = {
  // Your store URL, e.g. https://mystore.com   (no trailing slash).
  // If you forget the https://, we add it for you.
  storeUrl: (() => {
    let u = (process.env.WC_STORE_URL || "").trim().replace(/\/+$/, "");
    if (u && !/^https?:\/\//i.test(u)) u = "https://" + u;
    return u;
  })(),
  key: (process.env.WC_CONSUMER_KEY || "").trim(),
  secret: (process.env.WC_CONSUMER_SECRET || "").trim(),

  // Which order statuses count as "payment not done yet"
  statuses: (process.env.WC_STATUSES || "pending,on-hold").trim(),

  // Default country code used when a phone number has no international prefix.
  // 91 = India. Change to your country (44 UK, 1 US, 31 NL, ...).
  countryCode: (process.env.DEFAULT_COUNTRY_CODE || "91").replace(/\D/g, ""),

  // How many orders to pull per page (max 100)
  perPage: parseInt(process.env.WC_PER_PAGE || "100", 10),

  // Shipping charge quoted in the "Partial" option
  shippingCharge: process.env.SHIPPING_CHARGE || "150",

  // Your store / brand name used to sign off the message
  brand: process.env.BRAND_NAME || "our store",

  // Your UPI ID for payments (e.g. yourname@okhdfcbank)
  upi: (process.env.UPI_ID || "").trim(),
};

// Tokens the user can use in their message; shown in the editor.
const TOKENS = ["{name}", "{order}", "{total}", "{shipping}", "{delivery}", "{jersey}", "{discount}", "{upi}", "{brand}"];

// The starting message if none has been saved yet (concise, simple).
const DEFAULT_TEMPLATE =
`Hi {name}! 👋
Your order {order} ({total}) is still pending payment — let's get it shipped to you!

Choose how you'd like to pay:

1) PARTIAL
• Pay only {shipping} now — this is the shipping charge, NOT an advance.
• Then pay {delivery} on delivery (cash).
• Why {delivery}? That's just your jersey amount (after discount, if any). Shipping is already covered by the {shipping} you pay now, so there's nothing extra to pay at delivery.

2) PREPAID
• Pay the full {total} now and pay nothing on delivery.

Pay here (UPI): {upi}
After paying, reply 1 or 2 so we know which option you chose — we'll confirm and ship it out 📦

Any issue? Just type "problem" and we'll help you.
{brand}`;

// ---- Persistence helpers ---------------------------------------------------
async function readContacted() {
  try { return JSON.parse(await fsp.readFile(CONTACTED_FILE, "utf8")); }
  catch { return {}; }
}
async function writeContacted(obj) {
  await fsp.writeFile(CONTACTED_FILE, JSON.stringify(obj, null, 2), "utf8");
}
async function readTemplate() {
  try {
    const t = await fsp.readFile(TEMPLATE_FILE, "utf8");
    return t && t.trim() ? t : DEFAULT_TEMPLATE;
  } catch { return DEFAULT_TEMPLATE; }
}
async function writeTemplate(t) {
  await fsp.writeFile(TEMPLATE_FILE, t, "utf8");
}

// ---- Currency code -> symbol (extend as needed) ---------------------------
const CURRENCY_SYMBOLS = {
  INR: "₹", USD: "$", EUR: "€", GBP: "£", AED: "د.إ",
  PKR: "₨", BDT: "৳", LKR: "Rs", NPR: "Rs", AUD: "A$", CAD: "C$",
};

// ---------------------------------------------------------------------------
//  Phone normalisation -> digits only, in international format (no +)
//  This is heuristic. It handles the common WooCommerce cases:
//   "+91 98765 43210" / "098765-43210" / "9876543210" / "0091 9876543210"
// ---------------------------------------------------------------------------
function normalisePhone(raw) {
  if (!raw) return null;
  let s = String(raw).trim();

  const hadPlus = s.startsWith("+");
  let digits = s.replace(/\D/g, "");
  if (!digits) return null;

  // "00" international prefix -> treat like a leading +
  if (!hadPlus && digits.startsWith("00")) {
    digits = digits.slice(2);
    return digits;
  }

  // Already has a + -> assume it's already full international
  if (hadPlus) return digits;

  // Strip a single domestic leading zero (e.g. 098765... -> 98765...)
  if (digits.startsWith("0")) digits = digits.replace(/^0+/, "");

  // If it already starts with our country code AND is long enough, keep it.
  const cc = CFG.countryCode;
  if (cc && digits.startsWith(cc) && digits.length > 10) return digits;

  // Otherwise assume it's a local number missing the country code -> prepend.
  return cc ? cc + digits : digits;
}

// ---- Render the saved template for a specific order ------------------------
function renderTemplate(tpl, order) {
  const sym = order.currencySymbol || "";
  const map = {
    "{name}": order.firstName || order.customerName || "there",
    "{order}": "#" + order.number,
    "{total}": sym + order.total,
    "{shipping}": sym + CFG.shippingCharge,
    "{delivery}": sym + order.delivery,
    "{jersey}": sym + order.jersey,
    "{discount}": sym + order.discount,
    "{upi}": CFG.upi || "(add your UPI ID)",
    "{brand}": CFG.brand,
  };
  let out = tpl;
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  return out;
}

// Attach the rendered message + WhatsApp link to a shaped order
function attachMessage(order, tpl) {
  const msg = renderTemplate(tpl, order);
  return {
    ...order,
    message: msg,
    waLink: order.phone
      ? `https://wa.me/${order.phone}?text=${encodeURIComponent(msg)}`
      : null,
  };
}

// ---- Turn a raw Woo order into the trimmed shape the dashboard needs -------
function shapeOrder(o) {
  const first = o.billing?.first_name || "";
  const last = o.billing?.last_name || "";
  const name = `${first} ${last}`.trim();
  const phone = normalisePhone(o.billing?.phone);
  const sym = CURRENCY_SYMBOLS[o.currency] || o.currency_symbol || o.currency || "";

  const items = (o.line_items || [])
    .map((li) => `${li.quantity}× ${li.name}`)
    .join(", ");

  // ON-DELIVERY amount = product/jersey price − discount.
  // We use ONLY the product lines here — never the order total — so shipping
  // and tax are never included. (Shipping is the flat amount paid upfront in
  // the Partial option.) This subtracts the discount whether it was applied
  // as a coupon (discount_total) or as a per-line/sale discount (line totals).
  const grossProduct = (o.line_items || [])
    .reduce((s, li) => s + (parseFloat(li.subtotal) || 0), 0);   // product price, before discount
  const lineNet = (o.line_items || [])
    .reduce((s, li) => s + (parseFloat(li.total) || 0), 0);      // product price, after line discounts
  const couponDiscount = parseFloat(o.discount_total) || 0;

  const deliveryAmt = Math.max(
    0,
    Math.min(lineNet || grossProduct, grossProduct - couponDiscount)
  );
  const jerseyAmt = grossProduct || lineNet;          // jersey/product amount (before discount)
  const discountAmt = Math.max(0, jerseyAmt - deliveryAmt); // the discount actually taken off

  return {
    id: o.id,
    number: o.number || String(o.id),
    customerName: name || "Customer",
    firstName: first,
    phone,                       // normalised, digits only
    rawPhone: o.billing?.phone || "",
    total: o.total,
    jersey: jerseyAmt.toFixed(2),     // jersey amount (before discount)
    discount: discountAmt.toFixed(2), // discount on the order
    delivery: deliveryAmt.toFixed(2), // amount to collect on delivery
    currencySymbol: sym,
    status: o.status,
    items,
    itemCount: (o.line_items || []).reduce((n, li) => n + (li.quantity || 0), 0),
    // Absolute UTC instant (…Z) so the browser shows the correct "X ago"
    // regardless of the store's or server's timezone. Falls back to local.
    dateCreated: o.date_created_gmt ? o.date_created_gmt + "Z" : o.date_created,
  };
}

// ---- Order fetching (pagination + crash isolation + caching) ---------------
const ORDER_FIELDS =
  "id,number,status,currency,currency_symbol,total,discount_total,date_created,date_created_gmt,billing,line_items";
const MAX_PAGES = parseInt(process.env.WC_MAX_PAGES || "20", 10); // safety cap
const ISO_TTL_MS = 60000; // cache crash-prone statuses for 60s
const isoCache = {};      // status -> { at, orders, skipped }

function isServerCrash(text, httpStatus) {
  return httpStatus === 500 ||
    /critical error|internal_server_error|"status":\s*500|method_exists|Uncaught/i.test(text || "");
}

// Fetch a single page of one status.
async function fetchOrdersPage(status, page, perPage, attempt = 0) {
  const auth = Buffer.from(`${CFG.key}:${CFG.secret}`).toString("base64");
  const url =
    `${CFG.storeUrl}/wp-json/wc/v3/orders` +
    `?status=${encodeURIComponent(status)}` +
    `&per_page=${perPage}&page=${page}&orderby=date&order=desc` +
    `&_fields=${encodeURIComponent(ORDER_FIELDS)}` +
    `&consumer_key=${encodeURIComponent(CFG.key)}` +
    `&consumer_secret=${encodeURIComponent(CFG.secret)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const r = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        "User-Agent": "Mozilla/5.0 (OrderRadar)",
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (r.redirected) console.log(`[redirect] '${status}' landed at: ${r.url}`);
    if (!r.ok) {
      // Transient server hiccup -> back off and retry before reporting
      if ([429, 502, 503, 504].includes(r.status) && attempt < 2) {
        await new Promise((res) => setTimeout(res, 350 * (attempt + 1)));
        return fetchOrdersPage(status, page, perPage, attempt + 1);
      }
      const body = await r.text();
      return {
        ok: false,
        httpStatus: r.status,
        redirectedTo: r.redirected ? r.url : undefined,
        detail: body.slice(0, 300),
        crash: isServerCrash(body, r.status),
      };
    }
    return { ok: true, orders: await r.json() };
  } catch (err) {
    // Transient network/timeout hiccup -> retry a couple of times before giving up
    if (attempt < 2) {
      await new Promise((res) => setTimeout(res, 350 * (attempt + 1)));
      return fetchOrdersPage(status, page, perPage, attempt + 1);
    }
    const cause = err && err.cause ? err.cause : {};
    return { ok: false, error: `${err.message}${cause.code ? " (" + cause.code + ")" : ""}`, network: true };
  } finally {
    clearTimeout(timer);
  }
}

// Fetch ALL orders of a status, paging through results. If a page crashes
// (one poisoned order kills the batch), re-fetch that page one order at a
// time, keeping the good ones and skipping only the broken one(s).
async function fetchStatusAll(status) {
  const cached = isoCache[status];
  if (cached && Date.now() - cached.at < ISO_TTL_MS) {
    return { status, orders: cached.orders, skipped: cached.skipped, cached: true };
  }

  const PAGE = Math.min(CFG.perPage || 100, 100);
  const all = [];
  let skipped = 0;
  let isolatedAny = false;
  let page = 1;

  while (page <= MAX_PAGES) {
    const res = await fetchOrdersPage(status, page, PAGE);

    if (res.ok) {
      all.push(...res.orders);
      if (res.orders.length < PAGE) break; // last page reached
      page++;
      continue;
    }

    if (res.crash) {
      // Rescue this page order-by-order (in small parallel batches)
      isolatedAny = true;
      const start = (page - 1) * PAGE + 1;
      const positions = Array.from({ length: PAGE }, (_, i) => start + i);
      let reachedEnd = false;
      for (let i = 0; i < positions.length && !reachedEnd; i += 5) {
        const batch = positions.slice(i, i + 5);
        const settled = await Promise.all(batch.map((k) => fetchOrdersPage(status, k, 1)));
        for (const one of settled) {
          if (one.ok) {
            if (one.orders.length === 0) reachedEnd = true;
            else all.push(...one.orders);
          } else if (one.crash) {
            skipped++; // the poisoned order — skip just this one
          } else {
            // transient network error after retries: leave this one out of
            // THIS poll (the sticky front-end keeps it visible) and continue
          }
        }
      }
      if (reachedEnd) break;
      page++;
      continue;
    }

    // Non-crash failure (auth, redirect, network) -> report it
    return {
      status, orders: all, skipped,
      error: res.error || `HTTP ${res.httpStatus}`,
      detail: res.detail, redirectedTo: res.redirectedTo, httpStatus: res.httpStatus,
    };
  }

  if (isolatedAny) isoCache[status] = { at: Date.now(), orders: all, skipped };
  return { status, orders: all, skipped };
}

// ---- API: return unpaid orders --------------------------------------------
app.get("/api/orders", async (req, res) => {
  if (!CFG.storeUrl || !CFG.key || !CFG.secret) {
    return res.status(500).json({
      error: "Server is missing WooCommerce credentials. Set WC_STORE_URL, " +
             "WC_CONSUMER_KEY and WC_CONSUMER_SECRET.",
    });
  }

  const statuses = CFG.statuses.split(",").map((s) => s.trim()).filter(Boolean);
  console.log(`[fetch] ${CFG.storeUrl} | statuses: ${statuses.join(", ")}`);

  const results = await Promise.all(statuses.map(fetchStatusAll));

  const allOrders = [];
  const problems = [];
  let totalSkipped = 0;
  for (const r1 of results) {
    if (r1.orders && r1.orders.length) allOrders.push(...r1.orders);
    totalSkipped += r1.skipped || 0;
    if (r1.error) {
      problems.push({
        status: r1.status,
        detail: (r1.detail || r1.error || "").slice(0, 140),
        redirectedTo: r1.redirectedTo,
        httpStatus: r1.httpStatus,
      });
    }
  }
  allOrders.sort((a, b) => new Date(b.date_created) - new Date(a.date_created));

  // Everything failed -> hard error with a useful hint
  if (allOrders.length === 0 && problems.length) {
    const p = problems[0];
    const blob = `${p.detail || ""}`;
    let hint;
    if (isServerCrash(blob, p.httpStatus)) {
      hint = "Your WordPress site threw a 500 error while building the order list. " +
             "This is a bug on the site — usually one order points to a payment gateway " +
             "that's been removed. Check the site's PHP error log to find the plugin.";
    } else if (p.redirectedTo) {
      hint = "A redirect dropped your login. Set WC_STORE_URL to the address shown below.";
    } else if (p.httpStatus === 401) {
      hint = "The key lacks Read permission, or its user isn't an Admin/Shop Manager.";
    } else {
      hint = "Check WC_STORE_URL and your API key.";
    }
    return res.status(502).json({
      error: "The store returned an error",
      hint, redirectedTo: p.redirectedTo,
      detail: (p.detail || "").slice(0, 300),
    });
  }

  const tpl = await readTemplate();
  const contacted = await readContacted();

  // Active = orders not yet marked done, with their WhatsApp message attached
  const active = allOrders
    .map(shapeOrder)
    .filter((o) => !contacted[o.id])
    .map((o) => attachMessage(o, tpl));

  // Done = contacted orders, most recent first
  const done = Object.values(contacted)
    .sort((a, b) => new Date(b.contactedAt) - new Date(a.contactedAt));

  res.json({
    brand: CFG.brand,
    upi: CFG.upi,
    shipping: CFG.shippingCharge,
    template: tpl,
    tokens: TOKENS,
    orders: active,
    done,
    skipped: totalSkipped || undefined,
    problems: problems.length
      ? problems.map((p) => ({ status: p.status, detail: p.detail }))
      : undefined,
    fetchedAt: new Date().toISOString(),
  });
});

// ---- Mark an order as contacted (done) -> removes it from the active list --
app.post("/api/contact", async (req, res) => {
  const { order, message } = req.body || {};
  if (!order || order.id == null) {
    return res.status(400).json({ error: "Missing order" });
  }
  const contacted = await readContacted();
  contacted[order.id] = {
    id: order.id,
    number: order.number,
    customerName: order.customerName,
    total: order.total,
    currencySymbol: order.currencySymbol,
    phone: order.phone,
    rawPhone: order.rawPhone,
    status: order.status,
    message: message || "",
    contactedAt: new Date().toISOString(),
  };
  await writeContacted(contacted);
  res.json({ ok: true });
});

// ---- Move an order back to active (undo) -----------------------------------
app.post("/api/uncontact", async (req, res) => {
  const { orderId } = req.body || {};
  const contacted = await readContacted();
  delete contacted[orderId];
  await writeContacted(contacted);
  res.json({ ok: true });
});

// ---- Get / save the editable message template -----------------------------
app.get("/api/template", async (_req, res) => {
  res.json({ template: await readTemplate(), tokens: TOKENS, upi: CFG.upi });
});
app.post("/api/template", async (req, res) => {
  const { template } = req.body || {};
  if (typeof template !== "string" || !template.trim()) {
    return res.status(400).json({ error: "Message can't be empty" });
  }
  await writeTemplate(template);
  res.json({ ok: true });
});

// Tiny health check (Render likes one)
app.get("/healthz", (_req, res) => res.send("ok"));

// ---- Serve the dashboard ---------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard running on :${PORT}`));
