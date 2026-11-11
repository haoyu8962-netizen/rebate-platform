import { describe, expect, it, vi } from 'vitest';
import type { SharePageService } from '../../application/share-page.ts';
import { SharePageController } from './share-page.controller.ts';

const LINK = '0199a3b4-5c6d-7000-8000-0000000026b1';
const REQUEST_ID = '0199a3b4-5c6d-7000-8000-0000000026b2';

function request(headers: Record<string, string>) {
  return {
    id: REQUEST_ID,
    ip: '198.51.100.40',
    params: { link_id: LINK },
    headers: { 'x-app-id': 'app1', 'user-agent': 'Mozilla/5.0', ...headers },
    body: { ticket: 'ticket-1' },
  };
}

function setup() {
  const ok = (data: Record<string, unknown>) => ({
    status: 200,
    envelope: { code: 0, msg: '', data, trace_id: REQUEST_ID },
  });
  const pages = {
    get: vi.fn(async () => ok({ jump_url: 'https://example.test/j' })),
    tpwd: vi.fn(async () => ok({ tpwd: 'synthetic' })),
  };
  const headers = new Map<string, string>();
  const reply = { header: (name: string, value: string) => headers.set(name, value) };
  const controller = new SharePageController(pages as unknown as SharePageService);
  return { pages, headers, reply, controller };
}

describe('SharePageController X-App-Version (D10-1232 / D10-1246)', () => {
  it('[AC-CT-26zj#1] h5 and admin without X-App-Version reach the use case', async () => {
    for (const platform of ['h5', 'admin']) {
      const { pages, reply, controller } = setup();
      await expect(
        controller.get(request({ 'x-platform': platform }) as never, reply),
      ).resolves.toMatchObject({ code: 0 });
      await expect(
        controller.tpwd(request({ 'x-platform': platform }) as never, reply),
      ).resolves.toMatchObject({ code: 0 });
      expect(pages.get).toHaveBeenCalledTimes(1);
      expect(pages.tpwd).toHaveBeenCalledTimes(1);
    }
  });

  it('[AC-CT-26zj#2] ios / android / harmony without X-App-Version: 400 20001 fields=[x-app-version], no-store, use case not called', async () => {
    for (const platform of ['ios', 'android', 'harmony']) {
      const { pages, headers, reply, controller } = setup();
      const expected = {
        status: 400,
        response: {
          code: 20001,
          data: { fields: ['x-app-version'] },
          trace_id: REQUEST_ID,
        },
      };
      await expect(
        controller.get(request({ 'x-platform': platform }) as never, reply),
      ).rejects.toMatchObject(expected);
      await expect(
        controller.tpwd(request({ 'x-platform': platform }) as never, reply),
      ).rejects.toMatchObject(expected);
      expect(headers.get('Cache-Control')).toBe('no-store');
      expect(pages.get).not.toHaveBeenCalled();
      expect(pages.tpwd).not.toHaveBeenCalled();
    }
  });

  it('[AC-CT-26zj#2] the three apps with X-App-Version reach the use case', async () => {
    for (const platform of ['ios', 'android', 'harmony']) {
      const { pages, reply, controller } = setup();
      const headers = { 'x-platform': platform, 'x-app-version': '1.0.0' };
      await expect(controller.get(request(headers) as never, reply)).resolves.toMatchObject({
        code: 0,
      });
      await expect(controller.tpwd(request(headers) as never, reply)).resolves.toMatchObject({
        code: 0,
      });
      expect(pages.get).toHaveBeenCalledTimes(1);
      expect(pages.tpwd).toHaveBeenCalledTimes(1);
    }
  });
});
