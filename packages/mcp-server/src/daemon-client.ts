import { DEFAULT_PORT } from '@loopsy/protocol';

const BASE_URL = `http://127.0.0.1:${DEFAULT_PORT}/api/v1`;

export class DaemonClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey?: string, port?: number) {
    this.apiKey = apiKey ?? process.env.LOOPSY_API_KEY ?? '';
    this.baseUrl = `http://127.0.0.1:${port ?? DEFAULT_PORT}/api/v1`;
  }

  private async request<T>(path: string, opts: RequestInit = {}): Promise<T> {
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
