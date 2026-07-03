const http = require('http');
const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');
const { URL } = require('url');
const pty = require('node-pty');
const qrcode = require('qrcode-terminal');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 4521);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.BRIDGE_TOKEN || crypto.randomBytes(12).toString('hex');
const DEFAULT_COLS = Number(process.env.TERMINAL_COLS || 120);
const DEFAULT_ROWS = Number(process.env.TERMINAL_ROWS || 32);
const HISTORY_LIMIT = 120000;
const REMOTE_HOST = process.env.BRIDGE_REMOTE_HOST || '';
const REMOTE_PORT = Number(process.env.BRIDGE_REMOTE_PORT || PORT);
const REMOTE_LABEL = process.env.BRIDGE_REMOTE_LABEL || 'Remote access';
const REMOTE_SECURE = ['1', 'true', 'yes'].includes(String(process.env.BRIDGE_REMOTE_SECURE || '').toLowerCase());

const clients = new Set();
let terminal = null;
let history = '';
let currentShell = '';
let currentCwd = process.cwd();
let currentCols = DEFAULT_COLS;
let currentRows = DEFAULT_ROWS;

function broadcast(payload) {
  const serialised = JSON.stringify(payload);

  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(serialised);
    }
  }
}

function appendHistory(chunk) {
  history = (history + chunk).slice(-HISTORY_LIMIT);
}

function commandExists(command) {
  const result = spawnSync('where.exe', [command], {
    stdio: 'ignore',
    shell: false,
  });

  return result.status === 0;
}

function resolveShell() {
  const candidates = [process.env.BRIDGE_SHELL, 'pwsh.exe', 'powershell.exe', 'cmd.exe'].filter(Boolean);

  for (const candidate of candidates) {
    if (commandExists(candidate)) {
      return candidate;
    }
  }

  throw new Error('No supported Windows shell found. Install PowerShell or ensure cmd.exe is available.');
}

function getShellArgs(shell) {
  if (shell.toLowerCase().includes('pwsh') || shell.toLowerCase().includes('powershell')) {
    return ['-NoLogo'];
  }

  return [];
}

function getLocalIpv4Addresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const values of Object.values(interfaces)) {
    if (!values) {
      continue;
    }

    for (const entry of values) {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }

  return [...new Set(addresses)];
}

function createConnectionDescriptor({
  host,
  port,
  secure,
  label,
  mode,
}) {
  return {
    host,
    port,
    secure,
    label,
    mode,
  };
}

function getLocalConnection() {
  const hosts = getLocalIpv4Addresses();
  const host = hosts[0] || '127.0.0.1';

  return createConnectionDescriptor({
    host,
    port: PORT,
    secure: false,
    label: os.hostname(),
    mode: 'local',
  });
}

function getRemoteConnection() {
  if (!REMOTE_HOST) {
    return null;
  }

  return createConnectionDescriptor({
    host: REMOTE_HOST,
    port: REMOTE_PORT,
    secure: REMOTE_SECURE,
    label: REMOTE_LABEL,
    mode: 'remote',
  });
}

function createPairingPayload(connection) {
  return {
    type: 'pocketpilot-pairing',
    version: 2,
    app: 'PocketPilot',
    name: connection.label,
    label: connection.label,
    host: connection.host,
    hosts: connection.mode === 'local' ? getLocalIpv4Addresses() : [connection.host],
    port: connection.port,
    token: TOKEN,
    shell: currentShell || 'shell',
    secure: connection.secure,
    mode: connection.mode,
  };
}

function createPairingUrl(connection) {
  const payload = createPairingPayload(connection);
  const url = new URL('pocketpilot://pair');
  url.searchParams.set('host', payload.host);
  url.searchParams.set('port', String(payload.port));
  url.searchParams.set('token', payload.token);
  url.searchParams.set('name', payload.name);
  url.searchParams.set('secure', payload.secure ? '1' : '0');
  url.searchParams.set('mode', payload.mode);

  return url.toString();
}

function printPairingQr(connection, title) {
  const pairingUrl = createPairingUrl(connection);

  console.log(title);
  console.log(pairingUrl);
  qrcode.generate(pairingUrl, { small: true });
}

