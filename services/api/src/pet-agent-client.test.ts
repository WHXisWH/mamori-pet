import { afterEach, expect, it, vi } from 'vitest';

import { HttpPetAgentClient } from './pet-agent-client.js';

afterEach(() => vi.unstubAllGlobals());

async function captureHeaders(client: HttpPetAgentClient) {
  let headers: Record<string, string> | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response('{"type":"done"}\n', { status: 200 });
    }),
  );
  for await (const chunk of client.turn({} as never)) expect(chunk).toEqual({ type: 'done' });
  return headers;
}

it('sends the caller identity token to pet-agent when one is provided', async () => {
  const headers = await captureHeaders(
    new HttpPetAgentClient('https://pet-agent.example', async () => 'id-token'),
  );
  expect(headers?.['Authorization']).toBe('Bearer id-token');
});

it('sends no Authorization header without a token provider', async () => {
  const headers = await captureHeaders(new HttpPetAgentClient('http://localhost:8082'));
  expect(headers?.['Authorization']).toBeUndefined();
});

it('fails the turn when pet-agent rejects the call', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 403 })),
  );
  const client = new HttpPetAgentClient('https://pet-agent.example', async () => 'id-token');
  await expect(async () => {
    for await (const chunk of client.turn({} as never)) void chunk;
  }).rejects.toThrow('pet-agent 403');
});
