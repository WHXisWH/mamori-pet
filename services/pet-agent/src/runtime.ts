import { resolve } from 'node:path';

import { Firestore } from '@google-cloud/firestore';
import type { BaseLlm } from '@google/adk';
import type { GradeBand, PetAction } from '@ijime/api-types';
import {
  buildPetInstruction,
  childPath,
  createGemini,
  createPetAgent,
  createPetCallbacks,
  createPetTools,
  loadGamePreferenceRules,
  gamePreferenceChange,
  defaultPetName,
  LocalChildDirectory,
  disableAdkContentCapture,
  FirestoreChildDirectory,
  ScopedChildDirectory,
  FirestoreSessionService,
  OutputFilter,
  petDemoScript,
  ScriptedLlm,
  type ChildDirectory,
  type ChildRecord,
  type PetToolExecutor,
  type TurnContext,
} from '@ijime/agent-core';
import { loadEnv, type Env } from '@ijime/config';
import { KmsKeyWrapper, kmsKeyPath } from '@ijime/crypto';
import {
  FsKbSource,
  Kb,
  loadQuickReplyCatalog,
  outputFilterSchema,
  safeRepliesSchema,
} from '@ijime/kb-loader';
import { Logger, PubSubRestPublisher, type Publisher } from '@ijime/service-kit';

import { createExecutor } from './executor.js';
import { createSkillSearch } from './skills.js';
import { createModelNameDetector } from './pseudonyms.js';
import { createModelSummaryGenerator, type SummaryGenerator } from './summary.js';
import { createModelArmorInspector, type OutputInspector } from './model-armor.js';
import { createMemorySearch } from './memory-search.js';
import { createChildPushSender, type ChildPushSender } from './child-push.js';
import { consultationPending } from './context.js';

export type PetRuntime = {
  kb: Kb;
  db: Firestore;
  directory: ChildDirectory;
  sessions: FirestoreSessionService;
  filter: OutputFilter;
  safeReplies: Record<GradeBand, string>;
  model: BaseLlm;
  summarize?: SummaryGenerator;
  inspectOutput?: OutputInspector;
  childPush?: ChildPushSender;
  logger: Logger;
  publish: Publisher['publish'];
  executorFor: (
    child: ChildRecord,
    sessionId: string,
    actions: PetAction[],
    onCrisis?: (crisisId: string) => void,
  ) => PetToolExecutor;
};

export type ModelMode = 'scripted' | 'vertex';

export function modelMode(env: NodeJS.ProcessEnv = process.env): ModelMode {
  if (env['NODE_ENV'] === 'production') {
    if (env['PET_MODEL_MODE'] && env['PET_MODEL_MODE'] !== 'vertex')
      throw new Error('production pet-agent requires vertex mode');
    return 'vertex';
  }
  if (env['PET_MODEL_MODE'] && !['vertex', 'scripted'].includes(env['PET_MODEL_MODE']))
    throw new Error('invalid PET_MODEL_MODE');
  return env['PET_MODEL_MODE'] === 'vertex' ? 'vertex' : 'scripted';
}

export function createEventPublisher(
  env: Pick<Env, 'NODE_ENV' | 'GCP_PROJECT_ID' | 'PUBSUB_EMULATOR_HOST'>,
): Publisher['publish'] {
  if (env.GCP_PROJECT_ID && (env.NODE_ENV === 'production' || env.PUBSUB_EMULATOR_HOST)) {
    const publisher = PubSubRestPublisher.fromEnv(env.GCP_PROJECT_ID, {
      ...(env.PUBSUB_EMULATOR_HOST ? { PUBSUB_EMULATOR_HOST: env.PUBSUB_EMULATOR_HOST } : {}),
    });
    return (topic, payload) => publisher.publish(topic, payload);
  }
  if (env.NODE_ENV === 'production') throw new Error('GCP_PROJECT_ID is required for Pub/Sub');
  return async () => {
    throw new Error('checkin_publisher_not_configured');
  };
}

