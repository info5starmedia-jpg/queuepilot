/**
 * Per-profile async mutex. All lifecycle mutations for a profile run under
 * this lock, so concurrent API requests serialize instead of racing. The
 * durable guard against double launches is the partial unique index in
 * browser_runs; this mutex is the first line that turns races into ordered
 * operations and makes conflict errors deterministic.
 */
export class ProfileOperationMutex {
  private readonly queues = new Map<string, Promise<void>>();

  async runExclusive<T>(profileId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(profileId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.queues.set(profileId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      // Drop the map entry once this chain drains, unless a newer caller has
      // already chained onto it (then the entry is theirs to clean up).
      if (this.queues.get(profileId) === tail) {
        void tail.then(() => {
          if (this.queues.get(profileId) === tail) this.queues.delete(profileId);
        });
      }
    }
  }
}
