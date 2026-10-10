import { describe, expect, it, vi } from 'vitest';
import type { GoogleHttp } from '@ijime/service-kit';

import { createModelArmorInspector } from './model-armor.js';

const env = {
  GCP_PROJECT_ID: 'demo-armor',
  MODEL_ARMOR_TEMPLATE: 'projects/demo-armor/locations/asia-northeast1/templates/output',
};
const settings = {
  templateMetadata: { dataResidencyCompliant: true, logSanitizeOperations: false },
  filterConfig: { raiSettings: { raiFilters: [{ filterType: 'DANGEROUS' }] } },
};
const result = (match = 'NO_MATCH_FOUND', invocation = 'SUCCESS') => ({
  sanitizationResult: { filterMatchState: match, invocationResult: invocation },
});

describe('optional Model Armor output inspection', () => {
  it('is disabled without config and rejects foreign project/region/invalid names', () => {
    expect(createModelArmorInspector({})).toBeUndefined();
    for (const name of [
      env.MODEL_ARMOR_TEMPLATE.replace('demo-armor', 'foreign'),
      env.MODEL_ARMOR_TEMPLATE.replace('asia-northeast1', 'us-central1'),
      `${env.MODEL_ARMOR_TEMPLATE}?key=bad`,
    ])
      expect(() => createModelArmorInspector({ ...env, MODEL_ARMOR_TEMPLATE: name })).toThrow();
  });

  it('checks residency before sending text and uses only the regional endpoint', async () => {
    const request = vi.fn().mockResolvedValueOnce(settings).mockResolvedValue(result());
    const inspect = createModelArmorInspector(env, { request } as GoogleHttp)!;
    expect(await inspect('synthetic output')).toBe(true);
    expect(await inspect('second output')).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0]![0]).not.toHaveProperty('body');
    expect(request.mock.calls[1]![0]).toMatchObject({
      url: `https://modelarmor.asia-northeast1.rep.googleapis.com/v1/${env.MODEL_ARMOR_TEMPLATE}:sanitizeModelResponse`,
      method: 'POST',
      body: { modelResponseData: { text: 'synthetic output' } },
      retry: false,
    });
  });

  it.each([result('MATCH_FOUND'), result('NO_MATCH_FOUND', 'PARTIAL'), {}, result('UNKNOWN')])(
    'fails closed for matched, partial and malformed results',
    async (value) => {
      const request = vi.fn().mockResolvedValueOnce(settings).mockResolvedValue(value);
      expect(await createModelArmorInspector(env, { request } as GoogleHttp)!('synthetic')).toBe(
        false,
      );
    },
  );

  it.each([
    {},
    { ...settings, filterConfig: { raiSettings: {} } },
    {
      ...settings,
      filterConfig: { piAndJailbreakFilterSettings: { filterEnforcement: 'DISABLED' } },
    },
    { ...settings, templateMetadata: { dataResidencyCompliant: false } },
    {
      ...settings,
      templateMetadata: { dataResidencyCompliant: true, logSanitizeOperations: true },
    },
  ])('does not send content to an unverified template', async (value) => {
    const request = vi.fn().mockResolvedValue(value);
    expect(await createModelArmorInspector(env, { request } as GoogleHttp)!('synthetic')).toBe(
      false,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('aborts hung requests without leaking an error body', async () => {
    vi.useFakeTimers();
    try {
      const request = vi.fn().mockImplementation(() => new Promise(() => {}));
      const pending = createModelArmorInspector(env, { request } as GoogleHttp)!('synthetic');
      await vi.runAllTimersAsync();
      expect(await pending).toBe(false);
      expect(request.mock.calls[0]![0].signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
