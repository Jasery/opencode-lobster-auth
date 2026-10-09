# opencode-lobster-auth

为 [magpie](https://usemagpie.ai) 提供 provider `lobster`：使用有道
LobsterAI（有道龙虾）账号里的模型。

## 登录

两种方式，任选其一：

1. **浏览器登录** —— 插件在本机 `127.0.0.1` 起一个回调服务，打开有道登录页。
   登录成功后浏览器跳回本地，插件用授权码换取 token。存成 OAuth 账号，
   magpie 会在过期前自动续期。
2. **从本机 LobsterAI 导入** —— 只读读取 LobsterAI 桌面端的登录信息
   （Windows `%APPDATA%\LobsterAI\lobsterai.sqlite`）。**不弹浏览器、不需要
   输入任何东西**，直接使用桌面端当前登录的账号。
   这种方式需要先在本机安装并登录 LobsterAI 桌面端。

两种方式用同一个账号标识（有道账号的 `yid`），因此用第二种登录后，
再用第一种登录同一账号会原地替换它。

### 为什么导入这条路不保存 token

导入方式**一个字节的凭据都不存**（`access`、`refresh` 都是空串，`expires` 为 0），
只在每次请求时现读桌面端的库：

- 抄一份 `refreshToken` 会让桌面端和插件共用同一个 token，**谁先续期谁就把
  对方踢下线**。留空则双方互不干扰。
- `expires` 为 0，magpie 因此永不续期（它只在 `expires` 非零时才调用
  `auth.refresh`），桌面端的会话不会被搅动。
- 现读的好处是桌面端续期后，插件下一次请求自动用上新 token，不必重新登录。

代价是：如果桌面端退出登录、卸载或库文件不可读，这个账号会立刻失效并提示
重新登录 —— 这比用一个已经悄悄失效的旧 token 更诚实。

## 模型

登录后从 `/api/models/available` 拉取账号可用的模型（约 30 个，
含 DeepSeek、GLM、Kimi、Qwen、MiniMax、豆包等），并带上各自的思考档位。
未登录时显示一份静态兜底列表。

## 说明

- 思考档位通过 LobsterAI 的私有字段 `lobsterai_options` 传给上游。
  只有自带档位表的模型才会带上这个字段 —— 对其它模型带上它会被上游直接
  拒答（`model does not have a valid thinkingConfig`）。
- 上游始终以 SSE 作答（即使请求写了 `stream:false`），插件会为非流式
  请求重组；上游把错误放在 SSE 里且状态码仍为 200，插件会还原成真正的
  非 2xx，以便 magpie 故障切换。
- 本插件不会主动调用 LobsterAI 的续期接口去验证或刷新「导入」来的 token；
  续期只发生在浏览器登录的账号上，由 magpie 在过期前触发。

## 开发

```bash
bun test
```

## 许可

MIT
