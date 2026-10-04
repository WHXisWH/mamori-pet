import { CONTEXT_CATEGORIES, DOMAINS, GRADE_BANDS, MOOD_WEATHERS } from '@ijime/api-types';
import { z } from 'zod';

// literature_reviewed: 出典を原文で確認し会話指針に対応づけた段階。専門家の署名はまだない。
export const reviewStatusSchema = z.enum([
  'draft_pending_expert_review',
  'literature_reviewed',
  'expert_approved',
]);

export const manifestSchema = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    releasedAt: z.string().datetime(),
    approvedBy: z.array(z.string().trim().min(1)),
    reviewStatus: reviewStatusSchema.optional(),
    files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  })
  .superRefine((manifest, ctx) => {
    if (manifest.reviewStatus === 'draft_pending_expert_review' && manifest.approvedBy.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['approvedBy'],
        message: 'draft content cannot claim expert approval',
      });
    }
    if (manifest.reviewStatus === 'literature_reviewed' && manifest.approvedBy.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['approvedBy'],
        message: 'a literature review is not an expert approval',
      });
    }
    if (manifest.reviewStatus === 'expert_approved' && manifest.approvedBy.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['approvedBy'],
        message: 'expert_approved requires an approval record',
      });
    }
  });
export type Manifest = z.infer<typeof manifestSchema>;

export const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9_]*$/;
const sourceId = z.string().regex(SOURCE_ID_PATTERN);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const evidenceStrength = z.enum(['high', 'medium', 'low']);

export const sourceRegistrySchema = z
  .object({
    version: z.string().min(1),
    reviewed_by: z.string().min(1),
    sources: z
      .array(
        z.strictObject({
          id: sourceId,
          title: z.string().min(1),
          publisher: z.string().min(1),
          url: z.string().min(1),
          year: z.number().int().nullable(),
          accessed_on: isoDate.nullable(),
          license: z.string().min(1),
          strength: evidenceStrength,
          verified: z.boolean(),
          notes: z.string(),
        }),
      )
      .min(1),
  })
  .superRefine((registry, ctx) => {
    const seen = new Set<string>();
    registry.sources.forEach((source, index) => {
      if (seen.has(source.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sources', index, 'id'],
          message: `duplicate source id ${source.id}`,
        });
      }
      seen.add(source.id);
    });
  });
export type SourceRegistry = z.infer<typeof sourceRegistrySchema>;
export type SourceEntry = SourceRegistry['sources'][number];

export const lexiconCategorySchema = z.object({
  id: z.string(),
  label_ja: z.string(),
  handling: z.string(),
  explicit: z.boolean().optional(),
  grade_bands: z.array(z.enum(GRADE_BANDS)).optional(),
  notes: z.string().optional(),
  expressions: z.array(z.string().min(1)),
});
export const lexiconSchema = z.object({
  language: z.literal('ja'),
  categories: z.array(lexiconCategorySchema),
});
export type Lexicon = z.infer<typeof lexiconSchema>;

export const gradeExamplesSchema = z.partialRecord(z.enum(GRADE_BANDS), z.array(z.string().min(1)));
export type GradeExamples = z.infer<typeof gradeExamplesSchema>;

const signalEvidenceSchema = z
  .object({
    sources: z.array(sourceId).min(1).optional(),
    source: z.string().min(1).optional(),
    strength: evidenceStrength,
  })
  .superRefine((evidence, ctx) => {
    if (!evidence.sources && !evidence.source) {
      ctx.addIssue({
        code: 'custom',
        path: ['sources'],
        message: 'evidence.sources must list at least one registry id',
      });
    }
  });

