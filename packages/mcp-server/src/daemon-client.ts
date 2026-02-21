import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_PORT,
  CONFIG_DIR,
  CONFIG_FILE,
  type MessageEnvelope,
  type MessageType,
  createMessageEnvelope,
  parseMessageEnvelope,
  MESSAGE_TTL,
  ACK_TTL,
} from '@loopsy/protocol';

/**
 * Read the API key from config.yaml.
 * Uses LOOPSY_DATA_DIR env var if set (for session support),
 * otherwise falls back to ~/.loopsy/config.yaml.
 * Falls back to LOOPSY_API_KEY env var, then empty string.
 */
async function loadApiKeyFromConfig(): Promise<{ apiKey: string; port: number }> {
  try {
    const dataDir = process.env.LOOPSY_DATA_DIR ?? join(homedir(), CONFIG_DIR);
    const configPath = join(dataDir, CONFIG_FILE);
    const raw = await readFile(configPath, 'utf-8');
    const parsed = parseYaml(raw) as any;
    return {
      apiKey: parsed?.auth?.apiKey ?? process.env.LOOPSY_API_KEY ?? '',
      port: parsed?.server?.port ?? DEFAULT_PORT,
    };
  } catch {
    return {
      apiKey: process.env.LOOPSY_API_KEY ?? '',
      port: DEFAULT_PORT,
    };
  }
}

export class DaemonClient {
  private apiKey: string;
  private baseUrl: string;
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  constructor(apiKey?: string, port?: number) {
    this.apiKey = apiKey ?? '';
    this.baseUrl = `http://127.0.0.1:${port ?? DEFAULT_PORT}/api/v1`;

    // If no API key provided, auto-load from config
    if (!this.apiKey) {
      this.initPromise = this.autoInit(port);
    } else {
      this.initialized = true;
    }
  }

  private async autoInit(portOverride?: number): Promise<void> {
    const config = await loadApiKeyFromConfig();
    this.apiKey = this.apiKey || config.apiKey;
    this.baseUrl = `http://127.0.0.1:${portOverride ?? config.port}/api/v1`;
    this.initialized = true;
  }

  private async ensureInit(): Promise<void> {
    if (!this.initialized && this.initPromise) {
      await this.initPromise;
    }
  }

