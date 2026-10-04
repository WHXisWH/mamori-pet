import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// 全モジュール共通の安全性テスト
const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function deps(pkgDir: string): string[] {
  const pkg = JSON.parse(readFileSync(join(root, pkgDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(pkg.dependencies ?? {});
}

const allSources = ['services', 'packages'].flatMap((top) =>
  readdirSync(join(root, top))
    .map((name) => join(root, top, name, 'src'))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .flatMap(sourceFiles),
);
const rel = (p: string) => relative(root, p);

describe('dependency boundaries', () => {
  it('notifier and risk-engine never depend on the crypto package', () => {
    for (const svc of ['services/notifier', 'services/risk-engine']) {
      expect(deps(svc), svc).not.toContain('@ijime/crypto');
      for (const f of sourceFiles(join(root, svc, 'src')))
        expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/@ijime\/crypto/);
    }
  });

  it('voice-relay never writes to disk', () => {
    const write =
      /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|writeSync)\b/;
    for (const f of sourceFiles(join(root, 'services/voice-relay/src')))
      expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(write);
  });
});

describe('risk level is written only by risk-engine', () => {
  // 子どもの登録時に初期値 l0 を書き込む箇所
  const INITIAL_VALUE_SITES = new Set(['packages/agent-core/src/child-directory.ts']);

  it('no other code sets currentRiskLevel', () => {
    for (const f of allSources) {
      const r = rel(f);
      if (r.startsWith('services/risk-engine/')) continue;
      const src = readFileSync(f, 'utf8');
      const sets = [...src.matchAll(/currentRiskLevel['"]?\s*:\s*([^,\n}]+)/g)];
      if (INITIAL_VALUE_SITES.has(r)) {
        for (const m of sets) expect(m[1]!.trim(), r).toBe("'l0'");
      } else {
        expect(
          sets.map((m) => m[0]),
          r,
        ).toEqual([]);
      }
    }
  });

  it('no other code writes riskAssessments', () => {
    const write = /riskAssessments[\s\S]{0,200}?\.(set|add|create|update)\(/;
    for (const f of allSources) {
      const r = rel(f);
      if (r.startsWith('services/risk-engine/')) continue;
      expect(readFileSync(f, 'utf8'), r).not.toMatch(write);
    }
  });
});
