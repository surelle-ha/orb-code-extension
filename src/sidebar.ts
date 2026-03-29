// src/sidebar.ts
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as qrcode from 'qrcode';
import { OrbDaemon, DaemonEvent } from './daemon';
import { OrbConfig } from './types';
import {
  generatePairingToken, encodePairingQR, buildPairingPayload,
  getLocalIp, isTokenValid, tokenExpiresIn,
} from './pairing';
import { saveConfig } from './store';

export class OrbSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'orb.main';
  private _view?: vscode.WebviewView;
  private _daemon: OrbDaemon;
  private _context: vscode.ExtensionContext;
  private _cfg: OrbConfig;
  private _disposeEventListener?: () => void;
  private _tokenRefreshInterval?: NodeJS.Timeout;

  constructor(context: vscode.ExtensionContext, daemon: OrbDaemon, cfg: OrbConfig) {
    this._context = context;
    this._daemon  = daemon;
    this._cfg     = cfg;
  }

  updateState(cfg: OrbConfig): void {
    this._cfg = cfg;
    this._pushAll();
  }

  private _pushAll(): void {
    if (!this._view) { return; }
    const stats = this._daemon.getStats();
    const data  = this._daemon.getData();
    this._view.webview.postMessage({
      type: 'state',
      data: {
        stats,
        devices: this._cfg.pairedDevices,
        envs:    data.envs,
        vault:   data.vault,
      },
    });
  }

  private _startTokenRefresh(): void {
    this._stopTokenRefresh();
    this._tokenRefreshInterval = setInterval(() => {
      if (!this._view) { return; }
      if (!isTokenValid(this._cfg)) {
        this._view.webview.postMessage({ type: 'token_expired' });
        this._stopTokenRefresh();
      } else {
        const remaining = Math.ceil(tokenExpiresIn(this._cfg) / 1000);
        this._view.webview.postMessage({ type: 'token_tick', data: { remaining } });
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

    const nonce = crypto.randomBytes(16).toString('hex');

    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html    = this._buildHtml(nonce);

    // ── Daemon events → webview ──────────────────────────────
    this._disposeEventListener?.();
    this._disposeEventListener = this._daemon.onEvent((evt: DaemonEvent) => {
      switch (evt.type) {
        case 'started':
        case 'stopped':
        case 'client_connected':
        case 'client_disconnected':
        case 'synced_env':
        case 'synced_blocklist':
        case 'synced_vault':
        case 'reset':
          this._pushAll();
          break;
        case 'paired':
          this._stopTokenRefresh();
          this._pushAll();
          if (this._view) {
            this._view.webview.postMessage({ type: 'paired' });
          }
          break;
      }
    });

    // ── Webview → extension ──────────────────────────────────
    webviewView.webview.onDidReceiveMessage(async (msg: { type: string; data?: unknown }) => {
      switch (msg.type) {

        case 'ready':
          this._pushAll();
          break;

        case 'start_daemon':
          try {
            await this._daemon.start();
          } catch (e) {
            vscode.window.showErrorMessage(`Orb: Failed to start daemon — ${e}`);
          }
          this._pushAll();
          break;

        case 'stop_daemon':
          await this._daemon.stop();
          this._pushAll();
          break;

        case 'generate_qr':
          if (!this._daemon.isRunning) { return; }
          await this._generateQR();
          break;

        case 'disconnect_device': {
          const id = (msg.data as { id: string }).id;
          this._cfg.pairedDevices = this._cfg.pairedDevices.filter(d => d.id !== id);
          saveConfig(this._context, this._cfg);
          this._pushAll();
          break;
        }

        case 'reset_all':
          this._cfg.pairedDevices = [];
          saveConfig(this._context, this._cfg);
          this._stopTokenRefresh();
          this._pushAll();
          break;
      }
    });

    // Push initial state shortly after the webview is ready
    setTimeout(() => this._pushAll(), 150);
  }

  private async _generateQR(): Promise<void> {
    const { token } = generatePairingToken(this._cfg);
    saveConfig(this._context, this._cfg);
    const host      = getLocalIp();
    const port      = this._daemon.currentPort;
    const payload   = buildPairingPayload(host, port, token, 'none');
    const qrString  = encodePairingQR(payload);
    try {
      const dataUrl = await qrcode.toDataURL(qrString, {
        width: 220, margin: 2,
        color: { dark: '#e4e4ef', light: '#0d0d14' },
        errorCorrectionLevel: 'M',
      });
      if (this._view) {
        this._view.webview.postMessage({
          type: 'qr',
          data: { dataUrl, host, port, token: token.slice(0, 8) + '…' + token.slice(-8) },
        });
      }
      this._startTokenRefresh();
    } catch (e) {
      vscode.window.showErrorMessage(`Orb: QR generation failed — ${e}`);
    }
  }

  private _buildHtml(nonce: string): string {
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           style-src  'unsafe-inline' https://fonts.googleapis.com;
           font-src   https://fonts.gstatic.com;
           img-src    data: https:;
           script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orb DevKit</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700;800&family=Syne:wght@700;800&display=swap" rel="stylesheet">
<style>
:root {
  --bg:      #0a0a0f;
  --bg2:     #111118;
  --bg3:     #16161f;
  --bdr:     rgba(255,255,255,0.07);
  --bdr2:    rgba(255,255,255,0.12);
  --accent:  #7c6dff;
  --accent2: #a78bfa;
  --emerald: #34d399;
  --rose:    #f87171;
  --amber:   #fbbf24;
  --sky:     #60a5fa;
  --text:    #e4e4ef;
  --text2:   #71717a;
  --text3:   #3f3f46;
  --r:       9px;
  --mono:    'JetBrains Mono', monospace;
  --display: 'Syne', sans-serif;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; background: var(--bg); color: var(--text); font-family: var(--mono); font-size: 11px; }
::-webkit-scrollbar { width: 3px; }
::-webkit-scrollbar-thumb { background: var(--text3); border-radius: 2px; }

.panel { padding: 11px; display: flex; flex-direction: column; gap: 9px; min-height: 100vh; }

/* Header */
.hdr { display: flex; align-items: center; justify-content: space-between; padding-bottom: 9px; border-bottom: 1px solid var(--bdr); }
.logo { display: flex; align-items: center; gap: 7px; }
.orb-mark { width: 26px; height: 26px; border-radius: 50%; background: radial-gradient(circle at 38% 32%, #1a1a2e 0%, #09090b 60%, #000 100%); border: 1px solid var(--accent); box-shadow: 0 0 10px color-mix(in srgb,var(--accent) 33%,transparent); animation: orbp 3s ease-in-out infinite; flex-shrink: 0; }
@keyframes orbp { 0%,100% { box-shadow: 0 0 8px color-mix(in srgb,var(--accent) 27%,transparent); } 50% { box-shadow: 0 0 18px color-mix(in srgb,var(--accent) 53%,transparent); } }
.logo-name { font-family: var(--display); font-size: 13px; font-weight: 800; letter-spacing: .05em; }
.logo-name span { color: var(--accent); }
.vtag { font-size: 8px; color: var(--text3); background: var(--bg3); border: 1px solid var(--bdr); padding: 2px 6px; border-radius: 4px; font-weight: 600; letter-spacing: .08em; }

/* Status pill */
.status-row { display: flex; align-items: center; gap: 6px; padding: 7px 10px; border-radius: var(--r); background: var(--bg2); border: 1px solid var(--bdr); }
.sdot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: var(--rose); }
.sdot.on { background: var(--emerald); animation: pdot 2s ease-in-out infinite; }
@keyframes pdot { 0%,100% { opacity:1; } 50% { opacity:.35; } }
.slbl { font-weight: 700; font-size: 10px; flex: 1; color: var(--rose); }
.slbl.on { color: var(--emerald); }
.smeta { font-size: 9px; color: var(--text3); }
.tbtn { padding: 4px 9px; border-radius: 5px; border: none; cursor: pointer; font-family: var(--mono); font-size: 9px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; transition: opacity .12s; background: #2d2d3a; color: var(--text2); border: 1px solid var(--bdr2); }
.tbtn:hover { opacity: .8; }
.tbtn.start { background: rgba(52,211,153,.12); color: var(--emerald); border-color: rgba(52,211,153,.3); }
.tbtn.stop  { background: rgba(248,113,113,.1); color: var(--rose);    border-color: rgba(248,113,113,.25); }

/* Section head */
.sh { display: flex; align-items: center; justify-content: space-between; margin-bottom: 5px; }
.stitle { font-size: 8px; font-weight: 700; color: var(--text3); text-transform: uppercase; letter-spacing: .12em; }

/* Device card */
.device-card { background: var(--bg2); border: 1px solid rgba(124,109,255,.2); border-radius: var(--r); padding: 9px 11px; display: flex; align-items: center; gap: 8px; }
.dorb { width: 30px; height: 30px; border-radius: 50%; background: radial-gradient(circle at 38% 32%, #1a1a2e 0%, #000 100%); border: 1px solid rgba(124,109,255,.4); flex-shrink: 0; }
.dinfo { flex: 1; min-width: 0; }
.dname { font-weight: 700; font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dmeta { font-size: 9px; color: var(--text3); margin-top: 2px; }
.dbadge { font-size: 8px; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: rgba(52,211,153,.1); color: var(--emerald); border: 1px solid rgba(52,211,153,.2); white-space: nowrap; }
.disc-btn { padding: 3px 8px; border-radius: 5px; background: rgba(248,113,113,.08); color: var(--rose); border: 1px solid rgba(248,113,113,.2); cursor: pointer; font-family: var(--mono); font-size: 8px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; flex-shrink: 0; }
.disc-btn:hover { background: rgba(248,113,113,.18); }

/* Pairing card */
.pair-card { background: var(--bg2); border: 1px solid var(--bdr); border-radius: var(--r); overflow: hidden; }
.pair-hd { padding: 8px 10px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--bdr); }
.pair-icon { width: 26px; height: 26px; border-radius: 6px; display: flex; align-items: center; justify-content: center; background: rgba(124,109,255,.1); border: 1px solid rgba(124,109,255,.25); font-size: 13px; flex-shrink: 0; }
.pair-title { font-weight: 700; font-size: 10px; }
.pair-sub { font-size: 8px; color: var(--text3); margin-top: 1px; }
.pair-body { padding: 10px; display: flex; flex-direction: column; gap: 8px; }

/* Steps */
.steps { display: flex; flex-direction: column; gap: 5px; }
.step { display: flex; gap: 7px; align-items: flex-start; }
.snum { width: 16px; height: 16px; border-radius: 50%; background: rgba(124,109,255,.12); border: 1px solid rgba(124,109,255,.25); color: var(--accent); font-size: 8px; font-weight: 800; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
.stext { font-size: 9px; color: var(--text2); line-height: 1.4; }
.stext b { color: var(--accent2); }

/* QR */
.qr-wrap { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.qr-img { border-radius: 7px; border: 1px solid var(--bdr); display: block; }
.qr-meta { width: 100%; display: flex; flex-direction: column; gap: 4px; }
.qrow { display: flex; align-items: center; justify-content: space-between; background: var(--bg3); border: 1px solid var(--bdr); border-radius: 5px; padding: 4px 8px; }
.qkey { font-size: 8px; color: var(--text3); text-transform: uppercase; letter-spacing: .09em; }
.qval { font-size: 9px; font-weight: 600; color: var(--text); font-family: var(--mono); }
.qval.a { color: var(--accent2); }
.timer-bar { width: 100%; height: 3px; border-radius: 2px; background: var(--bdr); overflow: hidden; }
.timer-fill { height: 100%; background: var(--accent); border-radius: 2px; transition: width 1s linear; }
.timer-lbl { font-size: 8px; color: var(--text3); text-align: center; margin-top: 2px; }
.expired-msg { text-align: center; color: var(--rose); font-size: 9px; font-weight: 600; padding: 6px 0; }
.qr-btn { width: 100%; padding: 8px; background: var(--accent); color: #fff; border: none; border-radius: 7px; cursor: pointer; font-family: var(--mono); font-size: 10px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
.qr-btn:hover:not(:disabled) { background: var(--accent2); }
.qr-btn:disabled { opacity: .35; cursor: not-allowed; }

/* Stats */
.stats2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.scard { background: var(--bg2); border: 1px solid var(--bdr); border-radius: var(--r); padding: 8px 10px; }
.sc-label { font-size: 8px; color: var(--text3); text-transform: uppercase; letter-spacing: .1em; font-weight: 700; margin-bottom: 3px; }
.sc-val { font-size: 19px; font-weight: 800; line-height: 1; }
.sc-sub { font-size: 8px; color: var(--text3); margin-top: 2px; }
.cam { color: var(--amber); }
.cr  { color: var(--rose); }

/* ENV */
.env-list { display: flex; flex-direction: column; gap: 5px; }
.env-proj { background: var(--bg2); border: 1px solid var(--bdr); border-radius: var(--r); overflow: hidden; }
.env-proj-hd { display: flex; align-items: center; gap: 7px; padding: 7px 9px; cursor: pointer; user-select: none; }
.env-proj-hd:hover { background: rgba(255,255,255,.02); }
.proj-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.proj-name { font-weight: 700; font-size: 10px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.proj-env-tag { font-size: 7px; font-weight: 700; padding: 1px 5px; border-radius: 3px; flex-shrink: 0; }
.proj-chev { font-size: 11px; color: var(--text3); transition: transform .18s; flex-shrink: 0; display: inline-block; }
.proj-chev.open { transform: rotate(90deg); }
.env-vars { border-top: 1px solid var(--bdr); }
.var-row { display: flex; align-items: center; gap: 6px; padding: 5px 9px; border-bottom: 1px solid rgba(255,255,255,.03); }
.var-row:last-child { border-bottom: none; }
.var-key { font-size: 9px; font-weight: 600; color: var(--text); flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.var-type { font-size: 7px; font-weight: 700; padding: 1px 4px; border-radius: 3px; background: var(--bg3); color: var(--text3); border: 1px solid var(--bdr); text-transform: uppercase; flex-shrink: 0; }
.var-secret { font-size: 9px; color: var(--amber); flex-shrink: 0; }

/* Vault */
.vault-list { display: flex; flex-direction: column; gap: 4px; }
.vault-entry { display: flex; align-items: center; gap: 8px; background: var(--bg2); border: 1px solid var(--bdr); border-radius: var(--r); padding: 7px 9px; }
.vault-fav { width: 22px; height: 22px; border-radius: 5px; background: var(--bg3); border: 1px solid var(--bdr); display: flex; align-items: center; justify-content: center; font-size: 11px; flex-shrink: 0; }
.vault-info { flex: 1; min-width: 0; }
.vault-svc  { font-weight: 700; font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vault-usr  { font-size: 9px; color: var(--text3); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vault-cat  { font-size: 7px; font-weight: 700; padding: 1px 5px; border-radius: 3px; flex-shrink: 0; }

/* Footer */
.footer { display: flex; align-items: center; justify-content: space-between; padding-top: 6px; border-top: 1px solid var(--bdr); margin-top: 2px; }
.f-left { font-size: 8px; color: var(--text3); }
.rst-btn { font-size: 8px; color: var(--rose); opacity: .55; background: rgba(248,113,113,.06); border: 1px solid rgba(248,113,113,.15); padding: 2px 7px; border-radius: 4px; cursor: pointer; font-family: var(--mono); font-weight: 600; }
.rst-btn:hover { opacity: 1; }
</style>
</head>
<body>
<div class="panel">

  <!-- Header -->
  <div class="hdr">
    <div class="logo">
      <div class="orb-mark"></div>
      <div class="logo-name">Orb<span> DevKit</span></div>
    </div>
    <div class="vtag">v1.0.0</div>
  </div>

  <!-- Status row -->
  <div class="status-row">
    <div class="sdot" id="sdot"></div>
    <span class="slbl" id="slbl">daemon · offline</span>
    <span class="smeta" id="smeta">—</span>
    <button class="tbtn start" id="toggle-btn">Start</button>
  </div>

  <!-- Connected device -->
  <div id="device-section" style="display:none">
    <div class="sh"><span class="stitle">Connected Device</span></div>
    <div id="device-slot"></div>
  </div>

  <!-- Pairing card -->
  <div id="pair-section">
    <div class="sh"><span class="stitle">Pair Mobile App</span></div>
    <div class="pair-card">
      <div class="pair-hd">
        <div class="pair-icon">📡</div>
        <div>
          <div class="pair-title">Connect Mobile App</div>
          <div class="pair-sub">Open Orb app → Devices → Pair Desktop</div>
        </div>
      </div>
      <div class="pair-body">
        <div id="qr-section" style="display:none" class="qr-wrap">
          <img id="qr-img" class="qr-img" width="220" height="220" alt="Pairing QR" />
          <div class="qr-meta">
            <div class="qrow">
              <span class="qkey">Address</span>
              <span class="qval a" id="qr-addr">—</span>
            </div>
            <div class="qrow">
              <span class="qkey">Token</span>
              <span class="qval" id="qr-token">—</span>
            </div>
            <div>
              <div class="timer-bar"><div class="timer-fill" id="timer-fill" style="width:100%"></div></div>
              <div class="timer-lbl" id="timer-lbl">Expires in 5:00</div>
            </div>
          </div>
        </div>
        <div id="qr-expired" style="display:none">
          <div class="expired-msg">⚠ Token expired — regenerate below</div>
        </div>
        <div id="qr-steps" class="steps">
          <div class="step"><div class="snum">1</div><div class="stext">Open the <b>Orb</b> app → <b>Devices</b> tab</div></div>
          <div class="step"><div class="snum">2</div><div class="stext">Tap <b>Pair Desktop</b>, then Generate below</div></div>
          <div class="step"><div class="snum">3</div><div class="stext">Scan QR — both on the <b>same WiFi</b></div></div>
        </div>
        <button class="qr-btn" id="gen-btn" disabled>⬡ Generate Pairing QR</button>
      </div>
    </div>
  </div>

  <!-- Stats row -->
  <div class="stats2" id="stats-row" style="display:none">
    <div class="scard">
      <div class="sc-label">ENV vars</div>
      <div class="sc-val cam" id="stat-vars">0</div>
      <div class="sc-sub" id="stat-projects">0 projects</div>
    </div>
    <div class="scard">
      <div class="sc-label">Vault</div>
      <div class="sc-val cr" id="stat-vault">0</div>
      <div class="sc-sub">entries synced</div>
    </div>
  </div>

  <!-- ENV section -->
  <div id="env-section" style="display:none">
    <div class="sh"><span class="stitle">ENV Variables</span></div>
    <div class="env-list" id="env-list"></div>
  </div>

  <!-- Vault section -->
  <div id="vault-section" style="display:none">
    <div class="sh"><span class="stitle">Vault Entries</span></div>
    <div class="vault-list" id="vault-list"></div>
  </div>

  <!-- Footer -->
  <div class="footer">
    <span class="f-left">Uptime: <span id="uptime">—</span></span>
    <button class="rst-btn" id="reset-btn">Reset All</button>
  </div>

</div>

<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();

  // ── State ───────────────────────────────────────────────────
  let daemonRunning   = false;
  let hasPairedDevice = false;
  let uptimeStart     = null;
  let uptimeTimer     = null;
  let tokenMax        = 300;
  let tokenRemaining  = 300;
  const openProjects  = new Set();

  // ── Wire up buttons via addEventListener (no inline onclick) ─
  document.getElementById('toggle-btn').addEventListener('click', function() {
    vscode.postMessage({ type: daemonRunning ? 'stop_daemon' : 'start_daemon' });
  });

  document.getElementById('gen-btn').addEventListener('click', function() {
    if (!daemonRunning || hasPairedDevice) { return; }
    vscode.postMessage({ type: 'generate_qr' });
  });

  document.getElementById('reset-btn').addEventListener('click', function() {
    if (confirm('Reset all Orb data? This will unpair all devices and clear synced data.')) {
      vscode.postMessage({ type: 'reset_all' });
    }
  });

  // Disconnect button is injected dynamically — use event delegation
  document.getElementById('device-slot').addEventListener('click', function(e) {
    const btn = e.target.closest('.disc-btn');
    if (btn && btn.dataset.id) {
      vscode.postMessage({ type: 'disconnect_device', data: { id: btn.dataset.id } });
    }
  });

  // ENV project toggle — event delegation
  document.getElementById('env-list').addEventListener('click', function(e) {
    const hd = e.target.closest('.env-proj-hd');
    if (!hd) { return; }
    const key  = hd.dataset.projkey;
    const body = document.getElementById(key);
    const chev = hd.querySelector('.proj-chev');
    if (!body) { return; }
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : '';
    chev.classList.toggle('open', !isOpen);
    if (isOpen) { openProjects.delete(key); } else { openProjects.add(key); }
  });

  // ── Uptime ──────────────────────────────────────────────────
  function startUptime(ms) {
    uptimeStart = Date.now() - ms;
    clearInterval(uptimeTimer);
    uptimeTimer = setInterval(renderUptime, 1000);
    renderUptime();
  }
  function stopUptime() {
    clearInterval(uptimeTimer);
    uptimeStart = null;
    document.getElementById('uptime').textContent = '—';
  }
  function renderUptime() {
    if (!uptimeStart) { return; }
    const s   = Math.floor((Date.now() - uptimeStart) / 1000);
    const h   = Math.floor(s / 3600);
    const m   = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    document.getElementById('uptime').textContent = h > 0
      ? h + 'h ' + String(m).padStart(2, '0') + 'm'
      : String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }

  // ── Full state ──────────────────────────────────────────────
  function applyState(state) {
    const { stats, devices, envs, vault } = state;

    // Resolve hasPairedDevice FIRST so all subsequent functions read it correctly
    hasPairedDevice = !!(devices && devices.length > 0);

    updateStatus(stats);
    renderDevice(devices);
    renderEnvs(envs || []);
    renderVault(vault || []);

    const hasData = (stats.envProjects > 0) || (stats.vaultEntries > 0);
    document.getElementById('stats-row').style.display = hasData ? '' : 'none';
    document.getElementById('stat-vars').textContent = stats.totalVars != null ? stats.totalVars : 0;
    document.getElementById('stat-projects').textContent =
      (stats.envProjects || 0) + ' project' + (stats.envProjects === 1 ? '' : 's');
    document.getElementById('stat-vault').textContent = stats.vaultEntries != null ? stats.vaultEntries : 0;
  }

  // ── Daemon status ────────────────────────────────────────────
  function updateStatus(stats) {
    daemonRunning = !!stats.running;

    const dot = document.getElementById('sdot');
    const lbl = document.getElementById('slbl');
    const meta = document.getElementById('smeta');
    const btn = document.getElementById('toggle-btn');
    const gen = document.getElementById('gen-btn');

    if (daemonRunning) {
      dot.className    = 'sdot on';
      lbl.className    = 'slbl on';
      lbl.textContent  = 'daemon · online';
      meta.textContent = ':' + stats.port;
      btn.className    = 'tbtn stop';
      btn.textContent  = 'Stop';
      startUptime(stats.uptime || 0);
    } else {
      dot.className    = 'sdot';
      lbl.className    = 'slbl';
      lbl.textContent  = 'daemon · offline';
      meta.textContent = '—';
      btn.className    = 'tbtn start';
      btn.textContent  = 'Start';
      stopUptime();
    }

    gen.disabled = !daemonRunning || hasPairedDevice;
  }

  // ── Device ──────────────────────────────────────────────────
  function renderDevice(devices) {
    const pairSec   = document.getElementById('pair-section');
    const deviceSec = document.getElementById('device-section');
    const slot      = document.getElementById('device-slot');
    const gen       = document.getElementById('gen-btn');

    if (hasPairedDevice) {
      pairSec.style.display   = 'none';
      deviceSec.style.display = '';
      gen.disabled = true;

      const d = devices[devices.length - 1];
      slot.innerHTML =
        '<div class="device-card">' +
          '<div class="dorb"></div>' +
          '<div class="dinfo">' +
            '<div class="dname">' + esc(d.name) + '</div>' +
            '<div class="dmeta">Paired ' + ago(d.pairedAt) + '</div>' +
          '</div>' +
          '<div class="dbadge">paired</div>' +
          '<button class="disc-btn" data-id="' + esc(d.id) + '">Disconnect</button>' +
        '</div>';
    } else {
      pairSec.style.display   = '';
      deviceSec.style.display = 'none';
      slot.innerHTML = '';
      gen.disabled = !daemonRunning;
    }
  }

  // ── ENV ─────────────────────────────────────────────────────
  const PROJ_COLORS = ['#7c6dff','#34d399','#60a5fa','#fbbf24','#f87171','#a78bfa','#fb923c'];

  function renderEnvs(envs) {
    const sec  = document.getElementById('env-section');
    const list = document.getElementById('env-list');
    if (!envs || envs.length === 0) { sec.style.display = 'none'; return; }
    sec.style.display = '';

    // Group by project
    const byProject = {};
    envs.forEach(function(e) {
      if (!byProject[e.project]) { byProject[e.project] = []; }
      byProject[e.project].push(e);
    });

    list.innerHTML = '';
    var pi = 0;
    for (var proj in byProject) {
      var instances = byProject[proj];
      var color = PROJ_COLORS[pi % PROJ_COLORS.length];
      var projKey = 'proj-' + pi;
      var isOpen = openProjects.has(projKey);
      pi++;

      var tags = instances.map(function(e) {
        return '<span class="proj-env-tag" style="background:' + color + '18;color:' + color + ';border:1px solid ' + color + '30">' + esc(e.environment) + '</span>';
      }).join(' ');

      var varRows = instances.flatMap(function(inst) {
        return inst.vars.map(function(v) {
          return '<div class="var-row"><span class="var-key">' + esc(v.key) + '</span><span class="var-type">' + esc(v.type) + '</span>' + (v.secret ? '<span class="var-secret">🔒</span>' : '') + '</div>';
        });
      }).join('');

      var el = document.createElement('div');
      el.className = 'env-proj';
      el.innerHTML =
        '<div class="env-proj-hd" data-projkey="' + projKey + '">' +
          '<div class="proj-dot" style="background:' + color + '"></div>' +
          '<span class="proj-name">' + esc(proj) + '</span>' +
          tags +
          '<span class="proj-chev' + (isOpen ? ' open' : '') + '">›</span>' +
        '</div>' +
        '<div class="env-vars" id="' + projKey + '" style="' + (isOpen ? '' : 'display:none') + '">' + varRows + '</div>';
      list.appendChild(el);
    }
  }

  // ── Vault ────────────────────────────────────────────────────
  var FAVICON_MAP = {
    github:'🐙', google:'🔵', apple:'🍎', twitter:'🐦', facebook:'📘',
    instagram:'📸', linkedin:'💼', discord:'💬', slack:'💬', aws:'☁️',
    vercel:'▲', figma:'🎨', notion:'📝', stripe:'💳', paypal:'💸',
    netflix:'📺', spotify:'🎵',
  };
  var CAT_COLORS = {
    work:'#60a5fa', personal:'#34d399', dev:'#a78bfa',
    finance:'#fbbf24', social:'#f87171',
  };

  function getFavicon(service) {
    var k = (service || '').toLowerCase();
    for (var kw in FAVICON_MAP) { if (k.indexOf(kw) !== -1) { return FAVICON_MAP[kw]; } }
    return (service || '?').charAt(0).toUpperCase();
  }

  function renderVault(vault) {
    var sec  = document.getElementById('vault-section');
    var list = document.getElementById('vault-list');
    if (!vault || vault.length === 0) { sec.style.display = 'none'; return; }
    sec.style.display = '';
    list.innerHTML = vault.map(function(e) {
      var fv = getFavicon(e.service);
      var cc = CAT_COLORS[e.category] || '#71717a';
      return '<div class="vault-entry">' +
        '<div class="vault-fav">' + esc(fv) + '</div>' +
        '<div class="vault-info"><div class="vault-svc">' + esc(e.service) + '</div><div class="vault-usr">' + esc(e.username || '—') + '</div></div>' +
        '<div class="vault-cat" style="color:' + cc + ';border:1px solid ' + cc + '25;background:' + cc + '12">' + esc(e.category || 'other') + '</div>' +
      '</div>';
    }).join('');
  }

  // ── QR ───────────────────────────────────────────────────────
  function showQR(data) {
    document.getElementById('qr-steps').style.display   = 'none';
    document.getElementById('qr-expired').style.display = 'none';
    document.getElementById('qr-section').style.display = '';
    document.getElementById('qr-img').src               = data.dataUrl;
    document.getElementById('qr-addr').textContent      = 'ws://' + data.host + ':' + data.port;
    document.getElementById('qr-token').textContent     = data.token;
    tokenMax = 300; tokenRemaining = 300;
    updateTimer();
  }
  function updateTimer() {
    var pct = Math.max(0, (tokenRemaining / tokenMax) * 100);
    document.getElementById('timer-fill').style.width = pct + '%';
    var m = Math.floor(tokenRemaining / 60);
    var s = tokenRemaining % 60;
    document.getElementById('timer-lbl').textContent = 'Expires in ' + m + ':' + String(s).padStart(2, '0');
  }
  function expireQR() {
    document.getElementById('qr-section').style.display = 'none';
    document.getElementById('qr-steps').style.display   = 'none';
    document.getElementById('qr-expired').style.display = '';
  }

  // ── Helpers ──────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function ago(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    var m = Math.floor(diff / 60000);
    if (m < 1) { return 'just now'; }
    if (m < 60) { return m + 'm ago'; }
    return Math.floor(m / 60) + 'h ago';
  }

  // ── Message handler ───────────────────────────────────────────
  window.addEventListener('message', function(e) {
    var msg = e.data;
    switch (msg.type) {
      case 'state':
        applyState(msg.data);
        break;
      case 'qr':
        showQR(msg.data);
        break;
      case 'token_expired':
        expireQR();
        break;
      case 'token_tick':
        tokenRemaining = msg.data.remaining;
        updateTimer();
        break;
      case 'paired':
        document.getElementById('qr-section').style.display = 'none';
        document.getElementById('qr-steps').style.display   = '';
        break;
    }
  });

  // Tell the extension we're ready
  vscode.postMessage({ type: 'ready' });

})();
</script>
</body>
</html>`;
  }
}