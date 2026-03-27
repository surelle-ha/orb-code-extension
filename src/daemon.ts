// src/daemon.ts
import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { OrbConfig, OrbStore, AppMessage, DaemonMessage, PairedDevice } from './types';
import { consumePairingToken, addPairedDevice, getHostname } from './pairing';
import { saveConfig, saveStore, writeDotEnvFile, writeBlocklistFile } from './store';

const VERSION = '1.0.0';

export type DaemonEventType =
  | 'started'
  | 'stopped'
  | 'client_connected'
  | 'client_disconnected'
  | 'paired'
  | 'synced_env'
  | 'synced_blocklist'
  | 'synced_vault'
  | 'reset'
  | 'error'
  | 'log';

export interface DaemonEvent {
  type: DaemonEventType;
  data?: unknown;
  ts: number;
}

export class OrbDaemon {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private startTime: number | null = null;
  private port: number;
  private listeners: Array<(event: DaemonEvent) => void> = [];
  private context: vscode.ExtensionContext;
  private cfg: OrbConfig;
  private store: OrbStore;

  constructor(
    context: vscode.ExtensionContext,
    cfg: OrbConfig,
    store: OrbStore,
    port: number,
  ) {
    this.context = context;
    this.cfg = cfg;
    this.store = store;
    this.port = port;
  }

  updateState(cfg: OrbConfig, store: OrbStore): void {
    this.cfg = cfg;
    this.store = store;
  }

  onEvent(cb: (event: DaemonEvent) => void): () => void {
    this.listeners.push(cb);
    return () => { this.listeners = this.listeners.filter(l => l !== cb); };
  }

  private emit(type: DaemonEventType, data?: unknown): void {
    const event: DaemonEvent = { type, data, ts: Date.now() };
    this.listeners.forEach(l => l(event));
  }

  private log(msg: string): void {
    this.emit('log', { msg });
    console.log(`[Orb] ${msg}`);
  }

  get isRunning(): boolean { return this.server !== null; }
  get clientCount(): number { return this.clients.size; }
  get uptime(): number { return this.startTime ? Date.now() - this.startTime : 0; }
  get currentPort(): number { return this.port; }

