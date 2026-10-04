import { resolve } from 'node:path';

import { Firestore } from '@google-cloud/firestore';
import type { BaseLlm } from '@google/adk';
import type { GradeBand, PetAction } from '@ijime/api-types';
import {
  buildPetInstruction,
  createGemini,
  createPetAgent,
  createPetTools,
  defaultPetName,
  LocalChildDirectory,
  disableAdkContentCapture,
  FirestoreChildDirectory,
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
import { FsKbSource, Kb, outputFilterSchema, safeRepliesSchema } from '@ijime/kb-loader';
import { Logger, PubSubRestPublisher, type Publisher } from '@ijime/service-kit';

import { createExecutor } from './executor.js';
import { createSkillSearch } from './skills.js';

export type PetRuntime = {
  kb: Kb;
  db: Firestore;
  directory: ChildDirectory;
  sessions: FirestoreSessionService;
  filter: OutputFilter;
  safeReplies: Record<GradeBand, string>;
  model: BaseLlm;
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
        logger,
        publish,
        ...(onCrisis ? { onCrisis } : {}),
      }));

  return { kb, db, directory, sessions, filter, safeReplies, model, logger, publish, executorFor };
}

export async function buildAgent(
  rt: PetRuntime,
  child: ChildRecord,
  sessionId: string,
  actions: PetAction[],
  onCrisis?: (crisisId: string) => void,
  operationId?: string,
  text = '',
) {
  const executor = rt.executorFor(child, sessionId, actions, onCrisis);
  const ctx: TurnContext = {
    childId: child.childId,
    sessionId,
    gradeBand: child.gradeBand,
    characterId: child.characterId,
    ...(operationId ? { operationId } : {}),
  };
  const tools = createPetTools(
    executor,
    ctx,
    (a) => actions.push(a),
    (name) => {
      if (name === 'escalate_crisis') throw new Error('crisis_escalation_failed');
      return { error: 'tool_unavailable' };
    },
    { filter: rt.filter },
  );
  const status = await executor.getChildContext(ctx);
  const memories = text.trim() ? await executor.recall(ctx, text) : [];
  const instruction = await buildPetInstruction(rt.kb, {
    characterId: child.characterId,
    gradeBand: child.gradeBand,
    petName: child.petName || defaultPetName(child.characterId),
    status,
    memories,
    voice: false,
  });
  return createPetAgent({ model: rt.model, instruction, tools });
}
