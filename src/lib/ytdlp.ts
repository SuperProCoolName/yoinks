import {spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams} from 'node:child_process'
import {createWriteStream, rmSync} from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {formatBytes} from './format.js'

const YOINKS_DIR = path.join(os.homedir(), '.yoinks', 'bin')
const RELEASE_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
const LATEST_RELEASE_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'
const UPDATE_STAMP = path.join(YOINKS_DIR, 'update-check.json')
const UPDATE_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

function ytDlpAssetName(): string {
  if (process.platform === 'win32') return 'yt-dlp.exe'
  if (process.platform === 'darwin') return 'yt-dlp_macos'
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux'
}

// async on purpose: a spawnSync here blocks the event loop, which freezes
// ink mid-frame — the user hits enter and sees nothing until it returns
function commandWorks(cmd: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(cmd, args, {stdio: 'ignore', timeout: 10_000})
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
  })
}

// same as commandWorks, but keeps stdout — used to read `--version`
function commandOutput(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(cmd, args, {stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000})
    } catch {
      resolve(undefined)
      return
    }
    let out = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.on('error', () => resolve(undefined))
    child.on('close', code => resolve(code === 0 ? out.trim() || undefined : undefined))
  })
}

/** Where yoinks keeps its own copy of yt-dlp — the only one it ever replaces. */
export function managedYtDlpPath(): string {
  return path.join(YOINKS_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
}

/** Fetch the standalone binary and swap it in atomically. */
async function fetchYtDlp(dest: string, signal?: AbortSignal): Promise<void> {
  await fs.mkdir(path.dirname(dest), {recursive: true})

  const response = await fetch(`${RELEASE_BASE}/${ytDlpAssetName()}`, {signal})
  if (!response.ok || !response.body) {
    throw new Error(`Could not download yt-dlp (${response.status}). Check your connection and try again.`)
  }

  // write beside the target, then rename: a half-written binary is never
  // visible under the real name, and a copy already running keeps its inode
  const tmp = `${dest}.${process.pid}.download`
  try {
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmp), {signal})
    await fs.chmod(tmp, 0o755)
    await fs.rename(tmp, dest)
  } catch (error) {
    await fs.rm(tmp, {force: true})
    throw error
  }
}

