import { randomBytes } from "node:crypto";

/**
 * Generate a short, URL-safe identifier suitable for embedding in a Discord
 * component customId. We avoid full UUIDs because the customId budget is only
 * 100 chars total — a 12-char base64url string gives ~72 bits of entropy which
 * is plenty for short-lived flow executions.
 */
export function shortId(): string {
  return randomBytes(9)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
