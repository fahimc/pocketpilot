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

function createPairingPayload() {
  const hosts = getLocalIpv4Addresses();
  const host = hosts[0] || '127.0.0.1';

  return {
    type: 'pocketpilot-pairing',
    version: 1,
    app: 'PocketPilot',
    name: os.hostname(),
    host,
    hosts,
    port: PORT,
    token: TOKEN,
    shell: currentShell || 'shell',
  };
}

function createPairingUrl() {
  const payload = createPairingPayload();
  const url = new URL('pocketpilot://pair');
  url.searchParams.set('host', payload.host);
  url.searchParams.set('port', String(payload.port));
  url.searchParams.set('token', payload.token);
  url.searchParams.set('name', payload.name);

  return url.toString();
}

function printPairingQr() {
  const payload = createPairingPayload();
  const pairingUrl = createPairingUrl();

  console.log('Pair on mobile with one of these options:');
  console.log(`1. Discover PCs in the app on the same Wi-Fi/LAN`);
  console.log(`2. Scan this QR code from the app`);
  console.log(`3. Paste this pairing code in the app:`);
  console.log(pairingUrl);
  console.log(`Available bridge IPs: ${payload.hosts.join(', ') || '127.0.0.1'}`);
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
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  if (requestUrl.pathname === '/pairing') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(createPairingPayload()));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(
    [
      'PocketPilot bridge is running.',
      `Port: ${PORT}`,
      `Token: ${TOKEN}`,
      `Pairing URL: ${createPairingUrl()}`,
      'Use the Android app to discover this PC, scan the QR, or paste the pairing URL.',
    ].join('\n'),
  );
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
  console.log('PocketPilot bridge is live.');
  console.log(`Host: ${HOST}`);
  console.log(`Port: ${PORT}`);
  console.log(`Token: ${TOKEN}`);
  console.log(`Shell: ${currentShell}`);
  printPairingQr();
});
