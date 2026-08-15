import type { Coords } from './types';

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in metres. */
export function haversine(a: Coords, b: Coords): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Straight-line distance understates real driving distance. In a gridded city
 * the detour factor is ~1.3; we use that to keep travel costs honest.
 */
export const DETOUR_FACTOR = 1.3;

export function drivingKm(straightLineM: number): number {
  return (straightLineM * DETOUR_FACTOR) / 1000;
}

/**
 * Rough door-to-door minutes by car, including a fixed parking/walking penalty.
 * Almaty/Astana average city speed sits near 22 km/h in daytime traffic.
 */
export function drivingMinutes(straightLineM: number): number {
  const AVG_KMH = 22;
  const PARKING_MIN = 6;
  return (drivingKm(straightLineM) / AVG_KMH) * 60 + PARKING_MIN;
}

export function formatDistance(metres: number): string {
  if (metres < 950) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}
