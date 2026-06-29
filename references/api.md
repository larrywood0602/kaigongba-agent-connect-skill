# 开工吧 Agent Connection API

Default API base:

```text
KAIGONGBA_API_BASE_URL=http://127.0.0.1:3100
```

## Endpoints

```text
GET  /api/agent-schemas/manifest
POST /api/agent-connections
PATCH /api/agent-connections/:id/scopes
POST /api/agent-connections/:id/manifest
GET  /api/agent-connections/:id

POST /api/workflow-runs/:runId/events
GET  /api/workflow-runs/:runId/events

POST /api/artifacts/upload-url
POST /api/artifacts/:id/complete
```

## Onboarding sequence

1. Create a connection:
   ```json
   {
     "mainAgent": {
       "externalAgentId": "seller_orchestrator",
       "name": "Seller Orchestrator",
       "version": "1.0.0",
       "endpoint": "https://agent.example.com"
     }
   }
   ```

2. Authorize scopes:
   ```json
   {
     "scopes": ["workflows.write", "run_events.write", "artifacts.write"]
   }
   ```

3. Upload manifest to create a draft service card and SOP.

## Runtime sequence

1. 开工吧 creates or starts an order.
2. The main Agent receives the run/order ID from platform context.
3. The main Agent reports worker progress with `/events`.
4. Stage files are reported as `artifact.created` metadata.
5. Human approval nodes remain gated by platform UI.

## Auth header

Production integrations should send:

```text
Authorization: Bearer $KAIGONGBA_AGENT_TOKEN
```

The local prototype currently accepts requests without auth so the workflow can be tested end to end.
