# Contributing to Cairn

Thank you for helping build Cairn! We welcome contributions from developers, designers, and AI researchers.

---

## Core Philosophy

- **Markdown is the source of truth**: The vault is human-readable, Obsidian-compatible Markdown with YAML frontmatter. Nothing essential lives solely in memory or opaque database files.
- **Portability first**: No native binaries. Cairn runs anywhere Node.js 20+ runs (macOS, Linux, Windows, x64, arm64).
- **Strict isolation & security**: Memory is private to the machine or cloud instance. All state modification requires authentication and CSRF validation.

---

## Development Setup

### Prerequisites
- Node.js >= 20.0.0
- npm >= 10.0.0

### Getting Started

```sh
# 1. Clone the repository
git clone https://github.com/Arshdeep-Yadav/Cairn.git
cd Cairn

# 2. Install dependencies
npm ci

# 3. Build TypeScript
npm run build

# 4. Run automated tests
npm test

# 5. Verify package portability (zero native dependencies check)
npm run check:portable
```

### Development Scripts

- `npm run dev`: Run the CLI in development mode using `tsx` (no build step needed).
- `npm run build`: Compile TypeScript to `dist/`.
- `npm test`: Compile TypeScript and run all Vitest suites.
- `npm run typecheck`: Run `tsc --noEmit` to verify type safety.

---

## Pull Request Checklist

Before submitting a pull request, ensure:

1. [ ] All automated tests pass: `npm test`
2. [ ] TypeScript passes with zero errors: `npm run typecheck`
3. [ ] Package portability check passes: `npm run check:portable`
4. [ ] Line endings conform to `.gitattributes` (LF)
5. [ ] Tests are included for any new features or bug fixes
6. [ ] Documentation in `README.md` or `docs/` is updated if applicable

---

## Code Style & Conventions

- We follow standard TypeScript and modern ES module conventions.
- Prefer standard library modules (`node:crypto`, `node:fs`, `node:path`) over adding new external dependencies.
- Any new dependency must be pure JavaScript and cross-platform.
