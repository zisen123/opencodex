# Spec: opencodex Anthropic 透传 Adapter

## 问题陈述

opencodex 当前对 Claude Code 入站的 anthropic 请求（`/v1/messages`）执行全量翻译（解析→内部格式→重编码），即使上游也原生支持 anthropic 协议。这导致：

- 翻译过程丢失或改写 reasoning/thinking 块、tool_use 细节、cache_control 等上游原生语义
- TTFT 增加（序列化/反序列化开销）
- 新接入的"三协议全通"上游（如 Ox Alpha / aitokensflux）无法以最简路径服务 Claude Code

与此同时，responses 入口已有现成的 `createResponsesPassthroughAdapter`（`passthrough: true`），证明"同协议透传"在 opencodex 架构里是成熟模式。anthropic 入口缺一个对等的 passthrough 路径。

## 解决方案

为 opencodex fork 新增一个 **anthropic-passthrough adapter**：当 provider 声明上游支持 anthropic 协议时，Claude Code 的 `/v1/messages` 请求被**原样转发**到上游（仅注入 model 名 + apiKey），流式 SSE 事件**逐帧 relay** 回客户端，不做跨协议翻译。最终效果：Codex/DSH/Claude Code 三端各以自身协议到达 opencodex，opencodex 退化为纯路由层。

## 用户故事

1. 作为 Claude Code 用户，我希望我的 anthropic messages 请求原样发送到 anthropic 兼容上游而不被重编码，以便 thinking 块、tool_use、cache_control 等原生字段 100% 保留。
2. 作为接入新"全协议"API（如 Ox Alpha）的开发者，我希望注册一个 provider 后三个客户端（Codex/DSH/Claude Code）都能通过 opencodex 路由且零协议翻译，以便新上游接入只需几分钟而不是调试 adapter 兼容性。
3. 作为 Claude Code 用户，我希望流式 SSE 事件（message_start、content_block_delta、thinking_delta 等）被逐帧透传，以便部分输出无额外延迟地出现。
4. 作为 opencodex 运维者，我希望 usage.jsonl 仍能从透传的 anthropic 响应中捕获 input_tokens/output_tokens，以便成本和速度监控继续工作。
5. 作为 Claude Code 用户，我希望模型发现端点（`/v1/models`）继续返回可读别名（`claude-ocx-<provider>--<modelId>[1m]`），以便模型选择器和 roster agents 无需改动。
6. 作为 Codex CLI 用户，我希望 responses 协议透传（已有）继续与新的 anthropic 透传并存于同一上游，以便一个 provider 同时服务两种客户端。
7. 作为开发者，我希望通过声明式的 `adapter: "anthropic-passthrough"` 配置字段来选择透传模式，以便无需修改源码即可逐 provider 切换翻译/透传。
8. 作为开发者，我希望透传层自动将 provider 的 `apiKey` 注入为 `x-api-key` 头（或按 provider 配置用 `Authorization: Bearer`），以便上游认证由 opencodex 统一处理、不从客户端泄露。
9. 作为开发者，我希望透传层将转发体中的 `model` 字段替换为 router 解析后的 `modelId`，以便 publicAlias 和 provider 作用域的模型名正常工作。
10. 作为 opencodex 运维者，我希望对上游 anthropic 兼容性不完整的 provider 可以回退到现有翻译 adapter，以便已有的 sophnet-anthropic 模型继续正常运行。

## 实现决策

1. **新 adapter 而非模式标记**：引入 `anthropic-passthrough` 作为独立 adapter（与现有 `anthropic` 分离）。原因：翻译 adapter 有 900+ 行复杂逻辑（image normalize、thinking budget、tool schema）；通过 flag 混入透传逻辑会很脆弱。独立文件保持关注点分离。

2. **Adapter 注册表入口**：在 `src/adapters/registry.ts` 的 `ADAPTER_REGISTRY` 中新增 `"anthropic-passthrough"`，`wire: "anthropic"`，`mutation: "codex-owned"`，工厂函数调用 `createAnthropicPassthroughAdapter(provider)`。

3. **buildRequest 契约**：
   - 取 `parsed._rawBody`（Claude Code 入站请求的原始 JSON body）
   - 将 `body.model` 替换为 router 解析出的 `modelId`
   - URL 设为 `${provider.baseUrl}/v1/messages`（复用 `anthropicMessagesUrl(provider.baseUrl)`）
   - 设置 headers：`x-api-key: ${provider.apiKey}`、`anthropic-version: 2023-06-01`、`Content-Type: application/json`；若入站有 `anthropic-beta` 则透传
   - 其他字段（system、messages、tools、thinking、stream、max_tokens、metadata）原样保留

