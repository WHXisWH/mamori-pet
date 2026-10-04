import { Writable } from 'node:stream';

import type { BigQuery } from '@google-cloud/bigquery';
import { describe, expect, it } from 'vitest';

import { BigQueryFeatureStore } from './feature-store.js';

type Call = { kind: string; args: unknown };

function fakeBigQuery() {
  const calls: Call[] = [];
  const bq = {
    query: async (args: unknown) => {
      calls.push({ kind: 'query', args });
      return [[]];
    },
    createQueryJob: async (args: unknown) => {
      calls.push({ kind: 'queryJob', args });
      return [{ getQueryResults: async () => [[]] }];
    },
    dataset: (ds: string) => ({
      table: (t: string) => ({
        id: `${ds}.${t}`,
        createWriteStream: (opts: unknown) => {
          let body = '';
          const s = new Writable({
            write(chunk, _enc, cb) {
              body += String(chunk);
              cb();
            },
            final(cb) {
              calls.push({ kind: 'load', args: { table: `${ds}.${t}`, opts, body } });
              cb();
              setImmediate(() => s.emit('complete'));
            },
          });
          return s;
        },
      }),
    }),
  };
  return { bq: bq as unknown as BigQuery, calls };
}

const OPTS = { projectId: 'proj', dataset: 'features_deid', location: 'asia-northeast1' };

describe('BigQueryFeatureStore', () => {
  it('overwrites the day partition with a load job', async () => {
    const { bq, calls } = fakeBigQuery();
    const store = new BigQueryFeatureStore(bq, OPTS);
    await store.writePartition('risk_levels_daily', '2026-11-20', [
      {
        pseudo_id: 'p1',
        date: '2026-11-20',
        level: 'l1',
        domains_flagged: ['a'],
        rules_version: '0.1.0',
      },
    ]);
    expect(calls).toEqual([
      {
        kind: 'load',
        args: {
          table: 'features_deid.risk_levels_daily$20261120',
          opts: {
            sourceFormat: 'NEWLINE_DELIMITED_JSON',
            writeDisposition: 'WRITE_TRUNCATE',
            location: 'asia-northeast1',
          },
          body: '{"pseudo_id":"p1","date":"2026-11-20","level":"l1","domains_flagged":["a"],"rules_version":"0.1.0"}',
        },
      },
    ]);
  });

  it('clears the partition when there are no rows', async () => {
    const { bq, calls } = fakeBigQuery();
    await new BigQueryFeatureStore(bq, OPTS).writePartition('baselines', '2026-11-20', []);
    expect(calls[0]).toMatchObject({
      kind: 'query',
      args: {
        query: 'DELETE FROM `proj.features_deid.baselines` WHERE DATE(computed_at) = @d',
        params: { d: '2026-11-20' },
        location: 'asia-northeast1',
      },
    });
  });

  it('reads history with parameters, never string-built ids', async () => {
    const { bq, calls } = fakeBigQuery();
    await new BigQueryFeatureStore(bq, OPTS).readDailyFeatures(
      ["p1' OR 1=1 --"],
      '2026-10-01',
      '2026-11-20',
    );
    const args = calls[0]!.args as { query: string; params: { ids: string[] } };
    expect(args.query).not.toContain('p1');
    expect(args.params.ids).toEqual(["p1' OR 1=1 --"]);
  });

  it('retrains weekly and writes anomalies into the day partition', async () => {
    const { bq, calls } = fakeBigQuery();
    await new BigQueryFeatureStore(bq, OPTS).refreshAnomalies('2026-11-22', {
      retrain: true,
      threshold: 0.95,
      modelVersion: 'arima_plus@0.1.0',
    });
    expect((calls[0]!.args as { query: string }).query).toContain("model_type = 'ARIMA_PLUS'");
    const job = calls[1]!.args as {
      query: string;
      writeDisposition: string;
      destination: { id: string };
    };
    expect(job.query).toContain('ML.DETECT_ANOMALIES');
    expect(job.writeDisposition).toBe('WRITE_TRUNCATE');
    expect(job.destination.id).toBe('features_deid.anomalies$20261122');
  });
});
