// src/extension.ts
import * as vscode from 'vscode';
import { OrbDaemon } from './daemon';
import { OrbSidebarProvider } from './sidebar';
import { loadConfig, saveConfig, loadStore } from './store';

let daemon: OrbDaemon | undefined;
let sidebarProvider: OrbSidebarProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  console.log('[Orb] Extension activating');

  const cfg   = loadConfig(context);
  const store = loadStore(context);
  const port  = vscode.workspace.getConfiguration('orb').get<number>('port', 3131);

  // Create daemon instance
  daemon = new OrbDaemon(context, cfg, store, port);

  // Create sidebar
  sidebarProvider = new OrbSidebarProvider(context, daemon, cfg);

  // Register sidebar webview
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      OrbSidebarProvider.viewType,
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // ── Commands ──────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('orb.startDaemon', async () => {
      try {
        await daemon!.start();
        vscode.window.showInformationMessage(`Orb: Daemon started on port ${port}`);
      } catch (e) {
        vscode.window.showErrorMessage(`Orb: Failed to start daemon — ${e}`);
      }
    }),

    vscode.commands.registerCommand('orb.stopDaemon', async () => {
      await daemon!.stop();
      vscode.window.showInformationMessage('Orb: Daemon stopped');
    }),

    vscode.commands.registerCommand('orb.showPairing', () => {
      vscode.commands.executeCommand('orb.main.focus');
    }),

    vscode.commands.registerCommand('orb.openDashboard', () => {
      vscode.commands.executeCommand('orb.main.focus');
    }),

    vscode.commands.registerCommand('orb.resetAll', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Reset all Orb data? This will unpair all devices and clear synced data.',
        { modal: true },
        'Reset',
      );
      if (confirm === 'Reset') {
        if (daemon?.isRunning) await daemon.stop();
        cfg.pairedDevices = [];
        cfg.pairingToken = undefined;
        cfg.pairingTokenExpires = undefined;
        saveConfig(context, cfg);
        daemon = new OrbDaemon(context, cfg, { envs: {}, blocklist: [], vault: [] }, port);
        sidebarProvider?.updateState(cfg);
        vscode.window.showInformationMessage('Orb: All data reset');
      }
    }),
  );

  // ── Status bar item ───────────────────────────────────────
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'orb.openDashboard';
  statusItem.text = '$(circle-slash) Orb';
  statusItem.tooltip = 'Orb DevKit — click to open';
  statusItem.show();
  context.subscriptions.push(statusItem);

  // Update status bar when daemon changes
  daemon.onEvent((evt) => {
    if (evt.type === 'started') {
      statusItem.text = '$(circle-filled) Orb';
      statusItem.color = '#34d399';
    } else if (evt.type === 'stopped') {
      statusItem.text = '$(circle-slash) Orb';
      statusItem.color = undefined;
    } else if (evt.type === 'client_connected') {
      statusItem.text = '$(circle-filled) Orb';
    } else if (evt.type === 'paired') {
      statusItem.text = '$(pass-filled) Orb';
      const device = (evt.data as any)?.device;
      vscode.window.showInformationMessage(`Orb: Paired with ${device?.name ?? 'device'}`);
    }
  });

  // ── Auto-start ────────────────────────────────────────────
  const autoStart = vscode.workspace.getConfiguration('orb').get<boolean>('autoStart', true);
  if (autoStart) {
    setTimeout(async () => {
      try {
        await daemon!.start();
      } catch (e) {
        console.warn('[Orb] Auto-start failed:', e);
      }
    }, 1500); // slight delay so VS Code UI finishes loading
  }

  console.log('[Orb] Extension activated');
}

export async function deactivate(): Promise<void> {
  if (daemon?.isRunning) {
    await daemon.stop();
  }
}