4. **parseStream 契约**：
   - 逐帧 relay 上游 SSE（与 responses passthrough 类似：遍历 body lines，原样 yield）
   - 仅从 `message_start` 和 `message_delta` 事件中提取 `usage` 写入 usage.jsonl（轻量 parse，不改写）
   - 非 2xx 时读取错误体，yield `{ type: "error", message }` 与其他 adapter 一致

5. **Provider 配置形态**（无 schema 变更，复用现有字段）：
   ```json
   { "adapter": "anthropic-passthrough", "baseUrl": "https://api.aitokensflux.com", "apiKey": "sk-...", "liveModels": false }
   ```

6. **模型发现不变**：Claude Code 的 discovery 路径（`/v1/models` + `anthropic-version` + `claude-code/*` UA）在 adapter 运行之前由 server 的 model-info 层处理。用该 provider 注册的 customModels 会以 readable 别名和 display_name 正常显示——无需 adapter 参与。

7. **`_rawBody` 可用性**：anthropic 入站解析器已设置 `parsed._rawBody`（types.ts 第 34 行确认），透传 adapter 直接消费。

8. **双 adapter provider 模式**：一个同时支持 responses 和 anthropic 的上游（如 aitokensflux）可以注册为**两个 provider**（一个 `openai-responses`、一个 `anthropic-passthrough`），共享相同 baseUrl/apiKey，同一模型在两个 provider 下各注册一份。Router 根据入站 wire 选择 provider。后续增强可支持 per-model adapter 覆盖（`modelAdapters` 字段，registry.ts 注释中已提及）。

## 测试决策

**什么是好的测试**：测试应在 adapter 接口 seam 验证外部行为——给定输入 `OcxParsedRequest` 和 provider config，断言输出 `AdapterRequest` 的字段（URL、headers、body）以及 parseStream 的事件。测试不应断言内部实现细节（辅助函数调用、中间变量）。

**被测模块**：
- `src/adapters/anthropic-passthrough.ts`（新文件）：`buildRequest` + `parseStream`

**先例参照**：
- `src/lab/conformance/executor.ts` 已导入 `createResponsesPassthroughAdapter` 做一致性测试——同一模式适用
- 现有 responses passthrough 测试提供了"body 原样通过（仅 model 字段替换）"的断言模板

**测试用例**：
1. `buildRequest`：最小 messages body → URL 正确、apiKey 注入、model 被替换、其余不变
2. `buildRequest`：带 tools + thinking + stream → 所有字段逐字保留
3. `parseStream`：标准 anthropic SSE（message_start→content_block_start→delta→stop）→ 事件被 relay、usage 被提取
4. `parseStream`：上游返回 4xx → 发出 error 事件
5. `buildRequest`：publicAlias 模型名 → body 中解析为真实 modelId

## 不在范围内

- **修改现有 `anthropic`（翻译）adapter**：它继续为 sophnet-anthropic 和上游 anthropic 兼容性不完整的 provider 服务。
- **Chat（`openai-chat`）透传**：当前无客户端需要 chat-to-chat 透传（Codex 已移除 `wire_api=chat`；DSH 用 responses）。若未来需要，同一模式适用。
- **上游模型发现转发**：不转发 `/v1/models` 到上游（上游返回 OpenAI 格式且无 display_name）。Discovery 仍由 opencodex 内部 model-info 层处理。
- **基于 usage 的限流/计费执行**：透传捕获 usage 用于日志，但不基于成本阻断请求。
- **自动 adapter 选择**：运维者显式为每个 provider 选择 `anthropic-passthrough` 或 `anthropic`。自动探测（探测上游后择优）是后续增强。

## 补充说明

- **Ox Alpha 规格**：上下文窗口 ~100 万 tokens，免费（cost=0），owned_by openrouter/stealth，多模态（text+image）。TTFT 高度不稳定（1–57s），受共享免费池排队影响。适合作为备用/实验模型，非主力。
- **Rebase 安全性**：新 adapter 是一个独立文件 + registry.ts 一行追加。与上游 opencodex rebase 的冲突面极小（registry.ts 是唯一共享文件，且为追加模式）。
- **回滚**：如果透传对某个 provider 出问题，将 config.json 中 `adapter: "anthropic-passthrough"` 改回 `adapter: "anthropic"` + 重启，立即恢复全量翻译。
- **DSH 集成**：DSH 已通过 `openai-responses` wire 连接 opencodex。对 ox-alpha，DSH 只需在 `settings.yaml` 中加一条指向 publicAlias 的模型条目——DSH→opencodex 段无需 adapter 改动。
- **三端路由终态拓扑**：
  ```
  Codex ──responses──►  ┐
  DSH ──responses────►  ├─► opencodex（纯路由）──► api.aitokensflux.com
  Claude Code ──anthropic─► ┘      ↑ responses 透传    ↑ anthropic 透传
  ```
