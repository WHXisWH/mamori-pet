import { describe, expect, it } from 'vitest';

import { createApp, SERVICE_NAME } from './app.js';

describe('notifier', () => {
  it('answers /healthz', async () => {
    const res = await createApp().request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', service: SERVICE_NAME });
  });
});
