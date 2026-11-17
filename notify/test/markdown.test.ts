import test from 'node:test'
import assert from 'node:assert/strict'
import { parse } from '../src/markdown.ts'

const txt = (v: string) => ({ t: 'text', v })
test('paragraphs split on blank lines', () =>
  assert.deepEqual(parse('a\nb\n\nc'), [{ t: 'para', c: [txt('a\nb')] }, { t: 'para', c: [txt('c')] }]))
test('heading', () => assert.deepEqual(parse('## Hi'), [{ t: 'heading', c: [txt('Hi')] }]))
test('inline marks', () => assert.deepEqual(parse('**b** *i* _j_ `c` [t](https://x.y)'), [{ t: 'para', c: [
  { t: 'bold', c: [txt('b')] }, txt(' '), { t: 'italic', c: [txt('i')] }, txt(' '), { t: 'italic', c: [txt('j')] }, txt(' '),
  { t: 'code', v: 'c' }, txt(' '), { t: 'link', url: 'https://x.y', c: [txt('t')] }] }]))
test('bare url becomes a link', () => assert.deepEqual(parse('see https://x.y/z ok'), [{ t: 'para', c: [
  txt('see '), { t: 'link', url: 'https://x.y/z', c: [txt('https://x.y/z')] }, txt(' ok')] }]))
test('lists', () => assert.deepEqual(parse('- a\n* b\n\n1. c\n2. d'), [
  { t: 'list', ordered: false, items: [[txt('a')], [txt('b')]] }, { t: 'list', ordered: true, items: [[txt('c')], [txt('d')]] }]))
test('quote', () => assert.deepEqual(parse('> q\n> r'), [{ t: 'quote', c: [txt('q\nr')] }]))
test('fenced code keeps its text raw', () => assert.deepEqual(parse('```\n**x**\n```'), [{ t: 'code', v: '**x**' }]))
test('unclosed marks stay text', () => assert.deepEqual(parse('a **b'), [{ t: 'para', c: [txt('a **b')] }]))

test('bare url drops trailing punctuation', () => assert.deepEqual(parse('(go https://x.y/z).'), [{ t: 'para', c: [
  txt('(go '), { t: 'link', url: 'https://x.y/z', c: [txt('https://x.y/z')] }, txt(').')] }]))
test('bare url stops before a comma', () => assert.deepEqual(parse('https://a.b, c'), [{ t: 'para', c: [
  { t: 'link', url: 'https://a.b', c: [txt('https://a.b')] }, txt(', c')] }]))
test('snake_case is not italic', () => assert.deepEqual(parse('a_b_c'), [{ t: 'para', c: [txt('a_b_c')] }]))
test('nested marks', () => assert.deepEqual(parse('**a *b***'), [{ t: 'para', c: [
  { t: 'bold', c: [txt('a '), { t: 'italic', c: [txt('b')] }] }] }]))
test('unclosed fence runs to the end', () => assert.deepEqual(parse('```js\nx'), [{ t: 'code', v: 'x' }]))
test('headings of any level; seven hashes is text', () => {
  assert.deepEqual(parse('###### h'), [{ t: 'heading', c: [txt('h')] }])
  assert.deepEqual(parse('####### h'), [{ t: 'para', c: [txt('####### h')] }])
})
test('empty input', () => assert.deepEqual(parse(''), []))
test('never throws on odd input', () => {
  for (const s of ['*', '**', '`', '[', '[a](', '[a](x)', '> ', '- ', '1.', '```', '_', '\n\n', '[a]()', 'https://']) parse(s)
})