/** The first candidate that answers `--version`, in order. */
export async function firstWorking(
  candidates: string[],
  works: (cmd: string) => Promise<boolean> = cmd => commandWorks(cmd, ['--version']),
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await works(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolve a usable yt-dlp binary: our own copy first — it is the one kept
 * fresh every week — then one already on PATH, and only then a download of
 * the standalone binary from GitHub releases. A system yt-dlp from a distro
 * package can be months behind, which is exactly when sites break.
 */
export async function ensureYtDlp(onStatus: (message: string) => void, signal?: AbortSignal): Promise<string> {
  const local = managedYtDlpPath()
  const found = await firstWorking([local, 'yt-dlp'])
  if (found) return found

  onStatus('first run: fetching yt-dlp…')
  await fetchYtDlp(local, signal)
  return local
}

export type UpdateResult =
  | {status: 'updated'; from?: string; to: string}
  | {status: 'current'; version: string}
  | {status: 'system'; version?: string}
  | {status: 'unavailable'; reason: string}

async function latestYtDlpVersion(signal?: AbortSignal): Promise<string | undefined> {
  const response = await fetch(LATEST_RELEASE_API, {
    signal,
    headers: {accept: 'application/vnd.github+json', 'user-agent': 'yoinks'},
  })
  if (!response.ok) return undefined
  const release = (await response.json()) as {tag_name?: unknown}
  return typeof release.tag_name === 'string' ? release.tag_name.trim() || undefined : undefined
}

async function markUpdateChecked(version?: string): Promise<void> {
  try {
    await fs.mkdir(YOINKS_DIR, {recursive: true})
    await fs.writeFile(UPDATE_STAMP, `${JSON.stringify({checkedAt: Date.now(), version: version ?? null})}\n`)
  } catch {
    // the stamp is an optimisation — worst case we check again next run
  }
}

async function updateCheckDue(): Promise<boolean> {
  try {
    const stamp = JSON.parse(await fs.readFile(UPDATE_STAMP, 'utf8')) as {checkedAt?: unknown}
    if (typeof stamp.checkedAt !== 'number') return true
    return Date.now() - stamp.checkedAt > UPDATE_CHECK_INTERVAL_MS
  } catch {
    return true
  }
}

/**
 * Refresh the copy of yt-dlp in ~/.yoinks/bin. A yt-dlp that came from the
 * user's package manager is reported, never overwritten — that install isn't
 * ours to touch. It only matters when there is no copy of our own: with one,
 * that copy is what runs, so that copy is what gets updated.
 */
export async function updateYtDlp(signal?: AbortSignal): Promise<UpdateResult> {
  const local = managedYtDlpPath()
  const current = await commandOutput(local, ['--version'])

  if (!current && (await commandWorks('yt-dlp', ['--version']))) {
    return {status: 'system', version: await commandOutput('yt-dlp', ['--version'])}
  }

  let latest: string | undefined
  try {
    latest = await latestYtDlpVersion(signal)
  } catch (error) {
    return {status: 'unavailable', reason: error instanceof Error ? error.message : String(error)}
  }
  if (!latest) return {status: 'unavailable', reason: 'could not reach the yt-dlp release feed'}

  if (current && current === latest) {
    await markUpdateChecked(latest)
    return {status: 'current', version: current}
  }

  await fetchYtDlp(local, signal)
  await markUpdateChecked(latest)
  return {status: 'updated', from: current, to: latest}
}

/**
 * Weekly background refresh, silent by design. A months-old yt-dlp is the
 * usual reason downloads suddenly start failing, and the user can't act on a
 * mid-session notice anyway. Returns a canceller — the caller aborts it on
 * exit so a slow download can't keep the terminal hostage after quitting.
 */
export function autoUpdateYtDlp(): () => void {
  const controller = new AbortController()
  void (async () => {
    try {
      if (!(await updateCheckDue())) return
      // never on first run: ensureYtDlp is about to fetch a fresh binary anyway
      if (!(await commandWorks(managedYtDlpPath(), ['--version']))) return
      await updateYtDlp(controller.signal)
    } catch {
      // offline, rate-limited, no disk space — yoinks runs on what it has
    }
  })()
  return () => controller.abort()
}

export type FfmpegStatus = {
  /** False when neither merging streams nor making an mp3 is possible. */
  available: boolean
  /** Only set when ffmpeg isn't on PATH — yt-dlp finds that one by itself. */
  location?: string
}

/**
 * Find ffmpeg for stream merging / mp3 extraction: system install first,
 * ffmpeg-static as fallback. Its absence isn't fatal — yt-dlp still handles
 * formats that arrive as one finished file — but it has to be known before
 * the format list is built, not discovered halfway through a download.
 */
export async function findFfmpeg(): Promise<FfmpegStatus> {
  if (await commandWorks('ffmpeg', ['-version'])) return {available: true}
  try {
    const mod = await import('ffmpeg-static')
    const ffmpegPath = (mod.default ?? mod) as unknown as string | null
    if (ffmpegPath && (await commandWorks(ffmpegPath, ['-version']))) return {available: true, location: ffmpegPath}
  } catch {
    // ffmpeg-static not installed or unsupported platform
  }
  return {available: false}
}

/** Shown when ffmpeg is missing, so the shorter list on screen has a reason. */
export const FFMPEG_HINT = `no ffmpeg, no sound or mp3 — ${
  process.platform === 'win32' ? 'winget install ffmpeg' : process.platform === 'darwin' ? 'brew install ffmpeg' : 'apt install ffmpeg'
}`

export type VideoInfo = {
  title: string
  uploader?: string
  duration?: number
  webpage_url?: string
  extractor_key?: string
  formats?: RawFormat[]
}

type RawFormat = {
  format_id: string
  ext?: string
  vcodec?: string | null
  acodec?: string | null
  height?: number
  width?: number
  abr?: number
  tbr?: number
  protocol?: string
  filesize?: number
  filesize_approx?: number
}

// yt-dlp's own reading of the codec fields: 'none' means the stream is
// absent, while a missing codec only means nobody said which one it is.
// Twitter's plain mp4s name no codec at all and still carry both picture
// and sound, and its separate audio tracks name no audio codec either
const hasVideo = (f: RawFormat) => f.vcodec !== 'none'
const hasAudio = (f: RawFormat) => f.acodec !== 'none'
// a stream with no picture, or one that names only an audio codec and has
// no frame size to suggest otherwise
const isAudioOnly = (f: RawFormat) =>
  hasAudio(f) && (f.vcodec === 'none' || (!f.vcodec && Boolean(f.acodec) && !f.height && !f.width))

export type ProbeResult = {
  info: VideoInfo
  /** Raw -J output saved to disk so downloads can skip re-extraction via --load-info-json. */
  infoJsonPath: string
}

/**
 * Borrow the browser's cookies so private, age-gated and login-walled pages
 * (Instagram in particular) work at all. Empty when no browser is configured.
 */
function cookieArgs(cookiesFrom?: string): string[] {
  return cookiesFrom ? ['--cookies-from-browser', cookiesFrom] : []
}

export async function probe(
  ytdlp: string,
  url: string,
  opts: {cookiesFrom?: string} = {},
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawnYtDlp(ytdlp, ['-J', '--no-playlist', '--no-warnings', ...cookieArgs(opts.cookiesFrom), url], signal)
    let out = ''
    let stderr = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(cleanYtDlpError(stderr) || `yt-dlp exited with code ${code}`))
      } else {
        resolve(out)
      }
    })
  })

  let info: VideoInfo
  try {
    info = JSON.parse(stdout) as VideoInfo
  } catch {
    throw new Error('Could not parse video info from yt-dlp.')
  }

  const infoJsonPath = path.join(os.tmpdir(), `${INFO_PREFIX}${process.pid}-${Date.now()}.json`)
  await fs.writeFile(infoJsonPath, stdout)
  infoJsonFiles.add(infoJsonPath)
  return {info, infoJsonPath}
}

