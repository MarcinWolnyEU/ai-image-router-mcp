# scripts/ — dev & test harnesses

Guidance for working in `scripts/`. These are **not shipped** — ad-hoc harnesses for exercising the
server and its media/gateway paths. See root `CLAUDE.md` for architecture, conventions, and gotchas.

Dev/test harnesses (not shipped; in `scripts/`, run with `npx tsx`):
- `smoke.ts list|genimg <gateway> …` — gateway image listing/generation
- `or-image-caps.ts <model id…>|--list` — print an OpenRouter image model's LIVE `supported_parameters` (`/images/models/{id}/endpoints`: aspect ratios, resolution tiers, quality levels, background modes, n, references, passthrough) — the record the gateway builds requests from. No generation, no cost. Use it before wiring/debugging a model (e.g. gpt-image-2.5 has no `resolution` and no `transparent`).
- `video-test.ts probe-or|eden-i2v|or-i2v <model>|eden-t2v …|or-t2v <model>` — video
- `bg-test.ts [model]` — BiRefNet background removal (downloads ~930 MB on first run)
- `ram-test.ts <model> <ep> [image]` — measure peak RAM/VRAM for a bg model on an execution provider (`RAM_TEST_SAVE=1` dumps the cutout; feeds `models.ts` `usage`)
- `webgpu-forcecpu.ts [model] [image]` — probe WebGPU `forceCpuNodeNames`/run a model on WebGPU. `MODEL_PATH=` overrides the model file; `WEBGPU_VALIDATION=full` surfaces root errors; `FORCED_SEED=a,b` pre-seeds the forced set; `RAM_TEST_SAVE=1` dumps the mask.
- `cascade-wide-ops.ts <in.onnx> <out.onnx>` — CLI for `src/bgremoval/cascade.ts`: rewrite a model so wide `Concat`/`Split` become cascades of ≤8-wide ops, fitting WebGPU's 16-binding limit. **This is what makes the BiRefNet family run on WebGPU (~7–8 s); the runtime now does it automatically.** Manual use only; default Node heap is enough for ~1 GB models.
- `edit-test.ts` — Tinify compress/convert + sharp crop/downsize + ffmpeg crop/downsize
- `mcp-test.ts [--crop --webp --gen --bg]` — spawns the server and drives it as an MCP client (`BUILT=1` to test `dist/`)
- `http-test.ts` — Streamable HTTP client (also exercises `shutdown`)
- `connector-test.ts [url] [--shutdown]` — what Le Chat/Vibe do over HTTP: asserts 401 without/with a wrong bearer token, then lists tools. No generation, no cost. Token from `$MCP_TOKEN` or `mcp http token.txt`; pass the tunnel URL to test the public path.
- `list-tools.ts [--names|--json] [--http [url]]` — list the registered MCP tools (name, description, params; colored table by default). Spawns the server over stdio (`BUILT=1` for `dist/`); `--http` connects to a running `--http` server instead. Spawns with `BG_NO_PREWARM=1` so it doesn't load the ~970 MB bg model just to introspect. Adapted from FoxMCP's `list-tools.sh`.
- `wizard-test.ts` — drives the wizard headlessly via `prompts.inject`
