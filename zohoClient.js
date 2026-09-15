/**
 * zohoClient.js
 *
 * Small wrapper around the Zoho Sign REST API.
 * Handles:
 *   - getting a valid access token (refresh-token flow, with an in-memory cache)
 *   - creating a signature request (document upload)
 *   - submitting a request (sends the email to the recipient(s))
 *   - fetching request status
 *
 * Docs used:
 *   https://www.zoho.com/sign/api/getting-started-with-zoho-sign-api.html
 *   https://www.zoho.com/sign/api/quick-start-with-zoho-sign-api.html
 */

const fs = require('fs');
const fetch = require('node-fetch');
const FormData = require('form-data');

const DC = process.env.ZOHO_DC || 'com';
const ACCOUNTS_BASE = `https://accounts.zoho.${DC}`;
const SIGN_BASE = `https://sign.zoho.${DC}/api/v1`;

// Simple in-memory token cache. Fine for a demo / single-instance server.
let cachedToken = {
  accessToken: process.env.ZOHO_ACCESS_TOKEN || null,
  expiresAt: process.env.ZOHO_ACCESS_TOKEN ? Date.now() + 55 * 60 * 1000 : 0,
};

/**
 * Returns a valid access token, refreshing it via the refresh_token grant
 * whenever we don't have one cached or it's expired/about to expire.
 * Pass forceRefresh=true to skip the cache entirely (used for retrying
 * after Zoho rejects a token as invalid, e.g. error code 9041).
 */
async function getAccessToken(forceRefresh = false) {
  const hasRefreshCreds = Boolean(
    process.env.ZOHO_CLIENT_ID &&
      process.env.ZOHO_CLIENT_SECRET &&
      process.env.ZOHO_REFRESH_TOKEN
  );

  const stillValid =
    !forceRefresh && cachedToken.accessToken && Date.now() < cachedToken.expiresAt;

  if (stillValid) return cachedToken.accessToken;

  if (!hasRefreshCreds) {
    // No refresh credentials configured, so the only thing we could ever
    // hand back is the static ZOHO_ACCESS_TOKEN from .env - and by this
    // point we already know it's missing, expired, or was just rejected
    // by Zoho. Returning it anyway just reproduces the same 9041 error,
    // so fail loudly with a clear next step instead.
    throw new Error(
      'Zoho access token is missing or expired, and no refresh credentials are ' +
        'configured. Either generate a fresh ZOHO_ACCESS_TOKEN (Settings > ' +
        'Developer Settings > API token - development, valid 60 minutes), or set ' +
        'ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN so the server can ' +
        'refresh tokens automatically.'
    );
  }

  const url = new URL(`${ACCOUNTS_BASE}/oauth/v2/token`);
  url.searchParams.set('refresh_token', process.env.ZOHO_REFRESH_TOKEN);
  url.searchParams.set('client_id', process.env.ZOHO_CLIENT_ID);
  url.searchParams.set('client_secret', process.env.ZOHO_CLIENT_SECRET);
  url.searchParams.set('grant_type', 'refresh_token');
  // redirect_uri isn't strictly required by Zoho for the refresh_token
  // grant (only for the initial authorization_code exchange), but it's
  // included here to mirror the exact request shape that was confirmed
  // working - set ZOHO_REDIRECT_URI in .env to match whatever redirect_uri
  // you used when generating the refresh token.
  if (process.env.ZOHO_REDIRECT_URI) {
    url.searchParams.set('redirect_uri', process.env.ZOHO_REDIRECT_URI);
  }

  const res = await fetch(url.toString(), { method: 'POST' });
  const json = await res.json();

  if (!json.access_token) {
    throw new Error('Failed to refresh Zoho access token: ' + JSON.stringify(json));
  }

  cachedToken = {
    accessToken: json.access_token,
    // expires_in is in seconds; refresh a little early to be safe.
    expiresAt: Date.now() + (json.expires_in - 60) * 1000,
  };

  return cachedToken.accessToken;
}

async function authHeaders(forceRefresh = false) {
  const token = await getAccessToken(forceRefresh);
  return { Authorization: `Zoho-oauthtoken ${token}` };
}

/**
 * Detects Zoho's "the access token is bad" response so we know when it's
 * worth retrying with a freshly refreshed token, vs. any other failure.
 */
function isInvalidTokenResponse(json) {
  if (!json) return false;
  if (json.code === 9041) return true; // documented "Invalid Oauth token" code
  return typeof json.message === 'string' && /invalid oauth token/i.test(json.message);
}

