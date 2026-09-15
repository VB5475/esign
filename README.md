# Dispatch — a Zoho Sign API demo

A small Node/Express app that demonstrates the core Zoho Sign e-signature flow:

1. Upload a PDF and create a signature **request**.
2. **Submit** the request with a recipient, which emails them a signing link.
3. **Track** the request's status by ID.

Built directly from the flow shown in [Zoho Sign's "Getting started" docs](https://www.zoho.com/sign/api/getting-started-with-zoho-sign-api.html) and the [OAuth quick-start guide](https://www.zoho.com/sign/api/quick-start-with-zoho-sign-api.html).

## Project layout

```
zoho-sign-demo/
├── server.js        Express app + routes
├── zohoClient.js     Thin wrapper around the Zoho Sign REST API + token refresh
├── public/           Static frontend (vanilla HTML/CSS/JS)
│   ├── index.html
│   ├── style.css
│   └── app.js
├── .env.example       Copy to .env and fill in
└── package.json
```

## 1. Get Zoho Sign credentials

You need a Zoho Sign account on a plan that includes API access, and you need an access token. There are two ways to get one:

### Option A — quick local testing (fastest)

1. In Zoho Sign, go to **Settings → Developer Settings → API token - development**.
2. Click **Generate**. This gives you a token valid for **60 minutes** — fine for trying the demo out, but it isn't meant for production.
3. Paste it into `.env` as `ZOHO_ACCESS_TOKEN`.

### Option B — production-style refresh token flow

1. Register a client at [api-console.zoho.com](https://api-console.zoho.com/) to get a **Client ID** and **Client Secret**.
2. Generate a grant token/code with scope `ZohoSign.documents.ALL,ZohoSign.templates.ALL`.
3. Exchange the grant code for a **refresh token** (see Zoho Sign's dashboard under **Settings → API tokens → API token - deployment**, or call `https://accounts.zoho.com/oauth/v2/token` directly with `grant_type=authorization_code`).
4. Put `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, and `ZOHO_REFRESH_TOKEN` in `.env`.

With option B, `zohoClient.js` automatically exchanges the refresh token for a fresh access token whenever the cached one expires, so the server can run indefinitely without manual intervention.

If your Zoho account is on a non-US data center, also set `ZOHO_DC` (e.g. `eu`, `in`, `com.au`, `jp`).

## 2. Install and run

```bash
cd zoho-sign-demo
cp .env.example .env   # then fill in your credentials
npm install
npm start
```

Open **http://localhost:3000**.

## 3. Using the demo

- Upload any PDF, add one or more recipients, and click **Send for signature**.
  - **Multiple recipients**: click "+ Add another recipient" to add more. With **"Sign in order"** checked (the default), Zoho handles sequential signing natively — recipient 2 isn't notified at all until recipient 1 finishes signing. This is entirely Zoho's behavior once `is_sequential: true` and each recipient's `signing_order` is set; nothing on this server drives that chaining.
- Leave **"Use Zoho's free test mode"** checked to send up to 50 test envelopes per month for free — these carry a "Powered by Zoho Sign — for testing purposes only" watermark and aren't legally binding. Uncheck it once you're ready to send real requests (this consumes Zoho Sign credits).
- After sending, the request ID appears — paste it into **Check a request's status** on the right to poll Zoho for the latest state (sent, viewed, signed, declined, etc).
- Below the form, the **Tracking** panel shows every document you've sent, pulled live from Zoho: total sent, how many recipients have signed, how many are still pending, and how many declined, plus a per-recipient grid with status and progress. It refreshes automatically after each send, or click **Refresh** any time. This reads directly from Zoho's `GET /requests` endpoint each time — there's no local database, so it's always accurate, but very large accounts (200+ requests) are capped to the most recent 200 for the demo.

## Real-time notifications (webhook + live feed)

The polling above (Refresh button, refresh-after-send) still works exactly the same and needs no setup. On top of that, there's an optional push layer:

- **`POST /webhooks/zoho-sign`** — a receiver endpoint that Zoho Sign can call the instant something happens to a document (viewed, signed, declined, completed), instead of you having to poll for it.
- **`GET /api/events`** — a Server-Sent Events stream the browser subscribes to. When the webhook receives something, it's broadcast here instantly, and the **"Live activity"** panel in the sidebar updates in real time and auto-refreshes the tracking grid.

**To actually receive webhook calls from Zoho, you need:**
1. A public HTTPS URL pointing at this server (Zoho's servers can't reach `localhost` — use a tunnel like [ngrok](https://ngrok.com) for local testing: `ngrok http 3000`, then use the `https://...ngrok-free.app/webhooks/zoho-sign` URL it gives you).
2. Register that URL in your Zoho Sign account. As of writing, Zoho Sign doesn't document a REST API to register webhooks (unlike some other Zoho products) — look under **Settings** in Zoho Sign for a Webhooks/Integrations section, or check current Zoho Sign documentation, since this can change.
3. (Optional) If Zoho Sign gives you a signing secret for the webhook, set `ZOHO_WEBHOOK_SECRET` in `.env` — the receiver will then verify each incoming payload's signature and reject anything that doesn't match, instead of trusting requests blindly.

Without any of that set up, the app still works exactly as before — you just won't see anything in the Live activity panel until either you send a document (which the server always broadcasts itself) or a real webhook call comes in.

## API routes exposed by this server

| Method | Path                  | Description                                              |
|--------|-----------------------|------------------------------------------------------------|
| GET    | `/api/health`         | Verifies your Zoho credentials can produce an access token |
| POST   | `/api/send`            | multipart form: `file`, `recipients` (JSON array of `{name, email}`), `isSequential`, `requestName`, `notes`, `testing` → creates + submits a request |
| GET    | `/api/requests/:id`   | Fetches status/details for a request                       |
| GET    | `/api/requests`        | Lists requests (support depends on your Zoho Sign plan)   |
| GET    | `/api/dashboard`       | Summary counts (sent/signed/pending/declined) + a flat per-recipient grid, for the Tracking panel |
| GET    | `/api/events`          | Server-Sent Events stream for the Live activity panel        |
| POST   | `/webhooks/zoho-sign`  | Receiver for Zoho Sign webhook notifications (needs a public URL + registration in Zoho Sign, see above) |

## Notes / things to adapt for a real deployment

- This demo stores the access token in memory and writes uploads to a temp `uploads/` folder that's deleted right after each send — fine for a demo, not for a multi-user production app.
- Zoho Sign document create/submit endpoints expect `multipart/form-data` with a `data` field containing JSON — see `zohoClient.js` for the exact shape.
- Access tokens go in the `Authorization: Zoho-oauthtoken <token>` header — never as a query parameter.
- Each real (non-test) envelope submission consumes Zoho Sign credits, so keep test mode on until you're ready.
