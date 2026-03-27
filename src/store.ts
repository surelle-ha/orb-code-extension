// src/store.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { OrbConfig, OrbStore } from './types';

const CONFIG_FILE = 'orb-config.json';
const STORE_FILE = 'orb-store.json';

function dataDir(context: vscode.ExtensionContext): string {
    const dir = context.globalStorageUri.fsPath;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function loadConfig(context: vscode.ExtensionContext): OrbConfig {
    const p = path.join(dataDir(context), CONFIG_FILE);
    try {
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { }
    return {
        deviceId: crypto.randomUUID(),
        pairedDevices: [],
    };
}

export function saveConfig(context: vscode.ExtensionContext, cfg: OrbConfig): void {
    const p = path.join(dataDir(context), CONFIG_FILE);
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
}

export function loadStore(context: vscode.ExtensionContext): OrbStore {
    const p = path.join(dataDir(context), STORE_FILE);
    try {
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { }
    return { envs: {}, blocklist: [], vault: [] };
}

export function saveStore(context: vscode.ExtensionContext, store: OrbStore): void {
    const p = path.join(dataDir(context), STORE_FILE);
    fs.writeFileSync(p, JSON.stringify(store, null, 2));
}

export function resetAll(context: vscode.ExtensionContext): void {
    const dir = dataDir(context);
    [CONFIG_FILE, STORE_FILE].forEach(f => {
        const p = path.join(dir, f);
        if (fs.existsSync(p)) fs.unlinkSync(p);
    });
}

// Write .env file for a project/environment
export function writeDotEnvFile(
    context: vscode.ExtensionContext,
    project: string,
    environment: string,
    vars: Array<{ key: string; value: string }>,
): void {
    const dir = path.join(dataDir(context), 'envs', project);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const content = vars.map(v => `${v.key}=${v.value}`).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, `${environment}.env`), content);
}

// Write blocklist hosts file
export function writeBlocklistFile(
    context: vscode.ExtensionContext,
    platforms: Array<{ name: string; domains: string[]; enabled: boolean }>,
): void {
    const dir = path.join(dataDir(context), 'blocklist');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const enabled = platforms.filter(p => p.enabled);
    const lines = [
        '# Orb DevKit - Vibecode blocklist',
        `# Updated: ${new Date().toISOString()}`,
        '',
        ...enabled.flatMap(p => [
            `# ${p.name}`,
            ...p.domains.flatMap(d => [`127.0.0.1 ${d}`, `127.0.0.1 www.${d}`]),
            '',
        ]),
    ];
    fs.writeFileSync(path.join(dir, 'blocked.hosts'), lines.join('\n'));
}

export function getDataDir(context: vscode.ExtensionContext): string {
    return dataDir(context);
}