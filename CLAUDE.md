# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack

Elysia web framework on the Bun runtime, TypeScript with `strict: true`. The project was scaffolded with `bun create elysia` and currently contains only the starter route in [src/index.ts](src/index.ts).

## Commands

- `bun run dev` — run the server with file watching (entry: [src/index.ts](src/index.ts), port 3000)
- `bun install` — install dependencies (lockfile is `bun.lock`, not `package-lock.json`)
- No test runner is wired up yet; the `test` script is the placeholder from `bun init`.

## Notes

- Use `bun` for everything (install, run, exec). Don't introduce `npm`/`pnpm`/`yarn` — it would create a competing lockfile.
- `tsconfig.json` pulls in `bun-types`, so Bun globals (`Bun.serve`, `Bun.file`, etc.) are available without imports.
- The Elysia idiom is method-chained route registration on a single `Elysia` instance (see [src/index.ts:3](src/index.ts#L3)). Prefer composing sub-apps via `.use(plugin)` over splitting state across multiple `new Elysia()` roots.
