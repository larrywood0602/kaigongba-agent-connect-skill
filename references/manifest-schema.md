# Manifest Schema

The manifest turns an external main Agent into a draft 开工吧 service card and SOP.

## Required shape

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
- `workflow.nodes[].key` must be stable. Runtime events use this as `nodeKey`.
- Use `ownerKind: "human"` for quote, approval, delivery, and final write-back gates.
- Use `ownerKind: "external_agent"` for worker-agent production nodes.
- Keep service card text customer-safe. Do not include secrets or raw private customer data.
