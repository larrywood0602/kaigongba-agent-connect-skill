# Runtime Event Schema

The main Agent reports runtime events to:

```text
POST /api/workflow-runs/:runId/events
```

## Progress event

```json
{
  "connectionId": "conn_123",
  "serviceSopId": "sop_456",
  "nodeKey": "external_agent_execution",
  "event": "node.progress",
  "status": "running",
  "progress": 60,
  "message": "已完成 12 页初稿",
  "sourceAgent": {
    "id": "ppt_worker",
    "name": "PPT Production Agent"
  },
  "reportedByAgent": {
    "id": "codex_orchestrator",
    "name": "Codex Agent"
  },
  "sequence": 18,
  "idempotencyKey": "order_123-external_agent_execution-18"
}
```

## Supported events

```text
heartbeat
node.started
node.progress
node.log
node.needs_input
node.needs_approval
artifact.created
node.completed
node.failed
```

## Artifact event

```json
{
  "connectionId": "conn_123",
  "serviceSopId": "sop_456",
  "nodeKey": "external_agent_execution",
  "event": "artifact.created",
  "status": "submitted",
  "sequence": 19,
  "idempotencyKey": "order_123-external_agent_execution-artifact-19",
  "artifact": {
    "externalArtifactId": "art_001",
    "name": "融资路演PPT_初稿.pptx",
    "type": "pptx",
    "mimeType": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "sizeBytes": 2480000,
    "externalUrl": "https://agent.example.com/files/art_001"
  }
}
```

## Rules

- Retry with the same `idempotencyKey` for the same event.
- Increase `sequence` for each node event.
- Do not send `node.completed` before the worker Agent has actually completed the task.
- Use `node.needs_approval` to stop at human review gates.
- Send large files separately; events only contain metadata or URLs.
