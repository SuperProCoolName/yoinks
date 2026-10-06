import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONFIG_FILE = path.join(os.homedir(), '.config', 'yoinks', 'config.json')

/** Browsers yt-dlp can read cookies from. */
export const COOKIE_BROWSERS = [
  'brave',
  'chrome',
  'chromium',
  'edge',
  'firefox',
  'opera',
  'safari',
  'vivaldi',
  'whale',
] as const

export type CookieBrowser = (typeof COOKIE_BROWSERS)[number]

export function isCookieBrowser(value: string): value is CookieBrowser {
  return (COOKIE_BROWSERS as readonly string[]).includes(value)
}

export type Config = {
  /**
   * Browser to borrow cookies from. A browser name pins that one, 'off' means
   * stay signed out, and unset means "figure it out" — see detectCookieBrowser.
   */
  cookiesFrom?: CookieBrowser | 'off'
  /** Where to save files. Unset means "wherever this machine keeps downloads". */
  outDir?: string
}

export function loadConfig(): Config {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return {}
    const {cookiesFrom, outDir} = parsed as {cookiesFrom?: unknown; outDir?: unknown}
    const config: Config = {}
    if (cookiesFrom === 'off') config.cookiesFrom = 'off'
    else if (typeof cookiesFrom === 'string' && isCookieBrowser(cookiesFrom)) config.cookiesFrom = cookiesFrom
    if (typeof outDir === 'string' && outDir) config.outDir = outDir
    return config
  } catch {
    return {}
  }
}

/** Persist settings so `--cookies` only has to be typed once. */
export function saveConfig(config: Config): void {
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), {recursive: true})
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`)
  } catch {
    // a read-only home shouldn't stop anyone from downloading a video
  }
}
