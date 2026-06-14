/** Minimal typed event emitter (no `any`, no Node EventEmitter dependency). */
export class TypedEmitter<Events extends Record<string, (...args: never[]) => void>> {
  private listeners = new Map<keyof Events, Set<(...args: never[]) => void>>();

  on<K extends keyof Events>(event: K, fn: Events[K]): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn as (...args: never[]) => void);
    return () => this.off(event, fn);
  }

  off<K extends keyof Events>(event: K, fn: Events[K]): void {
    this.listeners.get(event)?.delete(fn as (...args: never[]) => void);
  }

  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    for (const fn of this.listeners.get(event) ?? []) {
      (fn as (...a: Parameters<Events[K]>) => void)(...args);
    }
  }
}
