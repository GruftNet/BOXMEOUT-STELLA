# Contributing to BOXMEOUT

Welcome! BOXMEOUT is a decentralized boxing prediction market built on Stellar Soroban. We're glad you're here. This guide will help you get up and running as a contributor — whether you're into smart contracts, backend APIs, or frontend UI.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Making Contributions](#making-contributions)
- [Smart Contract Contributions](#smart-contract-contributions)
- [Backend Contributions](#backend-contributions)
- [Frontend Contributions](#frontend-contributions)
- [Testing](#testing)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Issue Labels](#issue-labels)
- [Communication](#communication)

---

## Code of Conduct

We follow a simple rule: be respectful, be constructive, and assume good intent. Harassment, discrimination, or toxic behavior of any kind will not be tolerated. If you experience or witness any issues, please reach out to the maintainers directly.

---

## Project Structure

```
boxmeout/
├── contracts/      # Rust / Soroban smart contracts
│   ├── market_factory/
│   ├── market/
│   └── treasury/
├── backend/        # Node.js / TypeScript indexer + REST API
├── frontend/       # Next.js 14 web application
├── docs/           # Architecture and API documentation
└── scripts/        # Deployment and utility scripts
```

Each layer is independent — you don't need to understand the full stack to contribute meaningfully. Pick the layer you're most comfortable with and dive in.

---

## Getting Started

### Prerequisites

| Tool | Version | Required For |
|------|---------|--------------|
| Node.js | 18+ | Backend, Frontend |
| Docker | Latest | Local infrastructure |
| Rust | Stable | Smart contracts |
| stellar-cli | Latest | Contract deployment |
| Git | Any | All |

### Local Setup

```bash
# 1. Fork and clone the repository
git clone https://github.com/your-username/boxmeout.git
cd boxmeout

# 2. Start local infrastructure
docker compose up postgres redis

# 3. Set up the backend
cd backend
cp .env.example .env
npm install
npm run dev

# 4. Set up the frontend
cd ../frontend
cp .env.example .env
npm install
npm run dev

# 5. Build smart contracts (optional, requires Rust + stellar-cli)
cd ../contracts
cargo build --workspace
```

The app will be running at `http://localhost:3000` and the API at `http://localhost:4000`.

---

## Development Workflow

We use a standard GitHub flow:

```
main          ← production-ready code
└── develop   ← integration branch
    └── feature/your-feature-name   ← your work
```

1. Branch off `develop` for new features: `git checkout -b feature/your-feature-name`
2. Branch off `main` for hotfixes: `git checkout -b fix/brief-description`
3. Keep commits small and focused
4. Open a PR against `develop` (or `main` for hotfixes)

### Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add oracle resolution endpoint
fix: correct payout calculation rounding error
docs: update contract deployment instructions
chore: upgrade dependencies
test: add market factory unit tests
```

---

## Making Contributions

### First-Time Contributors

Look for issues tagged `good first issue` — these are scoped to be approachable without deep knowledge of the full stack. A maintainer will be assigned to review your first PR and provide feedback within 48 hours.

### Reporting Bugs

Open a GitHub Issue with:
- A clear title
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Node version, browser if frontend)

### Suggesting Features

Open a GitHub Issue with the `enhancement` label. Describe the use case, not just the implementation. We'll discuss feasibility before you spend time building it.

---

## Smart Contract Contributions

### Requirements

- Rust (stable toolchain)
- `stellar-cli` installed and configured
- Familiarity with Soroban SDK

### Building

```bash
cd contracts
cargo build --workspace

# Run tests
cargo test --workspace

# Build optimized WASM
stellar contract build
```

### Guidelines

- All contract changes require unit tests
- Any change to `MarketFactory`, `Market`, or `Treasury` must include a description of security implications
- Do not introduce new admin-only functions without discussion — we are moving toward decentralization
- Gas efficiency matters — avoid unnecessary storage reads/writes

---

## Backend Contributions

### Stack

- Node.js / TypeScript
- PostgreSQL 15
- Redis 7
- REST API

### Guidelines

- Follow existing TypeScript patterns — strict mode is enabled
- All new endpoints require input validation
- Add or update tests for any logic changes
- Database migrations go in `backend/migrations/` and must be reversible

```bash
cd backend
npm run dev       # Start dev server with hot reload
npm test          # Run test suite
npm run lint      # Check code style
```

---

## Frontend Contributions

### Stack

- Next.js 14 (App Router)
- TypeScript
- Tailwind CSS
- Freighter / Albedo wallet integration

### Guidelines

- Components go in `frontend/components/`
- Pages go in `frontend/app/`
- Use Tailwind utility classes — avoid custom CSS unless absolutely necessary
- Keep wallet interaction logic in dedicated hooks (`hooks/useWallet.ts`, etc.)
- All UI must be responsive

```bash
cd frontend
npm run dev       # Start dev server
npm run build     # Test production build
npm run lint      # Check code style
```

---

## Testing

| Layer | Command | Framework |
|-------|---------|-----------|
| Contracts | `cargo test --workspace` | Rust built-in |
| Backend | `npm test` | Jest |
| Frontend | `npm test` | Jest + React Testing Library |

We aim for meaningful test coverage on business logic. You don't need 100% coverage, but any PR that adds new logic should include relevant tests.

---

## Pull Request Guidelines

Before opening a PR:

- [ ] Code builds without errors
- [ ] Tests pass locally
- [ ] Linting passes
- [ ] You've updated relevant documentation
- [ ] PR description clearly explains *what* changed and *why*

PR titles should follow the same Conventional Commits format as commit messages.

Maintainers aim to review all PRs within **48 hours**. We'll leave constructive feedback and work with you to get things merged.

---

## Issue Labels

| Label | Meaning |
|-------|---------|
| `good first issue` | Beginner-friendly, well-scoped |
| `bug` | Something is broken |
| `enhancement` | New feature or improvement |
| `contracts` | Relates to Soroban smart contracts |
| `backend` | Relates to the API or indexer |
| `frontend` | Relates to the web app |
| `documentation` | Docs-only change |
| `help wanted` | Extra eyes or expertise needed |

---

## Communication

- **GitHub Issues** — bug reports, feature requests, and tracked work
- **GitHub Discussions** — open-ended questions and architecture ideas
- **Discord** — real-time chat, quick questions, and community updates

Join our Discord: [discord.gg/boxmeout](#) *(update with actual link)*

---

Thank you for contributing to BOXMEOUT. Every line of code, bug report, and suggestion helps us build a fairer, more transparent boxing prediction market. Let's build it together.
