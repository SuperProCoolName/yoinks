import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {buildChoices, firstWorking, isPostProcessorLine, removePartials, resolveFinalPath, type VideoInfo} from './ytdlp.js'

// a youtube-shaped answer: every resolution exists twice, once as a plain
// https stream that yt-dlp has measured and once as an hls copy it hasn't
const youtubeish: VideoInfo = {
  title: 'clip',
  duration: 100,
  formats: [
    {format_id: '96', ext: 'mp4', vcodec: 'avc1.4d', acodec: 'none', height: 720, tbr: 900, protocol: 'm3u8_native'},
    {format_id: '136', ext: 'mp4', vcodec: 'avc1.4d', acodec: 'none', height: 720, tbr: 600, filesize: 8_000_000, protocol: 'https'},
    {format_id: '135', ext: 'mp4', vcodec: 'avc1.4d', acodec: 'none', height: 480, tbr: 300, filesize: 4_000_000, protocol: 'https'},
    {format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', abr: 129, filesize: 2_000_000, protocol: 'https'},
    {format_id: '251', ext: 'webm', vcodec: 'none', acodec: 'opus', abr: 131, filesize: 2_100_000, protocol: 'https'},
  ],
}

test('a resolution weighs its own video stream plus the audio it is merged with', () => {
  const [best, second] = buildChoices(youtubeish)
  // 8 MB video + 2 MB m4a, both measured — no tilde, and no two rows alike
  assert.equal(best?.label, '720p · mp4 · 9.5 MB')
  assert.equal(second?.label, '480p · mp4 · 5.7 MB')
})

test('pins the streams it measured, keeping the generic selectors as fallback', () => {
  const [best] = buildChoices(youtubeish)
  assert.equal(best?.args[1], '136+140/bv*[height=720]+ba/b[height=720]/bv*[height<=720]+ba/b')
})

test('an hls duplicate never wins on bitrate alone', () => {
  // 96 has the higher bitrate but carries no size: picking it used to leave
  // every row showing the audio track's size and nothing else
  const [best] = buildChoices(youtubeish)
  assert.ok(best?.args[1]?.startsWith('136+140'))
  assert.ok(!best?.label.includes('~'))
})

test('says nothing rather than quoting a size that is missing the video', () => {
  const sizeless: VideoInfo = {
    title: 'clip',
    formats: [
      {format_id: 'v', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 720, protocol: 'https'},
      {format_id: 'a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', filesize: 2_000_000, protocol: 'https'},
    ],
  }
  assert.equal(buildChoices(sizeless)[0]?.label, '720p · mp4')
})

test('estimates from the bitrate when nothing has been measured, and marks it as a guess', () => {
  const hlsOnly: VideoInfo = {
    title: 'stream',
    duration: 60,
    formats: [{format_id: '720', ext: 'mp4', vcodec: 'avc1', acodec: 'mp4a', height: 720, tbr: 800, protocol: 'm3u8_native'}],
  }
  // 800 kbit/s over 60 s ≈ 6 MB, and the tilde says it is arithmetic
  assert.equal(buildChoices(hlsOnly)[0]?.label, '720p · mp4 · ~5.7 MB')
})

test('sizes the mp3 by what lame will write, not by the source track', () => {
  const audio = buildChoices(youtubeish).at(-1)
  // the 2.1 MB opus source becomes ~245 kbit/s of mp3 over 100 s
  assert.equal(audio?.label, 'audio only · mp3 · ~2.9 MB')
})

test('a finished file is found even when yt-dlp printed no path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-test-'))
  const file = path.join(dir, 'clip.mp4')
  await fs.writeFile(file, 'x')

  // the printed path wins when it is there
  assert.equal(await resolveFinalPath(file, path.join(dir, 'other.mp4')), file)
  // and the log's own name carries the run when it isn't
  assert.equal(await resolveFinalPath('', file), file)
  // a name that points at nothing must not be handed back as a result
  assert.equal(await resolveFinalPath('', path.join(dir, 'gone.mp4')), undefined)
  assert.equal(await resolveFinalPath('', ''), undefined)
  // a directory is not a download
  assert.equal(await resolveFinalPath(dir, ''), undefined)

  await fs.rm(dir, {recursive: true, force: true})
})

