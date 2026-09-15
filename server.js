require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const zoho = require('./zohoClient');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.use(cors());
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
 * Upload a PDF + recipient info, and send it out for signature in one go.
 * multipart/form-data fields:
 *   file            - the PDF (required)
 *   recipientName   - string (required)
 *   recipientEmail  - string (required)
 *   requestName     - string (optional)
 *   notes           - string (optional)
 *   testing         - "true"/"false" (optional, uses Zoho's free test mode)
 */
app.post('/api/send', upload.single('file'), async (req, res) => {
  const filePath = req.file && req.file.path;

  try {
    if (!req.file) {
      return res.status(400).json({ status: 'failure', message: 'A PDF file is required.' });
    }

    const { recipientName, recipientEmail, requestName, notes, testing } = req.body;

    if (!recipientName || !recipientEmail) {
      return res
        .status(400)
        .json({ status: 'failure', message: 'recipientName and recipientEmail are required.' });
    }

    const result = await zoho.createAndSubmit(
      filePath,
      [{ name: recipientName, email: recipientEmail }],
      {
        requestName: requestName || req.file.originalname,
        notes: notes || 'Please sign this document',
        testing: testing === 'true' || testing === true,
        fileName: req.file.originalname,
      }
    );

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
