# 开工吧 Agent Connection API

Default production flow:

```text
POST /api/agent-connect/token
```

The Agent receives a one-time connect code from the platform UI, exchanges it for `apiBaseUrl`, `connectionId`, and `agentToken`, and stores those values in `.kaigongba/connection.json`.
Use the platform-generated `npx -y github:larrywood0602/kaigongba-agent-connect-skill ... --onboard` command for first-time install and guided service upload. Pass the platform API address shown in the UI so remote Agents do not fall back to `127.0.0.1`.

## Endpoints

```text
GET  /api/agent-schemas/manifest
POST /api/agent-connect/token
POST /api/agent-connections
PATCH /api/agent-connections/:id/scopes
POST /api/agent-connections/:id/manifest
GET  /api/agent-connections/:id/capabilities
POST /api/agent-connections/:id/capabilities/sync
GET  /api/agent-capabilities/:id
POST /api/agent-capabilities/:id/create-service
GET  /api/agent-connections/:id
GET  /api/agent-connections/:id/runs
GET  /api/agent-connections/:id/work-items
GET  /api/agent/work-items
POST /api/agent/work-items/:id/claim
POST /api/agent-connections/:id/revoke
GET  /api/service-sops/:id/readiness
POST /api/service-sops/:id/publish

POST /api/workflow-runs/:runId/events
GET  /api/workflow-runs/:runId/events

POST /api/artifacts/upload-url
PUT  /api/artifact-uploads/:uploadId
GET  /api/artifact-uploads/:uploadId/download
POST /api/artifacts/:id/complete
```

## Onboarding sequence

1. Exchange the platform connect code:
   ```json
	   {
	     "connectCode": "kgbc_xxx",
	     "agent": {
	       "provider": "codex",
	       "externalAgentId": "codex_orchestrator",
	       "name": "Codex Agent",
	       "endpoint": "codex://agent",
	       "version": "1.0.0",
	       "environment": "production"
	     }
	   }
   ```

   Replace the provider and Agent fields with the external Agent the user actually connected. The connector must not silently fall back to a fixed provider.

2. Sync discovered skills as capabilities:
   ```bash
   node scripts/sync_capabilities.mjs --file capabilities-manifest.json --replace
   ```

3. Verify the real platform state:
   ```bash
   node scripts/verify_real_platform.mjs --file capabilities-manifest.json --sync
   ```

4. Create a draft service card and SOP from one selected capability:
   ```bash
   node scripts/create_service_from_capability.mjs --capability-id cap_123 --service-name "HTML 可视化报告服务"
   ```

5. Check readiness and publish:
   ```bash
   node scripts/readiness.mjs --service-sop-id sop_123
   node scripts/publish_service.mjs --service-sop-id sop_123
   ```

Local development fallback:

1. Create a connection:
   ```json
   {
     "mainAgent": {
       "provider": "codex",
       "externalAgentId": "codex_orchestrator",
       "name": "Codex Agent",
       "version": "1.0.0",
       "endpoint": "codex://agent",
       "environment": "production"
     }
   }
   ```

2. Authorize scopes:
   ```json
   {
     "scopes": ["workflows.write", "run_events.write", "artifacts.write"]
   }
   ```

3. Upload a hand-written workflow manifest, or sync capabilities first with `POST /api/agent-connections/:id/capabilities/sync`.

## Runtime sequence

1. 开工吧 creates or starts an order.
2. The main Agent calls `GET /api/agent/work-items`, `GET /api/agent-connections/:id/work-items`, or `node scripts/runtime_tick.mjs` to fetch executable work items.
3. Each work item includes the structured requirement, attachments, deliverables, acceptance criteria, callback event URL, and idempotency key.
4. The main Agent claims the work item with `POST /api/agent/work-items/:id/claim`, `node scripts/claim_work_item.mjs`, or `node scripts/run_work_item.mjs`, then reports worker progress with `/events`.
5. Stage files are reported as `artifact.created` metadata. `scripts/run_work_item.mjs` and `scripts/upload_artifact.mjs` can upload a local `file` to the platform `uploadUrl`, store the downloadable `externalUrl`, and mark the artifact complete. Upload/download URLs are signed; preserve the full URL including query parameters.
6. Human approval nodes remain gated by platform UI.
7. Completed/failed/skipped local execution attempts should be recorded with `scripts/action_record.mjs` so retries stay idempotent.

## Auth header

Production integrations should send the token returned by connect-code exchange:

```text
Authorization: Bearer $KAIGONGBA_AGENT_TOKEN
```

Local development can still use `KAIGONGBA_API_BASE_URL`, `KAIGONGBA_AGENT_TOKEN`, and dev headers.

For local user isolation tests, send the same user identity that the browser session should inspect:

```text
X-User-Id: $KAIGONGBA_USER_ID
X-User-Name: $KAIGONGBA_USER_NAME
```
