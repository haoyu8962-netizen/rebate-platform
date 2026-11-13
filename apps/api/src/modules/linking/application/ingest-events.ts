/** B1-06zo / CT-13g: validated batch at the future recordEvents connection point. */
export interface EventBatchContext {
  readonly appId: string;
  readonly userId: string | null;
  readonly deviceId: string | null;
}

export interface PreparedEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly clientAt: string;
}

export interface PreparedEventBatch extends EventBatchContext {
  readonly events: readonly PreparedEvent[];
}

export interface PreparedEvents {
  readonly droppedCount: number;
  readonly batch: PreparedEventBatch;
}

/** Validate individually against specs/events.yaml; omit transport/identity fields from props.
 * Missing link_jump.attempt_id is analytics-only (BR-ATTR-21), not a dropped event.
 * The HTTP receiver uses this boundary; CT-13h can later pass batch to recordEvents.
 */
export function prepareEvents(
  context: EventBatchContext,
  events: readonly unknown[],
): PreparedEvents {
  void context;
  void events;
  throw new Error('NotImplemented: prepareEvents');
}
