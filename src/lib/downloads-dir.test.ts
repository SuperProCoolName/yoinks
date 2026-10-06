import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {ensureDir, parseXdgDownloadDir, resolveUserDir} from './downloads-dir.js'
import {parseArgs} from './args.js'

test('reads a moved or localised downloads folder out of user-dirs.dirs', () => {
  const file = 'XDG_DESKTOP_DIR="$HOME/Рабочий стол"\nXDG_DOWNLOAD_DIR="$HOME/Загрузки"\n'
  assert.equal(parseXdgDownloadDir(file, '/home/me'), '/home/me/Загрузки')
  assert.equal(parseXdgDownloadDir('XDG_DOWNLOAD_DIR=/mnt/big/dl', '/home/me'), '/mnt/big/dl')
  assert.equal(parseXdgDownloadDir('XDG_MUSIC_DIR="$HOME/Music"', '/home/me'), undefined)
})

test('expands a leading ~ and makes the path absolute', () => {
  assert.equal(resolveUserDir('~/Videos'), path.join(os.homedir(), 'Videos'))
  assert.equal(resolveUserDir('~'), os.homedir())
  // a folder literally named "~backup" is not a home directory reference
  assert.equal(resolveUserDir('~backup'), path.resolve('~backup'))
  assert.equal(resolveUserDir('/tmp/x'), '/tmp/x')
})

test('creates a missing folder and reports one it cannot write to', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yoinks-dir-'))
  const nested = path.join(base, 'a', 'b')
  assert.equal(ensureDir(nested), undefined)
  assert.ok(fs.statSync(nested).isDirectory())

  const blocked = path.join(base, 'locked')
  fs.mkdirSync(blocked)
  fs.chmodSync(blocked, 0o500)
  const problem = ensureDir(path.join(blocked, 'child'))
  // root ignores the permission bits, so only assert when they bite
  if (problem) assert.match(problem, /can’t write to/)

  fs.chmodSync(blocked, 0o700)
  fs.rmSync(base, {recursive: true, force: true})
})

test('takes the output folder in every spelling, and auto to give it back', () => {
  assert.equal(parseArgs(['--out', '/videos']).outDir, '/videos')
  assert.equal(parseArgs(['-o', '/videos']).outDir, '/videos')
  assert.equal(parseArgs(['--out=/videos']).outDir, '/videos')
  assert.equal(parseArgs(['--out', 'auto']).outDir, 'auto')
  assert.match(parseArgs(['--out']).error ?? '', /needs a folder/)
  // the folder must not be mistaken for the url, whichever comes first
  assert.equal(parseArgs(['--out', '/videos', 'https://example.com/v']).initialUrl, 'https://example.com/v')
})
