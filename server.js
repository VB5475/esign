require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const zoho = require('./zohoClient');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors());

// The webhook route needs the raw body (to verify Zoho's signature, if
// configured), so it's registered with express.raw() before the global
// express.json() parser would otherwise consume the body.
app.use(
  '/webhooks/zoho-sign',
  express.raw({ type: '*/*', limit: '2mb' })
);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Where uploaded PDFs land temporarily before being sent to Zoho.
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF files are supported by this demo'));
    }
    cb(null, true);
  },
});

// ---------------------------------------------------------------------
// Live notifications (Server-Sent Events)
//
// Polling (GET /api/dashboard) still works exactly as before - this adds
// a push layer on top so the browser updates instantly when Zoho notifies
// us via webhook, instead of waiting for the next manual/periodic refresh.
// ---------------------------------------------------------------------

const sseClients = new Set();
const recentEvents = []; // small in-memory ring buffer, newest first
const MAX_RECENT_EVENTS = 50;

function broadcastEvent(event) {
  recentEvents.unshift(event);
  if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.length = MAX_RECENT_EVENTS;

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  // Replay recent history so a client that just connected isn't blank.
  res.write(`data: ${JSON.stringify({ type: 'hello', recent: recentEvents })}\n\n`);

  sseClients.add(res);

  // Keep the connection alive through proxies/load balancers.
  const keepAlive = setInterval(() => res.write(':ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

// --- Routes ---

/**
 * Health check / token check. Also handy for confirming your .env is set up.
 */
app.get('/api/health', async (req, res) => {
  try {
    await zoho.getAccessToken();
    res.json({ ok: true, message: 'Zoho Sign credentials look valid.' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

/**
 * Upload a PDF + one or more recipients, and send it out for signature.
 * multipart/form-data fields:
 *   file        - the PDF (required)
 *   recipients  - JSON string: [{ name, email }, ...] (required, at least one)
 *                 Order in the array = signing order when isSequential is true.
 *   requestName - string (optional)
 *   notes       - string (optional)
 *   isSequential- "true"/"false" (optional, default true) - true means
 *                 recipient 2 only gets notified after recipient 1 signs;
 *                 Zoho handles that chaining entirely on its own.
 *   testing     - "true"/"false" (optional, uses Zoho's free test mode)
 *
 * For backward compatibility, recipientName/recipientEmail (singular) are
 * still accepted as a fallback if `recipients` isn't provided.
 */
app.post('/api/send', upload.single('file'), async (req, res) => {
  const filePath = req.file && req.file.path;

  try {
    if (!req.file) {
      return res.status(400).json({ status: 'failure', message: 'A PDF file is required.' });
    }

    const { recipientName, recipientEmail, requestName, notes, testing, isSequential } = req.body;

    let recipients = [];
    if (req.body.recipients) {
      try {
        recipients = JSON.parse(req.body.recipients);
      } catch (e) {
        return res
          .status(400)
          .json({ status: 'failure', message: 'recipients must be a valid JSON array.' });
      }
    } else if (recipientName && recipientEmail) {
      recipients = [{ name: recipientName, email: recipientEmail }];
    }

    recipients = (recipients || []).filter((r) => r && r.name && r.email);

    if (recipients.length === 0) {
      return res.status(400).json({
        status: 'failure',
        message: 'At least one recipient with a name and email is required.',
      });
    }

    const result = await zoho.createAndSubmit(filePath, recipients, {
      requestName: requestName || req.file.originalname,
      notes: notes || 'Please sign this document',
      testing: testing === 'true' || testing === true,
      isSequential: isSequential === undefined ? true : isSequential === 'true' || isSequential === true,
      fileName: req.file.originalname,
    });

    broadcastEvent({
      type: 'request_sent',
      requestId: result.requests.request_id,
      requestName: result.requests.request_name,
      recipients: recipients.map((r) => r.name),
      time: Date.now(),
    });

    res.json({
      status: 'success',
      request_id: result.requests.request_id,
      request_status: result.requests.request_status,
      raw: result,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      status: 'failure',
      message: err.message,
      details: err.details || null,
    });
  } finally {
    // Clean up the temp upload regardless of outcome.
    if (filePath) fs.unlink(filePath, () => {});
  }
});

/**
 * Receives real-time notifications from Zoho Sign when you configure a
 * webhook URL pointing here (Zoho Sign > Settings > look for a Webhooks /
 * Integrations section - as of this writing Zoho Sign doesn't document a
 * REST endpoint to register the webhook via API, only through the
 * dashboard). Needs a public HTTPS URL to actually receive traffic from
 * Zoho's servers - won't get hit on localhost without a tunnel like ngrok.
 *
 * We don't assume Zoho's exact payload shape here since it isn't fully
 * published - this pulls out whatever recognizable fields are present and
 * passes the rest through untouched, so nothing breaks if the shape
 * differs from what's expected.
 */
app.post('/webhooks/zoho-sign', (req, res) => {
  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch (e) {
    payload = { raw: req.body.toString('utf8') };
  }

  // Optional signature verification: set ZOHO_WEBHOOK_SECRET in .env if
  // your Zoho Sign webhook config provides a signing secret, and this
  // will reject anything that doesn't match instead of trusting it blindly.
  if (process.env.ZOHO_WEBHOOK_SECRET) {
    const signature = req.get('x-zsign-webhook-signature') || req.get('x-webhook-signature');
    const expected = crypto
      .createHmac('sha256', process.env.ZOHO_WEBHOOK_SECRET)
      .update(req.body)
      .digest('hex');

    if (!signature || signature !== expected) {
      console.warn('Rejected webhook: signature mismatch.');
      return res.status(401).json({ status: 'failure', message: 'Invalid signature.' });
    }
  }

  const requestInfo = payload.requests || payload.request || payload;

  broadcastEvent({
    type: 'webhook',
    requestId: requestInfo.request_id,
    requestName: requestInfo.request_name,
    requestStatus: requestInfo.request_status,
    time: Date.now(),
    payload,
  });

  // Zoho expects a 200 quickly, or it will retry.
  res.status(200).json({ status: 'success' });
});

/**
 * Check the status of a previously sent request.
 */
app.get('/api/requests/:id', async (req, res) => {
  try {
    const result = await zoho.getRequestStatus(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: 'failure', message: err.message });
  }
});

/**
 * List recent requests (best-effort - depends on your Zoho Sign plan/scopes).
 */
app.get('/api/requests', async (req, res) => {
  try {
    const result = await zoho.listRequests();
    res.json(result);
  } catch (err) {
    res.status(500).json({ status: 'failure', message: err.message });
  }
});

/**
 * Tracking dashboard: summary counts + a flat per-recipient grid, sourced
 * directly from Zoho Sign (no local database - always reflects reality).
 */
app.get('/api/dashboard', async (req, res) => {
  try {
    const dashboard = await zoho.getDashboard();
    res.json({ status: 'success', ...dashboard });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      status: 'failure',
      message: err.message,
      details: err.details || null,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Zoho Sign demo app running at http://localhost:${PORT}`);
});
