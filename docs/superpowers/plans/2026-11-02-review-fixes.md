# Review fixes implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复本轮审查的六项问题，补齐失败回归测试及安全边界验证，不调用真实账号接口。

**Architecture:** 保留现有 Bun/ESM 插件及纯函数边界。桌面身份以实际 token 为依据，冲突拒绝；SSE 错误识别提取为共用模块，首帧和非流式重组使用同一判据；模型目录按当前协议选档，签到严格校验响应信封。

**Tech Stack:** Bun 1.3.14、JavaScript ESM、bun:test、bun:sqlite、Web Streams；零新增依赖。

**Spec:** 本会话代码审查的六项发现及用户“修复全部问题，并做好验证”的确认。上游契约参考 [优化方案](../specs/2026-11-02-lobster-plugin-optimization.md)；该历史文档中的未验证建议不是新的实现要求。

## Global constraints

- 只在当前分支修改，不提交、不发布、不操作真实 magpie 配置。
- 全部网络用桩；SQLite 使用临时目录。测试运行时隔离 APPDATA/HOME/USERPROFILE/XDG_CONFIG_HOME。
- 不改变桌面导入不保存 token、不续期的策略。
- 流式已发送内容之后不能改变 HTTP 状态；保留后续错误事件的可观察性。
- 只在没有有效 thinkingConfig 时使用 MEASURED_LEVELS；不支持思考时不声明档位。

## Review focus

- token 与用户行分别更新、标识部分缺失或冲突：必须避免用 A 身份返回 B token（任务 1）。
- 纯文本错误、JSON null/标量、choices 与 error 共存：首帧与中途识别规则一致（任务 2）。
- [DONE] 已到而物理连接未关闭、提前报错：应结束逻辑响应并释放上游迭代器（任务 2）。
- 档位表与实测表同时存在、supportsThinking=false：声明必须与最终出站协议一致（任务 3）。
- HTTP 503、缺少 code、成功 data/状态损坏及复核异常：必须 failed 而非 inactive/ineligible/claimed（任务 4）。

## Task 1: 桌面账号身份

**Files:** `lib/auth-import.mjs`、`test/auth-import.test.mjs`。

**Interfaces:** 保持 `desktopSignIn(env)`、`desktopToken(env, expected, expectedUid)`；`readCredentials(path)` 明确提供身份冲突状态。身份来自 JWT，用户行只能在已有共同标识吻合且无冲突时补全缺失标识。

- [x] 补测试：A 导入后只更新 token 为 B；只更新用户行；同一字段冲突不能被另一匹配字段掩盖；缺失 claims 不得借用户行绑定；纯数字身份、同账号续期及补全 yid 保持可用。
- [x] 运行 `bun test test/auth-import.test.mjs`，确认新增测试因原身份漏洞失败。
- [x] 实现 token/用户行交叉校验、冲突 fail-closed，以及导入身份/uid 的无冲突匹配。
- [x] 运行相同测试并确认通过。

## Task 2: SSE 错误和终止

**Files:** 新建 `lib/stream-error.mjs`；修改 `lib/proxy.mjs`、`lib/assemble.mjs`、`lib/sse.mjs` 及相关测试。

**Interfaces:** 共用 `errorOf(data) -> {code,message}`、`errorFrame(record) -> payload|null`、`StreamError`；proxy 保持既有 `errorOf` 导出可用。

- [x] 补测试：首帧/中途纯文本 event:error、带 choices 的显式错误、空值/标量前导帧、[DONE] 不等待 EOF、错误及终止时上游取消、预读记录顺序不丢失。
- [x] 运行 `bun test test/proxy.test.mjs test/assemble.test.mjs test/sse.test.mjs`，记录失败。
- [x] 在解析 JSON 前识别显式 event:error；非对象记录不能调用对象字段判定；保留原始文本错误消息。
- [x] 嗅探遇到 [DONE] 立即结束；chain 的 finally 向底层转发 return，提前错误也关闭迭代器。移除无消费者的 error:null 字段。
- [x] 运行相同测试，确认正常内容、推理、工具分片、错误和取消路径均通过。

## Task 3: 模型协议与 Kimi 历史兼容

**Files:** `lib/models.mjs`、`lib/thinking.mjs`、`test/models.test.mjs`、`test/thinking.test.mjs`、`test/proxy.test.mjs`。

