import { z } from 'zod';

// --- Messaging Protocol v1 ---

/** Valid message types */
export const MessageTypeSchema = z.enum(['chat', 'request', 'response', 'ack', 'broadcast']);

/** Message ID format: <timestamp>-<hostname>-<4char_hex> */
export const MessageIdSchema = z.string().regex(
  /^\d+-[a-zA-Z0-9_.-]+-[a-f0-9]{4}$/,
  'Message ID must be in format: <timestamp>-<hostname>-<4hex>',
);

/** Message envelope for peer-to-peer messaging */
export const MessageEnvelopeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  ts: z.number().int().positive(),
  id: MessageIdSchema,
  type: MessageTypeSchema,
  body: z.string(),
});

/** Default TTLs in seconds */
export const MESSAGE_TTL = 3600;
export const ACK_TTL = 7200;

/**
 * Generate a protocol-compliant message ID.
 * Format: <timestamp>-<hostname>-<4char_hex>
 * Uses Number(Date.now()) to avoid BigInt issues.
 */
export function generateMessageId(hostname: string): string {
  const ts = Number(Date.now());
  const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `${ts}-${hostname}-${hex}`;
}

/**
 * Create a validated message envelope.
 * Throws ZodError if any field is invalid.
 */
export function createMessageEnvelope(
  from: string,
  to: string,
  type: z.infer<typeof MessageTypeSchema>,
  body: string,
): { envelope: z.infer<typeof MessageEnvelopeSchema>; id: string } {
  const id = generateMessageId(from);
  const envelope = MessageEnvelopeSchema.parse({
    from,
    to,
    ts: Number(Date.now()),
    id,
    type,
    body,
  });
  return { envelope, id };
}

/**
 * Parse and validate a message envelope from a string value.
 * Returns the parsed envelope or throws if invalid.
 */
export function parseMessageEnvelope(value: string): z.infer<typeof MessageEnvelopeSchema> {
  const parsed = JSON.parse(value);
  return MessageEnvelopeSchema.parse(parsed);
}

// --- Existing schemas ---

export const ExecuteParamsSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  timeout: z.number().positive().optional(),
  stream: z.boolean().optional().default(false),
});

export const TransferPushSchema = z.object({
  destPath: z.string().min(1),
});

export const TransferPullSchema = z.object({
  sourcePath: z.string().min(1),
  destPath: z.string().min(1),
});

export const FileListSchema = z.object({
  path: z.string().min(1),
});

export const ContextSetSchema = z.object({
  value: z.string().max(1_048_576),
  ttl: z.number().positive().optional(),
});

export const ContextKeySchema = z.object({
  key: z.string().min(1).max(256),
});

// --- AI Task schemas ---

export const AiTaskParamsSchema = z.object({
  prompt: z.string().min(1),
  cwd: z.string().optional(),
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'dontAsk']).optional().default('default'),
  model: z.string().optional(),
  maxBudgetUsd: z.number().positive().optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  additionalArgs: z.array(z.string()).optional(),
  resumeSessionId: z.string().optional(),
});

export const AiTaskApprovalResponseSchema = z.object({
  requestId: z.string().min(1),
  approved: z.boolean(),
  message: z.string().optional(),
});

export const PermissionRequestBodySchema = z.object({
  requestId: z.string().min(1),
  toolName: z.string().min(1),
  toolInput: z.unknown().optional().default({}),
  description: z.string().optional(),
});

export const PeerAddSchema = z.object({
  address: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  apiKey: z.string().min(1).optional(),
});

export const HandshakeSchema = z.object({
  nodeId: z.string().min(1),
  hostname: z.string().min(1),
  platform: z.string().min(1),
  version: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  capabilities: z.array(z.string()),
});
