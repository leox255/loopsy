/** Identity of a Loopsy node on the network */
export interface LoopsyNodeIdentity {
  nodeId: string;
  hostname: string;
  platform: string;
  version: string;
  port: number;
  capabilities: string[];
}

/** Peer info stored in the registry */
export interface PeerInfo {
  nodeId: string;
  hostname: string;
  address: string;
  port: number;
  platform: string;
  version: string;
  capabilities: string[];
  status: 'online' | 'offline' | 'unknown';
  lastSeen: number;
  failureCount: number;
  trusted: boolean;
  manuallyAdded: boolean;
}

/** Generic request envelope */
export interface LoopsyRequest<T = unknown> {
  requestId: string;
  fromNodeId: string;
  timestamp: number;
  payload: T;
}

/** Generic response envelope */
export interface LoopsyResponse<T = unknown> {
  requestId: string;
  nodeId: string;
  timestamp: number;
  success: boolean;
  payload?: T;
  error?: {
    code: number;
    message: string;
    details?: unknown;
  };
}

/** Parameters for remote command execution */
export interface ExecuteParams {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  stream?: boolean;
}

/** Result of command execution */
export interface ExecuteResult {
  jobId: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  duration: number;
  killed: boolean;
}

/** Parameters for file transfer */
export interface TransferParams {
  direction: 'push' | 'pull';
  sourcePath: string;
  destPath: string;
}

/** Result of file transfer */
export interface TransferResult {
  path: string;
  size: number;
  checksum: string;
  duration: number;
}

/** Directory listing entry */
export interface FileListEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  modified: number;
}

/** Context entry stored on a peer */
export interface ContextEntry {
  key: string;
  value: string;
  fromNodeId: string;
  createdAt: number;
  updatedAt: number;
  ttl?: number;
  expiresAt?: number;
}

/** Health check response */
export interface HealthResponse {
  status: 'ok';
  nodeId: string;
  uptime: number;
  version: string;
}

/** Status response with peer info */
export interface StatusResponse {
  nodeId: string;
  hostname: string;
  platform: string;
  version: string;
  uptime: number;
  peers: {
    total: number;
    online: number;
    offline: number;
  };
  jobs: {
    active: number;
    total: number;
  };
  context: {
    entries: number;
  };
}

/** Daemon configuration */
export interface LoopsyConfig {
  server: {
    port: number;
    host: string;
    hostname?: string;
    dataDir?: string;
  };
  auth: {
    apiKey: string;
    allowedKeys: Record<string, string>;
  };
  tls?: TlsConfig;
  execution: {
    denylist: string[];
    allowlist?: string[];
    maxConcurrent: number;
    defaultTimeout: number;
  };
  transfer: {
    allowedPaths: string[];
    deniedPaths: string[];
    maxFileSize: number;
  };
  rateLimits: {
    execute: number;
    transfer: number;
    context: number;
  };
  discovery: {
    enabled: boolean;
    manualPeers: Array<{ address: string; port: number; hostname?: string }>;
  };
  logging: {
    level: string;
    file?: string;
  };
  /**
   * Optional Cloudflare-relay registration so this daemon can serve mobile
   * clients over the public internet. Populated by `loopsy relay configure`.
   */
  relay?: RelayConfig;

  /**
   * User-defined session shortcuts surfaced in the mobile/web "Start a
   * session" picker alongside the built-in agents. The daemon owns this
   * list so the same shortcuts appear on every paired phone — phones
   * fetch and mutate via control frames over the relay.
   */
  customCommands?: CustomCommand[];
}

/**
 * A user-defined command available in the "Start a session" picker, e.g.
 * `{ id, label: "Edit README", command: "nvim", args: ["README.md"] }`.
 * Spawned with the same security profile as the built-in `shell` agent —
 * the paired phone can already run any binary, so a labeled tile does
 * not change the threat model.
 */
export interface CustomCommand {
  /** Stable id (uuid v4). Used for update/remove and for the daemon to
   *  resolve a session-open without trusting client-supplied argv. */
  id: string;
  /** Display name shown in the picker, e.g. "Edit README". */
  label: string;
  /** Binary to spawn. Resolved on PATH at session-open time. */
  command: string;
  /** Optional argv tail. */
  args?: string[];
  /** Optional working directory; defaults to process.cwd(). */
  cwd?: string;
  /** Optional icon name (mobile maps to a HugeIcons identifier). */
  icon?: string;
  /** ISO timestamp the entry was created. */
  createdAt?: string;
}

/**
 * Public summary of a daemon-managed PTY session, included in
 * device-info so the phone picker can render a "Running on your machine"
 * section. Anything that would expose argv or cwd to a phone before
 * pairing-time scrutiny is omitted; we only ship what's needed to
 * render the tile + reattach.
 */