**Interfaces:** runtimeModel 优先当前 profile，实测表仅无 profile 时使用；reasoning=false 时 variants={}。保留 max 仅对精确 kimi-k3 强制，独立保留此前 kimi-k3 家族的工具历史修复。

- [x] 把“档位并集”断言改为“当前 profile 优先”，补已测模型关闭思考的用例和每个声明档位的出站协议断言。
- [x] 补 kimi-k3.1-pro 工具历史缺 reasoning_content、已有字段不覆盖的测试；仍不强制 max。
- [x] 运行对应测试确认失败，再实施最小修改。
- [x] 运行模型/档位/请求管线测试确认通过。Kimi 上游是否要求历史字段仍标注未做在线验证。

## Task 4: 签到响应与测试桩

**Files:** `lib/checkin.mjs`、`test/checkin.test.mjs`。

**Interfaces:** 保持 checkinWith 的 outcome/message/credit 契约；仅成功 HTTP、数值 code 与有效对象数据允许进入业务状态判断。

- [x] 修改 fetch 桩为记录 URL、method、headers、body，并断言领取 POST 的幂等键、configRevision、payload。
- [x] 补 slot/context/POST/复核阶段的 HTTP 503、缺 code、无效 data、claimedToday 非布尔值、actions 缺失及版本接口 HTTP 失败用例。
- [x] 运行 `bun test test/checkin.test.mjs` 确认原实现失败。
- [x] 实现严格信封/状态校验，失败保留可诊断原因；删除未使用的 before 和 ACTIVITY 常量。
- [x] 同一命令确认已领取、无活动、无资格、成功领取与失败重试分类通过。

## Task 5: 清理和整体验证

**Files:** 中英文 README、原优化方案及必要的集成测试。

- [x] 更新受影响的错误处理、身份核对和档位选择说明；移除原优化方案的行尾空白。
- [x] 复查 first() 的使用；若仍只用于测试且方案不再需要它，移除该内部助手和专属测试，保留 SSE/chain 覆盖。
- [x] 在隔离环境运行完整 `bun test`，再运行重复/随机顺序及 UTC 时区测试。
- [x] 运行语法检查、`git diff --check` 和相对 main 的最终差异检查，确认没有凭据/真实配置变更。
- [x] 自审最终差异，记录测试数量、范围及未覆盖的真实上游验证。全部改动保持未提交。

## Verification results

- 环境：Windows、Bun 1.3.14；当前 HEAD 仍为 `184a3f5`，所有修复未提交，未新增运行时依赖。
- 先失败后修复：身份测试 6 个失败、SSE 测试 14 个失败、档位/历史测试 10 个失败、签到测试 22 个失败；对应实现完成后各组通过。旧的不合法 profile 出站断言已随协议修正。
- `bun test`：183 通过、0 失败；`bun test --isolate` 同样 183 通过、0 失败（原审查基线 126 个测试）。
- `TZ=UTC bun test --isolate --randomize --seed 20261102 --rerun-each 3`：549 通过、0 失败。
- `bun test --isolate --coverage --coverage-reporter=text`：183 通过、0 失败；共用错误模块和 thinking 的行覆盖均为 100%。总体覆盖统计包含测试文件，未将其作为产品覆盖率指标。
- `node --check`：入口、库及测试共 25 个 ESM 文件通过。
- `git diff --check` 和 `git diff --check main`：使用仓库默认 Windows 换行设置时通过；未改动 Git 配置。
- 网络仅用桩和已有 loopback 测试，桌面库仅用临时目录；未调用真实签到、续期或付费推理接口，未操作真实 magpie 配置。
- 最终检查为作者自审（当前无普通子代理工具），不是独立审查。真实 magpie 网关、上游多轮工具调用契约仍未在线验证。

## Compatibility decisions

- 无绑定身份的旧账号不自动迁移或凭空绑定；可读 token 身份仍可用，token/用户行冲突或 token 身份不可读则拒绝使用，异常存储可能需要重新登录。
- Kimi 工具历史补齐保持变更前的 kimi-k3 前缀兼容范围，与仅 kimi-k3 本身强制 max 分开；这减少既有兼容性回归，但不能替代真实上游契约验证。
