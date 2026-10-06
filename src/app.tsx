import React, {useCallback, useEffect, useRef, useState} from 'react'
import os from 'node:os'
import {Box, Text, useApp, useInput, useStdout} from 'ink'
import Spinner from 'ink-spinner'
import {FramedInput} from './components/framed-input.js'
import {FullScreen} from './components/fullscreen.js'
import {Logo} from './components/logo.js'
import {Panel} from './components/panel.js'
import {ProgressBar} from './components/progress-bar.js'
import {Shortcuts} from './components/shortcuts.js'
import {TextInput} from './components/text-input.js'
import {clickTargetAt, findFrameRow, frameRowSpan, type ClickTarget} from './lib/click-map.js'
import {formatBytes, formatDuration, formatEta, formatSpeed, shortenPath, truncate, wrapText} from './lib/format.js'
import {addToHistory, loadHistory} from './lib/history.js'
import {cookiesForUrl, installedCookieBrowsers, nextCookieMode, resolveCookies, type CookieMode} from './lib/browsers.js'
import {loadConfig, saveConfig} from './lib/config.js'
import {isCookieProblem, needsSignIn, worthRetryingSignedOut} from './lib/errors.js'
import {latinKey} from './lib/keys.js'
import {detectPlatform, isProbablyUrl, type Platform} from './lib/platforms.js'
import {revealInFileManager} from './lib/reveal.js'
import {useMouseClick} from './lib/use-mouse-click.js'
import {nextThemeMode, ThemeProvider, type ThemeMode, useTheme} from './theme.js'
import {
  buildChoices,
  download,
  ensureYtDlp,
  FFMPEG_HINT,
  findFfmpeg,
  probe,
  type DownloadChoice,
  type FfmpegStatus,
  type DownloadProgress,
  type VideoInfo,
} from './lib/ytdlp.js'

const YOINK_BUTTON = 'yoink'
const DONE_LABEL = '↵ yoink another'
const TAGLINE = 'yoink any video. paste. yoink. done.'

const choiceLabel = (choice: DownloadChoice) => `${choice.kind === 'audio' ? '♪ ' : '▶ '}${choice.label}`

/**
 * The format list. Hand-rolled rather than ink-select-input so that j/k
 * work on the Russian layout too (о/л) — that component only knows Latin.
 * ↑↓ and j/k move, ↵ picks, a digit picks that row straight away.
 */