export async function createRuntime(overrides: Partial<PetRuntime> = {}): Promise<PetRuntime> {
  disableAdkContentCapture();
  const env = loadEnv();
  const logger = overrides.logger ?? new Logger('pet-agent');
  const publish = overrides.publish ?? createEventPublisher(env);
  const kb =
    overrides.kb ?? (await Kb.load(new FsKbSource(resolve(env.KB_LOCAL_DIR ?? 'kb/v0.1.0'))));
  const db =
    overrides.db ??
    new Firestore(
      env.GCP_PROJECT_ID ? { projectId: env.GCP_PROJECT_ID } : { projectId: 'demo-ijime' },
    );

  let directory = overrides.directory;
  if (!directory) {
    if (env.NODE_ENV === 'production') {
      const { KeyManagementServiceClient } = await import('@google-cloud/kms');
      const kms = new KeyManagementServiceClient();
      const keyName = kmsKeyPath({
        projectId: env.GCP_PROJECT_ID!,
        location: env.GCP_REGION,
        keyRing: env.KMS_KEY_RING,
        key: 'content',
      });
      directory = new FirestoreChildDirectory(db, new KmsKeyWrapper(kms as never, keyName));
    } else {
      directory = new LocalChildDirectory(db);
    }
  }

  // 1ターンの中でセッションサービスとツールが child を何度も読む：同じリクエストでは1回だけ読む
  directory = new ScopedChildDirectory(directory);
  const sessions =
    overrides.sessions ?? new FirestoreSessionService(db, directory, { writeUserEvents: false });
  const filter =
    overrides.filter ??
    new OutputFilter(await kb.yaml('rules/output_filter.yaml', outputFilterSchema));
  const safeReplies =
    overrides.safeReplies ??
    (await kb.yaml('prompts/safe_replies.yaml', safeRepliesSchema)).replies;

  let model = overrides.model;
  if (!model) {
    if (modelMode() === 'vertex') {
      if (!env.GCP_PROJECT_ID) throw new Error('PET_MODEL_MODE=vertex requires GCP_PROJECT_ID');
      model = createGemini('petChat', { projectId: env.GCP_PROJECT_ID, location: env.GCP_REGION });
    } else {
      model = new ScriptedLlm(petDemoScript());
    }
  }

  const searchSkill = await createSkillSearch(kb, process.env, { db, logger });
  const searchMemory = createMemorySearch(process.env, { db, sessions, logger });
  const executorFor =
    overrides.executorFor ??
    ((
      child: ChildRecord,
      sessionId: string,
      _actions: PetAction[],
      onCrisis?: (crisisId: string) => void,
    ): PetToolExecutor =>
      createExecutor({
        db,
        kb,
        sessions,
        child,
        sessionId,
        searchSkill,
        ...(searchMemory ? { searchMemory } : {}),
        logger,
        publish,
        ...(onCrisis ? { onCrisis } : {}),
        ...(modelMode() === 'vertex' ? { detectNames: createModelNameDetector(kb, model) } : {}),
      }));

  const summarize =
    overrides.summarize ??
    (modelMode() === 'vertex' ? createModelSummaryGenerator(kb, model, filter) : undefined);
  const inspectOutput = overrides.inspectOutput ?? createModelArmorInspector(process.env);
  const childPush = overrides.childPush ?? (await createChildPushSender({ db, directory, kb }));
  return {
    kb,
    db,
    directory,
    sessions,
    filter,
    safeReplies,
    model,
    logger,
    publish,
    executorFor,
    ...(summarize ? { summarize } : {}),
    ...(inspectOutput ? { inspectOutput } : {}),
    ...(childPush ? { childPush } : {}),
  };
}

export async function buildAgent(
  rt: PetRuntime,
  child: ChildRecord,
  sessionId: string,
  actions: PetAction[],
  onCrisis?: (crisisId: string) => void,
  operationId?: string,
  text = '',
  proactive = false,
) {
  const gamePreferenceRules = proactive ? undefined : await loadGamePreferenceRules(rt.kb);
  const declined = gamePreferenceRules && gamePreferenceChange(text, gamePreferenceRules);
  // Persist before Runner starts: state deltas on Gemini usage-only tail events can terminate the ADK tool loop.
  if (declined !== undefined)
    await rt.sessions.setGameSuggestionsDeclined(child.childId, sessionId, declined);
  const executor = rt.executorFor(child, sessionId, actions, onCrisis);
  const ctx: TurnContext = {
    childId: child.childId,
    sessionId,
    gradeBand: child.gradeBand,
    characterId: child.characterId,
    ...(operationId ? { operationId } : {}),
  };
  const allTools = createPetTools(
    executor,
    ctx,
    (a) => {
      if (
        a.type === 'offer_tell_adult' &&
        actions.some(
          (existing) =>
            existing.type === 'offer_tell_adult' && existing.consultationId === a.consultationId,
        )
      )
        return;
      actions.push(a);
    },
    (name) => {
      if (name === 'escalate_crisis') throw new Error('crisis_escalation_failed');
      return { error: 'tool_unavailable' };
    },
    { filter: rt.filter, quickReplyCatalog: await loadQuickReplyCatalog(rt.kb) },
  );
  const tools = proactive
    ? allTools.filter((tool) => ['recall', 'suggest_game', 'set_expression'].includes(tool.name))
    : allTools;
  const status = await executor.getChildContext(ctx);
  // Restore only the child's explicit, unfinished "I still need help" flow. No tool execution or writes.
  if (!proactive && status.pendingConsultationId) {
    const saved = await rt.db
      .doc(
        `${childPath(child.familyId, child.childId)}/consultations/${status.pendingConsultationId}`,
      )
      .get();
    const data = saved.data();
    if (
      data?.['source'] === 'child_followup' &&
      data['followUpReason'] === 'need_help' &&
      data['choice'] == null &&
      consultationPending(data, new Date())
    ) {
      const openingLine = (await rt.kb.text(`templates/coaching/${child.gradeBand}.ja.txt`))
        .split('\n')[0]
        ?.trim();
      actions.push({
        type: 'offer_tell_adult',
        consultationId: saved.id,
        source: 'restored_followup',
        ...(openingLine ? { openingLine } : {}),
      });
    }
  }
  const memories = text.trim() ? await executor.recall(ctx, text) : [];
  const instruction = await buildPetInstruction(rt.kb, {
    characterId: child.characterId,
    gradeBand: child.gradeBand,
    petName: child.petName || defaultPetName(child.characterId),
    status,
    memories,
    voice: false,
    restoredHelp: actions.some(
      (a) => a.type === 'offer_tell_adult' && a.source === 'restored_followup',
    ),
  });
  return createPetAgent({
    model: rt.model,
    instruction,
    tools,
    ...createPetCallbacks({
      filter: rt.filter,
      safeReply: rt.safeReplies[child.gradeBand],
      ...(gamePreferenceRules ? { gamePreferenceRules } : {}),
      ...(rt.inspectOutput ? { inspectOutput: rt.inspectOutput } : {}),
      ...(executor.prepareMemory
        ? { prepareMemory: (content) => executor.prepareMemory!(ctx, content) }
        : {}),
    }),
  });
}
