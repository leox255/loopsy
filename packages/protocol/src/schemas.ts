import { z } from 'zod';

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