const INFO_PREFIX = 'yoinks-info-'

// metadata dumps are only useful for the run that made them; keep track and
// take them with us on the way out instead of silting up /tmp
const infoJsonFiles = new Set<string>()
process.on('exit', () => {
  for (const file of infoJsonFiles) {
    try {
      rmSync(file, {force: true})
    } catch {
      // nothing sensible to do while exiting
    }
  }
})

/** Clear out dumps left by runs that were killed before they could tidy up. */
export async function sweepStaleInfoFiles(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
  try {
    const dir = os.tmpdir()
    const names = await fs.readdir(dir)
    const cutoff = Date.now() - maxAgeMs
    await Promise.all(
      names
        .filter(name => name.startsWith(INFO_PREFIX) && name.endsWith('.json'))
        .map(async name => {
          const file = path.join(dir, name)
          try {
            const stat = await fs.stat(file)
            if (stat.mtimeMs < cutoff) await fs.rm(file, {force: true})
          } catch {
            // someone else's file, or already gone
          }
        }),
    )
  } catch {
    // no readable temp dir — not worth a word to the user
  }
}

export type DownloadChoice = {
  label: string
  kind: 'video' | 'audio'
  args: string[]
}

const MAX_VIDEO_CHOICES = 8

/**
 * What a format weighs, and whether that is a fact or a guess. yt-dlp only
 * reports a size for streams it has measured; for the rest the bitrate and
 * the duration are all there is to go on.
 */
type Size = {bytes: number; exact: boolean}