  async start(): Promise<void> {
    if (this.isRunning) return;

    this.server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Orb DevKit Daemon v' + VERSION);
    });

    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws, req) => {
      const peer = req.socket.remoteAddress ?? 'unknown';
      this.clients.add(ws);
      this.log(`Client connected: ${peer}`);
      this.emit('client_connected', { peer, clientCount: this.clients.size });

      let authenticated = this.cfg.pairedDevices.length > 0;
      let deviceLabel = 'unknown';

      ws.on('message', (data) => {
        try {
          const raw = data.toString();
          const msg = JSON.parse(raw) as AppMessage;
          const reply = this.route(msg, { authenticated, deviceLabel }, (s) => {
            authenticated = s.authenticated;
            deviceLabel = s.deviceLabel;
          });
          ws.send(JSON.stringify(reply));
        } catch (e) {
          const reply: DaemonMessage = {
            type: 'Error',
            payload: { code: 'PARSE_ERROR', message: String(e) },
          };
          ws.send(JSON.stringify(reply));
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        this.log(`Client disconnected: ${deviceLabel}`);
        this.emit('client_disconnected', { deviceLabel, clientCount: this.clients.size });
      });

      ws.on('error', (err) => {
        this.log(`Client error: ${err.message}`);
        this.clients.delete(ws);
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, '0.0.0.0', () => resolve());
      this.server!.on('error', reject);
    });

    this.startTime = Date.now();
    this.log(`Daemon started on ws://0.0.0.0:${this.port}`);
    this.emit('started', { port: this.port });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.clients.forEach(ws => ws.close());
    this.clients.clear();
    await new Promise<void>((resolve) => {
      this.wss?.close(() => {
        this.server?.close(() => {
          resolve();
        });
      });
    });
    this.server = null;
    this.wss = null;
    this.startTime = null;
    this.log('Daemon stopped');
    this.emit('stopped');
  }

  private route(
    msg: AppMessage,
    state: { authenticated: boolean; deviceLabel: string },
    setState: (s: { authenticated: boolean; deviceLabel: string }) => void,
  ): DaemonMessage {
    // Handle Pair
    if (msg.type === 'Pair') {
      const { token, device_name, device_os } = msg.payload;
      if (!consumePairingToken(this.cfg, token)) {
        return {
          type: 'PairReject',
          payload: { reason: 'Invalid or expired pairing token. Click "Generate QR" in VS Code.' },
        };
      }
      const device: PairedDevice = {
        id: crypto.randomUUID(),
        name: `${device_name} (${device_os})`,
        os: device_os,
        pairedAt: new Date().toISOString(),
        fingerprint: crypto.randomBytes(16).toString('hex'),
      };
      addPairedDevice(this.cfg, device);
      saveConfig(this.context, this.cfg);
      setState({ authenticated: true, deviceLabel: device_name });
      this.log(`Paired: ${device_name}`);
      this.emit('paired', { device });
      return {
        type: 'PairOk',
        payload: {
          daemon_name: getHostname(),
          daemon_version: VERSION,
          fingerprint: device.fingerprint,
        },
      };
    }

    // Ping (no auth required)
    if (msg.type === 'Ping') {
      return {
        type: 'Pong',
        payload: { seq: msg.payload.seq, ts: Date.now() },
      };
    }

    // Auth gate
    if (!state.authenticated) {
      state.authenticated = this.cfg.pairedDevices.length > 0;
    }
    if (!state.authenticated) {
      return {
        type: 'Error',
        payload: { code: 'UNAUTHORIZED', message: 'Pair first via VS Code Orb panel.' },
      };
    }

    // Dispatched messages
    return this.dispatch(msg);
  }

  private dispatch(msg: AppMessage): DaemonMessage {
    switch (msg.type) {
      case 'SyncEnv': {
        const { project, environment, vars } = msg.payload;
        if (!this.store.envs[project]) this.store.envs[project] = {};
        this.store.envs[project][environment] = vars;
        saveStore(this.context, this.store);
        try { writeDotEnvFile(this.context, project, environment, vars); } catch {}
        this.log(`ENV synced: ${project}/${environment} (${vars.length} vars)`);
        this.emit('synced_env', { project, environment, count: vars.length });
        return { type: 'Ok', payload: { for_type: 'SyncEnv' } };
      }
      case 'DeleteEnv': {
        const { project, environment } = msg.payload;
        if (this.store.envs[project]) {
          delete this.store.envs[project][environment];
          if (Object.keys(this.store.envs[project]).length === 0) {
            delete this.store.envs[project];
          }
        }
        saveStore(this.context, this.store);
        return { type: 'Ok', payload: { for_type: 'DeleteEnv' } };
      }
      case 'SyncBlocklist': {
        const { platforms } = msg.payload;
        this.store.blocklist = platforms;
        saveStore(this.context, this.store);
        try { writeBlocklistFile(this.context, platforms); } catch {}
        const active = platforms.filter(p => p.enabled).length;
        this.log(`Blocklist synced: ${active} platforms active`);
        this.emit('synced_blocklist', { active });
        return { type: 'Ok', payload: { for_type: 'SyncBlocklist' } };
      }
      case 'SyncVault': {
        const { entries } = msg.payload;
        this.store.vault = entries;
        saveStore(this.context, this.store);
        this.log(`Vault synced: ${entries.length} entries`);
        this.emit('synced_vault', { count: entries.length });
        return { type: 'Ok', payload: { for_type: 'SyncVault' } };
      }
      case 'TriggerReload': {
        this.log(`Reload: ${msg.payload.target}`);
        return { type: 'Reloading', payload: { target: msg.payload.target } };
      }
      case 'RequestSync': {
        return { type: 'Ok', payload: { for_type: 'RequestSync' } };
      }
      case 'Reset': {
        this.store = { envs: {}, blocklist: [], vault: [] };
        saveStore(this.context, this.store);
        this.log('Daemon data reset by mobile client');
        this.emit('reset');
        return { type: 'ResetOk', payload: {} };
      }
      default:
        return { type: 'Error', payload: { code: 'UNKNOWN', message: 'Unknown message type' } };
    }
  }

  getStats() {
    const envProjectCount = Object.keys(this.store.envs).length;
    const totalVars = Object.values(this.store.envs)
      .flatMap(e => Object.values(e))
      .reduce((s, vars) => s + vars.length, 0);
    return {
      running: this.isRunning,
      port: this.port,
      uptime: this.uptime,
      connectedClients: this.clientCount,
      pairedDevices: this.cfg.pairedDevices.length,
      envProjects: envProjectCount,
      totalVars,
      vaultEntries: this.store.vault.length,
      blocklistActive: this.store.blocklist.filter(p => p.enabled).length,
    };
  }
}