import type { FastifyInstance } from 'fastify';
import type { AiTaskManager } from '../services/ai-task-manager.js';
import { AiTaskParamsSchema, AiTaskApprovalResponseSchema } from '@loopsy/protocol';

export function registerAiTaskRoutes(app: FastifyInstance, aiTaskManager: AiTaskManager) {
  // Dispatch a new AI task
  app.post('/api/v1/ai-tasks', async (request, reply) => {
    const params = AiTaskParamsSchema.parse(request.body);
    const fromNodeId = (request.headers['x-loopsy-node-id'] as string) || 'remote';

    try {
      const info = await aiTaskManager.dispatch(params, fromNodeId);
      reply.code(201);
      return info;
    } catch (err: any) {
      if (err.code === 6002) {
        reply.code(429);
        return { error: err.message };
      }
      if (err.code === 6006) {
        reply.code(500);
        return { error: err.message };
      }
      throw err;
    }
  });

  // List all tasks (active + recent)
  app.get('/api/v1/ai-tasks', async () => {
    return { tasks: aiTaskManager.getAllTasks() };
  });

  // Get a single task
  app.get<{ Params: { taskId: string } }>('/api/v1/ai-tasks/:taskId', async (request, reply) => {
    const info = aiTaskManager.getTask(request.params.taskId);
    if (!info) {
      reply.code(404);
      return { error: 'Task not found' };
    }
    return info;
  });

  // SSE stream for a task
  app.get<{ Params: { taskId: string }; Querystring: { since?: string } }>(
    '/api/v1/ai-tasks/:taskId/stream',
    async (request, reply) => {
      const { taskId } = request.params;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Send buffered events first (for reconnecting clients)
      const since = request.query.since ? parseInt(request.query.since, 10) : 0;
      const buffer = aiTaskManager.getEventBuffer(taskId);
      for (const event of buffer) {
        if (event.timestamp > since) {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      }

      // Subscribe to live events
      const unsubscribe = aiTaskManager.subscribe(taskId, (event) => {
        if (!reply.raw.destroyed) {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      });

      if (!unsubscribe) {
        // Task not active — check if it's a recent completed task
        const info = aiTaskManager.getTask(taskId);
        if (info) {
          reply.raw.write(`data: ${JSON.stringify({ type: 'status', taskId, timestamp: Date.now(), data: { status: info.status } })}\n\n`);
        } else {
          reply.raw.write(`data: ${JSON.stringify({ type: 'error', taskId, timestamp: Date.now(), data: 'Task not found' })}\n\n`);
        }
        reply.raw.end();
        return;
      }

      // Clean up on disconnect
      request.raw.on('close', () => {
        unsubscribe();
      });

      // Keep connection open until task completes or client disconnects
      // The 'exit' event from the task will trigger the subscriber, and the client
      // can close the EventSource after receiving it.
    },
  );

  // Approve/deny a permission request
  app.post<{ Params: { taskId: string } }>('/api/v1/ai-tasks/:taskId/approve', async (request, reply) => {
    const { taskId } = request.params;
    const response = AiTaskApprovalResponseSchema.parse(request.body);

    const success = aiTaskManager.approve(taskId, response);
    if (!success) {
      reply.code(400);
      return { error: 'Task not in waiting_approval state or not found' };
    }
    return { success: true, taskId };
  });

  // Get event buffer for a task (for debugging and catch-up)
  app.get<{ Params: { taskId: string } }>('/api/v1/ai-tasks/:taskId/events', async (request, reply) => {
    const events = aiTaskManager.getEventBuffer(request.params.taskId);
    return { events, count: events.length };
  });

  // Cancel a task
  app.delete<{ Params: { taskId: string } }>('/api/v1/ai-tasks/:taskId', async (request, reply) => {
    const success = aiTaskManager.cancel(request.params.taskId);
    if (!success) {
      reply.code(404);
      return { error: 'Task not found or already completed' };
    }
    return { success: true, taskId: request.params.taskId };
  });
}
