# pi-qq delivery 2.0.0

> **Delivery record.** 2.0.0 raises the minimum runtime to Node.js 26, refreshes the dependency set, and adapts the media tool schema to the current pi/TypeBox types. No QQ protocol behavior changed. See [README](../../README.md) for current user-facing behavior.
> Version: 2.0.0
> Date: 2026-11-28
> Previous: [delivery.1.7.3.md](./delivery.1.7.3.md).
> Open work: [doc/todo.md](../todo.md).

## 1. Scope

2.0.0 is a breaking runtime and maintenance release:

- Raise the minimum Node.js version from 22.19 to 26.
- Update development and runtime dependencies to their latest compatible versions.
- Adapt the `qq_send_media` parameter schema to the newer `StringEnum` typing in pi/pi-schema.
- Run CI and release workflows on Node.js 26.

Out of scope:

- QQ protocol, stream framing, stream recovery, or reply behavior.
- TypeScript 7 support; `typescript-eslint` does not support it yet.
- New features or settings.
- Re-running the 1.7.3 real-QQ stream tests; 2.0.0 has no runtime protocol changes.

## 2. Findings

### 2.1 Node.js baseline

The previous `engines.node` range was `>=22.19.0`, and CI tested Node.js 22.19.0. The project now targets Node.js 26, matching the development environment (Node.js 26.13.1) and the `@types/node` major.

Raising the minimum Node version is a breaking change for users on Node.js 22 or 24, so the package version is 2.0.0.

### 2.2 TypeScript 7

`typescript-eslint@8.74.0` declares:

```text
typescript >=4.8.4 <6.1.0
```

TypeScript 7.0.2 is outside that range. The latest canary (`8.74.1-alpha.7`) still declares the same range. Installing TypeScript 7 fails npm peer resolution; forcing it would leave lint unsupported. The highest compatible stable TypeScript is 6.0.3, so 2.0.0 uses that.

### 2.3 `StringEnum` typing change

Newer `@earendil-works/pi-ai` versions return a pi-schema `Schema` from `StringEnum`. Wrapping it directly in TypeBox's `Type.Optional` made the media tool's `kind` property required and `unknown` during type checking. The runtime JSON Schema was still correct; only the TypeScript view was wrong.

### 2.4 Dependency refresh

| Package                           | Before  | After   |
| --------------------------------- | ------- | ------- |
| `@earendil-works/pi-coding-agent` | 1.4.0   | 1.7.0   |
| `@tencent-connect/qqbot-nodejs`   | 1.0.5   | 1.0.6   |
| `@types/node`                     | 22.20.5 | 26.6.11 |
| `eslint`                          | 10.14.0 | 10.16.0 |
| `prettier`                        | 3.9.10  | 3.10.1  |
| `typescript`                      | 5.9.3   | 6.0.3   |
| `typescript-eslint`               | 8.72.1  | 8.74.0  |
| `vitest`                          | 5.0.5   | 5.1.2   |

`@eslint/js`, `@tencent-connect/qqbot-connector`, and `qrcode-terminal` were already current.

## 3. Decisions

| #   | Question                                  | Decision                                                                                                                 |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| D1  | What is the minimum Node version?         | Node.js 26.0.0. The package version becomes 2.0.0 because the change breaks Node 22/24 users.                            |
| D2  | Which Node version do CI and release use? | Both use Node.js 26. CI no longer tests the old 22.19 baseline.                                                          |
| D3  | Which TypeScript version?                 | 6.0.3, the highest stable version supported by `typescript-eslint@8.74.0`.                                               |
| D4  | Should TypeScript 7 be forced?            | No. It is outside the typescript-eslint peer range and would make lint unsupported.                                      |
| D5  | Which `@types/node` version?              | 26.6.11, matching the new runtime baseline.                                                                              |
| D6  | How is the media tool schema fixed?       | Keep `StringEnum` and wrap it with `Type.Unsafe<MediaKind>` plus a `TSchema` cast. The emitted JSON Schema is unchanged. |

## 4. Implementation

| Area             | Files                                                       | Change                                                                                 |
| ---------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Runtime baseline | `package.json`, `package-lock.json`                         | Version 2.0.0; `engines.node` is `>=26.0.0`.                                           |
| CI / release     | `.github/workflows/ci.yml`, `.github/workflows/release.yml` | Node.js 26.                                                                            |
| Documentation    | `README.md`, `README-zh.md`, `CHANGELOG.md`                 | Node.js 26 requirement and breaking-change note.                                       |
| Dependencies     | `package-lock.json`, `package.json`                         | Updated compatible dependencies, including TypeScript 6.0.3 and `@types/node` 26.6.11. |
| Media schema     | `src/qq/media-tool.ts`                                      | `MEDIA_KINDS` constant; `Type.Unsafe<MediaKind>(StringEnum(...) as TSchema)`.          |

The media tool's serialized schema remains:

```json
{
  "type": "object",
  "required": ["path"],
  "properties": {
    "path": { "type": "string" },
    "kind": { "type": "string", "enum": ["auto", "image", "video", "file"] },
    "caption": { "type": "string" },
    "name": { "type": "string" }
  }
}
```

## 5. Verification

### 5.1 Automated

- 25 test files, **266 tests passed**.
- `npm run lint`, `npm run typecheck`, `npm run format:check`, and `npm pack --dry-run` pass.
- Environment: Node.js 26.13.1, npm 11.20.0.
- `npm audit`: 0 vulnerabilities.
- `npm outdated`: only `typescript@7.0.2` remains, blocked by the typescript-eslint peer range.

### 5.2 Behavior

- No QQ protocol, stream, reply, or logging behavior changed in 2.0.0; the 1.7.3 real-QQ verification remains applicable.
- The media tool unit tests continue to pass, and the emitted JSON Schema is unchanged.
- CI and release workflows now install and run under Node.js 26.

## 6. Risks and limitations

| Risk                   | Impact                                          | Handling                                                                                  |
| ---------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Node.js 22/24 users    | Cannot upgrade to 2.0.0                         | Stay on 1.7.3, or move to Node.js 26.                                                     |
| TypeScript 7           | Not usable for lint                             | Wait for typescript-eslint to support it; TypeScript 6.0.3 remains supported.             |
| `@types/node` 26       | Type checking no longer models Node 22 APIs     | The package now requires Node 26, so the types match the runtime baseline.                |
| Dependency updates     | Third-party behavior changes                    | Tests cover the extension; no runtime protocol changes were introduced.                   |
| `StringEnum` type cast | The cast depends on the current pi-schema shape | Runtime schema is asserted by the media tool tests; revisit when pi's schema API changes. |

## 7. Open items

Active work is tracked in [doc/todo.md](../todo.md):

- `msg_id` validity beyond one hour.
- `40034020` recovery under real network jitter, reconnects, and rate limiting.
- The cause of duplicate `msg_seq` (`40054005`).

## 8. References

- Node.js releases: `https://nodejs.org/en/about/previous-releases`
- typescript-eslint peer range: `https://www.npmjs.com/package/typescript-eslint`
- TypeScript releases: `https://www.npmjs.com/package/typescript`
- Code: `src/qq/media-tool.ts`, `package.json`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`.
