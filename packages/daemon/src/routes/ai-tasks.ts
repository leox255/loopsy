import type { FastifyInstance } from 'fastify';
import type { AiTaskManager } from '../services/ai-task-manager.js';
import { AiTaskParamsSchema, AiTaskApprovalResponseSchema, PermissionRequestBodySchema } from '@loopsy/protocol';

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
      if (err.code === 6006 || err.code === 6007) {
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

  // Register a permission request from the hook script
  // Called by permission-hook.mjs when Claude wants to use a tool
  app.post<{ Params: { taskId: string } }>('/api/v1/ai-tasks/:taskId/permission-request', async (request, reply) => {
    const { taskId } = request.params;
    const body = PermissionRequestBodySchema.parse(request.body);

    const success = aiTaskManager.registerPermissionRequest(taskId, {
      requestId: body.requestId,
      toolName: body.toolName,
      toolInput: body.toolInput,
      description: body.description,
    });

    if (!success) {
      reply.code(404);
      return { error: 'Task not found' };
    }

    return { success: true, requestId: body.requestId };
  });

  // Poll for permission response (called by hook script)
  app.get<{ Params: { taskId: string }; Querystring: { requestId: string } }>(
    '/api/v1/ai-tasks/:taskId/permission-response',
    async (request, reply) => {
      const { taskId } = request.params;
      const { requestId } = request.query;

      if (!requestId) {
        reply.code(400);
        return { error: 'requestId query parameter required' };
      }

      const response = aiTaskManager.getPermissionResponse(taskId, requestId);
      if (!response) {
        return { resolved: false };
      }

      return {
        resolved: true,
        approved: response.approved,
        message: response.message || '',
      };
    },
  );

  // Approve/deny a permission request (called by dashboard)
  app.post<{ Params: { taskId: string } }>('/api/v1/ai-tasks/:taskId/approve', async (request, reply) => {
    const { taskId } = request.params;
    const response = AiTaskApprovalResponseSchema.parse(request.body);

    const success = aiTaskManager.approve(taskId, response);
    if (!success) {
      reply.code(400);
      return { error: 'No pending permission request found for this task' };
    }
    return { success: true, taskId };
  });

  // Get event buffer for a task (for debugging and catch-up)
  app.get<{ Params: { taskId: string } }>('/api/v1/ai-tasks/:taskId/events', async (request, reply) => {
    const events = aiTaskManager.getEventBuffer(request.params.taskId);
    return { events, count: events.length };
  });

  // Cancel a running task
  app.delete<{ Params: { taskId: string } }>('/api/v1/ai-tasks/:taskId', async (request, reply) => {
    const success = aiTaskManager.cancel(request.params.taskId);
    if (!success) {
      // Maybe it's a completed task — try deleting from recent
      const deleted = aiTaskManager.deleteTask(request.params.taskId);
      if (!deleted) {
        reply.code(404);
        return { error: 'Task not found' };
      }
      return { success: true, taskId: request.params.taskId, deleted: true };
    }
    return { success: true, taskId: request.params.taskId };
  });
}