export const signalDefinitionSchema = z
  .object({
    signal_id: z.string().regex(/^[A-Z]-[A-Z]+-\d{3}$/),
    domain: z.enum(DOMAINS),
    description: z.string(),
    examples_ja: z.union([z.array(z.string()), gradeExamplesSchema]),
    grade_bands: z.array(z.enum(GRADE_BANDS)),
    explicit: z.boolean(),
    evidence: signalEvidenceSchema,
    reviewed_by: z.string(),
    // model：シグナル抽出 Agent が選ぶ。rule：コードで計算し、モデルには見せない
    method: z.enum(['model', 'rule']).default('model'),
    // score：リスク計算に使う。observe：抽出して保存するだけで、リスクエンジンは読まない
    scoring: z.enum(['score', 'observe']).default('score'),
    // ルールシグナルの元になる指標名。日次特徴はこの名前で集計する
    metric: z
      .string()
      .regex(/^[a-z]_[a-z_]+$/)
      .optional(),
  })
  .transform(({ examples_ja, ...rest }) => {
    const grouped = Array.isArray(examples_ja) ? undefined : examples_ja;
    const flat = grouped
      ? [...new Set(GRADE_BANDS.flatMap((band) => grouped[band] ?? []))]
      : (examples_ja as string[]);
    return {
      ...rest,
      examples_ja: flat,
      ...(grouped ? { examples_by_grade: grouped } : {}),
    } as typeof rest & { examples_ja: string[]; examples_by_grade?: GradeExamples };
  });
export type SignalDefinition = z.infer<typeof signalDefinitionSchema>;

const levelRuleSchema = z.object({
  min_domains: z.number().int().positive().optional(),
  min_days: z.number().int().positive().optional(),
  or_explicit_in: z.array(z.enum(DOMAINS)).optional(),
  crisis_detector: z.boolean().optional(),
});
const weight = z.number().min(0).max(1);

// 日次ジョブのレベル判定パラメーター
const dailyRulesSchema = z.object({
  baseline: z.object({
    window_days: z.number().int().positive(),
    min_points: z.number().int().positive(),
  }),
  deviation: z.object({ iqr_k: z.number().positive() }),
  persistence: z.object({
    lookback_days: z.number().int().positive(),
    break_after_missing_days: z.number().int().positive(),
  }),
  context_weights: z.partialRecord(
    z.enum(CONTEXT_CATEGORIES),
    z.partialRecord(z.enum(DOMAINS), weight),
  ),
  rest_day_contexts: z.array(z.enum(CONTEXT_CATEGORIES)),
  school_avoidance: z.object({
    feature: z.string(),
    window_days: z.number().int().positive(),
    min_days: z.number().int().positive(),
  }),
  hold_l3_until_consultation_resolved: z.boolean(),
  anomaly_prob_threshold: z.number().gt(0).lt(1),
});

export const riskRulesSchema = z.object({
  cold_start_days: z.number().int().positive(),
  low_weight_domains: z.array(z.enum(DOMAINS)),
  levels: z.object({
    l1: levelRuleSchema,
    l2: levelRuleSchema,
    l3: levelRuleSchema,
    l4: levelRuleSchema,
  }),
  daily: dailyRulesSchema,
});
export type RiskRules = z.infer<typeof riskRulesSchema>;

export const featureDefinitionSchema = z
  .object({
    name: z.string().regex(/^[a-z]_[a-z_]+$/),
    domain: z.enum(DOMAINS),
    // metric：ルールシグナルの元になる指標。model_domain：その領域でモデルが選んだシグナルの強さ
    source: z.union([
      z.strictObject({ metric: z.string() }),
      z.strictObject({ model_domain: z.enum(DOMAINS) }),
    ]),
    agg: z.enum(['mean', 'sum', 'count', 'max']),
    filter: z.object({ outside: z.tuple([z.number(), z.number()]) }).optional(),
    worse: z.enum(['up', 'down']),
    min_spread: z.number().nonnegative(),
  })
  .refine((f) => f.name.startsWith(`${f.domain}_`), { message: 'name must start with domain' });
export type FeatureDefinition = z.infer<typeof featureDefinitionSchema>;

export const featuresSchema = z.object({ features: z.array(featureDefinitionSchema).min(1) });

export const contextKeywordsSchema = z.object({
  categories: z.array(
    z.object({
      category: z.enum(CONTEXT_CATEGORIES),
      keywords: z.array(z.string().min(1)).min(1),
    }),
  ),
});
export type ContextKeywords = z.infer<typeof contextKeywordsSchema>;

export const holidaysSchema = z.object({
  source: z.string(),
  source_ids: z.array(sourceId).optional(),
  holidays: z.array(
    z.object({ date: isoDate, name: z.string(), estimated: z.boolean().optional() }),
  ),
});
export type Holidays = z.infer<typeof holidaysSchema>;

