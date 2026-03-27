// src/types.ts

export interface PairedDevice {
    id: string;
    name: string;
    os: string;
    pairedAt: string;
    fingerprint: string;
}

export interface OrbConfig {
    deviceId: string;
    pairedDevices: PairedDevice[];
    pairingToken?: string;
    pairingTokenExpires?: string;
}

export interface EnvVar {
    key: string;
    value: string;
    type: string;
    secret: boolean;
}

export interface BlockedPlatform {
    id: string;
    name: string;
    domains: string[];
    enabled: boolean;
}

export interface VaultEntry {
    id: number;
    service: string;
    username: string;
    encrypted_password: string;
    category: string;
    url: string;
    notes: string;
}

export interface OrbStore {
    envs: Record<string, Record<string, EnvVar[]>>;
    blocklist: BlockedPlatform[];
    vault: VaultEntry[];
}

export interface PairingPayload {
    host: string;
    port: number;
    token: string;
    fingerprint: string;
    v: number;
}

// Message types — mirror the mobile app's protocol
export type AppMessage =
    | { type: 'Pair'; payload: { token: string; device_name: string; device_os: string } }
    | { type: 'Ping'; payload: { seq: number } }
    | { type: 'SyncEnv'; payload: { project: string; environment: string; vars: EnvVar[] } }
    | { type: 'DeleteEnv'; payload: { project: string; environment: string } }
    | { type: 'SyncBlocklist'; payload: { platforms: BlockedPlatform[] } }
    | { type: 'SyncVault'; payload: { entries: VaultEntry[] } }
    | { type: 'TriggerReload'; payload: { target: string } }
    | { type: 'RequestSync'; payload: { resource: string } }
    | { type: 'Reset'; payload: Record<string, never> };

export type DaemonMessage =
    | { type: 'PairOk'; payload: { daemon_name: string; daemon_version: string; fingerprint: string } }
    | { type: 'PairReject'; payload: { reason: string } }
    | { type: 'Error'; payload: { code: string; message: string } }
    | { type: 'Pong'; payload: { seq: number; ts: number } }
    | { type: 'Ok'; payload: { for_type: string } }
    | { type: 'Reloading'; payload: { target: string } }
    | { type: 'ResetOk'; payload: Record<string, never> };

export interface DaemonStats {
    connectedClients: number;
    uptime: number;
    port: number;
    running: boolean;
    pairedDevices: number;
    envProjects: number;
    vaultEntries: number;
    blocklistActive: number;
}