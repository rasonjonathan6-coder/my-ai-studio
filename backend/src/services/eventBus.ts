/**
 * In-process pub/sub used by the WebSocket layer. Events carry only what a
 * client needs to render progress; secrets are never placed on the bus.
 */
export type EventPayload = Record<string, unknown> & { type: string; projectId: string; timestamp: string };

type Listener = (event: EventPayload) => void;

export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  public subscribe(channel: string, listener: Listener): () => void {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.listeners.delete(channel);
    };
  }

  public publish(channel: string, event: EventPayload): void {
    const set = this.listeners.get(channel);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch {
        // a broken subscriber must not break the publisher
      }
    }
  }

  public emit(projectId: string, type: string, fields: Record<string, unknown> = {}): void {
    this.publish(projectId, { type, projectId, timestamp: new Date().toISOString(), ...fields });
  }

  public channelSize(channel: string): number {
    return this.listeners.get(channel)?.size ?? 0;
  }
}

export const eventBus = new EventBus();

export type AgentPhase =
  | 'queued' | 'analyzing' | 'planning' | 'reading' | 'editing'
  | 'running' | 'testing' | 'building' | 'inspecting' | 'fixing'
  | 'completed' | 'failed';

export function agentEvent(projectId: string, phase: AgentPhase, message: string, extra: Record<string, unknown> = {}): void {
  eventBus.emit(projectId, 'agent_status', { phase, message, level: 'info', ...extra });
}

export function logEvent(projectId: string, type: 'build_log' | 'test_log' | 'command_log', level: 'info' | 'warn' | 'error', message: string, extra: Record<string, unknown> = {}): void {
  eventBus.emit(projectId, type, { level, message, ...extra });
}
