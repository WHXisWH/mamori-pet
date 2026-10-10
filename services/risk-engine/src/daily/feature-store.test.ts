import { Writable } from 'node:stream';

import type { BigQuery } from '@google-cloud/bigquery';
import { batch } from '@ijime/config';
import { describe, expect, it } from 'vitest';

import { BigQueryFeatureStore, MemoryFeatureStore, retryBigQuery } from './feature-store.js';

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

  it('a shard deletes only its own rows, then appends', async () => {
    const { bq, calls } = fakeBigQuery();
    const row = {
      pseudo_id: 'p1',
      date: '2026-11-20',
      level: 'l1',
      domains_flagged: [],
      rules_version: '0.1.0',
    };
    await new BigQueryFeatureStore(bq, OPTS).replaceRows(
      'risk_levels_daily',
      '2026-11-20',
      ['p1', 'p2'],
      [row],
    );
    expect(calls[0]).toMatchObject({
      kind: 'query',
      args: {
        params: { d: '2026-11-20', ids: ['p1', 'p2'] },
        types: { d: 'DATE', ids: ['STRING'] },
      },
    });
    expect((calls[0]!.args as { query: string }).query).toMatch(
      /WHERE date = @d AND pseudo_id IN UNNEST\(@ids\)/,
    );
    expect(calls[1]).toMatchObject({
      kind: 'load',
      args: {
        table: 'features_deid.risk_levels_daily$20261120',
        opts: { writeDisposition: 'WRITE_APPEND' },
      },
    });
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

describe('MemoryFeatureStore.replaceRows', () => {
  it('keeps rows written by other shards', async () => {
    const store = new MemoryFeatureStore();
    const row = (pseudo_id: string, level: string) => ({
      pseudo_id,
      date: '2026-11-20',
      level,
      domains_flagged: [],
      rules_version: '0.1.0',
    });
    await store.replaceRows('risk_levels_daily', '2026-11-20', ['a'], [row('a', 'l0')]);
    await store.replaceRows('risk_levels_daily', '2026-11-20', ['b'], [row('b', 'l1')]);
    await store.replaceRows('risk_levels_daily', '2026-11-20', ['a'], [row('a', 'l2')]);
    expect(store.rows('risk_levels_daily', '2026-11-20')).toEqual([row('b', 'l1'), row('a', 'l2')]);
  });
});

describe('retryBigQuery', () => {
  const conflict = () => new Error('Could not serialize access to table due to concurrent update');

  it('backs off on concurrent-update conflicts and succeeds', async () => {
    const waits: number[] = [];
    let n = 0;
    const out = await retryBigQuery(
      async () => {
        if (++n < 3) throw conflict();
        return 'ok';
      },
      async (ms) => void waits.push(ms),
      () => 0,
    );
    expect(out).toBe('ok');
    expect(waits).toEqual([batch.bigQueryRetryBaseMs, batch.bigQueryRetryBaseMs * 2]);
  });

  it('does not retry other errors and gives up after the attempt limit', async () => {
    let n = 0;
    await expect(
      retryBigQuery(
        async () => {
          n++;
          throw new Error('Syntax error');
        },
        async () => undefined,
      ),
    ).rejects.toThrow('Syntax error');
    expect(n).toBe(1);

    n = 0;
    await expect(
      retryBigQuery(
        async () => {
          n++;
          throw conflict();
        },
        async () => undefined,
      ),
    ).rejects.toThrow('concurrent update');
    expect(n).toBe(batch.bigQueryWriteAttempts);
  });
});
