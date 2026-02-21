import type { FastifyInstance } from 'fastify';
import { ExecuteParamsSchema, LoopsyError, LoopsyErrorCode } from '@loopsy/protocol';
import type { JobManager } from '../services/job-manager.js';

export function registerExecuteRoutes(app: FastifyInstance, jobManager: JobManager) {
  app.post('/api/v1/execute', async (request, reply) => {
    try {
      const params = ExecuteParamsSchema.parse(request.body);
      const fromNodeId = (request.headers['x-loopsy-node-id'] as string) ?? 'unknown';
      const result = await jobManager.execute(params, fromNodeId);
      return result;
    } catch (err) {
      if (err instanceof LoopsyError) {
        reply.code(err.code >= 3000 && err.code < 4000 ? 400 : 500);
        return err.toJSON();
      }
      throw err;
    }
  });

  app.post('/api/v1/execute/stream', async (request, reply) => {
    try {
      const params = ExecuteParamsSchema.parse(request.body);
      const fromNodeId = (request.headers['x-loopsy-node-id'] as string) ?? 'unknown';

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const { spawn } = await import('node:child_process');
      const proc = spawn(params.command, params.args ?? [], {
        cwd: params.cwd,
        env: params.env ? { ...process.env, ...params.env } : process.env,
        shell: false,
        timeout: params.timeout,
      });

      const jobId = `stream-${Date.now()}`;

      const sendEvent = (type: string, data: string) => {
        reply.raw.write(`data: ${JSON.stringify({ type, data, jobId, timestamp: Date.now() })}\n\n`);
      };

      proc.stdout?.on('data', (chunk: Buffer) => sendEvent('stdout', chunk.toString()));
      proc.stderr?.on('data', (chunk: Buffer) => sendEvent('stderr', chunk.toString()));

      proc.on('close', (exitCode) => {
        sendEvent('exit', String(exitCode ?? 0));
        reply.raw.end();
      });

      proc.on('error', (err) => {
        sendEvent('error', err.message);
        reply.raw.end();
      });

      request.raw.on('close', () => {
        proc.kill('SIGTERM');
      });
    } catch (err) {
      if (err instanceof LoopsyError) {
        reply.code(400);
        return err.toJSON();
      }
      throw err;
    }
  });

  app.delete<{ Params: { jobId: string } }>('/api/v1/execute/:jobId', async (request, reply) => {
    const { jobId } = request.params;
    const cancelled = jobManager.cancel(jobId);
    if (!cancelled) {
      const err = new LoopsyError(LoopsyErrorCode.EXEC_JOB_NOT_FOUND, `Job ${jobId} not found`);
      reply.code(404);
      return err.toJSON();
    }
    return { success: true, jobId };
  });

  app.get('/api/v1/execute/jobs', async () => {
    return { jobs: jobManager.getActiveJobs() };
  });
}
