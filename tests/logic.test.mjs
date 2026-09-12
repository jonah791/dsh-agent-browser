/**
 * dsh-agent-browser 纯逻辑层单测（2026-09-12 · 本插件首次有自动化证据）。
 *
 * 跑 lib 产物（`node --test "tests/*.test.mjs"`）。样本构成：常规 + 边界 + **尸体**
 * （损坏状态文件 / 未来时间戳 / 超长文本 / 非法形状）——防线的测试必须带已知坏样本
 * （SOUL §5.9 §2、§5.17 §6）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  PAGE_MAX, normalizePage, parseClientState, toLogItem, appendLogs, isClientFresh,
} from '../lib/logic.js'

describe('normalizePage · 心跳页面归一化', () => {
  test('常规：原样返回', () => {
    assert.equal(normalizePage('http://127.0.0.1:3080/panel/'), 'http://127.0.0.1:3080/panel/')
  })
  test('边界：恰好 PAGE_MAX 不截断，超一字符即截断', () => {
    const at = 'a'.repeat(PAGE_MAX)
    assert.equal(normalizePage(at).length, PAGE_MAX)
    assert.equal(normalizePage(at + 'b').length, PAGE_MAX)
  })
  test('尸体：非字符串一律归空（不抛、不写 "undefined"）', () => {
    for (const bad of [undefined, null, 123, {}, [], true]) {
      assert.equal(normalizePage(bad), '')
    }
  })
  test('空串 → 空串（调用方据此不覆盖已有 page）', () => {
    assert.equal(normalizePage(''), '')
  })
})

describe('parseClientState · 状态文件解析', () => {
  test('常规：合法 JSON 解析成功', () => {
    assert.deepEqual(parseClientState('{"lastSeenAt":1000,"page":"/a"}'), { lastSeenAt: 1000, page: '/a' })
  })
  test('前向兼容：多余字段被忽略', () => {
    assert.deepEqual(parseClientState('{"lastSeenAt":1,"page":"/x","future":true}'), { lastSeenAt: 1, page: '/x' })
  })
  test('尸体：损坏 JSON / 空内容 / 非对象 → null（调用方保持内存态，不用半截数据覆盖）', () => {
    for (const bad of ['{oops', '', '   ', 'null', '123', '"str"', '[1,2]']) {
      assert.equal(parseClientState(bad), null, JSON.stringify(bad))
    }
  })
  test('尸体：字段缺失或类型不符 → null', () => {
    assert.equal(parseClientState('{"page":"/a"}'), null)
    assert.equal(parseClientState('{"lastSeenAt":1}'), null)
    assert.equal(parseClientState('{"lastSeenAt":"1","page":"/a"}'), null)
    assert.equal(parseClientState('{"lastSeenAt":1,"page":2}'), null)
  })
})

describe('toLogItem · 单条上报', () => {
  const opts = { maxText: 10, page: '/p', nowMs: 5000 }

  test('常规：字段齐全原样保留', () => {
    assert.deepEqual(toLogItem({ t: 1, level: 'warn', text: 'hi' }, opts), { t: 1, level: 'warn', text: 'hi', page: '/p' })
  })
  test('缺省：level→info，t→注入的 nowMs；text 截断到 maxText', () => {
    assert.deepEqual(toLogItem({ text: 'abcdefghijklmno' }, opts), { t: 5000, level: 'info', text: 'abcdefghij', page: '/p' })
  })
  test('边界：text 恰好 maxText 不截断', () => {
    assert.equal(toLogItem({ text: 'a'.repeat(10) }, opts)?.text.length, 10)
  })
  test('尸体：空串文本被丢弃；纯空白保留（与原实现一致）', () => {
    assert.equal(toLogItem({ text: '' }, opts), null)
    assert.equal(toLogItem({ text: ' ' }, opts)?.text, ' ')
  })
  test('尸体：非字符串 text 被 String() 化而非丢弃；NaN 时间戳回落 nowMs', () => {
    assert.equal(toLogItem({ text: 42 }, opts)?.text, '42')
    assert.equal(toLogItem({ text: 'x', t: Number.NaN }, opts)?.t, 5000)
    assert.equal(toLogItem({ text: 'x', level: 7 }, opts)?.level, 'info')
  })
})

describe('appendLogs · 环形缓冲', () => {
  const opts = { maxLogs: 3, maxText: 100, page: '/p', nowMs: 1 }
  const mk = (n) => ({ text: 't' + String(n) })

  test('常规：追加到尾部返回新数组', () => {
    const out = appendLogs([], [mk(1), mk(2)], opts)
    assert.equal(out.length, 2)
    assert.equal(out[0].text, 't1')
    assert.equal(out[1].text, 't2')
  })
  test('上限：超出 maxLogs 时保留**最新**的 N 条（旧的先出队）', () => {
    const existing = appendLogs([], [mk(1), mk(2), mk(3), mk(4)], opts)
    assert.deepEqual(existing.map((l) => l.text), ['t2', 't3', 't4'])
    const out = appendLogs(existing, [mk(5)], opts)
    assert.deepEqual(out.map((l) => l.text), ['t3', 't4', 't5'])
  })
  test('不可变性：不改入参（纯函数契约）', () => {
    const existing = appendLogs([], [mk(1)], opts)
    const snapshot = JSON.stringify(existing)
    const out = appendLogs(existing, [mk(2)], opts)
    assert.equal(JSON.stringify(existing), snapshot)
    assert.notEqual(out, existing)
  })
  test('尸体：incoming 非数组 → 原样返回（不抛）', () => {
    const existing = appendLogs([], [mk(1)], opts)
    assert.deepEqual(appendLogs(existing, undefined, opts), existing)
    assert.deepEqual(appendLogs(existing, 'nope', opts), existing)
  })
  test('边界：maxLogs=0 → 清空（配置为 0 即「不缓冲」）', () => {
    assert.deepEqual(appendLogs([], [mk(1)], { ...opts, maxLogs: 0 }), [])
  })
})

describe('isClientFresh · 在场判据（时间证据，非代理量）', () => {
  test('常规：age < ttl → true；恰好 ttl → true（闭区间）', () => {
    assert.equal(isClientFresh(1000, 1500, 1000), true)
    assert.equal(isClientFresh(1000, 2000, 1000), true)
  })
  test('过期：age > ttl → false', () => {
    assert.equal(isClientFresh(1000, 2001, 1000), false)
  })
  test('尸体：未来时间戳（时钟偏移）→ false（fail-closed：不可信即判不在场）', () => {
    assert.equal(isClientFresh(9999, 1000, 1000), false)
  })
  test('尸体：零/负/NaN 输入 → false，不抛', () => {
    assert.equal(isClientFresh(0, 1000, 1000), false)
    assert.equal(isClientFresh(-5, 1000, 1000), false)
    assert.equal(isClientFresh(Number.NaN, 1000, 1000), false)
    assert.equal(isClientFresh(1000, Number.NaN, 1000), false)
    assert.equal(isClientFresh(1000, 1000, Number.NaN), false)
  })
})