function sizeOf(f: RawFormat, duration?: number): Size | undefined {
  if (f.filesize) return {bytes: f.filesize, exact: true}
  if (f.filesize_approx) return {bytes: f.filesize_approx, exact: false}
  if (f.tbr && duration) return {bytes: (f.tbr * 1000 * duration) / 8, exact: false}
  return undefined
}

function addSizes(a: Size | undefined, b: Size | undefined): Size | undefined {
  // one unknown part makes the total unknown — better no number than a
  // number that is quietly missing the video track
  if (!a || !b) return undefined
  return {bytes: a.bytes + b.bytes, exact: a.exact && b.exact}
}

const sizeLabel = (size: Size | undefined) => (size ? ` · ${size.exact ? '' : '~'}${formatBytes(size.bytes)}` : '')

const isHls = (f: RawFormat) => /m3u8/.test(f.protocol ?? '')

/** LAME at --audio-quality 0 lands around here, whatever the source bitrate is. */
const MP3_KBPS = 245

export function buildChoices(info: VideoInfo, opts: {ffmpeg?: boolean} = {}): DownloadChoice[] {
  const formats = info.formats ?? []
  const duration = info.duration
  const choices: DownloadChoice[] = []
  // without ffmpeg nothing can be merged or re-encoded, so only formats that
  // arrive as one finished file are worth offering
  const canMerge = opts.ffmpeg !== false

  const audioOnly = formats
    .filter(isAudioOnly)
    .sort((a, b) => scoreAudio(b) - scoreAudio(a))
  const bestAudio = audioOnly[0]
  // an m4a track drops straight into an mp4 container; opus/webm would make
  // yt-dlp re-encode or fall back to mkv
  const mergeAudio = audioOnly.find(f => f.ext === 'm4a') ?? bestAudio
  const mergeAudioSize = mergeAudio ? sizeOf(mergeAudio, duration) : undefined

  const playable = formats.filter(f => hasVideo(f) && !isAudioOnly(f))
  const videos = playable.filter(f => f.height)
  const heights = [...new Set(videos.map(f => f.height as number))].sort((a, b) => b - a)
  // with no ffmpeg a stream that already carries its own audio is worth more
  // than any bitrate — it is the only kind that arrives with sound
  const rank = (f: RawFormat) => scoreVideo(f) + (!canMerge && hasAudio(f) ? 100_000 : 0)
  // when every line would say "muted" the label is just noise — the footer's
  // ffmpeg notice covers it. Only a mixed list needs marking
  const someHaveSound = !canMerge && videos.some(hasAudio)

  for (const height of heights.slice(0, MAX_VIDEO_CHOICES)) {
    const candidates = videos.filter(f => f.height === height)
    const best = [...candidates].sort((a, b) => rank(b) - rank(a))[0]
    const muxed = hasAudio(best)
    const videoSize = sizeOf(best, duration)
    const size = muxed || !canMerge ? videoSize : addSizes(videoSize, mergeAudioSize)
    // name the exact streams we measured, so the number on screen is the
    // number that gets downloaded; the generic selectors stay as a fallback
    // for when a format id has expired by the time the user picks it
    const pinned = muxed || !canMerge || !mergeAudio ? best.format_id : `${best.format_id}+${mergeAudio.format_id}`
    choices.push({
      kind: 'video',
      // merging always lands in mp4; without it the container is whatever came
      label: `${height}p · ${canMerge ? 'mp4' : best.ext ?? 'mp4'}${!muxed && someHaveSound ? ' · muted' : ''}${sizeLabel(size)}`,
      args: canMerge
        ? [
            '-f',
            `${pinned}/bv*[height=${height}]+ba/b[height=${height}]/bv*[height<=${height}]+ba/b`,
            '--merge-output-format',
            'mp4',
          ]
        : ['-f', `${pinned}/b[height<=${height}]`],
    })
  }

  if (choices.length === 0) {
    // sites that serve one plain file have no resolutions to choose between,
    // but they usually do know how big that file is
    const only = [...playable].sort((a, b) => scoreVideo(b) - scoreVideo(a))[0]
    const size = only ? sizeOf(only, duration) : undefined
    choices.push({
      kind: 'video',
      label: `best available · ${canMerge ? 'mp4' : only?.ext ?? 'mp4'}${sizeLabel(size)}`,
      args: canMerge ? ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'] : ['-f', 'b'],
    })
  }

  if (canMerge) {
    // the mp3 is re-encoded, so the source track's size says nothing about
    // what lands on disk — the target bitrate does
    const mp3Size: Size | undefined = duration ? {bytes: (MP3_KBPS * 1000 * duration) / 8, exact: false} : undefined
    choices.push({
      kind: 'audio',
      label: `audio only · mp3${sizeLabel(mp3Size)}`,
      args: [
        '-f',
        `${bestAudio ? `${bestAudio.format_id}/` : ''}ba/b`,
        '-x',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '0',
      ],
    })
  } else if (bestAudio) {
    // no converter, but the original track can still be saved as it comes
    choices.push({
      kind: 'audio',
      label: `audio only · ${bestAudio.ext ?? 'm4a'}${sizeLabel(sizeOf(bestAudio, duration))}`,
      args: ['-f', `${bestAudio.format_id}/ba`],
    })
  }

  return choices
}