function ChoiceList({
  choices,
  onSelect,
  onHighlight,
}: {
  choices: DownloadChoice[]
  onSelect: (index: number) => void
  onHighlight: (index: number) => void
}) {
  const theme = useTheme()
  const [selected, setSelected] = useState(0)
  const move = (to: number) => {
    const next = (to + choices.length) % choices.length
    setSelected(next)
    onHighlight(next)
  }
  useInput(
    (input, key) => {
      const typed = latinKey(input)
      if (key.upArrow || typed === 'k') move(selected - 1)
      else if (key.downArrow || typed === 'j') move(selected + 1)
      else if (key.return) onSelect(selected)
      else if (/^[1-9]$/.test(input) && Number(input) <= choices.length) onSelect(Number(input) - 1)
    },
    {isActive: Boolean(process.stdin.isTTY) && choices.length > 0},
  )
  return (
    <Box flexDirection="column">
      {choices.map((choice, index) => (
        <Box key={index}>
          <Box marginRight={1}>
            <Text color={theme.primary}>{index === selected ? '❯' : ' '}</Text>
          </Box>
          <Text color={theme.primary} bold={index === selected}>
            {choiceLabel(choice)}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

// explicit blank lines — empty <Box height={1}/> spacers can collapse, and
// ink boxes default to flexShrink=1, so spacers are the first thing yoga
// crushes when content overflows the terminal
const Gap = ({lines = 1}: {lines?: number}) => (
  <Box flexDirection="column" flexShrink={0}>
    {Array.from({length: lines}, (_, i) => (
      <Text key={i}> </Text>
    ))}
  </Box>
)

// fixed-width slots — the centered line must not change width as values tick,
// otherwise the whole layout shifts on every progress update
function partLabel(progress: DownloadProgress): string {
  // explains the bar resetting between files (video, then audio)
  return progress.totalParts > 1 ? `part ${progress.part + 1}/${progress.totalParts}  ` : ''
}

function downloadMeta(progress: DownloadProgress): string {
  const speed = progress.speed ? formatSpeed(progress.speed) : ''
  const eta = progress.eta ? `${formatEta(progress.eta)} left` : ''
  return `${partLabel(progress)}${speed.padStart(10)}  ${eta.padEnd(12)}`
}

function indeterminateMeta(progress: DownloadProgress): string {
  const bytes = formatBytes(progress.downloadedBytes)
  const speed = progress.speed ? formatSpeed(progress.speed) : ''
  return `${partLabel(progress)}${bytes.padStart(8)}  ${speed.padEnd(10)}`
}

export type Outcome = {filepath?: string}

type Phase =
  | {name: 'input'; warning?: string}
  | {name: 'probing'; status: string}
  | {name: 'picking'}
  | {
      name: 'downloading'
      choice: DownloadChoice
      progress?: DownloadProgress
      processing: boolean
      refreshing?: boolean
    }
  | {name: 'done'; filepath: string}
  | {
      name: 'error'
      message: string
      /** A browser to retry with, when the site wants an account we didn't bring. */
      signInWith?: string
    }

const HINTS: Record<Phase['name'], Array<[string, string]>> = {
  input: [
    ['↵', 'yoink'],
    ['^c', 'quit'],
  ],
  probing: [
    ['esc', 'cancel'],
    ['^c', 'quit'],
  ],
  picking: [
    ['↑↓', 'choose'],
    ['↵', 'yoink'],
    ['esc', 'back'],
    ['^c', 'quit'],
  ],
  downloading: [
    ['esc', 'cancel'],
    ['^c', 'quit'],
  ],
  done: [
    ['o', 'open folder'],
    ['^c', 'quit'],
  ],
  error: [
    ['↵', 'try again'],
    ['^c', 'quit'],
  ],
}

type AppProps = {
  initialUrl?: string
  clipboardUrl?: string
  initialThemeMode?: ThemeMode
  /** The remembered cookie setting: a browser, 'off', or undefined for auto. */
  initialCookieMode?: CookieMode
  /** Where finished files land — resolved in cli.tsx, never guessed here. */
  outDir: string
  /** True when the user picked the folder, so it is worth showing on screen. */
  outDirIsCustom?: boolean
  onOutcome: (outcome: Outcome) => void
}

export function App({initialThemeMode = 'auto', ...props}: AppProps) {
  const [themeMode, setThemeMode] = useState(initialThemeMode)
  const cycleTheme = useCallback(() => {
    setThemeMode(nextThemeMode)
  }, [])

  return (
    <ThemeProvider mode={themeMode}>
      <AppContent {...props} cycleTheme={cycleTheme} />
    </ThemeProvider>
  )
}

function AppContent({
  initialUrl,
  clipboardUrl,
  initialCookieMode,
  outDir,
  outDirIsCustom,
  onOutcome,
  cycleTheme,
}: {
  initialUrl?: string
  clipboardUrl?: string
  initialCookieMode?: CookieMode
  outDir: string
  outDirIsCustom?: boolean
  onOutcome: (outcome: Outcome) => void
  cycleTheme: () => void
}) {
  const theme = useTheme()
  const {exit} = useApp()
  const {stdout} = useStdout()
  const [url, setUrl] = useState(initialUrl ?? '')
  const [urlInput, setUrlInput] = useState('')
  const [history, setHistory] = useState(loadHistory)
  const [platform, setPlatform] = useState<Platform>()
  const [info, setInfo] = useState<VideoInfo>()
  const [choices, setChoices] = useState<DownloadChoice[]>([])
  const ytdlpRef = useRef('')
  // looked up once per session, before the format list is built: what ffmpeg
  // can't do has to be known while there is still a choice to make
  const ffmpegRef = useRef<FfmpegStatus | undefined>(undefined)
  const [ffmpegMissing, setFfmpegMissing] = useState(false)
  // the cookie setting, switchable on screen with ^g and remembered like --cookies
  const [cookieMode, setCookieMode] = useState(initialCookieMode)
  const [initialCookies] = useState(() => resolveCookies(initialCookieMode))
  // cookies for this session: dropped for good once they prove unusable
  const cookiesRef = useRef(initialCookies.cookiesFrom as string | undefined)
  // true when the browser was guessed rather than chosen — see cookiesForUrl
  const cookiesAutoRef = useRef(initialCookies.cookiesAuto)
  // browsers whose cookie store turned out unreadable — never offered again
  const unreadableRef = useRef(new Set<string>())
  // …and the ones the current link actually went out with, so the download
  // repeats exactly what the probe got away with
  const usedCookiesRef = useRef<string | undefined>(undefined)
  const [activeCookies, setActiveCookies] = useState(cookiesRef.current)
  const highlightRef = useRef(0) // choice under the cursor, for the ↵ hint click
  const infoJsonRef = useRef<string | undefined>(undefined)
  const abortRef = useRef<AbortController | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>(initialUrl ? {name: 'probing', status: 'warming up…'} : {name: 'input'})

  const columns = stdout?.columns && stdout.columns > 0 ? stdout.columns : 80
  const boxWidth = Math.max(14, Math.min(64, columns - 6))
  const contentWidth = Math.max(10, Math.min(columns - 4, 78))

  // a site that wants an account gets an offer to try again signed in, as
  // long as this attempt went without cookies and a readable browser exists
  const failWith = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    const browser = [cookiesRef.current, ...installedCookieBrowsers()].find(
      candidate => candidate && !unreadableRef.current.has(candidate),
    )
    const signInWith = needsSignIn(error) && !usedCookiesRef.current ? browser : undefined
    setPhase({name: 'error', message, signInWith})
  }, [])

  const switchCookies = useCallback(() => {
    setCookieMode(current => nextCookieMode(current, installedCookieBrowsers()))
  }, [])

  // applied and saved here rather than inside the state updater, which react
  // may run twice
  const firstCookieMode = useRef(true)
  useEffect(() => {
    if (firstCookieMode.current) {
      firstCookieMode.current = false
      return
    }
    const resolved = resolveCookies(cookieMode)
    cookiesRef.current = resolved.cookiesFrom
    cookiesAutoRef.current = resolved.cookiesAuto
    setActiveCookies(resolved.cookiesFrom)
    saveConfig({...loadConfig(), cookiesFrom: cookieMode})
  }, [cookieMode])

  const startProbe = useCallback(async (targetUrl: string, signInWith?: string) => {
    const controller = new AbortController()
    abortRef.current = controller
    setPlatform(detectPlatform(targetUrl))
    setPhase({name: 'probing', status: 'warming up…'})
    try {
      const ytdlp =
        ytdlpRef.current ||
        (await ensureYtDlp(status => setPhase({name: 'probing', status}), controller.signal))
      ytdlpRef.current = ytdlp
      if (controller.signal.aborted) return
      setPhase({name: 'probing', status: 'fetching video info…'})
      const ffmpeg = (ffmpegRef.current ??= await findFfmpeg())
      setFfmpegMissing(!ffmpeg.available)
      // cookies a browser we guessed may be locked, encrypted, or simply
      // unwelcome on this site — never let them cost a link that works
      // signed out anyway
      // signInWith is the user asking for it after a sign-in error, which
      // beats every rule about guessed cookies
      const wanted = signInWith ?? cookiesForUrl(cookiesRef.current, cookiesAutoRef.current, targetUrl)
      usedCookiesRef.current = wanted
      let result
      try {
        result = await probe(ytdlp, targetUrl, {cookiesFrom: wanted}, controller.signal)
      } catch (error) {
        if (controller.signal.aborted) throw error
        if (isCookieProblem(error) && wanted) unreadableRef.current.add(wanted)
        // only a guess is worth abandoning, and only when going signed out
        // could change the answer — not for a dead network or a missing video
        if (signInWith || !cookiesAutoRef.current || !wanted || !worthRetryingSignedOut(error)) throw error
        // an unreadable cookie store stays unreadable: stop asking for the
        // rest of the session. Any other failure only retires the cookies
        // for this one link
        if (isCookieProblem(error)) {
          cookiesRef.current = undefined
          setActiveCookies(undefined)
        }
        usedCookiesRef.current = undefined
        result = await probe(ytdlp, targetUrl, {}, controller.signal)
      }
      const {info: videoInfo, infoJsonPath} = result
      if (controller.signal.aborted) return
      infoJsonRef.current = infoJsonPath
      setInfo(videoInfo)
      setChoices(buildChoices(videoInfo, {ffmpeg: ffmpeg.available}))
      highlightRef.current = 0
      setPhase({name: 'picking'})
    } catch (error) {
      if (controller.signal.aborted) return
      failWith(error)
    }
  }, [])

  useEffect(() => {
    if (initialUrl) void startProbe(initialUrl)
  }, [initialUrl, startProbe])

  const [revealFailed, setRevealFailed] = useState(false)

  const openFolder = useCallback((filepath: string) => {
    void revealInFileManager(filepath).then(opened => setRevealFailed(!opened))
  }, [])

  const resetToInput = useCallback(() => {
    setUrl('')
    setUrlInput('')
    setPlatform(undefined)
    setInfo(undefined)
    setChoices([])
    setRevealFailed(false)
    setPhase({name: 'input'})
  }, [])

  const cancelRun = useCallback(() => {
    abortRef.current?.abort()
    resetToInput()
    setUrlInput(url) // keep the link around so a cancel isn't destructive
  }, [resetToInput, url])

  useInput(
    (input, key) => {
      if (key.ctrl && input === 't') {
        cycleTheme()
        return
      }
      if (key.ctrl && input === 'g' && phase.name === 'input') {
        switchCookies()
        return
      }
      // single-key shortcuts answer on any keyboard layout: щ is o, с is c
      const typed = key.ctrl || key.meta ? '' : latinKey(input)
      if (typed === 'o' && phase.name === 'done') {
        openFolder(phase.filepath)
        return
      }
      if (typed === 'c' && phase.name === 'error' && phase.signInWith) {
        void startProbe(url, phase.signInWith)
        return
      }
      if (key.escape && (phase.name === 'picking' || phase.name === 'error' || phase.name === 'done')) resetToInput()
      if (key.escape && (phase.name === 'probing' || phase.name === 'downloading')) cancelRun()
      if (key.return && (phase.name === 'error' || phase.name === 'done')) resetToInput()
    },
    {isActive: Boolean(process.stdin.isTTY)},
  )

  const handleUrlSubmit = (value: string) => {
    const trimmed = value.trim()
    if (!isProbablyUrl(trimmed)) {
      setPhase({name: 'input', warning: 'that doesn’t look like a link — paste a full url'})
      return
    }
    setUrl(trimmed)
    void startProbe(trimmed)
  }

  const clipboardOffered = Boolean(clipboardUrl) && urlInput === ''
  const clipboardAccepted = Boolean(clipboardUrl) && urlInput === clipboardUrl

  const handlePick = (item: {value: number}) => {
    const choice = choices[item.value]
    const controller = new AbortController()
    abortRef.current = controller
    setPhase({name: 'downloading', choice, processing: false})
    void (async () => {
      const handlers = {
        onProgress: (progress: DownloadProgress) =>
          setPhase(prev => (prev.name === 'downloading' ? {...prev, progress, processing: false} : prev)),
        onProcessing: () =>
          setPhase(prev => (prev.name === 'downloading' ? {...prev, processing: true} : prev)),
      }
      try {
        const base = {
          ytdlp: ytdlpRef.current,
          ffmpegLocation: ffmpegRef.current?.location,
          url,
          choice,
          cookiesFrom: usedCookiesRef.current,
          outDir,
        }
        let filepath: string
        try {
          // reuse the probe's metadata — starts immediately instead of re-extracting
          filepath = await download({...base, infoJsonPath: infoJsonRef.current}, handlers, controller.signal)
        } catch (error) {
          if (controller.signal.aborted) throw error
          // media urls in the cached info can expire — retry with a fresh extraction
          setPhase(prev =>
            prev.name === 'downloading' ? {...prev, progress: undefined, refreshing: true} : prev,
          )
          filepath = await download(base, handlers, controller.signal)
        }
        onOutcome({filepath})
        setHistory(addToHistory(url))
        setPhase({name: 'done', filepath})
      } catch (error) {
        if (controller.signal.aborted) return
        failWith(error)
      }
    })()
  }

  let hints: Array<[string, string]> = [...HINTS[phase.name], ['^t', `theme:${theme.mode}`]]
  if (phase.name === 'input') {
    // auto names the browser it settled on, so nobody wonders whose session it is
    const cookies = cookieMode === 'off' ? 'off' : cookieMode ?? (activeCookies ? `auto (${activeCookies})` : 'auto')
    hints = [hints[0]!, ...(history.length > 0 ? [['↑', 'history'] as [string, string]] : []), ['^g', `cookies:${cookies}`], ...hints.slice(1)]
  }
  if (phase.name === 'error' && phase.signInWith) {
    hints = [['c', `retry with ${phase.signInWith} cookies`], ...hints]
  }

  // Anything a mouse user would expect to press is clickable. Targets are
  // found by their text in the rendered frame (see lib/click-map.ts), so
  // there is no layout math to keep in sync.
  const hintAction = (key: string): (() => void) | undefined => {
    if (key === '^c') return () => exit()
    if (key === '^t') return cycleTheme
    if (key === '^g') return switchCookies
    if (key === 'c' && phase.name === 'error' && phase.signInWith) {
      const browser = phase.signInWith
      return () => void startProbe(url, browser)
    }
    if (key === 'o' && phase.name === 'done') return () => openFolder(phase.filepath)
    if (key === 'esc') return phase.name === 'probing' || phase.name === 'downloading' ? cancelRun : resetToInput
    if (key === '↵') {
      if (phase.name === 'input') return () => handleUrlSubmit(urlInput)
      if (phase.name === 'picking') return () => handlePick({value: highlightRef.current})
      if (phase.name === 'error' || phase.name === 'done') return resetToInput
    }
    return undefined // ↑↓ / ↑ stay keyboard-only
  }
  const clickTargets: ClickTarget[] = []
  if (phase.name === 'input') {
    // the frame button rows above/below the label are part of the button
    clickTargets.push({match: `  ${YOINK_BUTTON}  `, padY: 1, action: () => handleUrlSubmit(urlInput)})
  }
  if (phase.name === 'picking') {
    for (const [index, choice] of choices.entries()) {
      clickTargets.push({match: choiceLabel(choice), action: () => handlePick({value: index})})
    }
  }
  if (phase.name === 'done') {
    clickTargets.push({match: DONE_LABEL, padX: 4, padY: 1, action: resetToInput})
  }
  for (const [key, label] of hints) {
    const action = hintAction(key)
    if (action) clickTargets.push({match: `${key} ${label}`, action})
  }

  useMouseClick(
    (x, y) => {
      // the logo takes you home — it's the 3 rows one gap above the tagline
      const taglineRow = findFrameRow(TAGLINE)
      if (taglineRow > 3 && y - 1 >= taglineRow - 4 && y - 1 <= taglineRow - 2) {
        const span = frameRowSpan(y - 1)
        if (span && x >= span[0] - 1 && x <= span[1] + 1) {
          if (phase.name === 'probing' || phase.name === 'downloading') cancelRun()
          else if (phase.name !== 'input') resetToInput()
          return
        }
      }
      clickTargetAt(x, y, clickTargets)?.action()
    },
    Boolean(process.stdin.isTTY),
  )

  return (
    <FullScreen>
      <Logo />
      <Gap />
      <Text color={theme.primary}>{TAGLINE}</Text>
      <Text color={theme.gray} dimColor={theme.dimSecondary}>youtube · x · instagram · threads · tiktok · +1800 more</Text>
      <Gap />

      {phase.name === 'input' && (
        <Box flexDirection="column" alignItems="center">
          <FramedInput title="Paste a link" width={boxWidth} button={YOINK_BUTTON}>
            <TextInput
              value={urlInput}
              onChange={setUrlInput}
              onSubmit={handleUrlSubmit}
              placeholder="https://youtube.com/watch?v=…"
              width={boxWidth - 6}
              history={history}
              submitOnPaste={isProbablyUrl}
              onTab={() => {
                if (clipboardOffered) setUrlInput(clipboardUrl!)
              }}
            />
          </FramedInput>
          {phase.warning ? (
            <Text color={theme.gray} dimColor={theme.dimSecondary}>✗ {phase.warning}</Text>
          ) : clipboardOffered ? (
            <Text color={theme.gray} dimColor={theme.dimSecondary}>link in your clipboard — ⇥ to paste it</Text>
          ) : clipboardAccepted ? (
            <Text color={theme.gray} dimColor={theme.dimSecondary}>from your clipboard — ↵ to yoink it</Text>
          ) : null}
        </Box>
      )}

      {phase.name === 'probing' && (
        <Box flexDirection="column" alignItems="center">
          <FramedInput title={platform ? platform.label : 'Paste a link'} width={boxWidth} button={YOINK_BUTTON} buttonDim>
            <Text color={theme.gray} dimColor={theme.dimSecondary}>{url.length > boxWidth - 8 ? `${url.slice(0, boxWidth - 9)}…` : url}</Text>
          </FramedInput>
        </Box>
      )}

      {phase.name === 'picking' && platform && (
        <Box width={contentWidth}>
          <Box flexDirection="column" flexGrow={1} flexBasis={0} paddingTop={1} paddingRight={3}>
            {/* wrapped by hand so continuation lines stay flush left —
                ink's wrapping keeps the break's space as a 1-cell indent */}
            {wrapText(info?.title ?? '', Math.max(10, contentWidth - 41)).map((line, index) => (
              <Text key={index} bold color={theme.primary}>
                {line}
              </Text>
            ))}
            <Gap />
            <Text color={theme.gray} dimColor={theme.dimSecondary}>
              ▸ {platform.label}
              {info?.duration ? ` · ${formatDuration(info.duration)}` : ''}
              {info?.uploader ? ` · ${info.uploader}` : ''}
            </Text>
          </Box>
          <Panel title="Download" width={38}>
            <ChoiceList
              choices={choices}
              onSelect={index => handlePick({value: index})}
              onHighlight={index => (highlightRef.current = index)}
            />
          </Panel>
        </Box>
      )}

      {phase.name === 'downloading' && (
        <Box flexDirection="column" alignItems="center">
          <Text color={theme.gray} dimColor={theme.dimSecondary}>
            {info?.title ? `${truncate(info.title, 42)} · ` : ''}
            {phase.choice.label}
          </Text>
          <Gap />
          {/* every branch is exactly three rows — bar, gap, meta — so the layout never jumps */}
          {phase.processing ? (
            <>
              <ProgressBar percent={1} />
              <Gap />
              <Text>
                <Text color={theme.primary}>
                  <Spinner type="dots" />
                </Text>
                <Text color={theme.gray} dimColor={theme.dimSecondary}> processing…</Text>
              </Text>
            </>
          ) : phase.progress?.totalBytes ? (
            <>
              <ProgressBar percent={phase.progress.downloadedBytes / phase.progress.totalBytes} />
              <Gap />
              <Text color={theme.gray} dimColor={theme.dimSecondary}>{downloadMeta(phase.progress)}</Text>
            </>
          ) : phase.progress ? (
            <>
              <Text>
                <Text color={theme.primary}>
                  <Spinner type="dots" />
                </Text>
                <Text color={theme.gray} dimColor={theme.dimSecondary}> downloading…</Text>
              </Text>
              <Gap />
              <Text color={theme.gray} dimColor={theme.dimSecondary}>{indeterminateMeta(phase.progress)}</Text>
            </>
          ) : (
            <>
              <ProgressBar percent={0} />
              <Gap />
              <Text>
                <Text color={theme.primary}>
                  <Spinner type="dots" />
                </Text>
                <Text color={theme.gray} dimColor={theme.dimSecondary}>
                  {phase.refreshing ? ' link expired — grabbing a fresh one…' : ' starting download…'}
                </Text>
              </Text>
            </>
          )}
        </Box>
      )}

      {phase.name === 'done' && (
        <Box flexDirection="column" alignItems="center">
          <Text>
            <Text bold color={theme.primary}>✓ yoinked! </Text>
            <Text color={theme.primary}>find your file in:</Text>
          </Text>
          <Text color={theme.gray} dimColor={theme.dimSecondary}>{shortenPath(phase.filepath, os.homedir(), 60)}</Text>
          {revealFailed ? (
            <Text color={theme.gray} dimColor={theme.dimSecondary}>✗ no file manager to open it with</Text>
          ) : null}
          <Gap />
          <Box
            borderStyle="round"
            borderColor={theme.gray}
            borderDimColor={theme.dimSecondary}
            borderBackgroundColor={theme.background}
            paddingX={3}
          >
            <Text bold color={theme.primary}>{DONE_LABEL}</Text>
          </Box>
        </Box>
      )}

      {phase.name === 'error' && (
        <Box flexDirection="column" alignItems="center" width={Math.max(10, Math.min(columns - 6, 72))}>
          <Text bold color={theme.primary}>✗ {phase.message}</Text>
        </Box>
      )}

      {hints.length > 0 ? (
        <>
          <Gap lines={2} />
          <Shortcuts
            items={hints}
            leading={
              phase.name === 'probing' ? (
                <Text>
                  <Text color={theme.primary}>
                    <Spinner type="dots" />
                  </Text>
                  <Text color={theme.gray} dimColor={theme.dimSecondary}> {phase.status}</Text>
                </Text>
              ) : phase.name === 'picking' && ffmpegMissing ? (
                // the list is shorter than usual on this machine — say why
                // here, next to the choices it affects
                <Text color={theme.gray} dimColor={theme.dimSecondary}>{FFMPEG_HINT}</Text>
              ) : phase.name === 'input' && outDirIsCustom ? (
                // a remembered folder is silent otherwise, and "where did my
                // file go?" deserves an answer on screen. The default
                // downloads folder needs no announcement; cookies have their
                // own ^g switch
                <Text color={theme.gray} dimColor={theme.dimSecondary}>→ {shortenPath(outDir, os.homedir(), 28)}</Text>
              ) : undefined
            }
          />
        </>
      ) : null}
    </FullScreen>
  )
}
