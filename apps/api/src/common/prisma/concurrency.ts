type Task = () => Promise<unknown>;
type Results<T extends readonly Task[]> = { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };

/**
 * `Promise.all` over thunks with at most `limit` running at once (results keep their positions).
 *
 * Use it for read fan-outs on the root Prisma client: every concurrently running query holds one
 * pool connection, so an unbounded `Promise.all` of N heavy queries takes N of the pool's
 * DATABASE_POOL_MAX connections and makes every other request wait (or time out with 503).
 *
 * @example const [a, b, c] = await allLimited(2, [() => q1(), () => q2(), () => q3()] as const);
 */
export async function allLimited<T extends readonly Task[]>(limit: number, tasks: T): Promise<Results<T>> {
  const results = new Array<unknown>(tasks.length);
  let next = 0;
  let failed = false;
  const lane = async (): Promise<void> => {
    while (!failed && next < tasks.length) {
      const i = next++;
      try {
        results[i] = await tasks[i]!();
      } catch (err) {
        failed = true; // do not start further tasks
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, lane));
  return results as Results<T>;
}
