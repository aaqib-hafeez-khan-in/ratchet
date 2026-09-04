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

  /**
   * A production-shaped deployment that is not the real one.
   *
   * Staging runs with NODE_ENV=production on purpose, so it exercises the same
   * safety assertions and the same code paths. That means isProd cannot tell
   * the two apart, and everything that should differ — chiefly whether search
   * engines may index a complete second copy of the site — needs this instead.
   */
  get isStaging() { return process.env.RATCHET_ENV === 'staging'; },

  port: int('PORT', 8787),
  host: process.env.HOST ?? '0.0.0.0',
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${int('PORT', 8787)}`,

  databaseUrl: req('DATABASE_URL', 'postgres://ratchet:ratchet@127.0.0.1:5433/ratchet'),
  dbPoolMax: int('DB_POOL_MAX', 10),
  // Applied per transaction via SET LOCAL, never as a startup parameter — a
  // pooled endpoint rejects the latter.
  statementTimeoutMs: int('DB_STATEMENT_TIMEOUT_MS', 10_000),
  idleInTxTimeoutMs: int('DB_IDLE_IN_TX_TIMEOUT_MS', 15_000),
  dbSsl: bool('DB_SSL', false),

  // Used to derive the API-key lookup pepper and console session ids.
  authSecret: req('AUTH_SECRET', 'dev-only-insecure-auth-secret-change-me'),

  /**
   * Secrets this deployment has rotated AWAY from, newest first.
   *
   * A key hashed under a retired secret still authenticates, and is re-hashed
   * with the current one the first time it is used. Without this, rotating
   * AUTH_SECRET invalidates every customer key at the same instant — which made
   * the one action you must take after a suspected compromise the one action
   * nobody could take. Drop a secret from this list once no key still carries
   * its kid; `GET /metrics` reports the remaining count per kid.
   */
  retiredAuthSecrets: list('AUTH_SECRET_RETIRED'),

  /**
   * The pepper for blinding declared dimensions. Falls back to AUTH_SECRET.
   *
   * Separate because these two secrets protect different things and want
   * different lifetimes. An API key hash may be re-derived on next use, so
   * rotating it costs nothing. A blinded counterparty CANNOT be re-derived —
   * the value it was made from is gone, deliberately — so changing this pepper
   * does not invalidate ceilings, it silently RESETS them: every destination
   * looks new, and a limit an operator believes is holding refuses nothing
   * until spend re-accumulates. Pin this before rotating AUTH_SECRET, which
   * assertProductionSafety refuses to start without.
   */
  dimensionSecret: process.env.DIMENSION_SECRET
    || req('AUTH_SECRET', 'dev-only-insecure-auth-secret-change-me'),

  // Browser origins permitted to call the API with credentials.
  // Empty in production means "same-origin only".
  corsOrigins: list('CORS_ORIGINS'),

  /**
   * Limit for UNAUTHENTICATED requests (signup, health, docs), keyed by IP.
   * Authenticated requests are limited by their workspace's plan instead.
   */
  rateLimitPerMinute: int('RATE_LIMIT_PER_MINUTE', 600),

  /**
   * Keyless workspace provisioning.
   *
   * Per source was 20/hour in memory, which meant 20 per instance per deploy,
   * and 20 workspaces is 2,000 free gated effects — against a free PLAN of
   * 1,000 a month. Five is still more than a developer trying the service will
   * ever need, and it is now counted globally.
   *
   * The global ceiling is what survives address rotation. When it is reached,
   * keyless provisioning stops and everyone holding a key is unaffected.
   */
  /*
   * Getters, not values read at module load.
   *
   * `int()` captures the environment the instant config is first imported, and
   * import order decides when that is. A test file importing app.js on one line
   * and helpers.js on the next froze the default before helpers could raise it,
   * so keyless provisioning was capped at five for a suite that needed more —
   * and the failure looked like a bug in the feature, not in the wiring.
   * rateLimitOverride is a getter for exactly this reason.
   */
  get provisionPerSourcePerHour(): number {
    return Number.parseInt(process.env.PROVISION_PER_SOURCE_PER_HOUR ?? '5', 10);
  },
  get provisionGlobalPerHour(): number {
    return Number.parseInt(process.env.PROVISION_GLOBAL_PER_HOUR ?? '250', 10);
  },

  /**
   * Overrides every rate limit, plan limits included. Exists so test suites can
   * exercise volume without tripping the free-plan ceiling. Refused in
   * production by assertProductionSafety — a deployment that silently ignored
   * its own published limits would be the defect this override exists to test.
   */
  // A getter, not a captured value: ES module imports are hoisted, so a script
  // that sets this before its import statements would otherwise be read too
  // late and silently ignored.
  /**
   * Bearer token for GET /metrics. Unset means the endpoint does not exist —
   * it 404s rather than 401s, because advertising a protected operational
   * endpoint on a public domain invites people to go looking for the token.
   *
   * A getter, like everything else here that a script may set before importing.
   */
  get metricsToken(): string | null {
    const raw = process.env.METRICS_TOKEN;
    return raw && raw.length >= 16 ? raw : null;
  },

  get rateLimitOverride(): number | null {
    const raw = process.env.RATE_LIMIT_OVERRIDE;
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  },

  /**
   * Share rate-limit counters across instances via Postgres. Off means the
   * plugin's in-memory store, which allows N instances roughly N times the
   * published limit. Reconciliation is in the background, so this never adds
   * latency to a request — see src/api/shared-rate-limit.ts.
   */
  rateLimitShared: bool('RATE_LIMIT_SHARED', true),
  rateLimitFlushMs: int('RATE_LIMIT_FLUSH_MS', 250),

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
    replicationCheckIntervalMs: int('REPLICATION_CHECK_INTERVAL_MS', 60000),
    // Getters, not values. `int()` at module load means whichever module is
    // imported first decides the number for the whole process, which has
    // already caught a provisioning limit out once here.
    //
    // Well under the cluster's max_slot_wal_keep_size of 2 GB, which is the
    // point of no return: past it the slot is invalidated and the replica can
    // only be rebuilt. The alert exists to leave room to act before that.
    get replicaLagAlertBytes() { return int('REPLICA_LAG_ALERT_BYTES', 268_435_456); },
    // Zero disables the check. An operator who has not said how many replicas
    // to expect should not be told one is missing.
    get expectedReplicas() { return int('EXPECTED_REPLICAS', 0); },
  },

  // Read live from the environment rather than captured at import. Payment
  // configuration is the one thing an operator changes and then expects to
  // take effect on restart without wondering whether a module cached it, and
  // it lets the three provider states be tested without a fresh module graph.
  billing: {
    get provider() { return process.env.BILLING_PROVIDER ?? 'test'; },
    get stripeSecretKey() { return process.env.STRIPE_SECRET_KEY ?? ''; },
    get stripeWebhookSecret() { return process.env.STRIPE_WEBHOOK_SECRET ?? ''; },
    /**
     * Enables Stripe Tax on credit purchases. Off by default: turning it on
     * without a configured origin address and tax registrations makes Stripe
     * reject every checkout, so this must be a deliberate act after the
     * dashboard side is set up.
     */
    get stripeAutomaticTax() {
      const v = process.env.STRIPE_AUTOMATIC_TAX;
      return v === '1' || v?.toLowerCase() === 'true';
    },
  },

  // Console sign-in link lifetime.
  // Non-custodial crypto. Ratchet never holds a key; the destination is an
  // address the operator controls and can change without touching this service.
  crypto: {
    get solanaDestination() { return process.env.SOLANA_DESTINATION_ADDRESS ?? ''; },
    get rpcUrl() { return process.env.SOLANA_RPC_URL ?? ''; },
    get pollIntervalMs() {
      return Number.parseInt(process.env.CRYPTO_POLL_INTERVAL_MS ?? '20000', 10);
    },
    /**
     * Per-chain receiving addresses and RPCs. Each address belongs to the
     * operator; Ratchet only reads these chains and holds no key for any of
     * them. A chain with no destination set is simply off.
     */
    get chains() {
      return {
        solana: {
          destination: process.env.SOLANA_DESTINATION_ADDRESS ?? '',
          rpc: process.env.SOLANA_RPC_URL ?? '',
        },
        ethereum: {
          destination: process.env.ETHEREUM_DESTINATION_ADDRESS ?? '',
          rpc: process.env.ETHEREUM_RPC_URL ?? 'https://ethereum.publicnode.com',
        },
        base: {
          destination: process.env.BASE_DESTINATION_ADDRESS ?? '',
          rpc: process.env.BASE_RPC_URL ?? 'https://base-rpc.publicnode.com',
        },
        bitcoin: {
          destination: process.env.BITCOIN_DESTINATION_ADDRESS ?? '',
          rpc: process.env.BITCOIN_API_URL ?? 'https://mempool.space/api',
        },
      } as Record<string, { destination: string; rpc: string }>;
    },
    /** Comma-separated price sources. Volatile assets need at least two. */
    get priceSources() {
      return (process.env.CRYPTO_PRICE_SOURCES ?? 'coinbase,kraken')
        .split(',').map((s) => s.trim()).filter(Boolean);
    },
    get maxPriceDivergenceBps() {
      return Number.parseInt(process.env.CRYPTO_MAX_PRICE_DIVERGENCE_BPS ?? '200', 10);
    },
  },

  /**
   * Transactional email. Defaults to 'log', which writes the message to stdout
   * and sends nothing — the same shape as the test billing adapter, so the
   * whole queue and retry path runs without credentials.
   */
  email: {
    get provider() { return process.env.EMAIL_PROVIDER ?? 'log'; },
    get apiKey() { return process.env.EMAIL_API_KEY ?? ''; },
    get from() { return process.env.EMAIL_FROM ?? 'Ratchet <alerts@mail.ratchetgate.com>'; },
    get replyTo() { return process.env.EMAIL_REPLY_TO ?? ''; },
    get maxAttempts() {
      return Number.parseInt(process.env.EMAIL_MAX_ATTEMPTS ?? '5', 10);
    },
    get pollIntervalMs() {
      return Number.parseInt(process.env.EMAIL_POLL_INTERVAL_MS ?? '5000', 10);
    },
  },

  // Receipts outlive effects on purpose: an effect is operational state, a
  // receipt is evidence, and evidence is the thing a customer may need long
  // after the effect itself stopped mattering.
  /**
   * x402 machine payments. OFF unless a facilitator is configured: settling an
   * EIP-3009 authorization needs a funded wallet, which this service does not
   * hold, so without a facilitator we could advertise a price we cannot
   * collect. Better to not offer it.
   */
  x402: {
    get facilitatorUrl() { return process.env.X402_FACILITATOR_URL ?? ''; },
    get facilitatorKey() { return process.env.X402_FACILITATOR_KEY ?? ''; },
    get payTo() { return process.env.X402_PAY_TO ?? ''; },
    /** CAIP-2 chain id, e.g. eip155:8453 for Base mainnet. */
    get network() { return process.env.X402_NETWORK ?? 'eip155:8453'; },
    /** Token contract. Defaults to USDC on Base. */
    get asset() {
      return process.env.X402_ASSET ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    },
    /**
     * The token's EIP-712 domain. The client signs over it, so a wrong value
     * produces a signature the facilitator cannot verify. USDC uses name
     * "USDC" and version "2"; other tokens differ, so both travel with the
     * asset address.
     */
    get assetName() { return process.env.X402_ASSET_NAME ?? 'USDC'; },
    get assetVersion() { return process.env.X402_ASSET_VERSION ?? '2'; },
    /** Amount in the asset's base units. USDC has 6 decimals, so 1000000 = $1. */
    get amount() { return process.env.X402_AMOUNT ?? '1000000'; },
    /** Credit granted per payment, in micro-USD. Must match `amount`'s value. */
    get creditMicros() {
      return Number.parseInt(process.env.X402_CREDIT_MICROS ?? '1000000', 10);
    },
  },

  receiptRetentionDays: int('RECEIPT_RETENTION_DAYS', 90),
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
  for (const [i, retired] of config.retiredAuthSecrets.entries()) {
    if (retired.length < 32) {
      problems.push(`AUTH_SECRET_RETIRED[${i}] is shorter than 32 characters — `
        + 'a retired secret is still a live credential until every key has drained off it.');
    }
    if (retired === config.authSecret) {
      problems.push('AUTH_SECRET_RETIRED contains the current AUTH_SECRET, '
        + 'so nothing has actually been rotated.');
    }
  }
  /**
   * The trap this exists to close.
   *
   * Rotating AUTH_SECRET while dimensions still derive from it re-blinds every
   * counterparty. Nothing errors: the ceilings still read as configured in the
   * console and simply stop refusing, because every destination looks new. That
   * is a security control failing silently OPEN, during the incident response
   * that prompted the rotation. Pinning DIMENSION_SECRET to the pre-rotation
   * value keeps every existing bucket addressable.
   */
  if (config.retiredAuthSecrets.length > 0 && !process.env.DIMENSION_SECRET) {
    problems.push('AUTH_SECRET has been rotated but DIMENSION_SECRET is not set. '
      + 'Set DIMENSION_SECRET to the AUTH_SECRET value that was in use when the '
      + 'existing dimensions were blinded, or every per-counterparty ceiling '
      + 'silently resets to zero.');
  }
  if (config.webhook.allowPrivateNetwork) {
    problems.push('WEBHOOK_ALLOW_PRIVATE_NETWORK must be off in production.');
  }
  if (config.rateLimitOverride !== null) {
    problems.push('RATE_LIMIT_OVERRIDE is a test-only affordance and must be unset in production.');
  }
  if (config.corsOrigins.includes('*')) {
    problems.push('CORS_ORIGINS must not contain "*" in production.');
  }
  // Set but too short to be a credential. Refusing to start is right: the
  // endpoint would otherwise be silently disabled, and an operator who set the
  // variable would believe they had monitoring when they had a 404.
  if (process.env.METRICS_TOKEN && process.env.METRICS_TOKEN.length < 16) {
    problems.push('METRICS_TOKEN is set but shorter than 16 characters. '
      + 'It guards an operational endpoint on a public domain.');
  }
  // Every OAuth surface is derived from PUBLIC_URL: the issuer, the redirect
  // target, and the metadata clients trust to find them. Over plaintext, the
  // authorization code is exposed in transit and the whole flow is worthless.
  // Half-configured x402 would advertise a price we cannot collect.
  const x = config.x402;
  const anyX402 = x.facilitatorUrl || x.payTo;
  if (anyX402 && !(x.facilitatorUrl && x.payTo)) {
    problems.push(
      'x402 is partially configured: X402_FACILITATOR_URL and X402_PAY_TO are both '
      + 'required, or neither. Advertising a payment we cannot settle is worse than '
      + 'not accepting payment.');
  }
  if (anyX402 && x.creditMicros <= 0) {
    problems.push('X402_CREDIT_MICROS must be positive.');
  }

  if (!config.publicUrl.startsWith('https://')) {
    problems.push(
      'PUBLIC_URL must be https in production — it is the OAuth issuer and every '
      + 'endpoint clients discover is derived from it.');
  }
  return problems;
}
