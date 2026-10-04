import type { PetAction, TurnChunk, TurnReq } from '@ijime/api-types';
import {
  createPetTools,
  petToolSchemas,
  PET_TOOL_NAMES,
  SAFETY_TOOLS,
  runPetTurn,
  type PetToolName,
} from '@ijime/agent-core';
import { ApiHttpError, createServiceApp, type ServiceApp } from '@ijime/service-kit';
import { stream } from 'hono/streaming';
import { z } from 'zod';

import { buildAgent, type PetRuntime } from './runtime.js';
import { assertSession, reserveHttpToolCall } from './executor.js';

export const SERVICE_NAME = 'pet-agent';

const idSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
const turnReqSchema = z.object({
  childId: idSchema,
  sessionId: idSchema,
  messageId: idSchema,
});

export function createApp(runtime: () => Promise<PetRuntime>): ServiceApp {
  const app = createServiceApp({
    name: SERVICE_NAME,
    version: process.env['SERVICE_VERSION'] ?? '0.1.0',
    ready: () =>
      runtime().then(
        () => true,
        () => false,
      ),
  });

  app.post('/internal/turns', async (c) => {
    const parsed = turnReqSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiHttpError('INVALID_ARGUMENT', 'invalid turn request');
    const req: TurnReq = parsed.data;
    const rt = await runtime();
    const child = await rt.directory.lookup(req.childId);
    if (!child) throw new ApiHttpError('NOT_FOUND', 'unknown child');
    await assertSession(rt.db, child, req.sessionId);
    const context = await rt.sessions.readMessageContext(
      req.childId,
      req.sessionId,
      req.messageId,
      0,
    );
    const message = context?.message;
    if (!message || message.role !== 'child')
      throw new ApiHttpError('NOT_FOUND', 'unknown message');

    const actions: PetAction[] = [];
    const crises: string[] = [];
    const controller = new AbortController();
    const onClientAbort = () => controller.abort();
    c.req.raw.signal.addEventListener('abort', onClientAbort);
    const agent = await buildAgent(
      rt,
      child,
      req.sessionId,
      actions,
      (crisisId) => {
        crises.push(crisisId);
        controller.abort();
      },
      req.messageId,
      message.text,
    );
    const log = c.get('logger');
    c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
    c.header('Cache-Control', 'no-store');
    return stream(c, async (s) => {
      const gen = runPetTurn({
        agent,
        sessionService: rt.sessions,
        childId: req.childId,
        sessionId: req.sessionId,
        text: message.text,
        gradeBand: child.gradeBand,
        filter: rt.filter,
        safeReply: rt.safeReplies[child.gradeBand],
        actions,
        signal: controller.signal,
        onLog: (event, fields) =>
          log.info(event, { ...fields, pseudoId: child.childId, sessionId: req.sessionId }),
      });
      try {
        let r = await gen.next();
        // escalate_crisis のあとはペットの出力を一切転送しない（中断で生じたフォールバック応答も含む）
        while (!r.done && crises.length === 0) {
          const chunk: TurnChunk = r.value;
          await s.write(JSON.stringify(chunk) + '\n');
          r = await gen.next();
        }
        if (crises.length > 0) {
          const chunk: TurnChunk = { type: 'crisis', crisisId: crises[0]! };
          await s.write(JSON.stringify(chunk) + '\n');
        }
      } finally {
        await gen.return({ replyText: '', replyMessageId: '', fallback: null, toolCalls: [] });
        c.req.raw.signal.removeEventListener('abort', onClientAbort);
      }
    });
  });

  app.post('/internal/tools/:toolName', async (c) => {
    const parsed = z
      .object({
        childId: idSchema,
        sessionId: idSchema,
        operationId: idSchema.optional(),
        args: z.record(z.string(), z.unknown()).default({}),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiHttpError('INVALID_ARGUMENT', 'invalid tool request');
    const body = parsed.data;
    const name = c.req.param('toolName') as PetToolName;
    if (!PET_TOOL_NAMES.includes(name)) throw new ApiHttpError('NOT_FOUND', 'unknown tool');
    const args = petToolSchemas[name].strict().safeParse(body.args);
    if (!args.success) throw new ApiHttpError('INVALID_ARGUMENT', 'invalid tool arguments');
    const rt = await runtime();
    const child = await rt.directory.lookup(body.childId);
    if (!child) throw new ApiHttpError('NOT_FOUND', 'unknown child');
    await assertSession(rt.db, child, body.sessionId, SAFETY_TOOLS.has(name));
    const lastMessage = await rt.db
      .collection(
        `families/${child.familyId}/children/${child.childId}/sessions/${body.sessionId}/messages`,
      )
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    const actions: PetAction[] = [];
    const executor = rt.executorFor(child, body.sessionId, actions);
    const ctx = {
      childId: child.childId,
      sessionId: body.sessionId,
      gradeBand: child.gradeBand,
      characterId: child.characterId,
      operationId: body.operationId ?? lastMessage.docs[0]?.id ?? body.sessionId,
    };
    if (!(await reserveHttpToolCall(rt.db, child, ctx, name, args.data)))
      return c.json({ result: { error: 'tool_budget_exhausted' } });
    const tool = createPetTools(executor, ctx, (action) => actions.push(action), undefined, {
      filter: rt.filter,
    }).find((candidate) => candidate.name === name)!;
    try {
      const result = await tool.runAsync({ args: args.data, toolContext: {} as never });
      return c.json({ result, actions });
    } catch {
      throw new ApiHttpError('MODEL_UNAVAILABLE', 'tool_execution_failed');
    }
  });

  return app;
}
