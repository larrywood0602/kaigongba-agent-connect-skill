#!/usr/bin/env node
import { apiRequest, arg, parseArgs, required, writeConnectionConfig } from './lib.mjs'

const args = parseArgs()
const connectCode = required(arg(args, ['connect-code', 'connectCode'], process.env.KAIGONGBA_CONNECT_CODE), '--connect-code')
const apiBaseUrl = String(arg(args, ['api-base-url', 'apiBaseUrl'], process.env.KAIGONGBA_API_BASE_URL || 'http://127.0.0.1:3100')).replace(/\/+$/, '')

const agent = {
  provider: String(arg(args, 'provider', 'openclaw')),
  externalAgentId: String(arg(args, ['main-agent-id', 'mainAgentId'], 'openclaw_orchestrator')),
  name: String(arg(args, ['main-agent-name', 'mainAgentName'], 'OpenClaw Orchestrator')),
  version: String(arg(args, ['main-agent-version', 'mainAgentVersion'], '1.0.0')),
  endpoint: String(arg(args, 'endpoint', 'openclaw://agent')),
}

const result = await apiRequest(`${apiBaseUrl}/api/agent-connect/token`, {
  method: 'POST',
  body: JSON.stringify({ connectCode, agent }),
})

const config = {
  apiBaseUrl: result.apiBaseUrl || apiBaseUrl,
  connectionId: result.connectionId,
  agentToken: result.agentToken,
  scopes: result.scopes || [],
  expiresAt: result.expiresAt,
  mainAgent: agent,
}
const configPath = await writeConnectionConfig(config)

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      configPath,
      apiBaseUrl: config.apiBaseUrl,
      connectionId: config.connectionId,
      scopes: config.scopes,
      expiresAt: config.expiresAt,
    },
    null,
    2,
  )}\n`,
)
