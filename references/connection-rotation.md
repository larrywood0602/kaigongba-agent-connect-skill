# Agent 连接与令牌安全轮换

连接码是一次性凭据，成功兑换后不能再次使用。完成接入后，真正需要保护和轮换的是写入本机连接配置的 Agent 访问令牌，而不是已经消费的连接码。

不要在任务执行期间撤销连接。撤销会立即使旧访问令牌失效，正在进行的领取、续租、进度、交付物和完成回调都会返回未授权。

## 轮换前检查

1. 在开工吧连接详情页确认没有排队、已领取、执行中、返修中或正在上传交付物的工作项。
2. 确认最后一个订单已进入终态，最终事件和全部交付物均已显示在平台。
3. 记录旧连接 ID、最后一个运行 ID 和非敏感审计时间；不要复制访问令牌。

## 停止旧 worker

如果 worker 由 launchd、systemd 或其他进程管理器托管，应通过对应管理器停止，并核对服务定义指向当前 connector，避免它被自动拉起。

非托管 worker 不得直接信任 `worker.pid`。PID 可能陈旧并被系统复用；停止前必须同时人工核对 PID、进程命令、运行目录和连接身份：

```bash
SKILL_ROOT="$HOME/.codex/skills/kaigongba-agent-connect"
RUNTIME_DIR="$SKILL_ROOT/.kaigongba/runtime"
WORKER_PID="$(tr -d '[:space:]' < "$RUNTIME_DIR/worker.pid")"
ps -p "$WORKER_PID" -o pid= -o command=
node -e 'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(JSON.stringify({pid:s.pid,connectionId:s.connectionId,outputDir:s.outputDir}))' "$RUNTIME_DIR/worker-status.json"
node -e 'const fs=require("node:fs"); const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(JSON.stringify({connectionId:c.connectionId}))' "$SKILL_ROOT/.kaigongba/connection.json"
```

只有以下条件全部满足时，才能停止该 PID：

1. `worker-status.json` 的 PID 与 `worker.pid` 一致。
2. `ps` 命令行明确包含当前 `$SKILL_ROOT/scripts/worker_daemon.mjs`，且 `--output-dir` 指向当前 `$RUNTIME_DIR`。
3. worker 状态中的 connectionId 与当前连接配置完全一致。

任一项不匹配都应停止操作并人工调查；不要对可疑 PID 执行 `kill`。全部核验后再停止已确认的进程，并检查其退出：

```bash
kill -- "$WORKER_PID"
! kill -0 "$WORKER_PID" 2>/dev/null
```

## 撤销旧连接

在开工吧连接详情页点击“撤销接入”。平台会同时撤销该连接签发的访问令牌。

使用旧配置执行一次只读检查，预期返回 HTTP 401。不要在命令行打印令牌：

```bash
node "$HOME/.codex/skills/kaigongba-agent-connect/scripts/verify_real_platform.mjs"
```

如果仍返回连接成功，停止轮换并检查是否撤销了正确的连接 ID。

## 创建新连接

1. 在平台生成新的单次连接码。
2. 不要把连接码粘贴到聊天、工单、截图、shell 历史或持久日志。
3. 从真实 Agent 项目目录执行 connector `0.3.9`；如果当前目录不是 Agent 项目，必须传入真实 `--source-dir`。

以下示例使用 macOS 默认的 zsh。不要把 Bash 的 `read -p` 写法直接用于 zsh；zsh 会把 `-p` 解释为 coprocess 输入。

```zsh
IFS= read -r -s 'CONNECT_CODE?一次性连接码: '
print
KAIGONGBA_CONNECT_CODE="$CONNECT_CODE" \
npx -y github:larrywood0602/kaigongba-agent-connect-skill#v0.3.9 \
  --api-base-url https://kaigongba.net \
  --provider codex \
  --main-agent-id codex_orchestrator \
  --main-agent-name "Codex Agent" \
  --endpoint codex://agent \
  --environment production \
  --onboard \
  --start-worker \
  --source-dir "$HOME/path/to/real-agent-project"
CONNECT_CODE=
unset CONNECT_CODE
```

这里的连接码由静默输入读取，只作为单条命令的临时环境变量传给 connector，不进入命令参数或 shell 历史。不要启用会记录环境变量的 shell 调试模式（例如 `set -x`）。

## 新链路验收

依次验证：

1. 新连接 ID 与已撤销的旧连接 ID 不同。
2. 连接状态为 `connected`。
3. scopes 包含 `workflows.write`、`run_events.write` 和 `artifacts.write`。
4. worker PID 存活且状态文件持续更新时间。
5. 能力清单数量与本地扫描审计一致。
6. 使用无敏感数据的小任务验证真实进度事件。
7. 上传一个小型测试交付物，确认平台显示 uploaded。
8. 确认 `node.completed` 只在交付物上传完成后出现。

只读验收命令：

```bash
cd "$HOME/.codex/skills/kaigongba-agent-connect"
node scripts/validate_skill.mjs
node scripts/verify_real_platform.mjs
node scripts/list_runs.mjs --summary
```

## 清理旧凭据

新连接验收通过后，删除旧连接配置备份、包含连接码或访问令牌的日志以及不再使用的 shell 历史记录。保留不含凭据的连接 ID、运行 ID、撤销时间和验收结论作为审计记录。

旧令牌一旦撤销不能恢复。如果新连接失败，应修复新连接，不要尝试恢复旧令牌。
