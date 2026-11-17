import test from 'node:test'
import assert from 'node:assert/strict'
import { hostname } from 'node:os'
import { makeAlert } from '../src/alert.ts'

const env = { RESEND_API_KEY: 'k', EMAIL_FROM: 'hawk@x.y', EMAIL_TO: 'me@x.y' }

test('posts to Resend and returns res.ok', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const fake = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{}', { status: 200 }) }) as typeof fetch
  assert.equal(await makeAlert(env, fake)('hawk: Slack is down', 'body'), true)
  assert.equal(calls[0].url, 'https://api.resend.com/emails')
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer k')
  const body = JSON.parse(calls[0].init.body as string)
  assert.equal(body.from, 'hawk@x.y'); assert.deepEqual(body.to, ['me@x.y']); assert.equal(body.subject, 'hawk: Slack is down')
  assert.ok(body.text.startsWith('body\n') && body.text.endsWith(`(on ${hostname()})`))
})
test('false on a non-2xx response', async () => {
  const fake = (async () => new Response('{}', { status: 422 })) as typeof fetch
  assert.equal(await makeAlert(env, fake)('s', 't'), false)
})
test('false when fetch throws', async () => {
  const fake = (async () => { throw new Error('net') }) as typeof fetch
  assert.equal(await makeAlert(env, fake)('s', 't'), false)
})
test('false and no fetch when RESEND_API_KEY is missing', async () => {
  let called = false
  const fake = (async () => { called = true; return new Response('{}') }) as typeof fetch
  assert.equal(await makeAlert({ ...env, RESEND_API_KEY: undefined }, fake)('s', 't'), false)
  assert.equal(called, false)
})
