import type { HttpInstance, HttpRequestOptions } from '@larksuiteoapi/node-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  createRetryingHttpInstance,
  exponentialBackoffMs,
  FEISHU_HTTP_MAX_RETRIES,
} from '../../../src/bot/retrying-http.js';

describe('createRetryingHttpInstance', () => {
  it('retries a timed-out streaming request with bounded exponential backoff', async () => {
    const requests: HttpRequestOptions<Record<string, unknown>>[] = [];
    const delays: number[] = [];
    const delegate = requestOnly(async (options) => {
      requests.push(options as HttpRequestOptions<Record<string, unknown>>);
      if (requests.length < 3) {
        throw Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' });
      }
      return { ok: true };
    });
    const http = createRetryingHttpInstance(delegate, {
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    await expect(http.request({
      method: 'POST',
      url: 'https://open.feishu.cn/open-apis/im/v1/messages/om_1/reply',
      timeout: 120_000,
      data: { content: '{}', msg_type: 'interactive' },
    })).resolves.toEqual({ ok: true });

    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.timeout === 40_000)).toBe(true);
    expect(delays).toEqual([500, 1_000]);
    const uuids = requests.map((request) => request.data?.uuid);
    expect(uuids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(uuids).size).toBe(1);
  });

  it('allows twenty retries after the initial streaming attempt', async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    });
    const http = createRetryingHttpInstance(requestOnly(request), {
      baseDelayMs: 0,
      maxDelayMs: 0,
      sleep: async () => {},
    });

    await expect(http.request({
      method: 'PATCH',
      url: 'https://open.feishu.cn/open-apis/cardkit/v1/cards/card_1/settings',
      data: { sequence: 1, uuid: 'stable' },
    })).rejects.toThrow('connection reset');

    expect(FEISHU_HTTP_MAX_RETRIES).toBe(20);
    expect(request).toHaveBeenCalledTimes(21);
  });

  it('does not retry non-transient HTTP failures', async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error('bad request'), { response: { status: 400 } });
    });
    const sleep = vi.fn(async () => {});
    const http = createRetryingHttpInstance(requestOnly(request), { sleep });

    await expect(http.request({
      method: 'PATCH',
      url: 'https://open.feishu.cn/open-apis/im/v1/messages/om_1',
      data: { content: '{}' },
    })).rejects.toThrow('bad request');

    expect(request).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry unrelated REST endpoints', async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    });
    const http = createRetryingHttpInstance(requestOnly(request), {
      sleep: async () => {},
    });

    await expect(http.request({
      method: 'GET',
      url: 'https://open.feishu.cn/open-apis/contact/v3/users/ou_1',
    })).rejects.toThrow('connection reset');

    expect(request).toHaveBeenCalledOnce();
  });
});

describe('exponentialBackoffMs', () => {
  it('doubles delay and caps it at forty seconds', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 12].map((retry) => exponentialBackoffMs(retry))).toEqual([
      500,
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      32_000,
      40_000,
      40_000,
    ]);
  });
});

function requestOnly(
  request: (options: HttpRequestOptions<unknown>) => Promise<unknown>,
): HttpInstance {
  return { request } as HttpInstance;
}