function scoreAudio(f: RawFormat): number {
  let score = f.abr ?? f.tbr ?? 0
  if (isHls(f)) score -= 1_000
  return score
}

function scoreVideo(f: RawFormat): number {
  let score = f.tbr ?? 0
  // the hls rendition of a stream carries no size and downloads slower than
  // the plain https one it duplicates — never let it win on bitrate alone
  if (isHls(f)) score -= 40_000
  if (f.ext === 'mp4') score += 10_000
  if (f.vcodec?.startsWith('avc')) score += 5_000
  return score
}

export type DownloadProgress = {
  downloadedBytes: number
  totalBytes?: number
  speed?: number
  eta?: number
  part: number
  /** How many files this download resolves to (video+audio merges are 2). */
  totalParts: number
}

export type DownloadHandlers = {
  onProgress: (progress: DownloadProgress) => void
  onProcessing: () => void
}

// YouTube and most HLS sites hand out fragmented media; pulling four
// fragments at once is the single biggest speed win available here, and it
// is a no-op for sites that serve one plain file
const CONCURRENT_FRAGMENTS = '4'

const PROGRESS_PREFIX = 'YOINK|'
// tagged so the finished file's path can never be confused with some other
// absolute path yt-dlp happens to print
const PATH_PREFIX = 'YOINKFILE|'
const PROGRESS_TEMPLATE = `${PROGRESS_PREFIX}%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s`

// yt-dlp is never alone: it runs ffmpeg to merge and to convert, and a signal
// sent to yt-dlp alone leaves that ffmpeg writing to the file we just
// cancelled. Everything it started has to go with it.
const OWN_GROUP = process.platform !== 'win32'

// deliberately not skipped when the child itself has already exited: a group
// outlives its leader, and a stuck ffmpeg holding the pipes open is exactly
// the case worth killing
function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    // windows has no process groups; taskkill walks the tree instead
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {stdio: 'ignore'})
    return
  }
  try {
    process.kill(-child.pid, signal) // negative pid = the whole group
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

/** How long a cancelled ffmpeg gets to close its file before it is killed. */
const KILL_GRACE_MS = 2000

// Left alone, yt-dlp on Windows writes to a pipe in the system code page
// (cp1251 on a Russian install) and silently drops whatever doesn't fit:
// the full-width ： ？ ＂ it swaps into file names, emoji, most scripts. The
// path it prints then names a file that doesn't exist, and a finished
// download reads as a failed one. UTF-8 carries every name intact.
const UTF8_OUTPUT = ['--encoding', 'utf-8']

/** Spawn yt-dlp in its own process group and tie the abort signal to it. */
function spawnYtDlp(cmd: string, args: string[], signal?: AbortSignal): ChildProcessWithoutNullStreams {
  const child = spawn(cmd, [...UTF8_OUTPUT, ...args], {detached: OWN_GROUP})
  // decoded as a stream, so a character split across two chunks survives
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  if (!signal) return child

  const onAbort = () => {
    killTree(child)
    // the follow-up is never cancelled, not even once yt-dlp is gone: it dies
    // first and its ffmpeg keeps the file open, which is the whole problem
    setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS).unref()
  }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, {once: true})
  child.on('close', () => signal.removeEventListener('abort', onAbort))
  return child
}

