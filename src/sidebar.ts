// src/sidebar.ts
import * as vscode from 'vscode';
import * as qrcode from 'qrcode';
import { OrbDaemon, DaemonEvent } from './daemon';
import { OrbConfig } from './types';
import { generatePairingToken, encodePairingQR, buildPairingPayload, getLocalIp, isTokenValid, tokenExpiresIn } from './pairing';
import { saveConfig } from './store';

export class OrbSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'orb.main';
  private _view?: vscode.WebviewView;
  private _daemon: OrbDaemon;
  private _context: vscode.ExtensionContext;
  private _cfg: OrbConfig;
  private _logs: Array<{ ts: string; level: string; msg: string }> = [];
  private _qrDataUrl: string | null = null;
  private _disposeEventListener?: () => void;
  private _tokenRefreshInterval?: NodeJS.Timeout;

  constructor(context: vscode.ExtensionContext, daemon: OrbDaemon, cfg: OrbConfig) {
    this._context = context;
    this._daemon = daemon;
    this._cfg = cfg;
  }

  updateState(cfg: OrbConfig): void {
    this._cfg = cfg;
    this._pushStats();
  }

  private _log(level: 'info' | 'warn' | 'error', msg: string): void {
    const entry = { ts: new Date().toISOString().slice(11, 23), level, msg };
    this._logs.unshift(entry);
    if (this._logs.length > 100) this._logs.length = 100;
    this._view?.webview.postMessage({ type: 'log', data: entry });
  }

  private _pushStats(): void {
    const stats = this._daemon.getStats();
    this._view?.webview.postMessage({ type: 'stats', data: stats });
    this._view?.webview.postMessage({ type: 'devices', data: this._cfg.pairedDevices });
  }

  private _startTokenRefresh(): void {
    this._stopTokenRefresh();
    this._tokenRefreshInterval = setInterval(() => {
      if (!isTokenValid(this._cfg)) {
        this._view?.webview.postMessage({ type: 'token_expired' });
        this._stopTokenRefresh();
      } else {
        const remaining = Math.ceil(tokenExpiresIn(this._cfg) / 1000);
        this._view?.webview.postMessage({ type: 'token_tick', data: { remaining } });
      }
    }, 1000);
  }

  private _stopTokenRefresh(): void {
    if (this._tokenRefreshInterval) {
      clearInterval(this._tokenRefreshInterval);
      this._tokenRefreshInterval = undefined;
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this._buildHtml();

    // Listen to daemon events
    this._disposeEventListener?.();
    this._disposeEventListener = this._daemon.onEvent((evt: DaemonEvent) => {
      switch (evt.type) {
        case 'started':
          this._log('info', `Daemon started on port ${(evt.data as any)?.port}`);
          this._pushStats();
          break;
        case 'stopped':
          this._log('info', 'Daemon stopped');
          this._pushStats();
          break;
        case 'client_connected':
          this._log('info', `Client connected (total: ${(evt.data as any)?.clientCount})`);
          this._pushStats();
          break;
        case 'client_disconnected':
          this._log('info', `Client disconnected (${(evt.data as any)?.deviceLabel})`);
          this._pushStats();
          break;
        case 'paired':
          this._log('info', `✓ Paired: ${(evt.data as any)?.device?.name}`);
          this._stopTokenRefresh();
          this._qrDataUrl = null;
          this._view?.webview.postMessage({ type: 'paired', data: (evt.data as any)?.device });
          this._pushStats();
          break;
        case 'synced_env':
          this._log('info', `ENV synced: ${(evt.data as any)?.project}/${(evt.data as any)?.environment} (${(evt.data as any)?.count} vars)`);
          this._pushStats();
          break;
        case 'synced_blocklist':
          this._log('info', `Blocklist synced (${(evt.data as any)?.active} active)`);
          this._pushStats();
          break;
        case 'synced_vault':
          this._log('info', `Vault synced (${(evt.data as any)?.count} entries)`);
          this._pushStats();
          break;
        case 'reset':
          this._log('warn', 'Daemon data reset by mobile client');
          this._pushStats();
          break;
        case 'log':
          this._log('info', (evt.data as any)?.msg ?? '');
          break;
      }
    });

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          this._pushStats();
          this._view?.webview.postMessage({ type: 'devices', data: this._cfg.pairedDevices });
          this._view?.webview.postMessage({ type: 'logs', data: this._logs });
          break;

        case 'start_daemon':
          try {
            await this._daemon.start();
          } catch (e) {
            this._log('error', `Failed to start: ${e}`);
            vscode.window.showErrorMessage(`Orb: Failed to start daemon — ${e}`);
          }
          break;

        case 'stop_daemon':
          await this._daemon.stop();
          break;

        case 'generate_qr':
          await this._generateQR();
          break;

        case 'unpair_device': {
          const id = msg.data?.id;
          this._cfg.pairedDevices = this._cfg.pairedDevices.filter(d => d.id !== id);
          saveConfig(this._context, this._cfg);
          this._pushStats();
          this._view?.webview.postMessage({ type: 'devices', data: this._cfg.pairedDevices });
          this._log('info', `Device unpaired: ${msg.data?.name}`);
          break;
        }

        case 'reset_all':
          this._cfg.pairedDevices = [];
          saveConfig(this._context, this._cfg);
          this._qrDataUrl = null;
          this._stopTokenRefresh();
          this._pushStats();
          this._view?.webview.postMessage({ type: 'devices', data: [] });
          this._log('warn', 'All data reset');
          break;
      }
    });

    // Push initial state after a tick
    setTimeout(() => this._pushStats(), 100);
  }

  private async _generateQR(): Promise<void> {
    if (!this._daemon.isRunning) {
      try { await this._daemon.start(); } catch (e) {
        this._log('error', `Cannot generate QR — daemon failed to start: ${e}`);
        return;
      }
    }
    const { token } = generatePairingToken(this._cfg);
    saveConfig(this._context, this._cfg);
    const host = getLocalIp();
    const port = this._daemon.currentPort;
    const payload = buildPairingPayload(host, port, token, 'none');
    const qrString = encodePairingQR(payload);
    try {
      this._qrDataUrl = await qrcode.toDataURL(qrString, {
        width: 280,
        margin: 2,
        color: { dark: '#ffffff', light: '#0d0d12' },
        errorCorrectionLevel: 'M',
      });
      this._view?.webview.postMessage({
        type: 'qr',
        data: { dataUrl: this._qrDataUrl, host, port, token: token.slice(0, 8) + '...' + token.slice(-8) },
      });
      this._startTokenRefresh();
      this._log('info', `Pairing QR generated — ws://${host}:${port}`);
    } catch (e) {
      this._log('error', `QR generation failed: ${e}`);
    }
  }

  private _buildHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Orb DevKit</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700;800&family=Syne:wght@700;800&display=swap');
  
  :root {
    --bg:         #0a0a0f;
    --bg2:        #111118;
    --bg3:        #16161f;
    --border:     rgba(255,255,255,0.07);
    --border2:    rgba(255,255,255,0.12);
    --accent:     #7c6dff;
    --accent2:    #a78bfa;
    --emerald:    #34d399;
    --rose:       #f87171;
    --amber:      #fbbf24;
    --text:       #e4e4ef;
    --text2:      #71717a;
    --text3:      #3f3f46;
    --radius:     10px;
    --mono:       'JetBrains Mono', monospace;
    --display:    'Syne', sans-serif;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: var(--mono); font-size: 11px; overflow-x: hidden; }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 3px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--text3); border-radius: 2px; }

  .panel { padding: 12px; display: flex; flex-direction: column; gap: 10px; min-height: 100vh; }

  /* ── Header ── */
  .header { display: flex; align-items: center; justify-content: space-between; padding: 4px 0 8px; border-bottom: 1px solid var(--border); }
  .logo { display: flex; align-items: center; gap: 8px; }
  .orb-mark { width: 28px; height: 28px; border-radius: 50%; background: radial-gradient(circle at 38% 32%, #1a1a2e 0%, #09090b 60%, #000 100%); border: 1px solid var(--accent); box-shadow: 0 0 10px var(--accent)55, inset 0 0 8px rgba(0,0,0,0.8); position: relative; flex-shrink: 0; animation: orb-pulse 3s ease-in-out infinite; }
  @keyframes orb-pulse { 0%,100%{box-shadow:0 0 8px var(--accent)44} 50%{box-shadow:0 0 16px var(--accent)88,0 0 30px var(--accent)22} }
  .logo-text { font-family: var(--display); font-size: 13px; font-weight: 800; color: var(--text); letter-spacing: 0.05em; }
  .logo-text span { color: var(--accent); }
  .version-tag { font-size: 9px; color: var(--text3); background: var(--bg3); border: 1px solid var(--border); padding: 2px 6px; border-radius: 4px; font-weight: 600; letter-spacing: 0.08em; }

  /* ── Status bar ── */
  .status-bar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-radius: var(--radius); background: var(--bg2); border: 1px solid var(--border); }
  .status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .status-dot.online { background: var(--emerald); box-shadow: 0 0 6px var(--emerald)88; animation: pulse-dot 2s ease-in-out infinite; }
  .status-dot.offline { background: var(--rose); }
  @keyframes pulse-dot { 0%,100%{opacity:1} 50%{opacity:0.4} }
  .status-label { font-weight: 700; font-size: 10px; flex: 1; }
  .status-label.online { color: var(--emerald); }
  .status-label.offline { color: var(--rose); }
  .status-meta { font-size: 9px; color: var(--text3); }
  .status-btn { padding: 3px 8px; border-radius: 5px; border: none; cursor: pointer; font-family: var(--mono); font-size: 9px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; transition: all 0.15s; }
  .btn-start { background: var(--emerald)22; color: var(--emerald); border: 1px solid var(--emerald)44; }
  .btn-start:hover { background: var(--emerald)33; }
  .btn-stop { background: var(--rose)15; color: var(--rose); border: 1px solid var(--rose)33; }
  .btn-stop:hover { background: var(--rose)25; }

  /* ── Stats grid ── */
  .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .stat-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 10px; }
  .stat-label { font-size: 8px; color: var(--text3); text-transform: uppercase; letter-spacing: 0.1em; font-weight: 700; margin-bottom: 4px; }
  .stat-value { font-size: 20px; font-weight: 800; line-height: 1; }
  .stat-sub { font-size: 8px; color: var(--text3); margin-top: 3px; }
  .c-accent { color: var(--accent2); }
  .c-emerald { color: var(--emerald); }
  .c-amber { color: var(--amber); }
  .c-rose { color: var(--rose); }

  /* ── Section ── */
  .section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .section-title { font-size: 9px; font-weight: 700; color: var(--text3); text-transform: uppercase; letter-spacing: 0.12em; }
  .section-action { font-size: 9px; font-weight: 700; color: var(--accent); background: var(--accent)15; border: 1px solid var(--accent)30; border-radius: 5px; padding: 2px 7px; cursor: pointer; transition: all 0.15s; font-family: var(--mono); }
  .section-action:hover { background: var(--accent)25; }

  /* ── Pairing ── */
  .pair-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .pair-header { padding: 8px 10px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--border); }
  .pair-icon { width: 28px; height: 28px; border-radius: 7px; display: flex; align-items: center; justify-content: center; background: var(--accent)15; border: 1px solid var(--accent)30; font-size: 14px; }
  .pair-title { font-weight: 700; font-size: 11px; color: var(--text); }
  .pair-sub { font-size: 9px; color: var(--text3); margin-top: 1px; }
  .pair-body { padding: 10px; }
  .qr-wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .qr-img { border-radius: 8px; border: 1px solid var(--border); }
  .qr-meta { width: 100%; display: flex; flex-direction: column; gap: 5px; }
  .qr-row { display: flex; align-items: center; justify-content: space-between; background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; }
  .qr-key { font-size: 8px; color: var(--text3); text-transform: uppercase; letter-spacing: 0.1em; }
  .qr-val { font-size: 9px; font-weight: 600; color: var(--text); font-family: var(--mono); }
  .qr-val.accent { color: var(--accent2); }
  .timer-bar { width: 100%; height: 3px; border-radius: 2px; background: var(--border); overflow: hidden; }
  .timer-fill { height: 100%; background: var(--accent); border-radius: 2px; transition: width 1s linear; }
  .timer-label { font-size: 8px; color: var(--text3); text-align: center; }
  .expired-msg { text-align: center; padding: 12px 0 4px; color: var(--rose); font-size: 10px; font-weight: 600; }
  .gen-qr-btn { width: 100%; padding: 9px; background: var(--accent); color: #fff; border: none; border-radius: 7px; cursor: pointer; font-family: var(--mono); font-size: 10px; font-weight: 700; letter-spacing: 0.08em; transition: all 0.15s; text-transform: uppercase; }
  .gen-qr-btn:hover { background: var(--accent2); }

  /* ── Steps ── */
  .steps { display: flex; flex-direction: column; gap: 6px; padding-top: 4px; }
  .step { display: flex; gap: 8px; align-items: flex-start; }
  .step-num { width: 18px; height: 18px; border-radius: 50%; background: var(--accent)18; border: 1px solid var(--accent)30; color: var(--accent); font-size: 9px; font-weight: 800; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
  .step-text { font-size: 10px; color: var(--text2); line-height: 1.4; }
  .step-text b { color: var(--accent2); }

  /* ── Devices ── */
  .device-list { display: flex; flex-direction: column; gap: 6px; }
  .device-card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 10px; display: flex; align-items: center; gap: 8px; }
  .device-orb { width: 32px; height: 32px; border-radius: 50%; background: radial-gradient(circle at 38% 32%, #1a1a2e 0%, #000 100%); border: 1px solid var(--accent)66; box-shadow: 0 0 8px var(--accent)33; flex-shrink: 0; }
  .device-info { flex: 1; min-width: 0; }
  .device-name { font-weight: 700; font-size: 10px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .device-meta { font-size: 9px; color: var(--text3); margin-top: 2px; }
  .device-badge { font-size: 8px; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: var(--emerald)15; color: var(--emerald); border: 1px solid var(--emerald)25; white-space: nowrap; }
  .device-rm { width: 24px; height: 24px; border-radius: 5px; background: var(--rose)10; border: 1px solid var(--rose)20; color: var(--rose); cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 12px; transition: all 0.15s; flex-shrink: 0; }
  .device-rm:hover { background: var(--rose)25; }
  .no-devices { text-align: center; padding: 14px; color: var(--text3); font-size: 9px; border: 1px dashed var(--border2); border-radius: var(--radius); }

  /* ── Log ── */
  .log-box { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); max-height: 130px; overflow-y: auto; padding: 6px 8px; display: flex; flex-direction: column; gap: 2px; }
  .log-entry { display: flex; gap: 6px; font-size: 9px; line-height: 1.5; }
  .log-ts { color: var(--text3); flex-shrink: 0; font-size: 8px; }
  .log-msg { color: var(--text2); word-break: break-all; }
  .log-entry.error .log-msg { color: var(--rose); }
  .log-entry.warn .log-msg { color: var(--amber); }
  .log-entry.info .log-msg { color: var(--text2); }
  .log-empty { color: var(--text3); font-size: 9px; text-align: center; padding: 8px; }

  /* ── Footer ── */
  .footer { display: flex; align-items: center; justify-content: space-between; padding-top: 6px; border-top: 1px solid var(--border); margin-top: 4px; }
  .footer-left { font-size: 8px; color: var(--text3); }
  .reset-btn { font-size: 8px; color: var(--rose)99; background: var(--rose)08; border: 1px solid var(--rose)15; padding: 2px 7px; border-radius: 4px; cursor: pointer; font-family: var(--mono); font-weight: 600; }
  .reset-btn:hover { color: var(--rose); background: var(--rose)15; }

  /* ── Uptime ── */
  #uptime { font-feature-settings: 'tnum'; }
</style>
</head>
<body>
<div class="panel">

  <!-- Header -->
  <div class="header">
    <div class="logo">
      <div class="orb-mark"></div>
      <div>
        <div class="logo-text">Orb<span> DevKit</span></div>
      </div>
    </div>
    <div class="version-tag">v1.0.0</div>
  </div>

  <!-- Status bar -->
  <div class="status-bar" id="status-bar">
    <div class="status-dot offline" id="status-dot"></div>
    <span class="status-label offline" id="status-label">daemon · offline</span>
    <span class="status-meta" id="status-meta">—</span>
    <button class="status-btn btn-start" id="toggle-btn" onclick="toggleDaemon()">Start</button>
  </div>

  <!-- Stats -->
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Clients</div>
      <div class="stat-value c-accent" id="stat-clients">0</div>
      <div class="stat-sub">connected now</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Paired</div>
      <div class="stat-value c-emerald" id="stat-paired">0</div>
      <div class="stat-sub">devices</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">ENV vars</div>
      <div class="stat-value c-amber" id="stat-vars">0</div>
      <div class="stat-sub" id="stat-projects">0 projects</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Vault</div>
      <div class="stat-value c-rose" id="stat-vault">0</div>
      <div class="stat-sub">entries synced</div>
    </div>
  </div>

  <!-- Pairing section -->
  <div>
    <div class="section-head">
      <span class="section-title">Pairing</span>
    </div>
    <div class="pair-card">
      <div class="pair-header">
        <div class="pair-icon">📡</div>
        <div>
          <div class="pair-title">Connect Mobile App</div>
          <div class="pair-sub">Scan QR from the Orb mobile app → Devices tab</div>
        </div>
      </div>
      <div class="pair-body">
        <!-- QR display -->
        <div id="qr-section" style="display:none;" class="qr-wrap">
          <img id="qr-img" class="qr-img" width="220" height="220" alt="Pairing QR" />
          <div class="qr-meta">
            <div class="qr-row">
              <span class="qr-key">Address</span>
              <span class="qr-val accent" id="qr-addr">—</span>
            </div>
            <div class="qr-row">
              <span class="qr-key">Token</span>
              <span class="qr-val" id="qr-token">—</span>
            </div>
            <div>
              <div class="timer-bar"><div class="timer-fill" id="timer-fill" style="width:100%"></div></div>
              <div class="timer-label" id="timer-label">Expires in 5:00</div>
            </div>
          </div>
        </div>

        <!-- Expired / not yet generated -->
        <div id="qr-expired" style="display:none;">
          <div class="expired-msg">⚠ Token expired — generate a new QR code</div>
        </div>

        <!-- Default: steps + button -->
        <div id="qr-steps" class="steps">
          <div class="step">
            <div class="step-num">1</div>
            <div class="step-text">Open the <b>Orb</b> mobile app and navigate to <b>Devices</b></div>
          </div>
          <div class="step">
            <div class="step-num">2</div>
            <div class="step-text">Tap <b>Pair Desktop</b> then click the button below</div>
          </div>
          <div class="step">
            <div class="step-num">3</div>
            <div class="step-text">Scan the QR — must be on the <b>same WiFi</b> network</div>
          </div>
        </div>

        <button class="gen-qr-btn" style="margin-top:10px;" onclick="generateQR()">
          ⬡ Generate Pairing QR
        </button>
      </div>
    </div>
  </div>

  <!-- Paired devices -->
  <div>
    <div class="section-head">
      <span class="section-title">Paired Devices</span>
    </div>
    <div class="device-list" id="device-list">
      <div class="no-devices" id="no-devices">No devices paired yet</div>
    </div>
  </div>

  <!-- Live log -->
  <div>
    <div class="section-head">
      <span class="section-title">Activity Log</span>
      <button class="section-action" onclick="clearLog()">Clear</button>
    </div>
    <div class="log-box" id="log-box">
      <div class="log-empty">No activity yet…</div>
    </div>
  </div>

  <!-- Footer -->
  <div class="footer">
    <span class="footer-left">Uptime: <span id="uptime">—</span></span>
    <button class="reset-btn" onclick="resetAll()">Reset All</button>
  </div>

</div>

<script>
const vscode = acquireVsCodeApi();

let daemonRunning = false;
let uptimeStart = null;
let uptimeTimer = null;
let tokenMax = 300;
let tokenRemaining = 300;
let qrVisible = false;

// ── Uptime ──────────────────────────────────────────────────
function startUptime(ms) {
  uptimeStart = Date.now() - ms;
  clearInterval(uptimeTimer);
  uptimeTimer = setInterval(renderUptime, 1000);
  renderUptime();
}
function stopUptime() {
  clearInterval(uptimeTimer);
  uptimeTimer = null;
  uptimeStart = null;
  document.getElementById('uptime').textContent = '—';
}
function renderUptime() {
  if (!uptimeStart) return;
  const s = Math.floor((Date.now() - uptimeStart) / 1000);
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  document.getElementById('uptime').textContent = h > 0
    ? h + 'h ' + String(m).padStart(2,'0') + 'm'
    : String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
}

// ── Stats update ────────────────────────────────────────────
function updateStats(stats) {
  daemonRunning = stats.running;

  const dot   = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  const meta  = document.getElementById('status-meta');
  const btn   = document.getElementById('toggle-btn');

  if (stats.running) {
    dot.className   = 'status-dot online';
    label.className = 'status-label online';
    label.textContent = 'daemon · online';
    meta.textContent  = ':' + stats.port;
    btn.className  = 'status-btn btn-stop';
    btn.textContent = 'Stop';
    startUptime(stats.uptime);
  } else {
    dot.className   = 'status-dot offline';
    label.className = 'status-label offline';
    label.textContent = 'daemon · offline';
    meta.textContent  = '—';
    btn.className  = 'status-btn btn-start';
    btn.textContent = 'Start';
    stopUptime();
  }

  document.getElementById('stat-clients').textContent = stats.connectedClients;
  document.getElementById('stat-paired').textContent  = stats.pairedDevices;
  document.getElementById('stat-vars').textContent    = stats.totalVars ?? '0';
  document.getElementById('stat-projects').textContent = (stats.envProjects ?? 0) + ' projects';
  document.getElementById('stat-vault').textContent   = stats.vaultEntries;
}

// ── Device list ─────────────────────────────────────────────
function renderDevices(devices) {
  const list = document.getElementById('device-list');
  const noDevices = document.getElementById('no-devices');
  if (!devices || !devices.length) {
    noDevices.style.display = '';
    const existing = list.querySelectorAll('.device-card');
    existing.forEach(el => el.remove());
    return;
  }
  noDevices.style.display = 'none';
  list.querySelectorAll('.device-card').forEach(el => el.remove());
  devices.forEach(d => {
    const el = document.createElement('div');
    el.className = 'device-card';
    el.dataset.id = d.id;
    el.innerHTML = \`
      <div class="device-orb"></div>
      <div class="device-info">
        <div class="device-name">\${escHtml(d.name)}</div>
        <div class="device-meta">Paired \${timeAgo(d.pairedAt)}</div>
      </div>
      <div class="device-badge">paired</div>
      <div class="device-rm" onclick="unpairDevice('\${escHtml(d.id)}','\${escHtml(d.name)}')">×</div>
    \`;
    list.appendChild(el);
  });
}

// ── Log ─────────────────────────────────────────────────────
function addLog(entry) {
  const box = document.getElementById('log-box');
  const empty = box.querySelector('.log-empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'log-entry ' + (entry.level || 'info');
  el.innerHTML = \`<span class="log-ts">\${escHtml(entry.ts)}</span><span class="log-msg">\${escHtml(entry.msg)}</span>\`;
  box.insertBefore(el, box.firstChild);
  while (box.children.length > 60) box.removeChild(box.lastChild);
}
function clearLog() {
  document.getElementById('log-box').innerHTML = '<div class="log-empty">No activity yet…</div>';
}

// ── QR ──────────────────────────────────────────────────────
function showQR(data) {
  qrVisible = true;
  document.getElementById('qr-steps').style.display = 'none';
  document.getElementById('qr-expired').style.display = 'none';
  document.getElementById('qr-section').style.display = '';
  document.getElementById('qr-img').src = data.dataUrl;
  document.getElementById('qr-addr').textContent = 'ws://' + data.host + ':' + data.port;
  document.getElementById('qr-token').textContent = data.token;
  tokenMax = 300;
  tokenRemaining = 300;
  updateTimer();
}
function updateTimer() {
  const pct = Math.max(0, (tokenRemaining / tokenMax) * 100);
  document.getElementById('timer-fill').style.width = pct + '%';
  const m = Math.floor(tokenRemaining / 60);
  const s = tokenRemaining % 60;
  document.getElementById('timer-label').textContent = 'Expires in ' + m + ':' + String(s).padStart(2,'0');
}
function expireQR() {
  qrVisible = false;
  document.getElementById('qr-section').style.display = 'none';
  document.getElementById('qr-steps').style.display = 'none';
  document.getElementById('qr-expired').style.display = '';
}
function pairSuccess(device) {
  qrVisible = false;
  document.getElementById('qr-section').style.display = 'none';
  document.getElementById('qr-expired').style.display = 'none';
  document.getElementById('qr-steps').style.display = '';
}

// ── Actions ──────────────────────────────────────────────────
function toggleDaemon() {
  vscode.postMessage({ type: daemonRunning ? 'stop_daemon' : 'start_daemon' });
}
function generateQR() {
  vscode.postMessage({ type: 'generate_qr' });
}
function unpairDevice(id, name) {
  vscode.postMessage({ type: 'unpair_device', data: { id, name } });
}
function resetAll() {
  if (confirm('Reset all Orb data? This will unpair all devices.')) {
    vscode.postMessage({ type: 'reset_all' });
  }
}

// ── Helpers ──────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff/60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  return Math.floor(m/60) + 'h ago';
}

// ── Message handler ──────────────────────────────────────────
window.addEventListener('message', e => {
  const { type, data } = e.data;
  switch (type) {
    case 'stats':    updateStats(data); break;
    case 'devices':  renderDevices(data); break;
    case 'log':      addLog(data); break;
    case 'logs':     (data || []).slice(0,30).reverse().forEach(addLog); break;
    case 'qr':       showQR(data); break;
    case 'token_expired': expireQR(); break;
    case 'token_tick':
      tokenRemaining = data.remaining;
      updateTimer();
      break;
    case 'paired':   pairSuccess(data); break;
  }
});

// Init
vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}