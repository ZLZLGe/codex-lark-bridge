import { randomUUID } from 'node:crypto';
import type { HttpInstance, HttpRequestOptions } from '@larksuiteoapi/node-sdk';

export const FEISHU_HTTP_TIMEOUT_MS = 40_000;
export const FEISHU_HTTP_MAX_RETRIES = 20;
export const FEISHU_HTTP_RETRY_BASE_DELAY_MS = 500;
export const FEISHU_HTTP_RETRY_MAX_DELAY_MS = 40_000;

interface RetryInfo {
  retry: number;
  maxRetries: number;
  delayMs: number;
  method: string;
  endpoint: string;
  status?: number;
  code?: string;
}

interface RetryingHttpOptions {
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (info: RetryInfo) => void;
}

/**
 * Add bounded retries around the Feishu REST calls that deliver streamed
 * output. This sits below `channel.stream()`, so a transient network failure
 * retries only the failed HTTP transfer and never starts the agent again.
 */
export function createRetryingHttpInstance(
  delegate: HttpInstance,
  options: RetryingHttpOptions = {},
): HttpInstance {
  const timeoutMs = options.timeoutMs ?? FEISHU_HTTP_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? FEISHU_HTTP_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? FEISHU_HTTP_RETRY_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? FEISHU_HTTP_RETRY_MAX_DELAY_MS;
  const sleep = options.sleep ?? delay;

  const request: HttpInstance['request'] = async (requestOptions) => {
    const prepared = prepareRequest(requestOptions, timeoutMs);
    const method = String(prepared.method ?? 'GET').toUpperCase();
    const endpoint = endpointForLog(prepared.url);
    const retries = shouldRetryTransfer(prepared.url) ? maxRetries : 0;

    for (let retry = 0; ; retry += 1) {
      try {
        return await delegate.request(prepared);
      } catch (error) {
        if (retry >= retries || !isRetryableTransferError(error)) throw error;

        const delayMs = exponentialBackoffMs(retry, baseDelayMs, maxDelayMs);
        const details = errorDetails(error);
        options.onRetry?.({
          retry: retry + 1,
          maxRetries: retries,
          delayMs,
          method,
          endpoint,
          ...(details.status !== undefined ? { status: details.status } : {}),
          ...(details.code !== undefined ? { code: details.code } : {}),
        });
        await sleep(delayMs);
      }
    }
  };

  const call = <D>(
    method: string,
    url: string,
    data: D | undefined,
    requestOptions: HttpRequestOptions<D> | undefined,
  ): Promise<unknown> => request({
    ...requestOptions,
    url,
    method,
    ...(data !== undefined ? { data } : {}),
  });

  return {
    request,
    get: (url, requestOptions) => call('GET', url, undefined, requestOptions),
    delete: (url, requestOptions) => call('DELETE', url, undefined, requestOptions),
    head: (url, requestOptions) => call('HEAD', url, undefined, requestOptions),
    options: (url, requestOptions) => call('OPTIONS', url, undefined, requestOptions),
    post: (url, data, requestOptions) => call('POST', url, data, requestOptions),
    put: (url, data, requestOptions) => call('PUT', url, data, requestOptions),
    patch: (url, data, requestOptions) => call('PATCH', url, data, requestOptions),
  } as HttpInstance;
}

export function exponentialBackoffMs(
  retryIndex: number,
  baseDelayMs = FEISHU_HTTP_RETRY_BASE_DELAY_MS,
  maxDelayMs = FEISHU_HTTP_RETRY_MAX_DELAY_MS,
): number {
  return Math.min(maxDelayMs, baseDelayMs * (2 ** retryIndex));
}

function prepareRequest<D>(
  requestOptions: HttpRequestOptions<D>,
  timeoutMs: number,
): HttpRequestOptions<D> {
  const requestedTimeout = requestOptions.timeout;
  const boundedTimeout =
    typeof requestedTimeout === 'number' && requestedTimeout > 0
      ? Math.min(requestedTimeout, timeoutMs)
      : timeoutMs;
  const data = addMessageIdempotencyKey(
    requestOptions.url,
    requestOptions.method,
    requestOptions.data,
  );
  return {
    ...requestOptions,
    timeout: boundedTimeout,
    ...(data !== requestOptions.data ? { data } : {}),
  };
}

function addMessageIdempotencyKey<D>(
  url: string | undefined,
  method: string | undefined,
  data: D | undefined,
): D | undefined {
  if (String(method ?? 'GET').toUpperCase() !== 'POST') return data;
  const path = endpointForLog(url);
  const isMessageCreate = /\/open-apis\/im\/v1\/messages$/.test(path);
  const isMessageReply = /\/open-apis\/im\/v1\/messages\/[^/]+\/reply$/.test(path);
  if ((!isMessageCreate && !isMessageReply) || !isRecord(data)) return data;
  if (typeof data.uuid === 'string' && data.uuid) return data;
  return { ...data, uuid: randomUUID() } as D;
}

function shouldRetryTransfer(url: string | undefined): boolean {
  const path = endpointForLog(url);
  return (
    path.startsWith('/open-apis/im/v1/messages')
    || path.startsWith('/open-apis/cardkit/v1/cards')
    || path.startsWith('/open-apis/auth/v3/tenant_access_token')
    || path.startsWith('/open-apis/auth/v3/app_access_token')
  );
}

function isRetryableTransferError(error: unknown): boolean {
  const { status, code } = errorDetails(error);
  if (status !== undefined) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }
  if (code === 'ERR_CANCELED' || code === 'ABORT_ERR') return false;
  return true;
}

function errorDetails(error: unknown): { status?: number; code?: string } {
  if (!isRecord(error)) return {};
  const response = isRecord(error.response) ? error.response : undefined;
  const rawStatus = response?.status ?? error.status;
  const rawCode = error.code;
  return {
    ...(typeof rawStatus === 'number' ? { status: rawStatus } : {}),
    ...(typeof rawCode === 'string' ? { code: rawCode } : {}),
  };
}

function endpointForLog(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).pathname;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
