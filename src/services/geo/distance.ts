const EARTH_RADIUS_KM = 6371.0088;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance between two coordinates in kilometres (Haversine formula). */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Bounding box that fully contains a circle of `radiusKm` around a point.
 * Used as a cheap indexed pre-filter in SQL before the exact Haversine check.
 */
export function boundingBox(lat: number, lon: number, radiusKm: number) {
  const latDelta = radiusKm / 111.32;
  const cosLat = Math.cos(toRad(lat));
  const lonDelta = cosLat < 1e-6 ? 180 : Math.min(180, radiusKm / (111.32 * cosLat));
  return {
    minLat: Math.max(-90, lat - latDelta),
    maxLat: Math.min(90, lat + latDelta),
    minLon: lon - lonDelta,
    maxLon: lon + lonDelta,
  };
}
