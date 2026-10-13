import type { BaseLlm } from '@google/adk';
import type { Firestore } from '@google-cloud/firestore';
import {
  childPath,
  createExtractorAgent,
  runStructured,
  toGenaiSchema,
  type ChildRecord,
  type FirestoreSessionService,
  type JsonSchema,
} from '@ijime/agent-core';
import { agent } from '@ijime/config';
import type { Kb } from '@ijime/kb-loader';

export type NameDetector = (text: string) => Promise<string[]>;

// Scripted demos only; production uses the structured model detector below.
export function localPeerNames(text: string): string[] {
  return [
    ...text.matchAll(/([\p{Script=Han}\p{Script=Katakana}々ー]{1,12})(?:くん|ちゃん|さん|先生)/gu),
  ].map((match) => match[1]!);
}

export function createModelNameDetector(kb: Kb, model: BaseLlm): NameDetector {
  return async (text) => {
    const schema = JSON.parse(await kb.text('schemas/memory_names.json')) as JsonSchema;
    const extractor = createExtractorAgent({
      name: 'memory_names',
      description: 'Extract literal person names only; no tools or advice',
      model,
      instruction: await kb.text('prompts/memory_names.md'),
      outputSchema: toGenaiSchema(schema),
      temperature: 0,
    });
    const result = await runStructured<{ names: string[] }>(extractor, JSON.stringify({ text }), {
      schema,
      timeoutMs: agent.memoryPrivacyTimeoutMs,
      maxAttempts: 1,
      accept: ({ names }) => names.every((name) => text.includes(name)),
    });
    if (!result.ok) throw new Error('memory_privacy_unavailable');
    return result.value.names;
  };
}

type Mapping = [string, string][];

function savedMapping(
  saved: { exists: boolean; get(field: string): unknown },
  decrypt: (enc: Buffer) => string,
): Mapping {
  const mapping: Mapping = saved.exists
    ? JSON.parse(decrypt(Buffer.from(saved.get('mapEnc') as Uint8Array)))
    : [];
  if (
    !Array.isArray(mapping) ||
    mapping.length > agent.pseudonymMapLimit ||
    mapping.some(
      (entry) =>
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        entry.some((v) => typeof v !== 'string') ||
        !entry[0] ||
        entry[0].length > 40 ||
        !/^おともだち[A-Z]+$/u.test(entry[1]),
    )
  )
    throw new Error('invalid_pseudonym_map');
  return mapping;
}

// Replace longest literal names first without ever interpreting a name as a regex.
function applyMapping(text: string, mapping: Mapping): string {
  let remaining = text;
  let output = '';
  const ordered = [...mapping].sort((a, b) => b[0].length - a[0].length);
  while (remaining) {
    const match = ordered.find(([name]) => remaining.startsWith(name));
    output += match?.[1] ?? remaining[0];
    remaining = remaining.slice(match?.[0].length ?? 1);
  }
  return output;
}

// 読み取りのみ：保存済みの対応表で元の名前を仮名に置き換え、思い出すときの検索語に使う。人名の認識も対応表への書き込みもしない
export function createPseudonymReader(input: {
  db: Firestore;
  child: ChildRecord;
  sessions: FirestoreSessionService;
}): (text: string) => Promise<string> {
  const { db, child, sessions } = input;
  const ref = db.doc(`${childPath(child.familyId, child.childId)}/private/pseudonyms`);
  const aad = `${ref.path}#mapEnc`;
  return async (text) => {
    try {
      const mapping = savedMapping(await ref.get(), (enc) =>
        sessions.decryptForChild(child, enc, aad),
      );
      return applyMapping(text, mapping);
    } catch {
      // 対応表を読めないときは元の語のままローカルで照合する。検索語はこのサービスの外に出さない
      return text;
    }
  };
}

export function createMemorySanitizer(input: {
  db: Firestore;
  child: ChildRecord;
  sessions: FirestoreSessionService;
  detectNames?: NameDetector;
}): (text: string) => Promise<string> {
  const { db, child, sessions } = input;
  const base = childPath(child.familyId, child.childId);
  const ref = db.doc(`${base}/private/pseudonyms`);
  const aad = `${ref.path}#mapEnc`;
  const memo = new Map<string, Promise<string>>();
  const sanitize = async (text: string): Promise<string> => {
    const detected = await (input.detectNames ?? (async (value) => localPeerNames(value)))(text);
    const names = [...new Set(detected)].filter((name) => !/^おともだち[A-Z]+$/u.test(name));
    if (names.some((name) => !name || name.length > 40 || !text.includes(name)))
      throw new Error('invalid_person_names');
    return db.runTransaction(async (tx) => {
      const owner = await tx.get(db.doc(base));
      const saved = await tx.get(ref);
      if (!owner.exists || owner.get('status') !== 'active') throw new Error('child_not_active');
      const mapping = savedMapping(saved, (enc) => sessions.decryptForChild(child, enc, aad));
      let changed = false;
      for (const name of names) {
        if (mapping.some(([original]) => original === name)) continue;
        if (mapping.length >= agent.pseudonymMapLimit) throw new Error('pseudonym_limit');
        let index = mapping.length + 1;
        let label = '';
        while (index > 0) {
          index -= 1;
          label = String.fromCharCode(65 + (index % 26)) + label;
          index = Math.floor(index / 26);
        }
        mapping.push([name, `おともだち${label}`]);
        changed = true;
      }
      if (changed)
        tx.set(ref, {
          mapEnc: sessions.encryptForChild(child, JSON.stringify(mapping), aad),
          updatedAt: new Date(),
        });
      return applyMapping(text, mapping);
    });
  };
  return (text) => {
    const previous = memo.get(text);
    if (previous) return previous;
    const pending = sanitize(text).then((value) => {
      memo.set(value, Promise.resolve(value));
      return value;
    });
    memo.set(text, pending);
    return pending;
  };
}
