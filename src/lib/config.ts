import { config as loadDotenv } from 'dotenv';

loadDotenv({ quiet: true });

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function list(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  get isProd() { return this.env === 'production'; },

  port: int('PORT', 8787),
  host: process.env.HOST ?? '0.0.0.0',
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${int('PORT', 8787)}`,

  databaseUrl: req('DATABASE_URL', 'postgres://ratchet:ratchet@127.0.0.1:5433/ratchet'),
  dbPoolMax: int('DB_POOL_MAX', 10),
  dbSsl: bool('DB_SSL', false),

  // Used to derive the API-key lookup pepper and console session ids.
  authSecret: req('AUTH_SECRET', 'dev-only-insecure-auth-secret-change-me'),

  // Browser origins permitted to call the API with credentials.
  // Empty in production means "same-origin only".
  corsOrigins: list('CORS_ORIGINS'),

  rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 600),

  maxRequestBytes: int('MAX_REQUEST_BYTES', 65536),
  maxResultBytes: int('MAX_RESULT_BYTES', 32768),

  webhook: {
    timeoutMs: int('WEBHOOK_TIMEOUT_MS', 5000),
    maxResponseBytes: int('WEBHOOK_MAX_RESPONSE_BYTES', 16384),
    maxAttempts: int('WEBHOOK_MAX_ATTEMPTS', 6),
    // When set, webhook hosts must match one of these suffixes.
    hostAllowlist: list('WEBHOOK_HOST_ALLOWLIST'),
    // Only ever enabled for tests against a loopback listener.
    allowPrivateNetwork: bool('WEBHOOK_ALLOW_PRIVATE_NETWORK', false),
  },

  worker: {
    leaseSweepIntervalMs: int('LEASE_SWEEP_INTERVAL_MS', 2000),
    webhookPollIntervalMs: int('WEBHOOK_POLL_INTERVAL_MS', 1000),
    gcIntervalMs: int('GC_INTERVAL_MS', 300000),
  },

  billing: {
    provider: process.env.BILLING_PROVIDER ?? 'test',
    stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  },

  // Console sign-in link lifetime.
  consoleSessionTtlHours: int('CONSOLE_SESSION_TTL_HOURS', 72),
} as const;

export function assertProductionSafety(): string[] {
  const problems: string[] = [];
  if (!config.isProd) return problems;
  if (config.authSecret.startsWith('dev-only')) {
    problems.push('AUTH_SECRET is still the development default.');
  }
  if (config.authSecret.length < 32) {
    problems.push('AUTH_SECRET must be at least 32 characters in production.');
  }
  if (config.webhook.allowPrivateNetwork) {
    problems.push('WEBHOOK_ALLOW_PRIVATE_NETWORK must be off in production.');
  }
  if (config.corsOrigins.includes('*')) {
    problems.push('CORS_ORIGINS must not contain "*" in production.');
  }
  return problems;
}
