import type { BaseLlm } from '@google/adk';
import type { Firestore } from '@google-cloud/firestore';
import type { ChildDirectory, FirestoreSessionService } from '@ijime/agent-core';
import type { Kb } from '@ijime/kb-loader';
import type { Logger, Publisher } from '@ijime/service-kit';

export type SignalWorkerDeps = {
  db: Firestore;
  kb: Kb;
  sessions: FirestoreSessionService;
  directory: ChildDirectory;
  publisher: Publisher;
  // シグナル抽出（Flash）
  model: string | BaseLlm;
  // 作品特徴と島の語り（Pro）
  artworkModel: string | BaseLlm;
  logger: Logger;
  now: () => Date;
};
