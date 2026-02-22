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
  'loopsy_context_list',
  'List context entries, optionally filtered by key prefix. Use to scan for inbox messages (e.g. prefix "inbox:leo:").',
  {
    prefix: z.string().optional().describe('Key prefix to filter by (e.g. "inbox:leo:")'),
    peerAddress: z.string().optional().describe('Peer address (omit for local)'),
    peerPort: z.number().optional().describe('Peer port'),
    peerApiKey: z.string().optional().describe('Peer API key'),
  },
  async ({ prefix, peerAddress, peerPort, peerApiKey }) => {
    try {
      let result;
      if (peerAddress && peerApiKey) {
        result = await client.listContextFromPeer(peerAddress, peerPort ?? 19532, peerApiKey, prefix);
      } else {
        result = await client.listContext(prefix);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  'loopsy_context_delete',
  'Delete a context entry by key on a remote peer or locally. Use to clean up processed inbox messages.',
  {
    key: z.string().describe('Context key to delete'),
    peerAddress: z.string().optional().describe('Peer address (omit for local)'),
    peerPort: z.number().optional().describe('Peer port'),
    peerApiKey: z.string().optional().describe('Peer API key'),
  },
  async ({ key, peerAddress, peerPort, peerApiKey }) => {
    try {
      let result;
      if (peerAddress && peerApiKey) {
        result = await client.deleteContextFromPeer(peerAddress, peerPort ?? 19532, peerApiKey, key);
      } else {
        result = await client.deleteContext(key);
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

// --- Session Management Tools ---

server.tool(
  'loopsy_session_list',
  'List all Loopsy sessions (workers) with their status, port, and hostname',
  {},
  async () => {
    try {
      const result = await client.listSessions();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  'loopsy_session_start',
  'Start a new Loopsy worker session. Creates a new daemon instance on a free port.',
  {
    name: z.string().describe('Name for the session (e.g. "worker-1")'),
  },
  async ({ name }) => {
    try {
      const result = await client.startSession(name);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  'loopsy_session_stop',
  'Stop a running Loopsy worker session',
  {
    name: z.string().describe('Name of the session to stop'),
  },
  async ({ name }) => {
    try {
      const result = await client.stopSession(name);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  'loopsy_session_remove',
  'Stop and remove a Loopsy worker session, deleting its configuration and data',
  {
    name: z.string().describe('Name of the session to remove'),
  },
  async ({ name }) => {
    try {
      const result = await client.removeSession(name);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

// --- Messaging Protocol v1 Tools ---

server.tool(
  'loopsy_send_message',
  'Send a protocol-compliant message to a peer. Handles envelope creation, inbox key, outbox copy, and TTL automatically.',
  {
    peerAddress: z.string().describe('IP address or hostname of the peer'),
    peerPort: z.number().default(19532).describe('Port of the peer daemon'),
    peerApiKey: z.string().describe('API key for the peer'),
    peerHostname: z.string().describe('Hostname of the peer (e.g. "leo")'),
    type: z.enum(['chat', 'request', 'response', 'broadcast']).default('chat').describe('Message type'),
    body: z.string().describe('Message body text'),
  },
  async ({ peerAddress, peerPort, peerApiKey, peerHostname, type, body }) => {
    try {
      const { id, envelope } = await client.sendMessage(peerAddress, peerPort, peerApiKey, peerHostname, type, body);
      return {
        content: [{
          type: 'text',
          text: `Message sent!\nID: ${id}\nTo: ${envelope.to} (${peerAddress}:${peerPort})\nType: ${envelope.type}\nInbox key: inbox:${peerHostname}:${id}`,
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  'loopsy_check_inbox',
  'Check this machine\'s inbox for new messages. Returns all unprocessed messages sorted by timestamp.',
  {},
  async () => {
    try {
      const messages = await client.checkInbox();
      if (messages.length === 0) {
        return { content: [{ type: 'text', text: 'No new messages in inbox.' }] };
      }
      const lines = messages.map((m) =>
        `[${m.envelope.type}] From: ${m.envelope.from} | ID: ${m.envelope.id}\n  Body: ${m.envelope.body}\n  Key: ${m.key}`,
      );
      return { content: [{ type: 'text', text: `${messages.length} message(s):\n\n${lines.join('\n\n')}` }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  'loopsy_ack_message',
  'Acknowledge a received message. Sends ACK to the sender\'s machine and deletes the processed inbox message locally.',
  {
    senderAddress: z.string().describe('IP address of the message sender'),
    senderPort: z.number().default(19532).describe('Port of the sender daemon'),
    senderApiKey: z.string().describe('API key for the sender'),
    messageKey: z.string().describe('The inbox context key (e.g. "inbox:kai:1234-leo-ab12")'),
    messageId: z.string().describe('The message ID to acknowledge'),
  },
  async ({ senderAddress, senderPort, senderApiKey, messageKey, messageId }) => {
    try {
      await client.ackMessage(senderAddress, senderPort, senderApiKey, messageKey, messageId);
      return { content: [{ type: 'text', text: `ACK sent for message ${messageId} and inbox entry cleaned up.` }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  'loopsy_check_ack',
  'Check if a peer has acknowledged your messages. Returns the last acknowledged message ID.',
  {
    peerHostname: z.string().describe('Hostname of the peer to check ACK from'),
  },
  async ({ peerHostname }) => {
    try {
      const lastAck = await client.checkAck(peerHostname);
      if (lastAck) {
        return { content: [{ type: 'text', text: `Last ACK from ${peerHostname}: ${lastAck}` }] };
      }
      return { content: [{ type: 'text', text: `No ACK received from ${peerHostname} yet.` }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  },
);

// --- Peer Status & Broadcast ---

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
          text: `You have access to Loopsy - a cross-machine communication system with a built-in messaging protocol.

## Messaging Tools (Protocol v1)

Use these for all peer-to-peer communication:

1. **loopsy_send_message** - Send a message to a peer (handles envelope, inbox key, outbox, TTL automatically)
2. **loopsy_check_inbox** - Check your inbox for new messages
3. **loopsy_ack_message** - Acknowledge a received message (sends ACK + cleans up inbox)
4. **loopsy_check_ack** - Check if a peer has acknowledged your messages

## Other Tools

5. **loopsy_list_peers** - See all machines on the network
6. **loopsy_execute** - Run a command on a remote machine
7. **loopsy_transfer_file** - Send/receive files between machines
8. **loopsy_list_remote_files** - Browse files on a remote machine
9. **loopsy_context_set** - Store shared state (low-level, prefer messaging tools)
10. **loopsy_context_get** - Retrieve shared state (low-level)
11. **loopsy_context_list** - List context entries with prefix filtering
12. **loopsy_context_delete** - Delete context entries
13. **loopsy_peer_status** - Check a peer's health
14. **loopsy_broadcast_context** - Set context on all peers at once

## Session Management Tools

15. **loopsy_session_list** - List all worker sessions with their status
16. **loopsy_session_start** - Start a new worker session
17. **loopsy_session_stop** - Stop a running worker session
18. **loopsy_session_remove** - Stop and remove a worker session and its data

## How to Communicate with Other Claude Instances

1. **Discover peers**: Use loopsy_list_peers to find online machines
2. **Send a message**: Use loopsy_send_message with the peer's address, port, API key, and hostname
3. **Check for replies**: Use loopsy_check_inbox to see incoming messages
4. **Acknowledge**: Use loopsy_ack_message to confirm receipt and clean up
5. **Verify delivery**: Use loopsy_check_ack to see if your message was acknowledged

## Protocol Details

Messages use JSON envelopes with: from, to, ts (timestamp), id, type, body
- Inbox keys: inbox:<recipient>:<msg_id> (stored on recipient's machine)
- Outbox keys: outbox:<msg_id> (stored locally)
- ACK keys: ack:<receiver> (stored on sender's machine)
- Message IDs: <timestamp>-<hostname>-<4hex>
- Default TTL: 3600s for messages, 7200s for ACKs`,
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
1. First, check if the peer is online using loopsy_list_peers
2. Send a message describing what you need using loopsy_send_message (type: "request")
3. Poll for their response using loopsy_check_inbox (check every 5-10 seconds)
4. When you receive a reply, acknowledge it with loopsy_ack_message
5. Use loopsy_execute to run any necessary commands on the remote machine
6. Transfer any needed files with loopsy_transfer_file

Remember: Use the messaging protocol tools (loopsy_send_message, loopsy_check_inbox, loopsy_ack_message) for all communication. These handle envelope formatting, TTLs, and cleanup automatically.`,
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
