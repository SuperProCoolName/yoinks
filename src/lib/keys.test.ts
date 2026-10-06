import assert from 'node:assert/strict'
import test from 'node:test'
import {latinKey} from './keys.js'

test('a shortcut typed on the Russian layout reads as its Latin key', () => {
  assert.equal(latinKey('щ'), 'o')
  assert.equal(latinKey('с'), 'c')
  assert.equal(latinKey('о'), 'j')
  assert.equal(latinKey('л'), 'k')
  // shift keeps its meaning
  assert.equal(latinKey('Щ'), 'O')
})

test('everything else passes through untouched', () => {
  for (const input of ['o', 'j', '1', '', 'ё', 'щщ', '\r', '[']) assert.equal(latinKey(input), input)
})
