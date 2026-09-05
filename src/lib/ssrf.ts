// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';

/**
 * SSRF guard for outbound webhook delivery.
 *
 * Two independent layers, because either alone is bypassable:
 *  1. validateWebhookUrl() rejects a URL at configuration time (scheme, port,
 *     credentials, host allowlist, and any literal-IP host).
 *  2. resolvePublicAddress() re-resolves DNS immediately before the request and
 *     pins the connection to the resolved address, closing the DNS-rebinding
 *     window between check and connect. Redirects are never followed.
 */

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const;

const ALLOWED_PORTS = new Set([80, 443]);

function v4ToInt(ip: string): number {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return -1;
  }
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const ip = v4ToInt(address);
    if (ip < 0) return true;
    return BLOCKED_V4.some(([base, bits]) => {
      const mask = ((0xffffffff << (32 - bits)) >>> 0);
      return (ip & mask) >>> 0 === ((v4ToInt(base) & mask) >>> 0);
    });
  }
  if (family === 6) {
    const a = address.toLowerCase();
    if (a === '::' || a === '::1') return true;
    if (a.startsWith('fe80') || a.startsWith('fc') || a.startsWith('fd')) return true;
    // IPv4-mapped (::ffff:a.b.c.d) must be judged by its embedded v4 address.
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    if (a.startsWith('::ffff:')) return true;
    return false;
  }
  return true; // not an IP literal at all
}

export class UnsafeUrlError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'UnsafeUrlError';
  }
}

/** Static validation. Run when an endpoint is created or updated. */
export function validateWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('Not a valid absolute URL.');
  }

  const httpsOnly = !config.webhook.allowPrivateNetwork;
  if (httpsOnly ? url.protocol !== 'https:' : !['http:', 'https:'].includes(url.protocol)) {
    throw new UnsafeUrlError('Webhook URLs must use https.');
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError('Webhook URLs must not embed credentials.');
  }
  const port = url.port ? Number.parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80);
  if (!config.webhook.allowPrivateNetwork && !ALLOWED_PORTS.has(port)) {
    throw new UnsafeUrlError('Webhook URLs may only target port 80 or 443.');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    // Literal IPs bypass the allowlist and are almost always an SSRF probe.
    if (!config.webhook.allowPrivateNetwork) {
      throw new UnsafeUrlError('Webhook URLs must use a DNS hostname, not an IP literal.');
    }
    if (isPrivateAddress(host) && !config.webhook.allowPrivateNetwork) {
      throw new UnsafeUrlError('Webhook URLs must not target private network ranges.');
    }
  }

  const allowlist = config.webhook.hostAllowlist;
  if (allowlist.length > 0) {
    const ok = allowlist.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
    if (!ok) throw new UnsafeUrlError('Webhook host is not on the configured allowlist.');
  }
  return url;
}

export interface PinnedTarget { address: string; family: 4 | 6; host: string; }

/**
 * Resolve immediately before connecting and reject any private result. The
 * returned address is what the delivery layer connects to, so a rebind after
 * this point cannot redirect us.
 */
export async function resolvePublicAddress(url: URL): Promise<PinnedTarget> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host) && !config.webhook.allowPrivateNetwork) {
      throw new UnsafeUrlError('Resolved address is in a private range.');
    }
    return { address: host, family: net.isIP(host) as 4 | 6, host };
  }

  let results: Array<{ address: string; family: number }>;
  try {
    results = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError('Webhook host could not be resolved.');
  }
  if (results.length === 0) throw new UnsafeUrlError('Webhook host resolved to no addresses.');

  // Every resolved address must be public: a host that returns one public and
  // one private address is treated as hostile, not as "pick the good one".
  for (const r of results) {
    if (isPrivateAddress(r.address) && !config.webhook.allowPrivateNetwork) {
      throw new UnsafeUrlError('Webhook host resolves to a private network address.');
    }
  }
  const first = results[0]!;
  return { address: first.address, family: first.family as 4 | 6, host };
}
