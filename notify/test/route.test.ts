import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from '../src/route.ts'
import type { Routes } from '../src/route.ts'

const r: Routes = { default: { slack: '#d' }, routes: {
  'a.*': { slack: '#a' }, 'a.b.*': { slack: '#ab' }, 'a.b.c': { slack: '#exact' } } }
test('exact beats prefix', () => assert.deepEqual(resolve(r, 'a.b.c'), { slack: '#exact' }))
test('longest prefix wins', () => assert.deepEqual(resolve(r, 'a.b.x'), { slack: '#ab' }))
test('shorter prefix', () => assert.deepEqual(resolve(r, 'a.z'), { slack: '#a' }))
test('prefix needs a dot boundary', () => assert.deepEqual(resolve(r, 'ab.c'), { slack: '#d' }))
test('no match → default', () => assert.deepEqual(resolve(r, 'z.y'), { slack: '#d' }))
