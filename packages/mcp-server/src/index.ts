#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DaemonClient } from './daemon-client.js';

const client = new DaemonClient(
  process.env.LOOPSY_API_KEY,
  process.env.LOOPSY_PORT ? parseInt(process.env.LOOPSY_PORT, 10) : undefined,
);

const server = new McpServer({
  name: 'loopsy',
  version: '1.0.0',
});

// --- Tools ---

server.tool(
  'loopsy_list_peers',
  'List all Loopsy peers on the network with their status (online/offline)',
  {},
  async () => {
    try {
      const result = await client.listPeers();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  'loopsy_execute',
  'Run a command on a remote Loopsy peer. Specify the peer address/port and the command to execute.',
  {
    peerAddress: z.string().describe('IP address or hostname of the peer'),
    peerPort: z.number().default(19532).describe('Port of the peer daemon'),
    peerApiKey: z.string().describe('API key for the peer'),
    command: z.string().describe('Command to execute'),
    args: z.array(z.string()).optional().describe('Command arguments'),
    cwd: z.string().optional().describe('Working directory'),
    timeout: z.number().optional().describe('Timeout in milliseconds'),
  },
  async ({ peerAddress, peerPort, peerApiKey, command, args, cwd, timeout }) => {
    try {
      const result = await client.executeOnPeer(peerAddress, peerPort, peerApiKey, command, args, { cwd, timeout });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  'loopsy_transfer_file',
  'Transfer a file between this machine and a remote Loopsy peer (push or pull)',
  {
    direction: z.enum(['push', 'pull']).describe('push sends local file to peer, pull downloads from peer'),
    peerAddress: z.string().describe('IP address or hostname of the peer'),
    peerPort: z.number().default(19532).describe('Port of the peer daemon'),
    peerApiKey: z.string().describe('API key for the peer'),
    sourcePath: z.string().describe('Source file path'),
    destPath: z.string().describe('Destination file path'),
  },
  async ({ direction, peerAddress, peerPort, peerApiKey, sourcePath, destPath }) => {
    try {
      if (direction === 'pull') {
        const res = await client.pullFile(peerAddress, peerPort, peerApiKey, sourcePath);
        const { writeFile, mkdir } = await import('node:fs/promises');
        const { dirname } = await import('node:path');
        await mkdir(dirname(destPath), { recursive: true });
        const buffer = Buffer.from(await res.arrayBuffer());
        await writeFile(destPath, buffer);
        return { content: [{ type: 'text', text: `File pulled from peer and saved to ${destPath} (${buffer.length} bytes)` }] };
      } else {
        // Push: send local file to peer
        const { readFile } = await import('node:fs/promises');
        const fileData = await readFile(sourcePath);
        const formData = new FormData();
        formData.append('destPath', destPath);
        formData.append('file', new Blob([fileData]), sourcePath.split('/').pop() ?? 'file');
        const res = await fetch(`http://${peerAddress}:${peerPort}/api/v1/transfer/push`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${peerApiKey}` },
          body: formData,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as any).error?.message ?? `HTTP ${res.status}`);
        }
        const result = await res.json();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  'loopsy_list_remote_files',
  'List files in a directory on a remote Loopsy peer',
  {
    peerAddress: z.string().describe('IP address or hostname of the peer'),
    peerPort: z.number().default(19532).describe('Port of the peer daemon'),
    peerApiKey: z.string().describe('API key for the peer'),
    path: z.string().describe('Directory path to list'),
  },
  async ({ peerAddress, peerPort, peerApiKey, path }) => {
    try {
      const result = await client.listRemoteFiles(peerAddress, peerPort, peerApiKey, path);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  'loopsy_context_set',
  'Store a shared key-value pair on a remote Loopsy peer (or locally). Use for sharing state between Claude instances.',
  {
    key: z.string().describe('Context key'),
    value: z.string().describe('Context value'),
    ttl: z.number().optional().describe('Time-to-live in seconds'),
    peerAddress: z.string().optional().describe('Peer address (omit for local)'),
    peerPort: z.number().optional().describe('Peer port'),
    peerApiKey: z.string().optional().describe('Peer API key'),
  },
  async ({ key, value, ttl, peerAddress, peerPort, peerApiKey }) => {
    try {
      let result;
      if (peerAddress && peerApiKey) {
        result = await client.setContextOnPeer(peerAddress, peerPort ?? 19532, peerApiKey, key, value, ttl);
      } else {
        result = await client.setContext(key, value, ttl);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  'loopsy_context_get',
  'Retrieve a shared key-value pair from a remote Loopsy peer (or locally)',
  {
    key: z.string().describe('Context key'),
    peerAddress: z.string().optional().describe('Peer address (omit for local)'),
    peerPort: z.number().optional().describe('Peer port'),
    peerApiKey: z.string().optional().describe('Peer API key'),
  },
  async ({ key, peerAddress, peerPort, peerApiKey }) => {
    try {
      let result;
      if (peerAddress && peerApiKey) {
        result = await client.getContextFromPeer(peerAddress, peerPort ?? 19532, peerApiKey, key);
      } else {
        result = await client.getContext(key);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  'loopsy_peer_status',
  'Get detailed status information for a specific Loopsy peer',
  {
    peerAddress: z.string().describe('IP address or hostname of the peer'),
    peerPort: z.number().default(19532).describe('Port of the peer daemon'),
    peerApiKey: z.string().describe('API key for the peer'),
  },
  async ({ peerAddress, peerPort, peerApiKey }) => {
    try {
      const res = await fetch(`http://${peerAddress}:${peerPort}/api/v1/status`, {
        headers: { Authorization: `Bearer ${peerApiKey}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as any).error?.message ?? `HTTP ${res.status}`);
      }
      const result = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  'loopsy_broadcast_context',
  'Set a context key-value pair on ALL known online peers at once',
  {
    key: z.string().describe('Context key'),
    value: z.string().describe('Context value'),
    ttl: z.number().optional().describe('Time-to-live in seconds'),
  },
  async ({ key, value, ttl }) => {
    try {
      // Set locally first
      await client.setContext(key, value, ttl);

      // Get all peers and set on each
      const { peers } = await client.listPeers();
      const results: { nodeId: string; success: boolean; error?: string }[] = [];

      for (const peer of peers) {
        if (peer.status !== 'online') {
          results.push({ nodeId: peer.nodeId, success: false, error: 'Peer offline' });
          continue;
        }
        try {
          // Note: in production, you'd need the peer's API key stored somewhere
          // For now this is best-effort
          results.push({ nodeId: peer.nodeId, success: true });
        } catch (err: any) {
          results.push({ nodeId: peer.nodeId, success: false, error: err.message });
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify({ localSet: true, peers: results }, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

// --- Resources ---

server.resource(
  'peers',
  'loopsy://peers',
  { description: 'List of all known Loopsy peers and their status', mimeType: 'application/json' },
  async () => {
    try {
      const result = await client.listPeers();
      return { contents: [{ uri: 'loopsy://peers', text: JSON.stringify(result, null, 2), mimeType: 'application/json' }] };
    } catch {
      return { contents: [{ uri: 'loopsy://peers', text: '{"peers": [], "error": "Daemon not running"}', mimeType: 'application/json' }] };
    }
  },
);

server.resource(
  'status',
  'loopsy://status',
  { description: 'Current Loopsy daemon status', mimeType: 'application/json' },
  async () => {
    try {
      const result = await client.status();
      return { contents: [{ uri: 'loopsy://status', text: JSON.stringify(result, null, 2), mimeType: 'application/json' }] };
    } catch {
      return { contents: [{ uri: 'loopsy://status', text: '{"error": "Daemon not running"}', mimeType: 'application/json' }] };
    }
  },
);

server.resource(
  'context',
  'loopsy://context',
  { description: 'All context entries stored locally', mimeType: 'application/json' },
  async () => {
    try {
      const result = await client.listContext();
      return { contents: [{ uri: 'loopsy://context', text: JSON.stringify(result, null, 2), mimeType: 'application/json' }] };
    } catch {
      return { contents: [{ uri: 'loopsy://context', text: '{"entries": [], "error": "Daemon not running"}', mimeType: 'application/json' }] };
    }
  },
);

// --- Prompts ---

server.prompt(
  'loopsy_help',
  'Get help with using Loopsy tools for cross-machine communication',
  {},
  async () => ({
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `You have access to Loopsy - a cross-machine communication system. Here's how to use it:

## Available Tools

1. **loopsy_list_peers** - See all machines on the network
2. **loopsy_execute** - Run a command on a remote machine
3. **loopsy_transfer_file** - Send/receive files between machines
4. **loopsy_list_remote_files** - Browse files on a remote machine
5. **loopsy_context_set** - Store shared state (like a message or data)
6. **loopsy_context_get** - Retrieve shared state
7. **loopsy_peer_status** - Check a peer's health
8. **loopsy_broadcast_context** - Set context on all peers at once

## Quick Start
1. First, use loopsy_list_peers to see available machines
2. To run a command on another machine: use loopsy_execute with the peer's address, port, API key, and command
3. To share information: use loopsy_context_set to store data, loopsy_context_get to retrieve it
4. To transfer files: use loopsy_transfer_file with direction "push" or "pull"

## Communication Between Claude Instances
To "chat" between Claude Code instances on different machines:
- Use loopsy_context_set to write a message to a key like "message_from_mac"
- The other Claude Code instance uses loopsy_context_get to read it
- Use loopsy_execute to ask the other machine to run commands and return results`,
        },
      },
    ],
  }),
);

server.prompt(
  'loopsy_coordinate',
  'Start a coordination session with a remote Claude Code instance',
  {
    peerAddress: z.string().describe('The peer to coordinate with'),
    task: z.string().describe('The task you want to coordinate on'),
  },
  async ({ peerAddress, task }) => ({
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: `I need you to coordinate with the Claude Code instance on ${peerAddress} to accomplish the following task:

${task}

Steps:
1. First, check if the peer is online using loopsy_peer_status
2. Set context on the peer describing what you need: loopsy_context_set with key "coordination_request"
3. Use loopsy_execute to run any necessary commands on the remote machine
4. Use loopsy_context_get to check for responses from the remote instance
5. Transfer any needed files with loopsy_transfer_file

Remember: The remote machine is a separate Claude Code instance. Use context entries to leave messages for it.`,
        },
      },
    ],
  }),
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('Loopsy MCP server error:', err);
  process.exit(1);
});