let activeChild: ChildProcess | undefined
process.on('exit', () => activeChild && killTree(activeChild))

export function download(
  opts: {
    ytdlp: string
    ffmpegLocation?: string
    url: string
    /** When set, reuse the probe's metadata instead of re-extracting — starts much faster. */
    infoJsonPath?: string
    cookiesFrom?: string
    choice: DownloadChoice
    outDir: string
  },
  handlers: DownloadHandlers,
  signal?: AbortSignal,
): Promise<string> {
  const args = [
    ...(opts.infoJsonPath ? ['--load-info-json', opts.infoJsonPath] : [opts.url]),
    ...opts.choice.args,
    ...cookieArgs(opts.cookiesFrom),
    '--concurrent-fragments',
    CONCURRENT_FRAGMENTS,
    '--no-playlist',
    '--no-warnings',
    '--newline',
    // --print implies --quiet, which suppresses progress bars and the
    // [Merger]/[ExtractAudio] lines we detect the processing phase from
    '--no-quiet',
    '--progress',
    '--progress-template',
    `download:${PROGRESS_TEMPLATE}`,
    '--print',
    `after_move:${PATH_PREFIX}%(filepath)s`,
    '--no-simulate',
    '-o',
    path.join(opts.outDir, '%(title).60s.%(ext)s'),
  ]
  if (opts.ffmpegLocation) args.push('--ffmpeg-location', opts.ffmpegLocation)

  return new Promise((resolve, reject) => {
    const child = spawnYtDlp(opts.ytdlp, args, signal)
    activeChild = child

    let stderr = ''
    let filepath = ''
    // best guess from yt-dlp's own log, in case it prints no final path
    let produced = ''
    let part = 0
    let totalParts = 1
    let lastDownloaded = 0
    let buffer = ''
    // every file yt-dlp writes this run, so a cancel can clean up after itself
    const destinations: string[] = []

    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        if (line.startsWith(PROGRESS_PREFIX)) {
          const [downloaded, total, totalEstimate, speed, eta] = line.slice(PROGRESS_PREFIX.length).split('|')
          const downloadedBytes = toNumber(downloaded) ?? 0
          if (downloadedBytes < lastDownloaded) part++
          lastDownloaded = downloadedBytes
          handlers.onProgress({
            downloadedBytes,
            totalBytes: toNumber(total) ?? toNumber(totalEstimate),
            speed: toNumber(speed),
            eta: toNumber(eta),
            part,
            totalParts,
          })
        } else if (line.includes('Downloading 1 format(s):')) {
          // "[info] xxx: Downloading 1 format(s): 395+251" — each id is one file
          totalParts = (line.split('format(s):')[1] ?? '').trim().split('+').length
        } else if (line.startsWith(PATH_PREFIX)) {
          filepath = line.slice(PATH_PREFIX.length)
        } else if (isPostProcessorLine(line)) {
          const merging = /^\[Merger\] Merging formats into "(.+)"$/.exec(line)?.[1]
          const extracting = /^\[ExtractAudio\] Destination: (.+)$/.exec(line)?.[1]
          const target = merging ?? extracting
          if (target) {
            destinations.push(target)
            // whatever a post-processor writes last is the file the user wants
            produced = target
          }
          handlers.onProcessing()
        } else if (line.startsWith('[download] Destination: ')) {
          const target = line.slice('[download] Destination: '.length)
          destinations.push(target)
          // a plain single-file download is never named again after this;
          // a merge overwrites it below with the merged file
          if (!produced) produced = target
        } else {
          // "[download] /path/file.mp4 has already been downloaded" — nothing
          // is written this run, so no post-processor names the file
          const existing = /^\[download\] (.+) has already been downloaded$/.exec(line)?.[1]
          if (existing) produced = existing
        }
      }
    })
    child.stderr.on('data', chunk => (stderr += chunk))
    child.on('error', reject)
    child.on('close', code => {
      activeChild = undefined
      if (signal?.aborted) {
        // cancelled on purpose — don't leave half-written files behind, and
        // wait out the ffmpeg that may still be closing one of them
        void waitForTreeExit(child.pid).then(() => removePartials(destinations))
        reject(new Error('Download cancelled.'))
        return
      }
      if (code !== 0) {
        reject(new Error(cleanYtDlpError(stderr) || `Download failed (yt-dlp exit code ${code}).`))
        return
      }
      // a finished download whose path yt-dlp never printed used to be
      // reported as a failure, with the file sitting on disk all along
      resolveFinalPath(filepath, produced).then(
        found => {
          if (found) resolve(found)
          else reject(new Error(cleanYtDlpError(stderr) || 'yt-dlp finished but wrote no file.'))
        },
        () => reject(new Error('yt-dlp finished but wrote no file.')),
      )
    })
  })
}

