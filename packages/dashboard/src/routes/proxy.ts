import type { FastifyInstance } from 'fastify';

const ALLOWED_PORT_MIN = 19532;
const ALLOWED_PORT_MAX = 19640;

export function registerProxyRoutes(app: FastifyInstance, apiKey: string) {
  app.all<{ Params: { port: string; '*': string } }>(
    '/dashboard/api/proxy/:port/*',
    async (request, reply) => {
      const port = parseInt(request.params.port, 10);
      if (isNaN(port) || port < ALLOWED_PORT_MIN || port > ALLOWED_PORT_MAX) {
        reply.code(400);
        return { error: 'Port out of allowed range' };
      }

      const path = request.params['*'];
      if (!path.startsWith('api/v1/')) {
        reply.code(400);
        return { error: 'Path must start with api/v1/' };
      }

      const url = `http://127.0.0.1:${port}/${path}`;
      const method = request.method as string;

      try {
        const fetchOpts: RequestInit = {
          method,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          signal: AbortSignal.timeout(30_000),
        };

        if (!['GET', 'HEAD'].includes(method) && request.body) {
          fetchOpts.body = JSON.stringify(request.body);
        }

        const upstreamRes = await fetch(url, fetchOpts);

        // Check if SSE response
        const contentType = upstreamRes.headers.get('content-type') ?? '';
        if (contentType.includes('text/event-stream')) {
          reply.raw.writeHead(upstreamRes.status, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          if (upstreamRes.body) {
            for await (const chunk of upstreamRes.body as any) {
              if (reply.raw.destroyed) break;
              reply.raw.write(chunk);
            }
          }
          reply.raw.end();
          return;
        }

        reply.code(upstreamRes.status);
        const body = await upstreamRes.json().catch(() => ({}));
        return body;
      } catch (err: any) {
        reply.code(502);
        return { error: `Proxy error: ${err.message}` };
      }
    },
  );
}
