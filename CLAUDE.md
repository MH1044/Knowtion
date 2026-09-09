# Claude Code orientation

Knowtion is a local-first, offline knowledge workspace: no server and no account, with
a CRDT operation log as the single source of truth and everything else (SQLite, search,
formulas, views) derived and rebuildable from it. It's a TypeScript npm-workspaces
monorepo: `apps/desktop` is the Electron app (main process + React renderer), and
`packages/` holds the engine, format, sync, editor, importers, and readmodel packages.
The project is pre-alpha and is authored solely by the project owner and AI coding
agents.

Before making changes, read:

- **AGENTS.md** — commit-per-change and branch/push conventions for AI coding agents.
  Read this before your first commit.
- **CONTRIBUTING.md** — the clean-room licensing rule (mandatory, and not optional for
  agents either) and the dependency policy. Read this before opening any prior-art
  source or adding a dependency.
- **ARCHITECTURE.md** — the system design and layering. Read this before touching
  anything that crosses a package boundary.
- **docs/adr/** — append-only architectural decision records explaining why past
  decisions were made. Check here before revisiting a decision that looks odd.
