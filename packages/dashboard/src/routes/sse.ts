import type { FastifyInstance } from 'fastify';

export function registerSseRoutes(app: FastifyInstance, apiKey: string) {
  app.get<{ Params: { port: string }; Querystring: { command: string; args?: string; cwd?: string } }>(
    '/dashboard/api/sse/execute/:port',
    async (request, reply) => {
      const port = parseInt(request.params.port, 10);
      const { command, args, cwd } = request.query;

      if (!command) {
        reply.code(400);
        return { error: 'Missing command parameter' };
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      try {
        const upstreamRes = await fetch(`http://127.0.0.1:${port}/api/v1/execute/stream`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            command,
            args: args ? JSON.parse(args) : [],
            cwd: cwd || undefined,
          }),
          signal: AbortSignal.timeout(300_000),
        });

        if (!upstreamRes.ok) {
          const errBody = await upstreamRes.text();
          reply.raw.write(`data: ${JSON.stringify({ type: 'error', data: errBody, jobId: 'none', timestamp: Date.now() })}\n\n`);
          reply.raw.end();
          return;
        }

        if (upstreamRes.body) {
          for await (const chunk of upstreamRes.body as any) {
            if (reply.raw.destroyed) break;
            reply.raw.write(chunk);
          }
        }
      } catch (err: any) {
        reply.raw.write(`data: ${JSON.stringify({ type: 'error', data: err.message, jobId: 'none', timestamp: Date.now() })}\n\n`);
      }

      reply.raw.end();
    },
  );
}
