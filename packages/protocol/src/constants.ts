/** Default port for the Loopsy daemon */
export const DEFAULT_PORT = 19532;

/** mDNS service type for discovery */
export const MDNS_SERVICE_TYPE = '_loopsy._tcp';

/** Protocol version */
export const PROTOCOL_VERSION = '1.0.0';

/** Default config directory */
export const CONFIG_DIR = '.loopsy';

/** Default config file name */
export const CONFIG_FILE = 'config.yaml';

/** Peer health check interval in ms */
export const HEALTH_CHECK_INTERVAL = 15_000;

/** Number of failed health checks before marking peer offline */
export const HEALTH_CHECK_MAX_FAILURES = 3;

/** Max file size for transfer (1GB) */
export const MAX_FILE_SIZE = 1_073_741_824;

/** Chunk size for large file transfers (10MB) */
export const CHUNK_SIZE = 10_485_760;

/** Max context value size (1MB) */
export const MAX_CONTEXT_VALUE_SIZE = 1_048_576;

/** Max context entries */
export const MAX_CONTEXT_ENTRIES = 1000;

/** Default command execution timeout (5 minutes) */
export const DEFAULT_EXEC_TIMEOUT = 300_000;

/** Max concurrent jobs per peer */
export const MAX_CONCURRENT_JOBS = 10;

/** Rate limits (requests per minute) */
export const RATE_LIMITS = {
  execute: 30,
  transfer: 10,
  context: 60,
} as const;

/** Retry config */
export const RETRY = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10_000,
} as const;

/** Circuit breaker config */
export const CIRCUIT_BREAKER = {
  failureThreshold: 5,
  failureWindowMs: 60_000,
  cooldownMs: 30_000,
} as const;

/** API version prefix */
export const API_PREFIX = '/api/v1';
