// B1-28p (brief §9.2 ④): app.module assembles deletionCleanupPorts.feedback as feedback's cleanup
// step (deleteFeedbackForUser, DeletionCleanupStep shape). Read from the worker options app.module
// really passes to IdentityDeletionExpiryModule.forWorker (captured, the module is not built); no
// database. The port name is read untyped: DeletionCleanupPortName gains `feedback` with the
// implementation.
import { afterEach, expect, it, vi } from 'vitest';
import { assembledCleanup } from '../../catalog/favorites-deletion/kit.ts';
import { capturedWorkerOptions, identity, ports } from '../../identity/deletion-processing/kit.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

it('[AC-B1-28p#30] 装配：worker 的 deletionCleanupPorts.feedback 是清理步骤函数，不是 unavailable 标记', async () => {
  const api = await identity();
  const p = await ports();
  const cleanup = assembledCleanup(await capturedWorkerOptions(api, p), p) as unknown as Readonly<
    Record<string, unknown>
  >;
  expect(cleanup, 'deletionCleanupPorts has no feedback port').toHaveProperty('feedback');
  expect(cleanup['feedback'], 'feedback is a DeletionCleanupUnavailable marker').not.toHaveProperty(
    'unavailable',
  );
  expect(cleanup['feedback']).toBeTypeOf('function');
}, 30_000);
