# Manifest Schema

The manifest has two valid modes:

- Capability inventory mode: sync local Agent skills as `capabilities[]`; do not create a service SOP yet.
- Service workflow mode: create a draft 开工吧 service card and SOP from an explicit workflow.

## Capability inventory shape

```json
{
  "schemaVersion": "1.0",
  "mainAgent": {
    "externalAgentId": "seller_orchestrator",
    "name": "Seller Orchestrator",
    "version": "1.0.0",
    "endpoint": "https://agent.example.com"
  },
  "capabilities": [
    {
      "externalId": "html_report",
      "name": "HTML 可视化报告生成",
      "description": "将资料整理为单文件 HTML 报告。",
      "capabilityType": "skill",
      "sourceKind": "skill",
      "sourcePath": "skills/html-report/SKILL.md",
      "sourceFingerprint": "skill-html-report-v1",
      "tags": ["HTML", "报告"],
      "deliverables": ["单文件 HTML 报告"],
      "requiredInputs": ["Markdown 文档"],
      "riskBoundaries": ["不处理未授权的隐私资料"],
      "acceptanceCriteria": ["报告可在浏览器打开"]
    }
  ],
  "workflow": { "nodes": [] }
}
```

## Service workflow shape

```json
{
  "schemaVersion": "1.0",
  "mainAgent": {
    "externalAgentId": "seller_orchestrator",
    "name": "Seller Orchestrator",
    "version": "1.0.0",
    "endpoint": "https://agent.example.com"
  },
  "workerAgents": [
    {
      "externalAgentId": "ppt_worker",
      "name": "PPT Production Agent",
      "role": "worker"
    }
  ],
  "serviceCard": {
    "name": "路演 PPT 代工 SOP",
    "tagline": "把客户资料转成可交付的融资路演 PPT",
    "category": "PPT / 融资材料",
    "targetCustomers": ["创业者", "融资顾问"],
    "deliverables": ["PPTX 初稿", "PDF 预览"],
    "requiredInputs": ["公司介绍", "产品资料", "参考风格"],
    "automationLevel": "semi_auto",
    "humanProfile": {
      "name": "乙方负责人",
      "role": "报价与终审负责人",
      "bio": "负责确认需求、报价边界和最终交付质量。",
      "responsibleNodes": ["报价确认", "交付验收"]
    },
    "riskBoundaries": ["不承诺融资成功"],
    "acceptanceCriteria": ["文件可打开", "页数符合需求"]
  },
  "workflow": {
    "nodes": [
      {
        "key": "brief",
        "name": "需求确认",
        "ownerKind": "human",
        "requiresHuman": true
      },
      {
        "key": "external_agent_execution",
        "name": "外部 Agent 执行",
        "ownerKind": "external_agent",
        "sourceAgentId": "ppt_worker",
        "isAuto": true,
        "artifactTypes": ["pptx", "pdf"]
      }
    ]
  }
}
```

## Field rules

- `mainAgent.externalAgentId` must be stable across reconnects.
- `capabilities[].sourceFingerprint` must be stable across reconnects and updates.
- Do not expand a list of local skills into `workflow.nodes`. Sync them as `capabilities[]`, then create a service SOP from the selected capability.
- `workflow.nodes[].key` must be stable. Runtime events use this as `nodeKey`.
- Use `ownerKind: "human"` for quote, approval, delivery, and final write-back gates.
- Use `ownerKind: "external_agent"` for worker-agent production nodes.
- Keep service card text customer-safe. Do not include secrets or raw private customer data.
