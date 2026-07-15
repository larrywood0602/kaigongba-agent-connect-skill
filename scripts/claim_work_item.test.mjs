import { describe, expect, it } from 'vitest'
import { selectWorkItem } from './claim_work_item.mjs'

describe('claim work item selection', () => {
  it('selects queued work before already claimed or running work', () => {
    const selected = selectWorkItem([
      { id: 'claimed_1', status: 'claimed' },
      { id: 'running_1', status: 'running' },
      { id: 'queued_1', status: 'queued' },
    ])

    expect(selected).toMatchObject({ id: 'queued_1' })
  })

  it('allows an explicit work item id', () => {
    const selected = selectWorkItem([
      { id: 'queued_1', status: 'queued' },
      { id: 'revision_1', status: 'revision_requested' },
    ], 'revision_1')

    expect(selected).toMatchObject({ id: 'revision_1' })
  })

  it('skips claimed work whose lease is still active or attempts are exhausted', () => {
    const now = Date.parse('2026-07-04T04:31:30.000Z')
    const selected = selectWorkItem([
      {
        id: 'blocked_attempts',
        status: 'claimed',
        leaseExpiresAt: '2026-07-04T04:20:00.000Z',
        attemptCount: 3,
        maxAttempts: 3,
      },
      {
        id: 'blocked_lease',
        status: 'claimed',
        leaseExpiresAt: '2026-07-04T04:41:00.000Z',
        attemptCount: 1,
        maxAttempts: 3,
      },
      {
        id: 'claimable_expired',
        status: 'claimed',
        leaseExpiresAt: '2026-07-04T04:30:00.000Z',
        attemptCount: 2,
        maxAttempts: 3,
      },
    ], '', now)

    expect(selected).toMatchObject({ id: 'claimable_expired' })
  })
})
