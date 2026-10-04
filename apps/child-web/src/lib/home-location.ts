export type Geofence = { lat: number; lng: number; radiusM: number };
const key = (childId: string) => `mamori-home-geofence:${childId}`;

export function validGeofence(value: unknown): value is Geofence {
  if (!value || typeof value !== 'object') return false;
  const data = value as Geofence;
  return (
    Number.isFinite(data.lat) &&
    Math.abs(data.lat) <= 90 &&
    Number.isFinite(data.lng) &&
    Math.abs(data.lng) <= 180 &&
    Number.isFinite(data.radiusM) &&
    data.radiusM > 0 &&
    data.radiusM <= 1000
  );
}

export function readGeofence(childId: string, storage: Storage = localStorage): Geofence | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(key(childId)) ?? 'null');
    return validGeofence(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveGeofence(
  childId: string,
  value: Geofence,
  storage: Storage = localStorage,
): void {
  if (!childId || !validGeofence(value)) throw new Error('invalid_home_location');
  storage.setItem(key(childId), JSON.stringify(value));
}

export function clearGeofence(childId: string, storage: Storage = localStorage): void {
  storage.removeItem(key(childId));
}

export function distanceM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const squared =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, squared)));
}
