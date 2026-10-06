import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Where this machine actually keeps downloads.
 *
 * `~/Downloads` is only the default. Windows lets the folder be moved or
 * redirected into OneDrive, and Linux desktops localise it (Загрузки,
 * Téléchargements, …), so guessing the English name drops files somewhere
 * the user's file manager never shows.
 */
export function detectDownloadsDir(): string {
  const home = os.homedir()
  const found = process.platform === 'win32' ? windowsDownloads() : process.platform === 'darwin' ? undefined : xdgDownloads()
  const fallback = path.join(home, 'Downloads')
  return found && isUsable(found) ? found : isUsable(fallback) ? fallback : home
}

/** The known-folder record survives moves and OneDrive redirection. */
function windowsDownloads(): string | undefined {
  try {
    const out = execFileSync(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
        '/v',
        '{374DE290-123F-4565-9164-39C4925E467B}',
      ],
      {encoding: 'utf8', windowsHide: true, timeout: 3_000},
    )
    // ...    {374DE290-...}    REG_EXPAND_SZ    %USERPROFILE%\Downloads
    const value = /REG_(?:EXPAND_)?SZ\s+(.+)/.exec(out)?.[1]?.trim()
    return value ? expandWindowsVars(value) : undefined
  } catch {
    return undefined
  }
}

const expandWindowsVars = (value: string) =>
  value.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name.toUpperCase()] ?? whole)

/** XDG_DOWNLOAD_DIR is how Linux desktops record a localised or moved folder. */
function xdgDownloads(): string | undefined {
  const fromEnv = process.env.XDG_DOWNLOAD_DIR
  if (fromEnv) return fromEnv
  try {
    const dirs = fs.readFileSync(path.join(os.homedir(), '.config', 'user-dirs.dirs'), 'utf8')
    return parseXdgDownloadDir(dirs, os.homedir())
  } catch {
    return undefined
  }
}

/** Reads one line out of user-dirs.dirs: XDG_DOWNLOAD_DIR="$HOME/Загрузки" */
export function parseXdgDownloadDir(contents: string, home: string): string | undefined {
  const value = /^\s*XDG_DOWNLOAD_DIR\s*=\s*"?(.+?)"?\s*$/m.exec(contents)?.[1]
  return value?.replace(/^\$HOME/, home)
}

function isUsable(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** Turn what the user typed into an absolute path, expanding a leading ~. */
export function resolveUserDir(input: string): string {
  const home = os.homedir()
  const expanded = input === '~' || input.startsWith(`~${path.sep}`) || input.startsWith('~/') ? path.join(home, input.slice(1)) : input
  return path.resolve(expanded)
}

/**
 * Make sure downloads have somewhere to land. Returns the error text rather
 * than throwing, so the caller can say it in the same voice as everything else.
 */
export function ensureDir(dir: string): string | undefined {
  try {
    fs.mkdirSync(dir, {recursive: true})
    fs.accessSync(dir, fs.constants.W_OK)
    return undefined
  } catch {
    return `can’t write to “${dir}”`
  }
}
