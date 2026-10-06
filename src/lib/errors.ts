const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The cookie store itself is the problem: "could not find firefox cookies
 * database in …", "could not copy Chrome cookie database", or — without the
 * word cookie at all — "Failed to decrypt with DPAPI" and keyring errors.
 * A sign-in hint mentions --cookies too, but that one is about the site.
 */
export const isCookieProblem = (error: unknown) =>
  /cookie|dpapi|keyring|decrypt/i.test(messageOf(error)) && !needsSignIn(error)

/**
 * The site wants an account: age-gated and members-only videos, YouTube's
 * bot check, Instagram's login wall. yt-dlp ends most of these with a hint
 * to pass --cookies, which is the most reliable marker of all.
 */
export function needsSignIn(error: unknown): boolean {
  const message = messageOf(error)
  return (
    /--cookies|sign in|log ?in|login|members[- ]only|private video|age[- ]restricted|confirm your age|not a bot|inappropriate/i.test(
      message,
    )
  )
}

/**
 * Failures that have nothing to do with being signed in — no network, a
 * link yt-dlp can't read, a video that is gone. Retrying them signed out
 * only doubles the wait before the same error.
 */
function failsEitherWay(error: unknown): boolean {
  return /unable to download|timed out|connection|network|getaddrinfo|name resolution|ssl|unsupported url|not a valid url|http error 404|not found|unavailable|has been removed|deleted|no video formats/i.test(
    messageOf(error),
  )
}

/**
 * After borrowed cookies failed: is another go without them worth it?
 * Yes when the cookie store is unreadable, and for whatever we can't place —
 * some sites simply reject a foreign session. No when the error would repeat
 * signed out, or when it is the account the site wants, since dropping the
 * cookies can only make that worse.
 */
export function worthRetryingSignedOut(error: unknown): boolean {
  if (isCookieProblem(error)) return true
  return !failsEitherWay(error) && !needsSignIn(error)
}