export interface RunningSession {
  /** Daemon-assigned session UUID. The phone uses this verbatim when reattaching. */
  id: string;
  /** Agent name (shell, claude, custom, …). Drives the tile icon. */
  agent: string;
  /** Optional user-supplied label from `loopsy shell --name`. */
  name?: string;
  /** Number of clients currently attached. >1 means another phone or a local terminal is also looking at this session. */
  attachedClientCount: number;
  /** ms-epoch of the last PTY output. Used to render "12 min ago". */
  lastActivityAt: number;
}

/** Loopsy relay configuration (mobile WAN access). */
export interface RelayConfig {
  /** Base URL of the relay deployment, e.g. https://loopsy-relay.example.workers.dev */
  url: string;
  /** Server-issued device ID used to address this laptop on the relay. */
  deviceId: string;
  /** Bearer secret the laptop authenticates with at /laptop/connect and /pair/issue. */
  deviceSecret: string;
  /** Default scrollback ring buffer size per session (bytes). */
  scrollbackBytes?: number;
  /** Idle timeout for sessions with no attached client (seconds). */
  sessionIdleTimeoutSec?: number;
}

/** Running job info */
export interface JobInfo {
  jobId: string;
  command: string;
  args: string[];
  startedAt: number;
  fromNodeId: string;
  pid?: number;
}

/** SSE event for streaming execution */
export interface StreamEvent {
  type: 'stdout' | 'stderr' | 'exit' | 'error';
  data: string;
  jobId: string;
  timestamp: number;
}

/** Message types for the messaging protocol */
export type MessageType = 'chat' | 'request' | 'response' | 'ack' | 'broadcast';

/** Message envelope for peer-to-peer messaging */
export interface MessageEnvelope {
  from: string;
  to: string;
  ts: number;
  id: string;
  type: MessageType;
  body: string;
}

// ── AI Task Dispatch ──

/** AI task lifecycle status */
export type AiTaskStatus = 'pending' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';

/** Permission modes for the Claude CLI */
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk';

/** Supported AI agent CLIs */
export type AiAgent = 'claude' | 'gemini' | 'codex' | 'auto';

/** Parameters to dispatch an AI task */
export interface AiTaskParams {
  prompt: string;
  cwd?: string;
  permissionMode?: ClaudePermissionMode;
  model?: string;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  additionalArgs?: string[];
  resumeSessionId?: string;
  agent?: AiAgent;
}

/** AI task info tracked by the daemon */
export interface AiTaskInfo {
  taskId: string;
  prompt: string;
  status: AiTaskStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  fromNodeId: string;
  pid?: number;
  exitCode?: number | null;
  error?: string;
  model?: string;
  pendingApproval?: AiTaskApprovalRequest;
  sessionId?: string;
  agent?: AiAgent;
  permissionMode?: string;
}

/** A permission request from Claude needing human approval */
export interface AiTaskApprovalRequest {
  toolName: string;
  toolInput: unknown;
  requestId: string;
  timestamp: number;
  description?: string;
}

/** Human's approval/denial response */
export interface AiTaskApprovalResponse {
  requestId: string;
  approved: boolean;
}

/** A permission request registered by the hook script with the daemon */
export interface PermissionRequestEntry {
  requestId: string;
  taskId: string;
  toolName: string;
  toolInput: unknown;
  description?: string;
  timestamp: number;
}

/** The resolved permission decision (stored by daemon when user approves/denies) */
export interface PermissionResponseEntry {
  requestId: string;
  approved: boolean;
  message?: string;
  resolvedAt: number;
}

/** SSE event from an AI task stream */
export interface AiTaskStreamEvent {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'permission_request' | 'status' | 'error' | 'result' | 'exit' | 'system';
  taskId: string;
  timestamp: number;
  data: unknown;
}

// ── TLS & Pairing ──

/** TLS configuration in config.yaml */
export interface TlsConfig {
  enabled: boolean;
  certPath?: string;
  keyPath?: string;
  /** Map of peer hostname → SHA-256 cert fingerprint (hex) for pinning */
  pinnedCerts?: Record<string, string>;
}

/** Info about a peer's TLS certificate */
export interface PeerCertInfo {
  fingerprint: string;  // SHA-256 hex
  hostname: string;
  validFrom: string;
  validTo: string;
}

/** Pairing session state (server side) */
export interface PairingSession {
  inviteCode: string;
  publicKey: string;      // ECDH public key (base64)
  expiresAt: number;
  state: 'waiting' | 'key_exchanged' | 'completed' | 'expired';
  peerPublicKey?: string;
  sas?: string;           // Short Authentication String (6 digits)
}

/** Pairing initiation request from peer */
export interface PairingInitRequest {
  publicKey: string;     // ECDH public key (base64)
  inviteCode: string;
  hostname: string;
  apiKey: string;        // The peer's API key to add to allowedKeys
  certFingerprint?: string;
}

/** Pairing initiation response */
export interface PairingInitResponse {
  publicKey: string;
  hostname: string;
  apiKey: string;
  certFingerprint?: string;
  sas: string;           // 6-digit SAS for verification
}

/** Pairing confirmation request */
export interface PairingConfirmRequest {
  confirmed: boolean;
}
