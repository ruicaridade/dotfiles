# pi Cursor Provider Extension

Authenticates with Cursor via OAuth and exposes Cursor models (Claude, GPT, Gemini, Composer, Grok) inside pi without requiring the Cursor CLI.

## Install

This extension is auto-discovered by pi from `.pi/extensions/cursor/` in this repository. Run `npm install` once inside this directory to fetch `@bufbuild/protobuf`.

## Authenticate

```sh
pi
/login cursor
```

A browser window opens; complete the Cursor login, and the tokens are persisted to `~/.pi/agent/auth.json`.

Set `CURSOR_ACCESS_TOKEN=<token>` to bypass OAuth (useful for CI).

## Models

Models are discovered from Cursor's `AvailableModels` RPC at startup. Use `/cursor-refresh-models` to re-fetch and `/cursor-cleanup` to clear in-memory bridges and conversation cache.

## Attribution

Protocol implementation, native tool redirection, grep parser, and protobuf definitions are derived from [opencode-cursor](https://github.com/Hardcode84/opencode-cursor) (Apache-2.0).
