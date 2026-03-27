// src/pairing.ts
import * as crypto from 'crypto';
import * as os from 'os';
import { OrbConfig, PairedDevice, PairingPayload } from './types';

const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function generatePairingToken(cfg: OrbConfig): { token: string; expires: string } {
  const token = crypto.randomBytes(16).toString('hex'); // 32 hex chars
  const expires = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  cfg.pairingToken = token;
  cfg.pairingTokenExpires = expires;
  return { token, expires };
}

export function consumePairingToken(cfg: OrbConfig, token: string): boolean {
  if (!cfg.pairingToken || !cfg.pairingTokenExpires) return false;
  if (cfg.pairingToken !== token) return false;
  if (Date.now() > new Date(cfg.pairingTokenExpires).getTime()) return false;
  cfg.pairingToken = undefined;
  cfg.pairingTokenExpires = undefined;
  return true;
}

export function addPairedDevice(cfg: OrbConfig, device: PairedDevice): void {
  cfg.pairedDevices = cfg.pairedDevices.filter(d => d.id !== device.id);
  cfg.pairedDevices.push(device);
}

export function buildPairingPayload(
  host: string,
  port: number,
  token: string,
  fingerprint: string,
): PairingPayload {
  return { host, port, token, fingerprint, v: 1 };
}

export function encodePairingQR(payload: PairingPayload): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json).toString('base64');
  return `orb-pair://${b64}`;
}

export function getLocalIp(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

export function getHostname(): string {
  return os.hostname();
}

export function isTokenValid(cfg: OrbConfig): boolean {
  if (!cfg.pairingToken || !cfg.pairingTokenExpires) return false;
  return Date.now() < new Date(cfg.pairingTokenExpires).getTime();
}

export function tokenExpiresIn(cfg: OrbConfig): number {
  if (!cfg.pairingTokenExpires) return 0;
  return Math.max(0, new Date(cfg.pairingTokenExpires).getTime() - Date.now());
}