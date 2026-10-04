import { expect, it } from 'vitest';
import {
  clearGeofence,
  distanceM,
  readGeofence,
  saveGeofence,
  validGeofence,
} from './home-location';

it('stores home position only on the device and isolates children sharing it', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } as unknown as Storage;
  const location = { lat: 35, lng: 139, radiusM: 150 };
  saveGeofence('c1', location, storage);
  expect(readGeofence('c1', storage)).toEqual(location);
  expect(readGeofence('c2', storage)).toBeNull();
  clearGeofence('c1', storage);
  expect(readGeofence('c1', storage)).toBeNull();
});

it.each([
  null,
  {},
  { lat: 100, lng: 10, radiusM: 150 },
  { lat: 30, lng: 190, radiusM: 150 },
  { lat: 30, lng: 140, radiusM: 0 },
  { lat: '30', lng: 140, radiusM: 150 },
])('rejects invalid device coordinates %j', (value) => expect(validGeofence(value)).toBe(false));

it('computes distance locally', () => {
  expect(distanceM({ lat: 35, lng: 139 }, { lat: 35, lng: 139 })).toBe(0);
  expect(distanceM({ lat: 35, lng: 139 }, { lat: 35.001, lng: 139 })).toBeCloseTo(111.19, 1);
});
