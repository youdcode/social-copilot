/** Runs async jobs one at a time, in order. A failing job never blocks the next ones. */
export type SerialQueue = {
  run<T>(job: () => Promise<T>): Promise<T>;
  /** True while a job runs or waits. */
  readonly busy: boolean;
  /** Resolves once every job queued so far has finished. */
  idle(): Promise<void>;
};

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return {
    get busy() {
      return pending > 0;
    },
    run(job) {
      pending++;
      const result = tail.then(job).finally(() => pending--);
      tail = result.catch(() => {});
      return result;
    },
    async idle() {
      await tail;
    },
  };
}
