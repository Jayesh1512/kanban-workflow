import type { ConnectorEvent, EventSink } from '../contracts/index.ts';

/** Instance-local queue. Stop invalidates queued callbacks before resolving. */
export function createDelivery() {
  let sink: EventSink | null = null;
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();
  return {
    start(next: EventSink) {
      generation++;
      sink = next;
      queue = Promise.resolve();
    },
    stop() {
      generation++;
      sink = null;
    },
    emit(event: ConnectorEvent): Promise<void> {
      const target = sink;
      const epoch = generation;
      const pending = queue.then(async () => {
        if (!target || target !== sink || epoch !== generation) return;
        try {
          await target.emit(structuredClone(event));
        } catch (error) {
          if (target === sink && epoch === generation) {
            sink = null;
            generation++;
            if (event.type !== 'status' || event.state !== 'disconnected') {
              try {
                await target.emit({ type: 'status', state: 'disconnected' });
              } catch {
                // A rejecting sink cannot receive the failure notification either.
              }
            }
          }
          throw error;
        }
      });
      queue = pending.catch(() => {});
      return pending;
    },
  };
}
