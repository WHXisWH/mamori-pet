import type { Firestore } from '@google-cloud/firestore';
import type { TokenVault } from '@ijime/crypto';
import type { Kb } from '@ijime/kb-loader';
import type { CalendarApi, Logger } from '@ijime/service-kit';

export type CalendarSyncDeps = {
  db: Firestore;
  kb: Kb;
  calendar: CalendarApi;
  vault: TokenVault;
  logger: Logger;
  now: () => Date;
};
