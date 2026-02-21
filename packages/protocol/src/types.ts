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
  tls?: {
    enabled: boolean;
    cert?: string;
    key?: string;
    ca?: string;
  };
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
    manualPeers: Array<{ address: string; port: number }>;
  };
  logging: {
    level: string;
    file?: string;
  };
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
