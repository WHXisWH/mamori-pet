import { z } from 'zod';

import { REGION } from './values.js';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  GCP_PROJECT_ID: z.string().min(1).optional(),
  GCP_REGION: z.string().default(REGION),
  KMS_KEY_RING: z.string().default('ijime'),
  KB_BUCKET: z.string().optional(),
  KB_LOCAL_DIR: z.string().optional(),
  FIRESTORE_EMULATOR_HOST: z.string().optional(),
  PUBSUB_EMULATOR_HOST: z.string().optional(),
  SERVICE_NAME: z.string().default('unknown'),
});

export type Env = z.infer<typeof envSchema>;

export function isLocalManualPreview(source: NodeJS.ProcessEnv = process.env): boolean {
  if (
    source['LOCAL_MANUAL_PREVIEW'] !== '1' ||
    !['test', 'development'].includes(source['NODE_ENV'] ?? '')
  )
    return false;
  const match = /^(?:127\.0\.0\.1|localhost):(\d{1,5})$/.exec(
    source['FIRESTORE_EMULATOR_HOST'] ?? '',
  );
  return match !== null && Number(match[1]) > 0 && Number(match[1]) <= 65535;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.GCP_REGION !== REGION) {
    throw new Error(`GCP_REGION must be ${REGION} in production`);
  }
  return parsed.data;
}
