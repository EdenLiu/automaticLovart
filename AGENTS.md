# Repository Guidelines

## Project Structure & Module Organization

This repository is a Node.js CommonJS Playwright automation agent for Lovart.

- `src/run.js` loads configuration and tasks, then starts the agent.
- `src/lib/lovartAgent.js` contains browser workflow, prompt submission, image detection, and reporting logic.
- `src/lib/config.js` reads `lovart.config.json` and `prompts.json`.
- `src/lib/imageStore.js` validates and writes generated image files.
- `src/auth.js` and `src/auth-real-chrome.js` save Lovart login state.
- `picture_lovart/` stores generated task outputs and manifests.
- `.auth/` stores browser login state and should remain private.

There is currently no dedicated `test/` directory.

## Build, Test, and Development Commands

- `npm install` installs dependencies.
- `npm run install:browsers` installs Playwright Chromium.
- `npm run auth:chrome` opens installed Chrome and saves Lovart login state; preferred for Google OAuth.
- `npm run auth` uses the standard Playwright auth flow.
- `npm run run:headed` runs tasks with a visible browser for debugging.
- `npm run run` runs tasks headlessly.
- `node --check src/lib/lovartAgent.js` performs a syntax check for a changed file.

## Coding Style & Naming Conventions

Use CommonJS (`require`, `module.exports`) and Node.js built-ins. Keep code ASCII unless existing file content requires otherwise. Use two-space indentation, descriptive camelCase names for functions and variables, and PascalCase for classes such as `LovartAgent`. Prefer small helper functions near related workflow code. Avoid broad refactors when changing selectors or browser behavior.

## Testing Guidelines

No formal test framework is configured. For changes, run `node --check` on edited JavaScript files. For browser workflow changes, prefer a headed smoke test with `npm run run:headed` and a small `prompts.json`. Avoid submitting real Lovart prompts during diagnostics unless generation is required; monkeypatch submit behavior or inspect DOM when possible.

## Commit & Pull Request Guidelines

Git history currently uses concise imperative commits, for example `Add Lovart automation agent`. Follow that style: `Fix Lovart prompt input`, `Add image validation fallback`.

Pull requests should include a short summary, changed files or behavior, verification commands, and any Lovart UI assumptions such as selectors or observed DOM attributes. Include screenshots only for visible browser/UI failures.

## Security & Configuration Tips

Do not commit `.auth/`, saved storage state, generated images, or private `prompts.json` content. Keep tunable browser selectors in `lovart.config.json`; update that file before hard-coding Lovart-specific DOM details in source code.
