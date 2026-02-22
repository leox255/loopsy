/** Default port for the Loopsy daemon */
export const DEFAULT_PORT = 19532;

/** mDNS service type for discovery */
export const MDNS_SERVICE_TYPE = '_loopsy._tcp';

/** Protocol version — kept in sync with root package.json */
export const PROTOCOL_VERSION = '1.0.16';

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

/** Sessions subdirectory */
export const SESSIONS_DIR = 'sessions';

/** Max concurrent AI tasks per daemon */
export const MAX_CONCURRENT_AI_TASKS = 3;

/** Default AI task timeout (30 minutes) */
export const DEFAULT_AI_TASK_TIMEOUT = 1_800_000;

/** Max event buffer per AI task (for reconnecting clients) */
export const AI_TASK_EVENT_BUFFER_SIZE = 500;

/** TLS certificate directory under CONFIG_DIR */
export const TLS_DIR = 'tls';

/** TLS certificate file names */
export const TLS_CERT_FILE = 'cert.pem';
export const TLS_KEY_FILE = 'key.pem';

/** Pairing invite code length */
export const PAIRING_CODE_LENGTH = 6;

/** Pairing session timeout (5 minutes) */
export const PAIRING_TIMEOUT = 300_000;

/** Pairing endpoint path */
export const PAIRING_PATH = '/api/v1/pair';