/**
 * Runs a Zoho Sign API call and, if Zoho reports the access token as
 * invalid (code 9041 - this happens if a token expires slightly earlier
 * than our local cache expects, or was revoked/regenerated elsewhere),
 * forces a token refresh and retries exactly once with a rebuilt request.
 *
 * buildRequest(token) must return fresh fetch options each time it's
 * called - this matters because request bodies that stream a file from
 * disk (FormData + fs.createReadStream) can only be consumed once, so a
 * naive retry of the same options object would send an empty body.
 */
async function requestZoho(url, buildRequest) {
  const attempt = async (forceRefresh) => {
    const headers = await authHeaders(forceRefresh);
    const res = await fetch(url, buildRequest(headers));
    return res.json();
  };

  const firstTry = await attempt(false);

  if (isInvalidTokenResponse(firstTry)) {
    return attempt(true);
  }

  return firstTry;
}

/**
 * Step 1 - Create a signature request by uploading a document.
 * filePath: path to a PDF on disk
 * options: { requestName, notes, expirationDays, isSequential, testing, fileName }
 */
async function createRequest(filePath, options = {}) {
  const {
    requestName = 'Demo document',
    notes = 'Please sign this document',
    expirationDays = 10,
    isSequential = true,
    testing = false,
    // The real, user-facing filename (must end in a real extension like
    // .pdf/.doc/.docx) - Zoho inspects the filename to validate the
    // format, so a bare temp path without an extension gets rejected
    // with "Invalid file format" (error code 9020).
    fileName = 'document.pdf',
  } = options;

  const data = {
    requests: {
      request_name: requestName,
      expiration_days: expirationDays,
      is_sequential: isSequential,
      notes,
    },
  };

  const buildRequest = (headers) => {
    const form = new FormData();
    // A fresh read stream every call - required for the retry-on-401 path
    // to work, since a stream can only be read once.
    form.append('file', fs.createReadStream(filePath), {
      filename: fileName,
      // Zoho's own reference implementation (see their Java sample in the
      // getting-started docs) sends this as application/octet-stream, not
      // application/pdf - matching that avoids any content-type-based
      // rejection on their end.
      contentType: 'application/octet-stream',
    });
    form.append('data', JSON.stringify(data));
    if (testing) form.append('testing', 'true');
    return { method: 'POST', headers, body: form };
  };

  return requestZoho(`${SIGN_BASE}/requests`, buildRequest);
}

/**
 * Step 2 - Submit the request: this is what actually emails the recipient(s).
 * recipients: [{ name, email }]
 * options.documentId - required for signers to get a placed field (see
 *   below) - pass the document_id returned from createRequest().
 * options.pageNo - which page (0-indexed) to place the signature field on;
 *   defaults to the last page of the document.
 *
 * Zoho requires every SIGN recipient to have at least one field placed on
 * the document before you can submit - otherwise it rejects with error
 * 9101 "Add atleast one field for a signer." This auto-places a single
 * Signature field for each recipient, stacked vertically so multiple
 * signers on the same document don't overlap. Coordinates are measured
 * from the top-left corner of the page, in points (a US Letter page is
 * roughly 612x792pt) - adjust FIELD_X / FIELD_Y_START if your documents
 * use a different page size or you want the field positioned elsewhere.
 */
const FIELD_X = 380;
const FIELD_Y_START = 640;
const FIELD_Y_STEP = 70;
const FIELD_WIDTH = 160;
const FIELD_HEIGHT = 40;

async function submitRequest(requestId, recipients, options = {}) {
  const { testing = false, documentId, pageNo } = options;

  const actions = recipients.map((r, index) => {
    const action = {
      action_type: 'SIGN',
      recipient_name: r.name,
      recipient_email: r.email,
      verify_recipient: false,
      signing_order: index,
    };

    if (documentId) {
      action.fields = [
        {
          field_name: `Signature-${index + 1}`,
          field_label: 'Signature',
          field_type_name: 'Signature',
          field_category: 'image',
          document_id: documentId,
          page_no: pageNo != null ? pageNo : 0,
          x_coord: FIELD_X,
          y_coord: FIELD_Y_START + index * FIELD_Y_STEP,
          abs_width: FIELD_WIDTH,
          abs_height: FIELD_HEIGHT,
          is_mandatory: true,
        },
      ];
    }

    return action;
  });

  const data = { requests: { actions } };

  const buildRequest = (headers) => {
    const form = new FormData();
    form.append('data', JSON.stringify(data));
    if (testing) form.append('testing', 'true');
    return { method: 'POST', headers, body: form };
  };

  return requestZoho(`${SIGN_BASE}/requests/${requestId}/submit`, buildRequest);
}

/**
 * Convenience helper that does create + submit in one call, matching the
 * "getting started" example from Zoho's docs.
 */
