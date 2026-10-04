import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const tf = join(here, '../../../terraform');

type KeyAccess = Record<string, Record<string, string[]>>;
const keyAccess = JSON.parse(readFileSync(join(tf, 'policy/key_access.json'), 'utf8')) as KeyAccess;

const SERVICES = [
  'api',
  'voice-relay',
  'pet-agent',
  'signal-worker',
  'risk-engine',
  'notifier',
  'calendar-sync',
];

function grantees(key: string): string[] {
  return Object.values(keyAccess[key] ?? {}).flat();
}

describe('KMS key access matrix (infra/terraform/policy/key_access.json)', () => {
  it('risk-engine and notifier never get the content key', () => {
    const content = grantees('content');
    expect(content).not.toContain('risk-engine');
    expect(content).not.toContain('notifier');
    expect(content).not.toContain('calendar-sync');
  });

  it('only known service accounts appear', () => {
    for (const key of Object.keys(keyAccess)) {
      for (const sa of grantees(key)) expect(SERVICES, `${key} → ${sa}`).toContain(sa);
    }
  });

  it('the storage CMEK key is never granted to application service accounts', () => {
    expect(keyAccess['storage']).toBeUndefined();
  });

  it('calendar-sync only touches the tokens key', () => {
    for (const key of Object.keys(keyAccess)) {
      if (key === 'tokens') continue;
      expect(grantees(key), key).not.toContain('calendar-sync');
    }
    expect(grantees('tokens')).toContain('calendar-sync');
  });

  it('api may wrap a new child key with the content key through the encrypt-only role', () => {
    expect(keyAccess['content']?.['roles/cloudkms.cryptoKeyEncrypter']).toEqual(['api']);
  });

  it('pet-agent can encrypt and decrypt content; api holds the separate decrypt role', () => {
    expect(keyAccess['content']?.['roles/cloudkms.cryptoKeyEncrypterDecrypter']).toContain(
      'pet-agent',
    );
    expect(keyAccess['content']?.['roles/cloudkms.cryptoKeyDecrypter']).toContain('api');
    expect(keyAccess['content']?.['roles/cloudkms.cryptoKeyEncrypterDecrypter']).not.toContain(
      'api',
    );
  });
});

describe('Terraform sources', () => {
  const read = (f: string) => readFileSync(join(tf, f), 'utf8');

  it('pins every resource to asia-northeast1 through var.region', () => {
    const vars = read('variables.tf');
    expect(vars).toContain('var.region == "asia-northeast1"');
    for (const f of [
      'kms.tf',
      'firestore.tf',
      'bigquery.tf',
      'storage.tf',
      'pubsub.tf',
      'cloud_run.tf',
      'tasks.tf',
    ]) {
      expect(read(f), f).not.toMatch(/us-central1|europe-|asia-east|asia-south|northamerica/);
    }
  });

  it('firestore rules deny all client access', () => {
    const rules = read('firestore.rules');
    expect(rules).toContain('allow read, write: if false;');
    expect(rules).not.toMatch(/if (true|request\.)/);
  });

  it('ADK content capture is disabled in every Cloud Run env', () => {
    expect(read('locals.tf')).toContain('ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS = "false"');
  });
});