  private async request<T>(path: string, opts: RequestInit = {}): Promise<T> {
    await this.ensureInit();
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...opts.headers,
      },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } })) as any;
      throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    }

    return res.json() as Promise<T>;
  }

  // Health
  async health() {
    return this.request('/health');
  }

  async status() {
    return this.request('/status');
  }

  async identity() {
    return this.request('/identity');
  }

  // Peers
  async listPeers() {
    return this.request<{ peers: any[] }>('/peers');
  }

  async addPeer(address: string, port: number) {
    return this.request('/peers', {
      method: 'POST',
      body: JSON.stringify({ address, port }),
    });
  }

  // Execute on local daemon (which can proxy to peer)
  async execute(command: string, args?: string[], opts?: { cwd?: string; timeout?: number }) {
    return this.request('/execute', {
      method: 'POST',
      body: JSON.stringify({ command, args, ...opts }),
    });
  }

  // Execute on a remote peer via their daemon
  async executeOnPeer(peerAddress: string, peerPort: number, peerApiKey: string, command: string, args?: string[], opts?: { cwd?: string; timeout?: number }) {
    const res = await fetch(`http://${peerAddress}:${peerPort}/api/v1/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${peerApiKey}`,
      },
      body: JSON.stringify({ command, args, ...opts }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } })) as any;
      throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    }
    return res.json();
  }

  // Context
  async setContext(key: string, value: string, ttl?: number) {
    return this.request(`/context/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value, ttl }),
    });
  }

  async getContext(key: string) {
    return this.request(`/context/${encodeURIComponent(key)}`);
  }

  async listContext(prefix?: string) {
    const query = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
    return this.request<{ entries: any[] }>(`/context${query}`);
  }

  async deleteContext(key: string) {
    return this.request(`/context/${encodeURIComponent(key)}`, { method: 'DELETE' });
  }

  // Context on a remote peer
  async setContextOnPeer(peerAddress: string, peerPort: number, peerApiKey: string, key: string, value: string, ttl?: number) {
    const res = await fetch(`http://${peerAddress}:${peerPort}/api/v1/context/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${peerApiKey}`,
      },
      body: JSON.stringify({ value, ttl }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } })) as any;
      throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    }
    return res.json();
  }

  async listContextFromPeer(peerAddress: string, peerPort: number, peerApiKey: string, prefix?: string) {
    const query = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
    const res = await fetch(`http://${peerAddress}:${peerPort}/api/v1/context${query}`, {
      headers: { Authorization: `Bearer ${peerApiKey}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } })) as any;
      throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    }
    return res.json();
  }

  async deleteContextFromPeer(peerAddress: string, peerPort: number, peerApiKey: string, key: string) {
    const res = await fetch(`http://${peerAddress}:${peerPort}/api/v1/context/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${peerApiKey}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } })) as any;
      throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    }
    return res.json();
  }

  async getContextFromPeer(peerAddress: string, peerPort: number, peerApiKey: string, key: string) {
    const res = await fetch(`http://${peerAddress}:${peerPort}/api/v1/context/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${peerApiKey}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } })) as any;
      throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    }
    return res.json();
  }

  // Transfer
  async listRemoteFiles(peerAddress: string, peerPort: number, peerApiKey: string, path: string) {
    const res = await fetch(`http://${peerAddress}:${peerPort}/api/v1/transfer/list`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${peerApiKey}`,
      },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } })) as any;
      throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    }
    return res.json();
  }

  // --- Messaging Protocol v1 ---

  /**
   * Get this machine's hostname from the daemon status endpoint.
   */
  async getHostname(): Promise<string> {
    const res = await this.request<{ hostname: string }>('/status');
    return res.hostname;
  }

  /**
   * Send a protocol-compliant message to a peer's inbox on their machine.
   * Returns the message ID and envelope.
   */
  async sendMessage(
    peerAddress: string,
    peerPort: number,
    peerApiKey: string,
    peerHostname: string,
    type: MessageType,
    body: string,
  ): Promise<{ id: string; envelope: MessageEnvelope }> {
    const myHostname = await this.getHostname();
    const { envelope, id } = createMessageEnvelope(myHostname, peerHostname, type, body);
    const value = JSON.stringify(envelope);
    const inboxKey = `inbox:${peerHostname}:${id}`;

    // PUT to peer's inbox on their machine
    await this.setContextOnPeer(peerAddress, peerPort, peerApiKey, inboxKey, value, MESSAGE_TTL);

    // Store outbox copy locally
    await this.setContext(`outbox:${id}`, value, MESSAGE_TTL);

    return { id, envelope };
  }

  /**
   * Check this machine's inbox for messages.
   * Returns parsed message envelopes sorted by timestamp.
   */
  async checkInbox(): Promise<Array<{ key: string; envelope: MessageEnvelope }>> {
    const myHostname = await this.getHostname();
    const prefix = `inbox:${myHostname}:`;
    const { entries } = await this.listContext(prefix);

    const messages: Array<{ key: string; envelope: MessageEnvelope }> = [];
    for (const entry of entries) {
      try {
        const envelope = parseMessageEnvelope(entry.value);
        messages.push({ key: entry.key, envelope });
      } catch {
        // Skip malformed messages
      }
    }

    return messages.sort((a, b) => a.envelope.ts - b.envelope.ts);
  }

  /**
   * Acknowledge a received message by setting ack on the sender's machine
   * and deleting the processed inbox message locally.
   */
  async ackMessage(
    senderAddress: string,
    senderPort: number,
    senderApiKey: string,
    messageKey: string,
    messageId: string,
  ): Promise<void> {
    const myHostname = await this.getHostname();

    // Set ACK on sender's machine
    await this.setContextOnPeer(senderAddress, senderPort, senderApiKey, `ack:${myHostname}`, messageId, ACK_TTL);

    // Delete processed message locally
    await this.deleteContext(messageKey);
  }

  /**
   * Check if a peer has acknowledged our messages.
   * Returns the last acknowledged message ID or null.
   */
  async checkAck(peerHostname: string): Promise<string | null> {
    try {
      const res = await this.request<{ value: string }>(`/context/${encodeURIComponent(`ack:${peerHostname}`)}`);
      return res.value;
    } catch {
      return null;
    }
  }

  // --- Transfer ---

  async pullFile(peerAddress: string, peerPort: number, peerApiKey: string, sourcePath: string) {
    const res = await fetch(`http://${peerAddress}:${peerPort}/api/v1/transfer/pull`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${peerApiKey}`,
      },
      body: JSON.stringify({ sourcePath }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } })) as any;
      throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    }
    return res;
  }
}
