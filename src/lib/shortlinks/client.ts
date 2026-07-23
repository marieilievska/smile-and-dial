import "server-only";

/**
 * Client for the HireAI presell app's shortener API.
 *
 * This runs INSIDE a live phone call — the AI has just told the lead their text
 * is on the way while we wait on this request. So every failure path returns
 * null rather than throwing, and the caller sends the full URL instead. A slow
 * or broken shortener must never be the reason a message doesn't go out.
 *
 * Without SHORTLINK_API_KEY (local dev, tests) we never touch the network.
 */

const SHORTLINK_API = "https://presale.hireai.me/api/public/shortlinks";

/** Well under the tools' 20s ElevenLabs budget — the rest of the send (Close
 *  delivery, row insert) still has to finish inside it. */
const TIMEOUT_MS = 4000;

export type ShortLink = { code: string | null; shortUrl: string };

type ShortlinkResponse = { code?: string; short_url?: string };

async function postOnce(
  apiKey: string,
  longUrl: string,
  label: string,
): Promise<{ link: ShortLink | null; status: number }> {
  const res = await fetch(SHORTLINK_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ url: longUrl, label }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) return { link: null, status: res.status };

  const data = (await res.json()) as ShortlinkResponse;
  if (!data.short_url) return { link: null, status: res.status };
  return {
    link: { code: data.code ?? null, shortUrl: data.short_url },
    status: res.status,
  };
}

/**
 * Exchange a long URL for a short one. Returns null on ANY failure — no key,
 * timeout, auth rejection, bad response — so the caller falls back to the full
 * URL. Failures log distinctly enough to tell a bad key from a dead app.
 */
export async function createShortLink(
  longUrl: string,
  label: string,
): Promise<ShortLink | null> {
  const apiKey = process.env.SHORTLINK_API_KEY?.trim();
  if (!apiKey) return null;

  try {
    const first = await postOnce(apiKey, longUrl, label);
    if (first.link) return first.link;

    // 409 is a code collision, which the API documents as retryable — a second
    // attempt generates a different code. Anything else won't change on retry.
    if (first.status === 409) {
      const retry = await postOnce(apiKey, longUrl, label);
      if (retry.link) return retry.link;
      console.error(
        `[shortlinks] retry after 409 failed (${retry.status}); sending the full URL`,
      );
      return null;
    }

    console.error(
      first.status === 401
        ? "[shortlinks] 401 unauthorized — check SHORTLINK_API_KEY in Vercel (no 'Bearer ' prefix, no trailing whitespace); sending the full URL"
        : `[shortlinks] shortener returned ${first.status}; sending the full URL`,
    );
    return null;
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    console.error(
      timedOut
        ? `[shortlinks] shortener did not respond within ${TIMEOUT_MS}ms; sending the full URL`
        : `[shortlinks] shortener request failed: ${err instanceof Error ? err.message : String(err)}; sending the full URL`,
    );
    return null;
  }
}
