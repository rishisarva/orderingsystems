# Order Radar — Woo → WhatsApp

A live dashboard for your unpaid WooCommerce orders. Refreshes every 5 seconds,
flags new orders with a sound + green highlight, and gives you a one-tap
**Message on WhatsApp** button that opens a chat with the customer's number and a
ready-written message already filled in. You don't type anything.

Your WooCommerce keys live only on the server (env vars) — never in the browser.

---

## Run it locally (Mac / zsh)

Open Terminal **inside this folder**, then run these one at a time:

```bash
cp .env.example .env
```

Now open `.env` in a text editor and fill in your real values:

```bash
open -e .env
```

(Set `WC_STORE_URL`, `WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET`, and your
`DEFAULT_COUNTRY_CODE`. Save and close.)

Then install and start:

```bash
npm install
npm start
```

Open **http://localhost:3000** — the dashboard loads and starts polling.

> The `.env` file is read automatically. You do NOT need the long
> `env $(cat .env …)` command from before — just `npm start`.

### Get your WooCommerce keys

WordPress admin → **WooCommerce → Settings → Advanced → REST API → Add key**.
Give it **Read** permission. Copy the Consumer key (`ck_…`) and secret (`cs_…`)
into `.env`.

---

## Deploy on Render

1. Push this folder to a GitHub repo.
2. Render → **New → Web Service** → connect the repo. The included `render.yaml`
   fills in the build/start commands:
   - Build: `npm install`
   - Start: `npm start`
3. In the service's **Environment** tab, add:

   | Key | Example |
   |-----|---------|
   | `WC_STORE_URL` | `https://yourstore.com` |
   | `WC_CONSUMER_KEY` | `ck_…` |
   | `WC_CONSUMER_SECRET` | `cs_…` |
   | `DEFAULT_COUNTRY_CODE` | `91` |
   | `SHIPPING_CHARGE` | `150` |
   | `UPI_ID` | `yourname@okhdfcbank` |
   | `BRAND_NAME` | `Your Store` |

> **Edited message & "Done" list persistence:** your saved message and the orders
> you've marked done are stored in a `data/` folder on disk. Locally that survives
> restarts. On Render's free tier the disk resets on each redeploy, so those would
> reset too — fine for everyday use; add a Render Disk if you want them permanent.

4. Deploy. Render gives you a public URL.

> Render's free tier sleeps when idle and wakes on the next visit (a few seconds).
> For an always-on radar, use a paid instance.

---

## Common issues

- **"Cannot GET /"** → the `public/` folder isn't sitting next to `server.js`.
  Keep the folder structure exactly as it is in this zip.
- **Dashboard loads but shows a red error** → your `.env` values are missing or
  wrong, or the WooCommerce keys don't have Read permission.
- **A card says "No phone number"** → that order has no usable billing phone.

## Customize

- **Message wording** → `buildMessage()` in `server.js`.
- **Which statuses count as unpaid** → `WC_STATUSES` (default `pending,on-hold`).
- **Add a currency symbol** → `CURRENCY_SYMBOLS` in `server.js`.
