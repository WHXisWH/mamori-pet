import type { Schema, Type } from '@google/genai';

// kb/schemas/*.json で使う JSON Schema のサブセット
export type JsonSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  nullable?: boolean;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: readonly (string | number)[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
};

// Gemini の responseSchema に変換する（@google/genai の Type は大文字）
export function toGenaiSchema(schema: JsonSchema): Schema {
  const out: Schema = {};
  if (schema.type) out.type = schema.type.toUpperCase() as Type;
  if (schema.nullable) out.nullable = true;
  if (schema.enum) {
    out.enum = schema.enum.map(String);
    if (!schema.type) out.type = 'STRING' as Type;
  }
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, toGenaiSchema(v)]),
    );
  }
  if (schema.required) out.required = [...schema.required];
  if (schema.items) out.items = toGenaiSchema(schema.items);
  if (schema.minimum !== undefined) out.minimum = schema.minimum;
  if (schema.maximum !== undefined) out.maximum = schema.maximum;
  if (schema.maxLength !== undefined) out.maxLength = String(schema.maxLength);
  if (schema.minItems !== undefined) out.minItems = String(schema.minItems);
  if (schema.maxItems !== undefined) out.maxItems = String(schema.maxItems);
  return out;
}

export type SchemaCheck<T = unknown> = { ok: true; value: T } | { ok: false; path: string };

// 検証し、宣言済みのフィールドだけを含むコピーを返す。余分なフィールドは捨て、下流に流さない
export function checkSchema<T = unknown>(
  schema: JsonSchema,
  value: unknown,
  path = '$',
): SchemaCheck<T> {
  const fail = (p: string): SchemaCheck<T> => ({ ok: false, path: p });
  if (value === null) return schema.nullable ? { ok: true, value: null as T } : fail(path);
  if (schema.enum && !schema.enum.includes(value as string | number)) return fail(path);
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') return fail(path);
      if (schema.maxLength !== undefined && [...value].length > schema.maxLength) return fail(path);
      return { ok: true, value: value as T };
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail(path);
      if (schema.type === 'integer' && !Number.isInteger(value)) return fail(path);
      if (schema.minimum !== undefined && value < schema.minimum) return fail(path);
      if (schema.maximum !== undefined && value > schema.maximum) return fail(path);
      return { ok: true, value: value as T };
    }
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value: value as T } : fail(path);
    case 'array': {
      if (!Array.isArray(value)) return fail(path);
      if (schema.minItems !== undefined && value.length < schema.minItems) return fail(path);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return fail(path);
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const r = schema.items
          ? checkSchema(schema.items, value[i], `${path}[${i}]`)
          : { ok: true as const, value: value[i] };
        if (!r.ok) return fail(r.path);
        out.push(r.value);
      }
      return { ok: true, value: out as T };
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return fail(path);
      const obj = value as Record<string, unknown>;
      for (const k of schema.required ?? []) if (!(k in obj)) return fail(`${path}.${k}`);
      const out: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(schema.properties ?? {})) {
        if (!(k in obj)) continue;
        const r = checkSchema(sub, obj[k], `${path}.${k}`);
        if (!r.ok) return fail(r.path);
        out[k] = r.value;
      }
      return { ok: true, value: out as T };
    }
    default:
      return { ok: true, value: value as T };
  }
}
