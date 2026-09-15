const form = document.getElementById('sendForm');
const fileInput = document.getElementById('file');
const fileDrop = document.getElementById('fileDrop');
const fileLabel = document.getElementById('fileLabel');
const submitBtn = document.getElementById('submitBtn');
const statusMessage = document.getElementById('statusMessage');
const stageTrack = document.getElementById('stageTrack');
const healthText = document.getElementById('healthText');

const lookupBtn = document.getElementById('lookupBtn');
const lookupId = document.getElementById('lookupId');
const lookupResult = document.getElementById('lookupResult');

function setStage(stage) {
  const order = ['upload', 'send', 'track'];
  const idx = order.indexOf(stage);
  [...stageTrack.children].forEach((li, i) => {
    li.classList.toggle('active', i === idx);
    li.classList.toggle('done', i < idx);
  });
}

// --- File picker label ---
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) {
    fileLabel.textContent = fileInput.files[0].name;
  } else {
    fileLabel.textContent = 'Drop a PDF here, or click to choose one';
  }
});

['dragenter', 'dragover'].forEach((evt) =>
  fileDrop.addEventListener(evt, (e) => {
    e.preventDefault();
    fileDrop.classList.add('drag-over');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  fileDrop.addEventListener(evt, (e) => {
    e.preventDefault();
    fileDrop.classList.remove('drag-over');
  })
);
fileDrop.addEventListener('drop', (e) => {
  const dropped = e.dataTransfer.files[0];
  if (dropped) {
    fileInput.files = e.dataTransfer.files;
    fileLabel.textContent = dropped.name;
  }
});

// --- Health check on load ---
(async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    const json = await res.json();
    if (json.ok) {
      healthText.textContent = 'Connected — credentials are valid.';
      healthText.classList.add('ok');
    } else {
      throw new Error(json.message);
    }
  } catch (err) {
    healthText.textContent = 'Not connected: ' + err.message;
    healthText.classList.add('bad');
  }
})();

// --- Send form ---
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!fileInput.files[0]) return;

  setStage('send');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Sending…';
  statusMessage.hidden = true;

  const body = new FormData();
  body.append('file', fileInput.files[0]);
  body.append('recipientName', document.getElementById('recipientName').value);
  body.append('recipientEmail', document.getElementById('recipientEmail').value);
  body.append('requestName', document.getElementById('requestName').value);
  body.append('notes', document.getElementById('notes').value);
  body.append('testing', document.getElementById('testing').checked);

  try {
    const res = await fetch('/api/send', { method: 'POST', body });
    const json = await res.json();

    if (json.status === 'success') {
      setStage('track');
      showStatus(
        'success',
        `Sent. Request ID: ${json.request_id}\nStatus: ${json.request_status}\n\nPaste the request ID on the right to check on it later.`
      );
      lookupId.value = json.request_id;
      loadDashboard();
    } else {
      throw new Error(json.message || 'Something went wrong.');
    }
  } catch (err) {
    showStatus('error', err.message);
    setStage('upload');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Send for signature';
  }
});

function showStatus(kind, message) {
  statusMessage.hidden = false;
  statusMessage.className = 'status-message ' + kind;
  statusMessage.textContent = message;
}

// --- Status lookup ---
lookupBtn.addEventListener('click', async () => {
  const id = lookupId.value.trim();
  if (!id) return;

  lookupResult.hidden = false;
  lookupResult.textContent = 'Checking…';

  try {
    const res = await fetch(`/api/requests/${encodeURIComponent(id)}`);
    const json = await res.json();
    lookupResult.textContent = JSON.stringify(json, null, 2);
  } catch (err) {
    lookupResult.textContent = 'Error: ' + err.message;
  }
});

// --- Tracking dashboard ---
const statSent = document.getElementById('statSent');
const statSigned = document.getElementById('statSigned');
const statPending = document.getElementById('statPending');
const statDeclined = document.getElementById('statDeclined');
const dashboardGridBody = document.getElementById('dashboardGridBody');
const refreshDashboardBtn = document.getElementById('refreshDashboardBtn');

const STATUS_META = {
  SIGNED: { label: 'Signed', cls: 'status-signed' },
  DECLINED: { label: 'Declined', cls: 'status-declined' },
  VIEWED: { label: 'Viewed — pending', cls: 'status-pending' },
  UNOPENED: { label: 'Unopened — pending', cls: 'status-pending' },
  NOACTION: { label: 'Waiting their turn', cls: 'status-pending' },
};

function statusPill(status) {
  const meta = STATUS_META[status] || { label: status || 'Unknown', cls: 'status-pending' };
  return `<span class="status-pill ${meta.cls}">${meta.label}</span>`;
}

function formatDate(ms) {
  if (!ms) return '—';
  const n = Number(ms);
  if (Number.isNaN(n)) return '—';
  return new Date(n).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

async function loadDashboard() {
  refreshDashboardBtn.disabled = true;
  refreshDashboardBtn.textContent = 'Refreshing…';

  try {
    const res = await fetch('/api/dashboard');
    const json = await res.json();

    if (json.status !== 'success') {
      throw new Error(json.message || 'Failed to load tracking data.');
    }

    const { summary, rows } = json;

    statSent.textContent = summary.totalDocumentsSent;
    statSigned.textContent = summary.signed;
    statPending.textContent = summary.pending;
    statDeclined.textContent = summary.declined;

    if (!rows.length) {
      dashboardGridBody.innerHTML =
        '<tr><td colspan="5" class="grid-empty">No documents sent yet — send one above to see it tracked here.</td></tr>';
      return;
    }

    // Most recently created requests first.
    rows.sort((a, b) => (b.createdTime || 0) - (a.createdTime || 0));

    dashboardGridBody.innerHTML = rows
      .map((row) => {
        const pct = Math.round(row.signPercentage || 0);
        return `
          <tr>
            <td>${escapeHtml(row.requestName)}</td>
            <td>
              <span class="recipient-name">${escapeHtml(row.recipientName)}</span>
              <span class="recipient-email">${escapeHtml(row.recipientEmail)}</span>
            </td>
            <td>${statusPill(row.actionStatus)}</td>
            <td>
              <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
            </td>
            <td>${formatDate(row.createdTime)}</td>
          </tr>
        `;
      })
      .join('');
  } catch (err) {
    dashboardGridBody.innerHTML = `<tr><td colspan="5" class="grid-empty">Couldn't load tracking data: ${escapeHtml(
      err.message
    )}</td></tr>`;
  } finally {
    refreshDashboardBtn.disabled = false;
    refreshDashboardBtn.textContent = 'Refresh';
  }
}

refreshDashboardBtn.addEventListener('click', loadDashboard);
loadDashboard();
