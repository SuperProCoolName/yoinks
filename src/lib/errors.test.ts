import assert from 'node:assert/strict'
import test from 'node:test'
import {isCookieProblem, needsSignIn, worthRetryingSignedOut} from './errors.js'

// real yt-dlp wording, with the "ERROR: [site] id:" prefix already stripped
const unreadableStore = [
  'could not find firefox cookies database in /home/u/.mozilla/firefox',
  'Could not copy Chrome cookie database. See https://github.com/yt-dlp/yt-dlp/issues/7271',
  'Failed to decrypt with DPAPI. See https://github.com/yt-dlp/yt-dlp/issues/10927',
]
const wantsAccount = [
  'Sign in to confirm your age. This video may be inappropriate for some users. Use --cookies-from-browser or --cookies for the authentication.',
  'Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.',
  'Requested content is not available, rate-limit reached or login required. Use --cookies, --cookies-from-browser, --username and --password',
  'This is a members-only video',
  'Private video. Sign in if you\'ve been granted access to this video',
]
const failsAnyway = [
  'Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>',
  'Unsupported URL: https://example.com/page',
  'Video unavailable. This video has been removed by the uploader',
  'HTTP Error 404: Not Found',
  'Unable to download webpage: The read operation timed out',
]

test('an unreadable cookie store is told apart from a site asking for one', () => {
  for (const message of unreadableStore) assert.ok(isCookieProblem(new Error(message)), message)
  // these mention --cookies, but the store is fine — the site wants an account
  for (const message of wantsAccount) assert.ok(!isCookieProblem(new Error(message)), message)
})

test('recognises the errors a sign-in would fix', () => {
  for (const message of wantsAccount) assert.ok(needsSignIn(new Error(message)), message)
  for (const message of [...failsAnyway, ...unreadableStore]) assert.ok(!needsSignIn(new Error(message)), message)
  // "page" must not pass for "age"
  assert.ok(!needsSignIn(new Error('The page needs to be reloaded.')))
})

test('only retries signed out when it could change the answer', () => {
  for (const message of unreadableStore) assert.ok(worthRetryingSignedOut(new Error(message)), message)
  for (const message of [...failsAnyway, ...wantsAccount]) assert.ok(!worthRetryingSignedOut(new Error(message)), message)
  // something we can't place may well be a site rejecting a foreign session
  assert.ok(worthRetryingSignedOut(new Error('The page needs to be reloaded.')))
  assert.ok(worthRetryingSignedOut('HTTP Error 403: Forbidden'))
})