const dateSpan = z.object({ name: z.string().min(1), start: isoDate, end: isoDate });
export const schoolCalendarsSchema = z
  .object({
    version: z.string().min(1),
    reviewed_by: z.string().min(1),
    calendars: z
      .array(
        z.strictObject({
          id: sourceId,
          prefecture: z.string().min(1),
          city: z.string().min(1).nullable(),
          school_level: z.enum(['elementary', 'junior_high', 'both']),
          year: z.number().int().min(2020),
          terms: z.array(dateSpan).min(1),
          long_breaks: z.array(dateSpan).min(1),
          source_ids: z.array(sourceId),
          verified: z.boolean(),
          verified_at: isoDate.nullable(),
          verified_by: z.string().min(1),
          notes: z.string(),
        }),
      )
      .min(1),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.calendars.forEach((calendar, index) => {
      if (seen.has(calendar.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['calendars', index, 'id'],
          message: `duplicate calendar id ${calendar.id}`,
        });
      }
      seen.add(calendar.id);
      for (const [key, spans] of [
        ['terms', calendar.terms],
        ['long_breaks', calendar.long_breaks],
      ] as const) {
        spans.forEach((span, spanIndex) => {
          if (span.start > span.end) {
            ctx.addIssue({
              code: 'custom',
              path: ['calendars', index, key, spanIndex],
              message: `${span.name} ends before it starts`,
            });
          }
        });
      }
    });
  });
export type SchoolCalendars = z.infer<typeof schoolCalendarsSchema>;

export const bannedWordsSchema = z.object({
  banned: z.array(z.string().min(1)),
});

const hotlineSchema = z.object({
  id: z.string(),
  name: z.string(),
  phone: z.string().optional(),
  url: z.string().url().optional(),
  hours: z.string().optional(),
  audience: z.string(),
  official_url: z.string().url(),
  verified_at: isoDate.nullable(),
  verified_by: z.string().min(1),
  notes: z.string().optional(),
});
export const hotlinesSchema = z
  .object({
    version: z.string(),
    resources: z.array(hotlineSchema),
    candidates: z.array(hotlineSchema).default([]),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    for (const [key, list] of [
      ['resources', file.resources],
      ['candidates', file.candidates],
    ] as const) {
      list.forEach((hotline, index) => {
        if (seen.has(hotline.id)) {
          ctx.addIssue({
            code: 'custom',
            path: [key, index, 'id'],
            message: `duplicate hotline id ${hotline.id}`,
          });
        }
        seen.add(hotline.id);
      });
    }
  });
export type Hotlines = z.infer<typeof hotlinesSchema>;
export type Hotline = Hotlines['resources'][number];

export const weeklyReportSentencesSchema = z.object({
  sentences: z.array(
    z.object({
      condition: z.enum(['low_activity', 'low_mood_days', 'late_night_days', 'stable_days']),
      text_ja: z.string(),
    }),
  ),
});

export const outputFilterSchema = z.object({
  rules: z.array(
    z.object({
      id: z.string(),
      label_ja: z.string(),
      patterns: z.array(z.string().min(1)).min(1),
    }),
  ),
});
export type OutputFilterRules = z.infer<typeof outputFilterSchema>;

const perGrade = z.object({ low: z.string(), high: z.string(), jhs: z.string() });
export const openingsSchema = z.object({
  openings: z.object({
    low: z.array(z.string()).min(1),
    high: z.array(z.string()).min(1),
    jhs: z.array(z.string()).min(1),
  }),
});
export const safeRepliesSchema = z.object({ replies: perGrade });

export const childRepliesSchema = z.object({
  mood: z.record(z.enum(MOOD_WEATHERS), perGrade),
  home: z.object({ at_home: perGrade, not_home: perGrade }),
  artwork: z.object({ self_portrait: perGrade, story: perGrade }),
  island: perGrade,
});
export type ChildReplies = z.infer<typeof childRepliesSchema>;

export const moodScoresSchema = z.object({
  scores: z.record(z.enum(MOOD_WEATHERS), z.number().int().min(0)),
});
export type MoodScores = z.infer<typeof moodScoresSchema>['scores'];

const unit = z.number().min(0).max(1);
export const islandGeometrySchema = z.object({
  figure_categories: z.array(z.string()).min(1),
  isolated_min_dist: unit,
  isolated_min_other_figures: z.number().int().min(1).optional(),
  neighbor_radius: unit,
  enclosed_min_neighbors: z.number().int().min(2),
});
export type IslandGeometryRules = z.infer<typeof islandGeometrySchema>;
