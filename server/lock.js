// Run model calls one at a time so replies and check-ins never interleave.
let chain = Promise.resolve();

export function withLock(fn) {
  const run = chain.then(() => fn());
  chain = run.catch(() => {});
  return run;
}
