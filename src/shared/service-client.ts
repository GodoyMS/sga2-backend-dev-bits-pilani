import { config, serviceUrls, type ServiceName } from '../config';
import { ApiError } from './errors';

interface CallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  requestId?: string;
  timeoutMs?: number;
}

/**
 * Service-to-service HTTP call. Uses the internal service token instead of a user JWT,
 * so downstream services can trust the caller without going back through the gateway.
 */
export async function callService<T = unknown>(service: ServiceName, path: string, opts: CallOptions = {}): Promise<T> {
  const url = `${serviceUrls[service]}${path}`;
  let res: globalThis.Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        'x-service-token': config.serviceToken,
        ...(opts.requestId && { 'x-request-id': opts.requestId }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
  } catch (err) {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', `${service} service is unavailable`, {
      reason: (err as Error).message,
    });
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'UPSTREAM_ERROR', e?.message ?? `${service} service error`, e?.details);
  }
  return data as T;
}