function createTerminal() {
  if (terminal) {
    return terminal;
  }

  currentShell = resolveShell();

  terminal = pty.spawn(currentShell, getShellArgs(currentShell), {
    name: 'xterm-color',
    cols: currentCols,
    rows: currentRows,
    cwd: currentCwd,
    env: process.env,
  });

  terminal.onData((data) => {
    appendHistory(data);
    broadcast({ type: 'output', data });
  });

  terminal.onExit(({ exitCode, signal }) => {
    appendHistory(`\n[bridge] shell exited (code=${exitCode}, signal=${signal ?? 'n/a'})\n`);
    broadcast({
      type: 'error',
      message: `Shell exited (code=${exitCode}, signal=${signal ?? 'n/a'}). Restart it from the app.`,
    });
    terminal = null;
  });

  appendHistory(`\n[bridge] shell started: ${currentShell}\n`);

  return terminal;
}

function ensureTerminal() {
  return terminal ?? createTerminal();
}

function sendStatus(ws) {
  const payload = {
    type: 'status',
    connectedClients: clients.size,
    shell: currentShell || 'starting',
    cwd: currentCwd,
    cols: currentCols,
    rows: currentRows,
    pid: terminal?.pid,
  };

  ws.send(JSON.stringify(payload));
}

function resetShell() {
  if (terminal) {
    terminal.kill();
    terminal = null;
  }

  createTerminal();
}

