import { config } from '../../config';
import { ApiError } from '../../shared/errors';

export interface GeocodeResult {
  latitude: number;
  longitude: number;
  formattedAddress: string;
  provider: 'google' | 'nominatim' | string;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  let res: globalThis.Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(config.geocoding.timeoutMs) });
  } catch (err) {
    throw new ApiError(502, 'GEOCODER_UNAVAILABLE', 'Geocoding provider could not be reached', {
      reason: (err as Error).message,
    });
  }
  if (!res.ok) {
    throw new ApiError(502, 'GEOCODER_ERROR', `Geocoding provider responded with HTTP ${res.status}`);
  }
  return res.json();
}

async function geocodeWithGoogle(address: string): Promise<GeocodeResult> {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', address);
  url.searchParams.set('key', config.geocoding.googleApiKey);
  const data = await getJson(url.toString());

  if (data.status === 'ZERO_RESULTS') throw new ApiError(404, 'ADDRESS_NOT_FOUND', `No coordinates found for "${address}"`);
  if (data.status !== 'OK') {
    throw new ApiError(502, 'GEOCODER_ERROR', `Google Geocoding API error: ${data.status}`, data.error_message);
  }
  const best = data.results[0];
  return {
    latitude: best.geometry.location.lat,
    longitude: best.geometry.location.lng,
    formattedAddress: best.formatted_address,
    provider: 'google',
  };
}

async function geocodeWithNominatim(address: string): Promise<GeocodeResult> {
  const url = new URL('/search', config.geocoding.nominatimUrl);
  url.searchParams.set('q', address);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  // Nominatim's usage policy requires an identifying User-Agent.
  const data = await getJson(url.toString(), { 'User-Agent': config.geocoding.userAgent, 'Accept-Language': 'en' });

  if (!Array.isArray(data) || data.length === 0) {
    throw new ApiError(404, 'ADDRESS_NOT_FOUND', `No coordinates found for "${address}"`);
  }
  return {
    latitude: Number(data[0].lat),
    longitude: Number(data[0].lon),
    formattedAddress: data[0].display_name,
    provider: 'nominatim',
  };
}

/**
 * Third-party geocoding integration. Uses the Google Maps Geocoding API when
 * GOOGLE_MAPS_API_KEY is configured, otherwise OpenStreetMap Nominatim.
 * Exposed as an object so tests can stub `geocoder.geocode` with Sinon.
 */
export const geocoder = {
  async geocode(address: string): Promise<GeocodeResult> {
    if (config.geocoding.provider === 'google' && config.geocoding.googleApiKey) {
      return geocodeWithGoogle(address);
    }
    return geocodeWithNominatim(address);
  },
};
