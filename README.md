# opencode-lobster-auth

Signs in to a [LobsterAI](https://lobsterai.youdao.com) (有道龙虾, NetEase
Youdao's desktop agent) account and serves its models as the provider
`lobster` in [magpie](https://usemagpie.ai). About 30 models: DeepSeek, GLM,
Kimi, Qwen, MiniMax and Doubao.

**English** · [中文](README.zh-CN.md)

## Install

From npm:

```sh
magpie plugin add opencode-lobster-auth
magpie plugin login lobster
```

`magpie plugin update` picks up later versions.

To run a checkout instead of the published package, point at the folder:

```sh
magpie plugin add /path/to/magpie-lobster
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
- **Remote browser.** For magpie on a server, in Docker, or anywhere the
  browser is on another machine: the callback lands on the browser's own
  `127.0.0.1` and never reaches magpie. The sign-in page's plain query names
  the callback port, so magpie offers a **Callback URL** field: sign in, copy
  the whole address the browser ends on, paste it there, and magpie sends it
  to the port the plugin is listening on. The rest is the browser way.
- **The desktop's sign-in.** Uses the account LobsterAI's own desktop app is
  signed in to. **No page is opened and nothing is typed.** The app's SQLite
  database is read, never written:
  - Windows: `%APPDATA%\LobsterAI\lobsterai.sqlite`
  - macOS: `~/Library/Application Support/LobsterAI/lobsterai.sqlite`
  - Linux: `~/.config/LobsterAI/lobsterai.sqlite`

  A database that isn't there, or one the app keeps encrypted, fails this
  way with a message saying so; use the browser way instead. The imported
  identity is checked against the current token, and an incomplete or
  conflicting identity fails closed rather than using another account's token.

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
- **Failures ride inside a 200.** LobsterAI puts errors in the stream
  (`event: error`, or an error JSON record) and still answers 200, which
  would leave a caller with nothing to fail over on. The plugin inspects the
  early records, preserves plain-text error messages, and answers the status
  it means: `40100` → 401, `40300` → 403, `42900` or rate-limit wording →
  429, anything else → 400. Non-streaming requests also catch an error that
  appears after an initial response chunk; streaming requests preserve such
  an event after content has started. A sign-in LobsterAI turns down is a
  genuine 401, passed through with magpie's lapse mark so the account is
  flagged.
- **Requests carry the desktop client's headers**
  (`X-LobsterAI-Client-Version`, `X-LobsterAI-Client-Capabilities`).
  LobsterAI doesn't insist on them, but they name the feature set the plugin
  speaks.

### Thinking levels

There are two kinds of model in LobsterAI's catalogue, and the plugin
speaks to each in its own way.

**8 models carry a `thinkingConfig`** (`deepseek-*`, `glm-*`), with the
levels `off`/`high`/`max`. Those go out in LobsterAI's own field:
`{"lobsterai_options":{"version":1,"thinking":{"level":"off"}}}`. Sending
that field to a model **without** a profile is a hard error (`code 4000`,
*model does not have a valid thinkingConfig*), so it is written only where
there is a profile to map it through. With a profile, only its declared
levels are offered; separately measured `reasoning_effort` levels apply only
while a model has no profile.

**10 models carry no profile** but still report `supportsThinking: true`.
For those the plugin declares levels and lets magpie's `reasoning_effort`
pass straight through, which LobsterAI honours.

Two things are worth knowing:

- **The lowest level is offered as `none`, not `off`.** magpie doesn't use
  what a variant holds; it maps `reasoning_effort` onto a level name the
  model declared, from a ladder of its own
  (`none/minimal/low/medium/high/xhigh/max`). `off` is not on that ladder,
  so a level declared as `off` can never be chosen. With a profile the
  plugin declares `none` and turns it back into `off`; without one it sends
  `none` as it is, since LobsterAI accepts it.
- **Levels differ per model and were measured, not assumed.** LobsterAI
  refuses some of them outright: `MiniMax-M3.1-Flash` rejects `none`
  (*requires adaptive thinking*), `qwen3.7-max` stops at `xhigh`, and
  `qwen3.7-plus` answers `max` with an occasional 500. `MiniMax-M3` writes
  its thinking into `<think>` tags inside the content and `reasoning_content`
  stays empty; its effort isn't graded at all, so it offers only `none` and
  `max`. A model whose levels were not measured declares none, and magpie
  shows it as *thinks, no levels*.

Measured on `deepseek-flash`: `none` leaves `reasoning_content` at exactly
0 bytes, while `high`, `max` and no level at all don't — and on
`kimi-k3.1-pro`, `none` leaves it at 0 bytes while `xhigh` produces some.

### Kimi

Every Kimi model takes its sampling parameters from the server:
`temperature` must be 1, `top_p` 0.95 and the penalties 0, so the plugin
drops `temperature`, `top_p`, `n` and both penalties for the whole family —
it measured that for `kimi-k3`, `kimi-k3.1-pro` and `kimi-k2.8-preview`
alike. A client that always sends `temperature` (most agents do) would
otherwise be answered `50204 invalid temperature: only 1 is allowed`.

Only `kimi-k3` has `reasoning_effort` fixed to `max`. That forcing is
not extended to `kimi-k3.1-pro`, which honours the full ladder and would
otherwise have every level silently overridden. Separately, tool-call
history repair stays enabled for the `kimi-k3` family, including
`kimi-k3.1-pro`: an assistant tool call missing `reasoning_content` is given
an empty string without overwriting existing reasoning or the chosen effort.

`kimi-k3` is one of the models LobsterAI serves without listing it in every
catalogue revision. It is kept in the list this package declares for a
signed-out account, so `lobster/kimi-k3` stays offered.

## Models

Signed in, the list is the account's own (`/api/models/available`) — 18 or
19 usable models, each with its context window, whether it takes images,
and its thinking levels. Until then a static list of five is used, so the
provider is visible before signing in.

`costMultiplier` becomes magpie's `rate`. It is **time-of-day pricing**:
`deepseek-flash` is 0.05 in LobsterAI's off-peak hours and 0.1 in the peak
ones (09:00–12:00 and 14:00–18:00, Beijing time). The rate is read when the
list is, so it can be a while out of date.

The reply limit is 131,072. The catalogue's `maxTokens` field is always
null, so this was measured: all 18 models answered `max_tokens=131072`,
`glm-5.3` names `[1, 131072]` as its own range, and 524,288 is where
LobsterAI starts answering 500.

## Usage

`magpie quota` shows the credits left and when the soonest batch expires,
from `/api/user/quota` and `/api/user/profile-summary`. The credits are
reported as a **wallet window** (`余额·点数` with `runsOut`/`runsOutAt`)
rather than a plain string, so magpie can show the lapse and routing can
spend the account that runs out first. Every day's check-in adds 100 points
that lapse 30 days later, first in first out, so knowing the date matters.
The plugin reports `kept`: it renews nothing itself, so it must not claim a
renewal it didn't do.

Expired free allowances are not reported as a live window — the free period
ended in August 2026, and showing "6% used" looked like a usable allowance.

## Daily check-in

The plugin implements `auth.checkin`, so magpie can claim LobsterAI's daily
gift (100 points) for you. **It is off by default**: turn it on under
Settings → Usage → Plugins. Once on, every signed-in LobsterAI account is
checked in once a day (Beijing time).

This is the only way to collect those points without opening LobsterAI's own
desktop app, whose sidebar holds the check-in. The claim is idempotent — a
day already claimed answers `51104`, and the plugin reports `done` rather
than claiming again — and every claim is confirmed by re-reading the state
before it is reported as `claimed`. HTTP failures, malformed business
responses and invalid state are reported as `failed`, not as an inactive
activity or an ineligible account, so magpie can retry later that day.

## Not here

- **Company accounts.** LobsterAI sends them through a different page
  (`EnterpriseIdentitySelect`). Only personal accounts are handled.
- **A verified `/api/auth/refresh`.** Calling it may spend the account's
  real refresh token, so it is not exercised. The renewal path is written
  from the app's own code and has not been confirmed against the service.
- **OpenCode.** The plugin is written in OpenCode's provider-plugin format —
  that is the format magpie loads — but it has only been exercised in magpie.
  `auth.refresh`, `auth.refreshLead`, `auth.checkin` and the `magpie` field
  in `package.json` are magpie's own, which OpenCode ignores.

## Several accounts

magpie can hold more than one sign-in per provider, and this plugin supports
that: sign in to a second Youdao account through the browser and both are
listed.

The desktop import is the exception to watch. LobsterAI's desktop app has one
signed-in account at a time, and the plugin reads that app's token on every
request. So an account imported from the desktop is tied to the account that
was signed in when it was imported: switch the desktop to another account,
and the imported one is marked *signed out · sign in again* rather than
quietly spending the other account's credits. Sign it in again, or use the
browser sign-in for accounts you want to keep independent.

## Development

```sh
bun test
```

The entry point only assembles the hooks. The logic lives in `lib/` as plain
functions and is reached through `_internal`, because magpie and OpenCode
both treat every exported function as a plugin of its own.

## License

MIT
