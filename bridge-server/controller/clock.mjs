// Every controller, process and protocol deadline uses this injected scheduler.
export const systemClock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

export const delay = (clock, ms) => new Promise((resolve) => clock.setTimeout(resolve, ms));

export async function bounded(clock, operation, ms, code) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = clock.setTimeout(() => reject(Object.assign(new Error(code), { code })), ms);
      }),
    ]);
  } finally { clock.clearTimeout(timer); }
}
