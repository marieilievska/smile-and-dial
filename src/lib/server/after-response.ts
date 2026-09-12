import "server-only";

import { after } from "next/server";

/**
 * Run `task` once the HTTP response has been sent, so bookkeeping never holds
 * up someone waiting on the phone.
 *
 * Next's `after()` only works inside a request; in a script or a unit test it
 * throws, and we then run the task inline and awaited rather than dropping it.
 * Never throws: the caller's answer must not depend on this.
 */
export async function afterResponse(
  task: () => Promise<unknown>,
): Promise<void> {
  const safe = async () => {
    try {
      await task();
    } catch {
      // best-effort by design
    }
  };
  try {
    after(safe);
  } catch {
    await safe();
  }
}
