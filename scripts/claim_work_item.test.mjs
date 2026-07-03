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
})