async function createAndSubmit(filePath, recipients, options = {}) {
  const createResp = await createRequest(filePath, options);

  if (createResp.status !== 'success') {
    const err = new Error('Zoho Sign: failed to create request');
    err.details = createResp;
    throw err;
  }

  const requestId = createResp.requests.request_id;

  // The uploaded file's document_id is required to place a signature field
  // on it - without this, Zoho rejects submission with error 9101
  // ("Add atleast one field for a signer"). Default to placing the field
  // on the last page of the document.
  const documentInfo =
    createResp.requests.document_ids && createResp.requests.document_ids[0];
  const documentId = documentInfo && documentInfo.document_id;
  const totalPages = documentInfo && documentInfo.total_pages;
  const lastPageIndex = totalPages ? totalPages - 1 : 0;

  const submitResp = await submitRequest(requestId, recipients, {
    ...options,
    documentId,
    pageNo: lastPageIndex,
  });

  if (submitResp.status !== 'success') {
    const err = new Error('Zoho Sign: failed to submit request');
    err.details = submitResp;
    err.requestId = requestId;
    throw err;
  }

  return submitResp;
}

/**
 * List documents/requests in the account, with pagination + sorting as
 * documented at https://www.zoho.com/sign/api/document-managment/get-document-list.html
 *
 * options: { rowCount, startIndex, sortColumn, sortOrder, searchColumns }
 * Returns Zoho's raw response: { code, requests: [...], page_context, status }
 */
async function listRequests(options = {}) {
  const {
    rowCount = 50,
    startIndex = 1,
    sortColumn = 'created_time',
    sortOrder = 'DESC',
    searchColumns = null,
  } = options;

  const payload = {
    page_context: {
      row_count: rowCount,
      start_index: startIndex,
      sort_column: sortColumn,
      sort_order: sortOrder,
      ...(searchColumns ? { search_columns: searchColumns } : {}),
    },
  };

  // Zoho's docs show this sent as a urlencoded "data" field, but that's on
  // a GET request - the standard fetch/node-fetch implementations refuse
  // to send a body on a GET request, so we pass the same JSON as a query
  // parameter instead, which Zoho's endpoints accept equivalently.
  const buildRequest = (headers) => ({ method: 'GET', headers });
  const url = new URL(`${SIGN_BASE}/requests`);
  url.searchParams.set('data', JSON.stringify(payload));

  return requestZoho(url.toString(), buildRequest);
}

/**
 * Fetches every request (paging through rowCount at a time) and reduces
 * them into a flat, per-recipient list plus summary counts - exactly what
 * a "who signed / who's pending" tracking grid needs. This is derived
 * entirely from Zoho's own data on each call, so it's always in sync with
 * reality - no local database required.
 */
async function getDashboard({ maxRequests = 200 } = {}) {
  const rowCount = 50;
  let startIndex = 1;
  const allRequests = [];

  // Page through results until we've either seen everything or hit our cap.
  while (allRequests.length < maxRequests) {
    const page = await listRequests({ rowCount, startIndex });

    if (page.status !== 'success') {
      const err = new Error('Zoho Sign: failed to list requests');
      err.details = page;
      throw err;
    }

    const requests = page.requests || [];
    allRequests.push(...requests);

    const hasMore = page.page_context && page.page_context.has_more_rows;
    if (!hasMore || requests.length === 0) break;
    startIndex += rowCount;
  }

  const rows = [];
  let signedCount = 0;
  let declinedCount = 0;
  let pendingCount = 0;

  for (const req of allRequests) {
    const actions = (req.actions || []).filter((a) => a.action_type === 'SIGN');

    for (const action of actions) {
      const status = action.action_status || 'UNKNOWN';

      if (status === 'SIGNED') signedCount += 1;
      else if (status === 'DECLINED') declinedCount += 1;
      else pendingCount += 1;

      rows.push({
        requestId: req.request_id,
        requestName: req.request_name,
        requestStatus: req.request_status,
        signPercentage: req.sign_percentage,
        createdTime: req.created_time,
        modifiedTime: req.modified_time,
        recipientName: action.recipient_name,
        recipientEmail: action.recipient_email,
        actionStatus: status,
      });
    }
  }

  return {
    summary: {
      totalDocumentsSent: allRequests.length,
      totalRecipients: rows.length,
      signed: signedCount,
      pending: pendingCount,
      declined: declinedCount,
    },
    rows,
  };
}

/**
 * Fetch details/status of a previously created request.
 */
async function getRequestStatus(requestId) {
  const buildRequest = (headers) => ({ method: 'GET', headers });
  return requestZoho(`${SIGN_BASE}/requests/${requestId}`, buildRequest);
}

module.exports = {
  getAccessToken,
  createRequest,
  submitRequest,
  createAndSubmit,
  getRequestStatus,
  listRequests,
  getDashboard,
};
