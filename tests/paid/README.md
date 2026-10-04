# Paid integration tests

Run with `npm run integration:paid`.

These tests call **live, billed APIs** (e.g. fal.ai / OpenRouter / Eden image
generation) and therefore need a real token + cost real money. They are **excluded
from `npm test`** (which runs `unit` then `integration:nonpayment`).

## Convention

- Place each paid test as `tests/paid/<gateway>.<topic>.test.ts` — the glob
  `tests/paid/**/*.test.ts` picks them up automatically.
- Tests must **fail fast if the API token is missing** so a forgetful `npm run
  integration:paid` doesn't burn credit. Read the token from the same default
  files the server uses (`DEFAULT_TOKEN_FILES` in `src/config/schema.ts`) and
  throw a clear `SKIPPED`/setup error when absent.
- Keep the **cheapest** model/provider that exercises the path (e.g. Eden MiniMax
  for video, Krea 2 Medium for fal image gen), and wrap each scenario so a failure
  surfaces the raw provider error.
- Prefer a single test per paid endpoint and keep the total cost / runtime small.
  Reuse the real gateway classes via `createGateway(id, token, logger)` (like
  `scripts/smoke.ts`) rather than going through the full MCP tool for a quick
  contract check — the tool layer is already covered by `integration:nonpayment`.
- Any artifact the test produces should be saved to `output/` for inspection
  (per the project's convention for test runs).

## Example

```ts
import { readFileSync } from 'node:fs';
import { Logger } from '../src/logging/logger.js';
import { createGateway } from '../src/gateways/registry.js';
import { DEFAULT_TOKEN_FILES } from '../src/config/schema.js';

const logger = new Logger('none', 'logs');
const token = process.env.FAL_TOKEN ?? readFileSync(DEFAULT_TOKEN_FILES.fal, 'utf8').trim();
if (!token) throw new Error('fal token missing; set FAL_TOKEN or create "fal ai token.txt"');
const gw = createGateway('fal', token, logger);
// ...gw.generateImage({...}) assertions...
```
