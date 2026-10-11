# AI Delivery Lab

A lightweight task management application foundation built with Vite, React,
TypeScript, and Vitest.

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`
- npm 10 or newer

## Installation

```bash
npm install
```

## Development

Start the local development server:

```bash
npm run dev
```

Vite prints the local URL after startup.

## Testing

Run the automated test suite:

```bash
npm test
```

## Production Build

Create a production build:

```bash
npm run build
```

Preview the built app locally:

```bash
npm run preview
```

## Project Structure

- `src/components` contains reusable dashboard UI components.
- `src/data` contains static sample task data for the starter interface.
- `src/test` contains shared Vitest setup.
- `.github/workflows/ci.yml` runs installation, tests, and production build checks.
