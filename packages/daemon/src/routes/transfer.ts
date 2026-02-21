import type { FastifyInstance } from 'fastify';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, readdir, mkdir } from 'node:fs/promises';
import { join, dirname, resolve, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { LoopsyError, LoopsyErrorCode } from '@loopsy/protocol';
import type { FileListEntry, TransferResult } from '@loopsy/protocol';
import type { LoopsyConfig } from '@loopsy/protocol';

export function registerTransferRoutes(app: FastifyInstance, config: LoopsyConfig) {
  const isPathAllowed = (filePath: string): boolean => {
    const normalized = normalize(resolve(filePath));
    for (const denied of config.transfer.deniedPaths) {
      if (normalized.startsWith(normalize(resolve(denied)))) return false;
    }
    if (config.transfer.allowedPaths.length === 0) return true;
    for (const allowed of config.transfer.allowedPaths) {
      if (normalized.startsWith(normalize(resolve(allowed)))) return true;
    }
    return false;
  };

  // Push: receive a file from a peer
  app.post('/api/v1/transfer/push', async (request, reply) => {
    try {
      const data = await (request as any).file();
      if (!data) {
        throw new LoopsyError(LoopsyErrorCode.TRANSFER_FAILED, 'No file in request');
      }

      const destPath = data.fields?.destPath?.value as string;
      if (!destPath) {
        throw new LoopsyError(LoopsyErrorCode.INVALID_REQUEST, 'Missing destPath field');
      }

      if (!isPathAllowed(destPath)) {
        throw new LoopsyError(LoopsyErrorCode.TRANSFER_PATH_DENIED, `Path '${destPath}' is not allowed`);
      }

      await mkdir(dirname(destPath), { recursive: true });

      const hash = createHash('sha256');
      let size = 0;
      const start = Date.now();

      const writeStream = createWriteStream(destPath);
      for await (const chunk of data.file) {
        hash.update(chunk);
        size += chunk.length;
        if (size > config.transfer.maxFileSize) {
          writeStream.destroy();
          throw new LoopsyError(LoopsyErrorCode.TRANSFER_TOO_LARGE, `File exceeds max size of ${config.transfer.maxFileSize} bytes`);
        }
        writeStream.write(chunk);
      }
      writeStream.end();

      const result: TransferResult = {
        path: destPath,
        size,
        checksum: hash.digest('hex'),
        duration: Date.now() - start,
      };
      return result;
    } catch (err) {
      if (err instanceof LoopsyError) {
        reply.code(400);
        return err.toJSON();
      }
      throw err;
    }
  });

  // Pull: send a file to a peer
  app.post('/api/v1/transfer/pull', async (request, reply) => {
    try {
      const body = request.body as { sourcePath: string };
      if (!body?.sourcePath) {
        throw new LoopsyError(LoopsyErrorCode.INVALID_REQUEST, 'Missing sourcePath');
      }

      if (!isPathAllowed(body.sourcePath)) {
        throw new LoopsyError(LoopsyErrorCode.TRANSFER_PATH_DENIED, `Path '${body.sourcePath}' is not allowed`);
      }

      const fileStat = await stat(body.sourcePath).catch(() => null);
      if (!fileStat || !fileStat.isFile()) {
        throw new LoopsyError(LoopsyErrorCode.TRANSFER_FILE_NOT_FOUND, `File not found: ${body.sourcePath}`);
      }

      if (fileStat.size > config.transfer.maxFileSize) {
        throw new LoopsyError(LoopsyErrorCode.TRANSFER_TOO_LARGE, `File exceeds max size`);
      }

      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${body.sourcePath.split('/').pop()}"`);
      reply.header('X-Loopsy-File-Size', String(fileStat.size));

      return reply.send(createReadStream(body.sourcePath));
    } catch (err) {
      if (err instanceof LoopsyError) {
        reply.code(400);
        return err.toJSON();
      }
      throw err;
    }
  });

  // List directory contents
  app.post('/api/v1/transfer/list', async (request, reply) => {
    try {
      const body = request.body as { path: string };
      if (!body?.path) {
        throw new LoopsyError(LoopsyErrorCode.INVALID_REQUEST, 'Missing path');
      }

      if (!isPathAllowed(body.path)) {
        throw new LoopsyError(LoopsyErrorCode.TRANSFER_PATH_DENIED, `Path '${body.path}' is not allowed`);
      }

      const entries = await readdir(body.path, { withFileTypes: true });
      const files: FileListEntry[] = [];

      for (const entry of entries) {
        const fullPath = join(body.path, entry.name);
        try {
          const s = await stat(fullPath);
          files.push({
            name: entry.name,
            path: fullPath,
            type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
            size: s.size,
            modified: s.mtimeMs,
          });
        } catch {
          // Skip files we can't stat
        }
      }

      return { files };
    } catch (err) {
      if (err instanceof LoopsyError) {
        reply.code(400);
        return err.toJSON();
      }
      throw err;
    }
  });
}
