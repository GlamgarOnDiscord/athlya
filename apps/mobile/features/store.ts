/**
 * Minimal observable state container for the screen controllers. It is
 * plain TypeScript, so the controllers are unit-tested in Node; screens
 * read it with `useSyncExternalStore(store.subscribe, store.get)`.
 */
export class Store<T> {
  #state: T;
  readonly #listeners = new Set<() => void>();

  public constructor(initial: T) {
    this.#state = initial;
  }

  public readonly get = (): T => this.#state;

  public set(next: T | ((current: T) => T)): void {
    const value = typeof next === 'function' ? (next as (current: T) => T)(this.#state) : next;
    if (Object.is(value, this.#state)) return;
    this.#state = value;
    for (const listener of this.#listeners) listener();
  }

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
}