/**
 * Pick the path of the file that actually exists. yt-dlp normally prints it,
 * but it stays quiet in a few cases (a post-processor that decides there is
 * nothing to do, an older build) — its log still names the file.
 */
export async function resolveFinalPath(printed: string, produced: string): Promise<string | undefined> {
  for (const candidate of [printed, produced]) {
    if (!candidate) continue
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile()) return candidate
    } catch {
      // named but not there — try the next candidate
    }
  }
  return undefined
}

/** Give a killed process group time to actually die before touching its files. */
async function waitForTreeExit(pid: number | undefined, ms = KILL_GRACE_MS): Promise<void> {
  if (!pid || process.platform === 'win32') return
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      process.kill(-pid, 0)
    } catch {
      return // the group is gone
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

export async function removePartials(destinations: string[]): Promise<void> {
  const targets = new Set<string>()
  for (const dest of destinations) {
    const ext = path.extname(dest)
    targets.add(dest)
    targets.add(`${dest}.part`)
    targets.add(`${dest}.ytdl`)
    // ffmpeg merges into a neighbouring file and renames it only at the end
    targets.add(`${dest.slice(0, dest.length - ext.length)}.temp${ext}`)
    // an interrupted fragmented download leaves its fragments behind too
    const base = path.basename(dest)
    try {
      for (const name of await fs.readdir(path.dirname(dest))) {
        if (name.startsWith(`${base}.part-Frag`)) targets.add(path.join(path.dirname(dest), name))
      }
    } catch {
      // the folder went away with the download — nothing to sweep
    }
  }
  await Promise.allSettled([...targets].map(file => fs.rm(file, {force: true})))
}

/**
 * yt-dlp's post-processors announce themselves as "[Merger] …",
 * "[ExtractAudio] …", "[FixupM4a] Correcting container of …" and so on. Any
 * of them means the download is over and ffmpeg is at work — the screen has
 * to say "processing", not sit on a full bar looking frozen.
 */
export const isPostProcessorLine = (line: string) =>
  /^\[(Merger|ExtractAudio|Fixup\w*|VideoRemuxer|VideoConvertor|ModifyChapters|SponsorBlock|EmbedThumbnail|Metadata)\]/.test(line)

function toNumber(value: string | undefined): number | undefined {
  if (!value || value === 'NA' || value === 'None') return undefined
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : undefined
}

function cleanYtDlpError(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('ERROR:'))
  const last = lines.at(-1)
  return last ? last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') : ''
}
