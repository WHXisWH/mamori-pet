import type { Firestore } from '@google-cloud/firestore';
import type { Kb } from '@ijime/kb-loader';
import type { Logger, Publisher, TaskQueue } from '@ijime/service-kit';

export type RiskEngineDeps = {
  db: Firestore;
  kb: Kb;
  publisher: Publisher;
  tasks: TaskQueue;
  logger: Logger;
  // L3 の相談が期限までに回答されなかったときに notifier をコールバックする
  notifierUrl: string;
  now: () => Date;
};
