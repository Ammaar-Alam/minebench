# Contributing to MineBench

Thanks for your interest in contributing to MineBench! This document covers how to get started.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Follow the [Quick Start](README.md#quick-start-local) instructions to set up the dev environment
4. Create a new branch for your work

## Ways to Contribute

### Add a New AI Model Provider

MineBench supports multiple AI providers. To add a new one:

1. Create a new provider adapter in `lib/ai/providers/`
2. Follow the pattern of existing adapters (e.g., `openai.ts`, `anthropic.ts`)
3. Register the provider in the model catalog
4. Test generation with the new provider in the Sandbox

### Submit New Benchmark Prompts

Good benchmark prompts test spatial reasoning in interesting ways. To add prompts:

1. Run `pnpm prompt --init --prompt your-slug --text "Your prompt description"`
2. Generate builds for the prompt using available models
3. Submit a PR with the prompt folder under `uploads/`

### Improve the Frontend

The UI is built with Next.js, React, Tailwind CSS, and Three.js. Improvements to the 3D viewer, voting experience, or overall design are welcome.

### Fix Bugs or Improve Documentation

Bug fixes and documentation improvements are always appreciated. Check the [open issues](https://github.com/Ammaar-Alam/minebench/issues) for things to work on.

## Development Workflow

```bash
# install dependencies
pnpm install

# start dev environment (resets DB, runs migrations, starts dev server)
pnpm dev:setup

# seed the database with existing builds
pnpm prompt --import

# run linter
pnpm lint
```

## Pull Request Guidelines

- Keep PRs focused on a single change
- Include a clear description of what the PR does and why
- Make sure `pnpm lint` passes
- Test your changes locally before submitting
- If adding a new model provider, include sample output in the PR description

## Reporting Issues

When reporting bugs, please include:

- Steps to reproduce the issue
- Expected vs actual behavior
- Browser and OS information (for frontend issues)
- Relevant console output or error messages

## Code Style

- TypeScript with strict mode
- Tailwind CSS for styling
- ESLint for linting (`pnpm lint`)
- Keep comments brief and informal

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
