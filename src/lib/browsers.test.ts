import assert from 'node:assert/strict'
import test from 'node:test'
import {cookiesForUrl, installedCookieBrowsers, nextCookieMode, resolveCookies} from './browsers.js'

test('the cookie switch walks auto → off → each browser → auto', () => {
  const installed = ['firefox', 'chrome'] as const
  const seen = []
  let mode = nextCookieMode(undefined, [...installed])
  for (let i = 0; i < 4; i++) {
    seen.push(mode ?? 'auto')
    mode = nextCookieMode(mode, [...installed])
  }
  assert.deepEqual(seen, ['off', 'firefox', 'chrome', 'auto'])
})

test('a pinned browser that is no longer installed resets the switch to auto', () => {
  assert.equal(nextCookieMode('vivaldi', ['firefox']), undefined)
  // and with no browser at all it simply toggles auto and off
  assert.equal(nextCookieMode(undefined, []), 'off')
  assert.equal(nextCookieMode('off', []), undefined)
})

test('the stored mode turns into the cookies actually used', () => {
  const detect = () => 'firefox' as const
  assert.deepEqual(resolveCookies(undefined, detect), {cookiesFrom: 'firefox', cookiesAuto: true})
  assert.deepEqual(resolveCookies('off', detect), {cookiesAuto: false})
  assert.deepEqual(resolveCookies('chrome', detect), {cookiesFrom: 'chrome', cookiesAuto: false})
  assert.deepEqual(resolveCookies(undefined, () => undefined), {cookiesFrom: undefined, cookiesAuto: true})
})

test('a guessed browser stays away from youtube, a chosen one does not', () => {
  assert.equal(cookiesForUrl('firefox', true, 'https://youtu.be/dQw4w9WgXcQ'), undefined)
  assert.equal(cookiesForUrl('firefox', false, 'https://youtu.be/dQw4w9WgXcQ'), 'firefox')
  assert.equal(cookiesForUrl('firefox', true, 'https://www.instagram.com/p/abc/'), 'firefox')
})

test('lists installed browsers best first', () => {
  const present = new Set<string>()
  const exists = (dir: string) => [...present].some(name => dir.toLowerCase().includes(name))
  assert.deepEqual(installedCookieBrowsers(exists), [])
  present.add('chrome')
  present.add('firefox')
  const found = installedCookieBrowsers(exists)
  // firefox leads: chromium stores are encrypted on windows and macos
  assert.equal(found[0], 'firefox')
  assert.ok(found.includes('chrome'))
})
