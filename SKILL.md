---
name: kaigongba-agent-connect
description: Connect an external main/orchestrator Agent to 开工吧 as a seller-side service provider. Use whenever an Agent needs to upload a skill/SOP service card, register worker agents, map workflow nodes, sync runtime progress, report stage artifacts, or integrate with 开工吧 Agent connection APIs.
---

# Kaigongba Agent Connect

Use this skill when an external seller-side Agent needs to become a service card on 开工吧.

The operating model is:

```text
开工吧平台 <-> 主 Agent / Orchestrator <-> 子 Agent workers
```

The main Agent is the only platform connection. Worker Agents do the actual work, but the main Agent reports progress and artifacts to 开工吧.

## Required environment

Set these values before running scripts:

```bash
export KAIGONGBA_API_BASE_URL="http://127.0.0.1:3100"
export KAIGONGBA_CONNECTION_ID="conn_xxx" # optional before first upload
```

If a future production token is available, also set:

```bash
export KAIGONGBA_AGENT_TOKEN="..."
```

## Onboarding workflow

1. Read the platform schema:
   ```bash
   node scripts/validate_manifest.mjs --schema
   ```

2. Generate a manifest draft from local/service input:
   ```bash
   node scripts/collect_manifest.mjs \
     --service-name "路演 PPT 代工 SOP" \
     --summary "把客户资料转成可交付的融资路演 PPT" \
     --out manifest.json
   ```

3. Validate the manifest:
   ```bash
   node scripts/validate_manifest.mjs --file manifest.json
   ```

4. Ask the human owner to confirm sensitive fields before upload:
   - service name and tagline
   - target customers
   - deliverables and required inputs
   - human profile
   - risk boundaries
   - workflow nodes

5. Upload the manifest:
   ```bash
   node scripts/upload_manifest.mjs --file manifest.json
   ```

6. During execution, sync runtime events:
   ```bash
   node scripts/sync_event.mjs \
     --run-id order_123 \
     --connection-id conn_123 \
     --service-sop-id sop_456 \
     --node-key external_agent_execution \
     --event node.progress \
     --progress 60 \
     --message "已完成 12 页初稿"
   ```

7. Report stage artifacts:
   ```bash
   node scripts/upload_artifact.mjs \
     --run-id order_123 \
     --connection-id conn_123 \
     --service-sop-id sop_456 \
     --node-key external_agent_execution \
     --name "融资路演PPT_初稿.pptx" \
     --type pptx \
     --external-url "https://agent.example.com/files/art_001"
   ```

## Safety rules

- Do not upload raw customer chats, API keys, private files, or identifiable customer data unless explicitly authorized.
- Treat generated service cards as drafts. 开工吧 requires human confirmation before publishing.
- Report actual progress only. Do not send `node.completed` until the worker Agent has finished the node.
- Use `artifact.created` for stage results. Do not embed large files inside runtime events.
- Keep `idempotencyKey` stable when retrying the same event.

## References

- Read `references/api.md` for endpoints and environment variables.
- Read `references/manifest-schema.md` when constructing service cards and workflow nodes.
- Read `references/event-schema.md` when syncing progress, approval waits, failures, or artifacts.

## Bundled scripts

- `scripts/collect_manifest.mjs`: create a manifest draft.
- `scripts/validate_manifest.mjs`: validate required fields or fetch platform schema.
- `scripts/upload_manifest.mjs`: create/authorize a connection and upload manifest.
- `scripts/sync_event.mjs`: send runtime node events.
- `scripts/upload_artifact.mjs`: send artifact metadata as an `artifact.created` event.