test('without ffmpeg nothing is merged and silent streams say so', () => {
  const withMuxed: VideoInfo = {
    title: 'clip',
    duration: 100,
    formats: [
      ...(youtubeish.formats ?? []),
      {format_id: '18', ext: 'mp4', vcodec: 'avc1.42', acodec: 'mp4a', height: 360, tbr: 500, filesize: 6_000_000, protocol: 'https'},
    ],
  }
  const choices = buildChoices(withMuxed, {ffmpeg: false})

  // 360p carries its own audio; the higher ones can only come without it, and
  // the label has to admit that before the download, not after
  assert.deepEqual(choices.map(c => c.label), [
    '720p · mp4 · muted · 7.6 MB',
    '480p · mp4 · muted · 3.8 MB',
    '360p · mp4 · 5.7 MB',
    'audio only · webm · 2.0 MB',
  ])
  // and nothing asks yt-dlp to merge or re-encode
  const args = choices.flatMap(c => c.args).join(' ')
  assert.ok(!args.includes('+'), args)
  assert.ok(!args.includes('-x'), args)
})

test('with ffmpeg present the merged formats stay', () => {
  assert.equal(buildChoices(youtubeish, {ffmpeg: true}).length, buildChoices(youtubeish).length)
})

test('a list where nothing has sound leaves the labels alone', () => {
  // every line saying "muted" is noise; the footer's ffmpeg notice says it once
  const labels = buildChoices(youtubeish, {ffmpeg: false}).map(c => c.label)
  assert.deepEqual(labels, ['720p · mp4 · 7.6 MB', '480p · mp4 · 3.8 MB', 'audio only · webm · 2.0 MB'])
})

test('our own yt-dlp beats one found on PATH', async () => {
  const tried: string[] = []
  const works = async (cmd: string) => {
    tried.push(cmd)
    return true
  }
  assert.equal(await firstWorking(['/home/u/.yoinks/bin/yt-dlp', 'yt-dlp'], works), '/home/u/.yoinks/bin/yt-dlp')
  // and PATH isn't even asked once ours answers
  assert.deepEqual(tried, ['/home/u/.yoinks/bin/yt-dlp'])
  // a broken copy of ours falls through to the system one
  assert.equal(await firstWorking(['ours', 'yt-dlp'], async cmd => cmd === 'yt-dlp'), 'yt-dlp')
  assert.equal(await firstWorking(['ours', 'yt-dlp'], async () => false), undefined)
})

test('every post-processor counts as processing, not just merge and mp3', () => {
  for (const line of [
    '[Merger] Merging formats into "/d/clip.mp4"',
    '[ExtractAudio] Destination: /d/clip.mp3',
    '[FixupM4a] Correcting container of "/d/clip.m4a"',
    '[FixupM3u8] Fixing MPEG-TS in MP4 container of "/d/clip.mp4"',
    '[VideoRemuxer] Remuxing video from webm to mp4',
  ]) {
    assert.ok(isPostProcessorLine(line), line)
  }
  for (const line of ['[download] Destination: /d/clip.f140.m4a', '[info] abc: Downloading 1 format(s): 140', '[youtube] abc: Downloading webpage']) {
    assert.ok(!isPostProcessorLine(line), line)
  }
})

test('cancel cleanup copes with awkward names and sweeps every leftover', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-тест «кавычки» '))
  const dest = path.join(dir, `Клип — 'quotes' & [brackets] #1 😀.mp4`)
  const leftovers = [dest, `${dest}.part`, `${dest}.ytdl`, `${dest}.part-Frag1`, `${dest}.part-Frag12`]
  const merging = path.join(dir, `Клип — 'quotes' & [brackets] #1 😀.temp.mp4`)
  const bystander = path.join(dir, 'someone else.mp4')
  for (const file of [...leftovers, merging, bystander]) await fs.writeFile(file, 'x')

  await removePartials([dest])

  assert.deepEqual(await fs.readdir(dir), ['someone else.mp4'])
  // a destination whose folder vanished must not throw
  await removePartials([path.join(dir, 'gone', 'clip.mp4')])
  await fs.rm(dir, {recursive: true, force: true})
})

test('the finished file is found under an awkward name too', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yoinks-'))
  const file = path.join(dir, 'Видео: "часть 2" (финал) ?.mp4'.replace(/[:"?]/g, process.platform === 'win32' ? '_' : '$&'))
  await fs.writeFile(file, 'x')
  assert.equal(await resolveFinalPath('', file), file)
  await fs.rm(dir, {recursive: true, force: true})
})

test('a page with no formats at all still offers something to try', () => {
  const labels = buildChoices({title: 'bare'}).map(c => c.label)
  assert.deepEqual(labels, ['best available · mp4', 'audio only · mp3'])
})
