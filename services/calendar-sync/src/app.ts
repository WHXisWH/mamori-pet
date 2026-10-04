import { createServiceApp, type ServiceApp } from '@ijime/service-kit';

export const SERVICE_NAME = 'calendar-sync';

export function createApp(): ServiceApp {
  return createServiceApp({
    name: SERVICE_NAME,
    version: process.env['SERVICE_VERSION'] ?? '0.1.0',
  });
}
