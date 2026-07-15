import { describe, expect, it } from 'vitest'
import {
  EXECUTOR_PROTOCOL,
  createExecutorEventFactory,
  mapCodexEvent,
  parseExecutorProtocolLine,
  sanitizePublicText,
} from './executor_protocol.mjs'

describe('executor protocol', () => {
  it('creates monotonic v1 envelopes with stable event ids', () => {
    const emit = createExecutorEventFactory({
      runId: 'run_123',
      now: () => new Date('2026-07-15T03:00:00.000Z'),
    })

    expect(emit({ type: 'lifecycle', state: 'started', message: 'started' })).toEqual({
      protocol: EXECUTOR_PROTOCOL,
      type: 'lifecycle',
      sequence: 1,
      eventId: 'run_123:1',
      occurredAt: '2026-07-15T03:00:00.000Z',
      state: 'started',
      message: 'started',
    })
    expect(emit({ type: 'progress', progress: 25 })).toMatchObject({
      protocol: 'kaigongba.executor.v1',
      sequence: 2,
      eventId: 'run_123:2',
    })
  })

  it('does not allow event input to override reserved envelope fields', () => {
    const emit = createExecutorEventFactory({
      runId: 'run_safe',
      now: () => new Date('2026-07-15T03:00:00.000Z'),
    })

    expect(emit({
      type: 'lifecycle',
      protocol: 'attacker',
      sequence: 999,
      eventId: 'attacker:999',
      occurredAt: 'yesterday',
    })).toMatchObject({
      protocol: 'kaigongba.executor.v1',
      sequence: 1,
      eventId: 'run_safe:1',
      occurredAt: '2026-07-15T03:00:00.000Z',
    })
  })

  it('maps Codex file changes without exposing absolute paths', () => {
    expect(mapCodexEvent({
      type: 'item.completed',
      item: { type: 'file_change', changes: [{ path: '/tmp/private/report.pptx' }] },
    }, { outputDir: '/tmp/private' })).toEqual([
      { type: 'file', status: 'observed', name: 'report.pptx', relativePath: 'report.pptx' },
    ])
  })

  it('ignores file changes outside the output directory', () => {
    expect(mapCodexEvent({
      type: 'item.completed',
      item: { type: 'file_change', changes: [{ path: '/tmp/secret.txt' }, { path: '../escape.txt' }] },
    }, { outputDir: '/tmp/private' })).toEqual([])
  })

  it.each([
    ['thread.started', 'started'],
    ['turn.started', 'working'],
    ['turn.completed', 'finalizing'],
  ])('conservatively maps %s lifecycle events', (type, state) => {
    expect(mapCodexEvent({ type }, { outputDir: '/tmp/private' })).toEqual([
      expect.objectContaining({ type: 'lifecycle', state }),
    ])
  })

  it('maps a failed Codex turn to a stable public error', () => {
    expect(mapCodexEvent({ type: 'turn.failed' }, { outputDir: '/tmp/private' })).toEqual([{
      type: 'error',
      code: 'codex_turn_failed',
      message: 'Codex turn failed',
      retryable: true,
    }])
  })

  it('redacts credentials, signed query values, and absolute paths', () => {
    const text = sanitizePublicText([
      'Authorization: Bearer kgb_agent_secret',
      'connect kgbc_one_time_code',
      'https://host/file?token=signed&signature=private&X-Amz-Signature=aws-secret&safe=yes',
      '/Users/larry/private/report.pptx',
      '/tmp/private/result.json',
      'C:\\Users\\larry\\private\\report.pptx',
    ].join(' '))

    expect(text).not.toContain('kgb_agent_secret')
    expect(text).not.toContain('kgbc_one_time_code')
    expect(text).not.toContain('signed')
    expect(text).not.toContain('private')
    expect(text).not.toContain('aws-secret')
    expect(text).not.toContain('/Users/')
    expect(text).not.toContain('/tmp/')
    expect(text).not.toContain('C:\\Users\\')
    expect(text).toContain('[REDACTED]')
    expect(text).toContain('safe=yes')
  })

  it('truncates public messages at a valid UTF-8 boundary of 64 KiB', () => {
    const text = sanitizePublicText('页'.repeat(30_000))

    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(64 * 1024)
    expect(text.endsWith('\uFFFD')).toBe(false)
  })

  it('redacts and bounds every public text field emitted by the event factory', () => {
    const emit = createExecutorEventFactory({ runId: 'run_safe_text' })
    const event = emit({
      type: 'progress',
      phase: `kgbc_SECRET /Users/larry/private ${'阶'.repeat(300)}`,
      unit: `kgb_agent_TOKEN ${'页'.repeat(100)}`,
      name: `Bearer super-secret /tmp/private/${'x'.repeat(2_000)}`,
      message: 'working in /Users/larry/private with kgb_agent_MESSAGE',
    })

    expect(JSON.stringify(event)).not.toMatch(/kgbc_SECRET|kgb_agent_TOKEN|super-secret|kgb_agent_MESSAGE/)
    expect(JSON.stringify(event)).not.toMatch(/\/Users\/|\/tmp\//)
    expect(Buffer.byteLength(event.phase, 'utf8')).toBeLessThanOrEqual(256)
    expect(Buffer.byteLength(event.unit, 'utf8')).toBeLessThanOrEqual(64)
    expect(Buffer.byteLength(event.name, 'utf8')).toBeLessThanOrEqual(1_024)
  })

  it('parses one valid protocol line', () => {
    const line = JSON.stringify({
      protocol: 'kaigongba.executor.v1',
      type: 'progress',
      sequence: 2,
      eventId: 'run_123:2',
    })

    expect(parseExecutorProtocolLine(line)).toMatchObject({ type: 'progress', eventId: 'run_123:2' })
  })

  it.each([
    ['not json'],
    [JSON.stringify({ protocol: 'wrong', type: 'progress', sequence: 1, eventId: 'run:1' })],
    [JSON.stringify({ protocol: 'kaigongba.executor.v1', sequence: 1, eventId: 'run:1' })],
    [JSON.stringify({ protocol: 'kaigongba.executor.v1', type: 'progress', sequence: 0, eventId: 'run:0' })],
    [JSON.stringify({ protocol: 'kaigongba.executor.v1', type: 'progress', sequence: 1 })],
  ])('rejects a malformed protocol line', (line) => {
    expect(() => parseExecutorProtocolLine(line)).toThrow(expect.objectContaining({
      code: 'executor_protocol_error',
    }))
  })

  it('returns no public event for an unknown Codex item', () => {
    expect(mapCodexEvent({
      type: 'item.completed',
      item: { type: 'reasoning', text: 'private chain of thought' },
    }, { outputDir: '/tmp/private' })).toEqual([])
  })
})
