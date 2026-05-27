import { createHash, randomBytes } from "crypto";

/** Key format: `sk_` + 32 base32-ish chars. We use base64url to keep it
 *  URL-safe; trim padding. The first 8 chars after the prefix are stored
 *  as `key_prefix` for lookups; the SHA-256 of the full raw key (without
 *  the `sk_` prefix) is stored as `key_hash`. SHA-256 is fine here because
 *  the entropy is high enough to make rainbow tables useless. */
export function generateApiKey(): {
  rawKey: string;
  keyPrefix: string;
  keyHash: string;
} {
  const random = randomBytes(24)
    .toString("base64url")
    .replace(/=+$/g, "")
    .slice(0, 32);
  const rawKey = `sk_${random}`;
  const keyPrefix = random.slice(0, 8);
  const keyHash = createHash("sha256").update(random).digest("hex");
  return { rawKey, keyPrefix, keyHash };
}

/** Hash a presented key the same way for comparison. */
export function hashApiKey(presented: string): {
  keyPrefix: string;
  keyHash: string;
} | null {
  if (!presented.startsWith("sk_")) return null;
  const body = presented.slice(3);
  if (body.length < 16) return null;
  return {
    keyPrefix: body.slice(0, 8),
    keyHash: createHash("sha256").update(body).digest("hex"),
  };
}

/** Constant-time comparison of two equal-length hex strings. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