function resolvePairingConnection(requestUrl) {
  const host = requestUrl.searchParams.get('host')?.trim();
  const port = Number(requestUrl.searchParams.get('port') || '');
  const secure = ['1', 'true', 'yes'].includes(
    String(requestUrl.searchParams.get('secure') || '').toLowerCase(),
  );
  const label = requestUrl.searchParams.get('label')?.trim() || requestUrl.searchParams.get('name')?.trim();
  const mode = requestUrl.searchParams.get('mode')?.trim();

  if (host) {
    return createConnectionDescriptor({
      host,
      port: Number.isFinite(port) && port > 0 ? port : PORT,
      secure,
      label: label || host,
      mode: mode === 'remote' ? 'remote' : 'custom',
    });
  }

  if (mode === 'remote') {
    return getRemoteConnection();
  }

  return getLocalConnection();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderConnectionCard(title, connection, helperText) {
  if (!connection) {
    return `
      <section class="card">
        <h2>${escapeHtml(title)}</h2>
        <p class="muted">${escapeHtml(helperText)}</p>
        <p class="empty">Not configured yet.</p>
      </section>
    `;
  }

  const pairUrl = createPairingUrl(connection);
  const transport = `${connection.secure ? 'wss' : 'ws'}://${connection.host}:${connection.port}/terminal`;

  return `
    <section class="card">
      <h2>${escapeHtml(title)}</h2>
      <p class="muted">${escapeHtml(helperText)}</p>
      <dl class="details">
        <div><dt>Host</dt><dd>${escapeHtml(connection.host)}</dd></div>
        <div><dt>Port</dt><dd>${escapeHtml(connection.port)}</dd></div>
        <div><dt>Transport</dt><dd>${escapeHtml(transport)}</dd></div>
        <div><dt>Token</dt><dd class="mono">${escapeHtml(TOKEN)}</dd></div>
      </dl>
      <label class="field">
        <span>Pairing code</span>
        <textarea readonly>${escapeHtml(pairUrl)}</textarea>
      </label>
      <div class="actions">
        <button type="button" onclick="copyValue(${JSON.stringify(pairUrl)})">Copy Pair Code</button>
      </div>
    </section>
  `;
}

function renderCompanionPage() {
  const localConnection = getLocalConnection();
  const remoteConnection = getRemoteConnection();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PocketPilot Connect</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #08131e;
      --panel: #0d1f2d;
      --panel-2: #132b3d;
      --text: #f8fafc;
      --muted: #9eb6c9;
      --accent: #f59e0b;
      --line: #284861;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", sans-serif;
      background: linear-gradient(180deg, #08131e, #102a3b);
      color: var(--text);
      min-height: 100vh;
    }
    .wrap {
      max-width: 1080px;
      margin: 0 auto;
      padding: 32px 20px 48px;
    }
    .hero {
      padding: 24px;
      border-radius: 28px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.08);
      margin-bottom: 18px;
    }
    .eyebrow {
      color: #7dd3fc;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 2px;
      margin-bottom: 10px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 36px;
      line-height: 1.1;
    }
    p {
      margin: 0;
      line-height: 1.5;
    }
    .grid {
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    }
    .card {
      background: rgba(7, 16, 25, 0.85);
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 24px;
      padding: 18px;
    }
    h2 {
      margin: 0 0 8px;
      font-size: 22px;
    }
    .muted, .hint {
      color: var(--muted);
    }
    .details {
      display: grid;
      gap: 10px;
      margin: 18px 0;
    }
    .details div {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(40, 72, 97, 0.6);
    }
    dt {
      color: var(--muted);
    }
    dd {
      margin: 0;
      text-align: right;
    }
    .mono {
      font-family: Consolas, monospace;
      word-break: break-all;
    }
    .field {
      display: grid;
      gap: 8px;
      margin-top: 14px;
    }
    .field span {
      color: #d5e5f3;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: var(--panel-2);
      color: var(--text);
      padding: 14px;
      font: inherit;
    }
    textarea {
      min-height: 108px;
      resize: vertical;
    }
    .actions {
      display: flex;
      gap: 10px;
      margin-top: 14px;
      flex-wrap: wrap;
    }
    button {
      border: 0;
      border-radius: 16px;
      padding: 14px 18px;
      font: inherit;
      font-weight: 700;
      background: var(--accent);
      color: #101418;
      cursor: pointer;
    }
    button.secondary {
      background: var(--panel-2);
      border: 1px solid var(--line);
      color: var(--text);
    }
    .empty {
      margin-top: 14px;
      padding: 14px;
      border-radius: 16px;
      background: rgba(19, 43, 61, 0.75);
      color: var(--muted);
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <div class="eyebrow">POCKETPILOT CONNECT</div>
      <h1>Pair your phone for local or on-the-go access.</h1>
      <p>
        Use the mobile app on the same LAN, on Tailscale, or through any private remote tunnel.
        This page generates pairing codes that the Android app can save as shortcuts.
      </p>
    </section>

    <div class="grid">
      ${renderConnectionCard('Local Pairing', localConnection, 'Use this when your phone is on the same Wi-Fi or wired LAN.')}
      ${renderConnectionCard('Configured Remote Pairing', remoteConnection, 'Set BRIDGE_REMOTE_HOST, optionally BRIDGE_REMOTE_PORT and BRIDGE_REMOTE_SECURE, then restart the bridge.')}
      <section class="card">
        <h2>Custom Remote Pairing</h2>
        <p class="muted">Generate a pairing code for Tailscale, ZeroTier, a reverse proxy, or any other reachable hostname.</p>
        <label class="field">
          <span>Host</span>
          <input id="remoteHost" placeholder="pc-name.tailnet.ts.net or 100.x.y.z" value="${escapeHtml(REMOTE_HOST)}">
        </label>
        <label class="field">
          <span>Port</span>
          <input id="remotePort" placeholder="${PORT}" value="${escapeHtml(REMOTE_HOST ? REMOTE_PORT : PORT)}">
        </label>
        <label class="field">
          <span>Label</span>
          <input id="remoteLabel" placeholder="Work Laptop" value="${escapeHtml(REMOTE_LABEL)}">
        </label>
        <label class="field">
          <span>Tunnel Type</span>
          <select id="remoteSecure">
            <option value="0"${REMOTE_SECURE ? '' : ' selected'}>Private VPN or raw websocket (ws)</option>
            <option value="1"${REMOTE_SECURE ? ' selected' : ''}>TLS reverse proxy (wss)</option>
          </select>
        </label>
        <div class="actions">
          <button type="button" onclick="generateRemotePair()">Generate Pair Code</button>
        </div>
        <label class="field">
          <span>Generated pairing code</span>
          <textarea id="generatedCode" readonly></textarea>
        </label>
        <div class="actions">
          <button type="button" onclick="copyGenerated()">Copy Generated Code</button>
        </div>
        <p class="hint">The phone app can scan, paste, or save this as a remote shortcut.</p>
      </section>
    </div>
  </main>

  <script>
    function copyValue(value) {
      navigator.clipboard.writeText(value);
    }
    function generateRemotePair() {
      const host = document.getElementById('remoteHost').value.trim();
      const port = document.getElementById('remotePort').value.trim() || '${PORT}';
      const secure = document.getElementById('remoteSecure').value;
      const label = document.getElementById('remoteLabel').value.trim() || host || 'Remote PC';
      if (!host) {
        alert('Enter a remote host first.');
        return;
      }
      const url = new URL(window.location.origin + '/pairing-url');
      url.searchParams.set('host', host);
      url.searchParams.set('port', port);
      url.searchParams.set('secure', secure);
      url.searchParams.set('label', label);
      url.searchParams.set('mode', 'remote');
      fetch(url)
        .then((response) => response.text())
        .then((text) => {
          document.getElementById('generatedCode').value = text;
        });
    }
    function copyGenerated() {
      const value = document.getElementById('generatedCode').value;
      if (!value) {
        return;
      }
      navigator.clipboard.writeText(value);
    }
  </script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host}`);

  if (requestUrl.pathname === '/health') {
    const payload = {
      ok: true,
      shell: currentShell || 'not-started',
      pid: terminal?.pid ?? null,
      cwd: currentCwd,
      connectedClients: clients.size,
      port: PORT,
      hosts: getLocalIpv4Addresses(),
      remoteHost: REMOTE_HOST || null,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  if (requestUrl.pathname === '/pairing') {
    const connection = resolvePairingConnection(requestUrl);
    if (!connection) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Remote connection is not configured.' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(createPairingPayload(connection)));
    return;
  }

  if (requestUrl.pathname === '/pairing-url') {
    const connection = resolvePairingConnection(requestUrl);
    if (!connection) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Remote connection is not configured.');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(createPairingUrl(connection));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderCompanionPage());
});

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  clients.add(ws);

  const shell = ensureTerminal();

  ws.send(
    JSON.stringify({
      type: 'banner',
      message: 'PocketPilot connected. Your phone is now attached to the PC terminal.',
      shell: currentShell,
    }),
  );
  ws.send(JSON.stringify({ type: 'history', data: history }));
  sendStatus(ws);
  broadcast({
    type: 'status',
    connectedClients: clients.size,
    shell: currentShell,
    cwd: currentCwd,
    cols: currentCols,
    rows: currentRows,
    pid: shell.pid,
  });

  ws.on('message', (rawData) => {
    try {
      const message = JSON.parse(String(rawData));
      const activeTerminal = ensureTerminal();

      switch (message.type) {
        case 'run': {
          const command = typeof message.command === 'string' ? message.command.trim() : '';
          if (!command) {
            return;
          }

          activeTerminal.write(`${command}\r`);
          return;
        }
        case 'input': {
          const data = typeof message.data === 'string' ? message.data : '';
          if (!data) {
            return;
          }

          activeTerminal.write(data);
          return;
        }
        case 'resize': {
          const cols = Number(message.cols) || DEFAULT_COLS;
          const rows = Number(message.rows) || DEFAULT_ROWS;
          currentCols = cols;
          currentRows = rows;
          activeTerminal.resize(cols, rows);
          broadcast({
            type: 'status',
            connectedClients: clients.size,
            shell: currentShell,
            cwd: currentCwd,
            cols: currentCols,
            rows: currentRows,
            pid: activeTerminal.pid,
          });
          return;
        }
        case 'clear': {
          history = '';
          activeTerminal.write('cls\r');
          broadcast({ type: 'cleared' });
          return;
        }
        case 'restart-shell': {
          resetShell();
          broadcast({
            type: 'banner',
            message: 'Shell restarted.',
            shell: currentShell,
          });
          broadcast({ type: 'history', data: history });
          return;
        }
        default:
          ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${message.type}` }));
      }
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: 'error',
          message: `Invalid client message: ${error instanceof Error ? error.message : 'unknown error'}`,
        }),
      );
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcast({
      type: 'status',
      connectedClients: clients.size,
      shell: currentShell || 'closed',
      cwd: currentCwd,
      cols: currentCols,
      rows: currentRows,
      pid: terminal?.pid,
    });
  });
});

server.on('upgrade', (req, socket, head) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const token = requestUrl.searchParams.get('token');

    if (requestUrl.pathname !== '/terminal' || token !== TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } catch {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
  }
});

createTerminal();

server.listen(PORT, HOST, () => {
  const localConnection = getLocalConnection();
  const remoteConnection = getRemoteConnection();

  console.log('PocketPilot bridge is live.');
  console.log(`Host: ${HOST}`);
  console.log(`Port: ${PORT}`);
  console.log(`Token: ${TOKEN}`);
  console.log(`Shell: ${currentShell}`);
  console.log(`Desktop companion page: http://127.0.0.1:${PORT}/`);
  console.log('Local pairing options: discover on LAN, open the desktop companion page, or scan the QR below.');
  printPairingQr(localConnection, 'Local pairing code:');

  if (remoteConnection) {
    console.log('Configured remote pairing code:');
    printPairingQr(remoteConnection, 'Remote pairing code:');
  } else {
    console.log('Remote pairing is not configured. Set BRIDGE_REMOTE_HOST to publish a reusable remote code.');
  }
});
