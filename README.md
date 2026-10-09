# opencode-lobster-auth

Signs in to a [LobsterAI](https://lobsterai.youdao.com) (有道龙虾, NetEase
Youdao's desktop agent) account and serves its models as the provider
`lobster` in [magpie](https://usemagpie.ai). About 30 models: DeepSeek, GLM,
Kimi, Qwen, MiniMax and Doubao.

**English** · [中文](README.zh-CN.md)

## Install

A folder plugin — it is not published to npm:

```sh
magpie plugin add /path/to/magpie-lobster
magpie plugin login lobster
```

## Signing in

Two ways, either one is enough. Both name the account by the Youdao account
id (`yid`), so signing in the second way to an account already signed in the
first way replaces it in place.

- **Browser (a Youdao account).** The plugin serves a callback on
  `127.0.0.1` and magpie opens Youdao's sign-in page. The browser comes back
  with a code, which is traded for tokens at `/api/auth/exchange`. Kept as
  an `oauth` sign-in holding the access and refresh tokens and their expiry,
  so magpie renews it.
- **The desktop's sign-in.** Uses the account LobsterAI's own desktop app is
  signed in to. **No page is opened and nothing is typed.** The app's SQLite
  database is read, never written:
  - Windows: `%APPDATA%\LobsterAI\lobsterai.sqlite`
  - macOS: `~/Library/Application Support/LobsterAI/lobsterai.sqlite`
  - Linux: `~/.config/LobsterAI/lobsterai.sqlite`

  A database that isn't there, or one the app keeps encrypted, fails this
  way with a message saying so; use the browser way instead.

Both are kept in magpie's `plugin-auth.json`.

### Why the import keeps no token

The desktop way stores **no credential at all** — `access` and `refresh` are
empty and `expires` is 0 — and reads the token from the app's database on
every request:

- A copied `refreshToken` would be shared with the app: whichever side
  refreshes first signs the other out. Empty means neither disturbs the
  other.
- `expires` of 0 means magpie never renews it — magpie renews only an
  `oauth` sign-in whose expiry is set — so the app's session is never
  touched.
- Reading it fresh means the plugin follows a token the app renewed, with no
  need to sign in again.

The cost: if the app is signed out, uninstalled, or its database becomes
unreadable, the account stops working at once and magpie is told to ask for
a new sign-in. That is more honest than a token that quietly went stale.

### Renewal

A browser sign-in is renewed by magpie through the plugin's `auth.refresh`,
six hours before it ends. The desktop's sign-in is structurally never
renewed, as above.

The plugin never calls LobsterAI's own refresh endpoint to check or renew
anything: `/api/auth/refresh` may spend the account's real refresh token, so
it is deliberately left alone.

## Requests

Chats are chat completions at
`https://lobsterai-server.youdao.com/api/proxy/v1`. Three of LobsterAI's
habits are handled:

- **Every reply is SSE**, even one asked for with `stream: false`. A
  non-streaming caller gets one `chat.completion` reassembled from it; a
  streaming caller gets the events as they are.
- **Failures ride inside a 200.** LobsterAI puts an error in the stream
  (`event: error`) and still answers 200, which would leave a caller with
  nothing to fail over on. The plugin reads the first record and answers the
  status it means: `40100` → 401, `40300` → 403, `42900` or rate-limit
  wording → 429, anything else → 400. A sign-in LobsterAI turns down is a
  genuine 401, passed through with magpie's lapse mark so the account is
  flagged.
- **Requests carry the desktop client's headers**
  (`X-LobsterAI-Client-Version`, `X-LobsterAI-Client-Capabilities`).
  LobsterAI doesn't insist on them, but they name the feature set the plugin
  speaks.

### Thinking levels

A model's `thinkingConfig` gives it levels — `off`, `high`, `max` in the
current catalogue — and they reach the wire in LobsterAI's own field:
`{"lobsterai_options":{"version":1,"thinking":{"level":"off"}}}`.

Two things are worth knowing:

- **`lobsterai_options` is only for models that have a thinking profile.**
  21 of the 29 models have none, and sending the field to one of those is a
  hard error (`code 4000`, *model does not have a valid thinkingConfig*), so
  the whole chat fails. A level is passed on only where there is a profile
  to map it through.
- **The lowest level is offered as `none`, not `off`.** magpie doesn't use
  what a variant holds; it maps `reasoning_effort` onto a level name the
  model declared, from a ladder of its own
  (`none/minimal/low/medium/high/xhigh/max`). `off` is not on that ladder,
  so a level declared as `off` can never be chosen. The plugin declares
  `none` and turns it back into `off` for LobsterAI.

Measured on `deepseek-flash`: `none` leaves `reasoning_content` at exactly
0 bytes, while `high`, `max` and no level at all don't.

### Kimi K3

LobsterAI's `kimi-k3` takes its sampling parameters from the server, so
`temperature`, `top_p`, `n` and the penalties are dropped, `reasoning_effort`
is fixed to `max`, and an assistant tool call missing `reasoning_content` is
given an empty one. No model in the current catalogue is K3; the handling is
there for when one is.

## Models

Signed in, the list is the account's own (`/api/models/available`): 29
models, each with its context window, whether it takes images, and its
thinking levels. Until then a static list of five is used, so the provider
is visible before signing in.

`costMultiplier` becomes magpie's `rate`. It is **time-of-day pricing**:
`deepseek-flash` is 0.05 in LobsterAI's off-peak hours and 0.1 in the peak
ones (09:00–12:00 and 14:00–18:00, Beijing time). The rate is read when the
list is, so it can be a while out of date.

## Usage

`magpie quota` shows the free allowance, when it ends and the credits left,
from `/api/user/quota` and `/api/user/profile-summary`. The plugin reports
`kept`: it renews nothing itself, so it must not claim a renewal it didn't
do.

## Not here

- **Company accounts.** LobsterAI sends them through a different page
  (`EnterpriseIdentitySelect`). Only personal accounts are handled.
- **A verified `/api/auth/refresh`.** Calling it may spend the account's
  real refresh token, so it is not exercised. The renewal path is written
  from the app's own code and has not been confirmed against the service.
- **An exact output limit.** The catalogue has no such field. The plugin
  declares a conservative 32,000; measured, LobsterAI takes 262,144 and
  answers 500 at 524,288, so the real ceiling is somewhere between.
- **OpenCode.** The plugin is written in OpenCode's provider-plugin format —
  that is the format magpie loads — but it has only been exercised in magpie.
  `auth.refresh`, `auth.refreshLead` and the `magpie` field in `package.json`
  are magpie's own, which OpenCode ignores.
- **Several accounts at once.** magpie keeps one sign-in per provider.

## Development

```sh
bun test
```

The entry point only assembles the hooks. The logic lives in `lib/` as plain
functions and is reached through `_internal`, because magpie and OpenCode
both treat every exported function as a plugin of its own.

## License

MIT
