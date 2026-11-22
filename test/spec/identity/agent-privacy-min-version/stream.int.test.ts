import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { setConfig, usePgEach } from '../../agent/stream-mount/kit.ts';
import { READ, WRITE, member, openStream, passed } from '../deletion-guard-stream/kit.ts';
import { MIN_KEY, consent, privacyError } from '../privacy-min-version/kit.ts';

const pg = usePgEach(createTestDatabase);

it('[AC-B3-08zi#8] 真实 stream 入口在开关关闭时先判隐私，达标后再返回 30501', async () => {
  // member 创建真实登录会话，并把该 app 的 agent.enabled 设为 false。
  const stream = await openStream(pg.db);
  try {
    const caller = await member(stream);
    await setConfig(pg.db, caller.appId, MIN_KEY, 3);
    await consent(pg.db, caller.appId, caller.uid, { version: 2 });

    const { status, response: envelope } = privacyError('');
    const routes = [
      ['POST', WRITE],
      ['GET', READ],
    ] as const;
    for (const [method, path] of routes) {
      const response = await caller.send(method, path);
      expect(response.statusCode, response.body).toBe(status);
      expect(response.json()).toEqual({ ...envelope, trace_id: expect.any(String) });
    }

    await consent(pg.db, caller.appId, caller.uid, { version: 3, at: '2026-10-17T02:00:01Z' });
    passed(await caller.send('POST', WRITE));
    passed(await caller.send('GET', READ));
  } finally {
    await stream.app.close();
  }
}, 120_000);
