import { agent, REGION } from '@ijime/config';
import { AdcGoogleHttp, type GoogleHttp } from '@ijime/service-kit';
import { z } from 'zod';

const resultSchema = z.object({
  sanitizationResult: z.object({
    invocationResult: z.literal('SUCCESS'),
    filterMatchState: z.enum(['NO_MATCH_FOUND', 'MATCH_FOUND']),
  }),
});

const filtersSchema = z.object({
  raiSettings: z.object({ raiFilters: z.array(z.object({ filterType: z.string() })) }).optional(),
  sdpSettings: z
    .object({
      basicConfig: z.object({ filterEnforcement: z.string() }).optional(),
      advancedConfig: z.object({ inspectTemplate: z.string().optional() }).optional(),
    })
    .optional(),
  piAndJailbreakFilterSettings: z.object({ filterEnforcement: z.string() }).optional(),
});

function hasEnabledFilter(value: unknown): boolean {
  const parsed = filtersSchema.safeParse(value);
  if (!parsed.success) return false;
  const filters = parsed.data;
  return !!(
    filters.raiSettings?.raiFilters.some((filter) =>
      ['HATE_SPEECH', 'HARASSMENT', 'DANGEROUS', 'SEXUALLY_EXPLICIT'].includes(filter.filterType),
    ) ||
    filters.sdpSettings?.basicConfig?.filterEnforcement === 'ENABLED' ||
    filters.sdpSettings?.advancedConfig?.inspectTemplate ||
    filters.piAndJailbreakFilterSettings?.filterEnforcement === 'ENABLED'
  );
}

export type OutputInspector = (text: string) => Promise<boolean>;

/** Optional extra check, never a replacement for the Japanese crisis detector and rules. */
export function createModelArmorInspector(
  env: NodeJS.ProcessEnv,
  injectedHttp?: GoogleHttp,
): OutputInspector | undefined {
  const template = env['MODEL_ARMOR_TEMPLATE'];
  if (!template) return undefined;
  const match = /^projects\/([a-zA-Z0-9-]+)\/locations\/([^/]+)\/templates\/([a-zA-Z0-9_-]+)$/.exec(
    template,
  );
  if (!match || match[1] !== env['GCP_PROJECT_ID'] || match[2] !== REGION)
    throw new Error('model_armor_template_must_use_project_and_tokyo');
  const http = injectedHttp ?? new AdcGoogleHttp();
  const endpoint = `https://modelarmor.${REGION}.rep.googleapis.com/v1/${template}`;
  let verified = false;
  return async (text) => {
    if (!text.trim()) return true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          if (!verified) {
            const settings = await http.request<{
              templateMetadata?: {
                dataResidencyCompliant?: boolean;
                logSanitizeOperations?: boolean;
              };
              filterConfig?: Record<string, unknown>;
            }>({ url: endpoint, method: 'GET', signal: controller.signal, retry: false });
            // Explicit residency enforcement and disabled content logging are required.
            if (
              settings.templateMetadata?.dataResidencyCompliant !== true ||
              settings.templateMetadata.logSanitizeOperations === true ||
              !hasEnabledFilter(settings.filterConfig)
            )
              return false;
            verified = true;
          }
          if (controller.signal.aborted) return false;
          const result = resultSchema.safeParse(
            await http.request({
              url: `${endpoint}:sanitizeModelResponse`,
              method: 'POST',
              body: { modelResponseData: { text } },
              signal: controller.signal,
              timeoutMs: agent.modelArmorTimeoutMs,
              retry: false,
            }),
          );
          return (
            result.success && result.data.sanitizationResult.filterMatchState === 'NO_MATCH_FOUND'
          );
        })(),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve(false);
          }, agent.modelArmorTimeoutMs);
        }),
      ]);
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  };
}
