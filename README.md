# ai-image-router-mcp

An [MCP](https://modelcontextprotocol.io) server that routes **image generation**,
**image-to-video**, **text-to-video**, and **local background removal** across multiple
LLM gateways — built on the official
[TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), using **direct
REST calls only** (no vendor SDKs).

## Supported gateways

| Gateway | Image generation | Text→Video | Image→Video |
|---------|:---------------:|:----------:|:-----------:|
| [OpenRouter](https://openrouter.ai/docs/guides/overview/multimodal/image-generation) | ✅ (`/images`; reference images via `input_references`) | ✅ (`/videos` async) | ✅ (frame images) |
| [Mistral AI](https://docs.mistral.ai/agents/connectors/image_generation/) | ✅ (Agents `image_generation`, FLUX1.1 [pro] Ultra) | — | — |
| [Eden AI](https://www.edenai.co/docs/api-reference/universal-ai/universal-ai) | ✅ (`/v3/universal-ai`, sync) | ✅ (`/v2/video/generation_async`; a `model` override is checked against Eden's public catalog before submitting) | ✅ (single + multi-ref) |
| [fal.ai](https://fal.ai/docs) | ✅ (queue — FLUX 2 Pro, FLUX 1.1, Recraft, Cosmos, Krea 2, Ideogram) | ✅ (queue — Veo/Kling/… ; not Cosmos) | ✅ (queue — Cosmos 3, single image) |

> **fal image request defaults** — fal's image models default to `jpeg` and may apply a strict safety gate. `fal.generateImage` seeds `output_format:"png"`, `safety_tolerance:"5"` (most permissive), and `enable_safety_checker:false` **only on models whose schema carries them** (per-model; a caller's explicit `provider_options` overrides). fal models differ per family: **FLUX/Recraft/Cosmos** take an object `image_size` `{width,height}` (exact pixels) or an enum tier; **Krea 2/Ideogram** take an `aspect_ratio` enum (no exact pixels).

Background removal runs **locally** (no gateway) via
[ONNX Runtime](https://github.com/microsoft/onnxruntime) + BiRefNet.

## Tools

| Tool | What it does |
|------|--------------|
| `generate_image` | Generate image(s) from a prompt; saves to the output dir and returns the path (+ inline preview). **Size**: `width` (px) is the primary lever; `height` is derived from `width` × `aspect_ratio` (default `1:1` → square) unless given. Gateways whose models accept exact pixel sizes (fal object `image_size`) honor width×height directly; others map to a tier. A lone `height` derives the width from the aspect ratio, and when a model returns a different size than the one you asked for, the reply says so (`Note: requested W×H, but <model> returned A×B`). `n` (images per call) is offered wherever the model advertises it (Eden; OpenRouter models such as gpt-image-1-mini). **Async**: `wait:false` submits the job and returns a `job_id` immediately (so a slow generation never trips a client timeout) — re-invoke with that `job_id` to poll it; the provider's native `request_id` (fal) is surfaced once the job is running. The result is saved to disk as soon as the job finishes (even if you never poll), and every poll of a finished job returns the **same** files — polling again never writes duplicates or re-runs Tinify. A failed job reports the same possible-cause hints as a blocking call. **Reference images**: where the model supports them (OpenRouter `input_references`, fal Krea `image_style_references`), pass `reference_images` — local paths / URLs / data-URLs. Passing them to a model with **no image-conditioning input fails hard before any API request (no credits)**. `output_format` may be `png`/`webp`/`jpg`/`avif` (Tinify) or **`ico`** (a single-entry Windows icon — see below); `output_mode` may be `filePath` (default) or `base64`. **Per-model options (OpenRouter)**: the tool's schema is built from the model's live `supported_parameters` — **`quality`** (e.g. gpt-image-2.5: `auto`/`low`/`medium`/`high`/`xhigh`/`max`) appears only when the model has it, `image_size` disappears for a model with no resolution tier (gpt-image-2.5 renders at its native full size, which is stored as-is — a configured default tier is dropped with a note), and the `background` description states the native modes (gpt-image-2.5: `auto`/`opaque` only — `transparent` is refused **before** generation with a `remove_background` hint). Explicit `width`×`height` is sent as an exact `size` (falls back to the native size if the provider rejects it as too small). Every result line reports the **image type, pixel size and bytes** (`image/png 1536×1024 (862 KB)`), and API failures come back **explained** (HTTP status meaning, OpenRouter `error_type`, moderation reasons, the offending parameter) with possible-cause hints. |
| `generate_image` (\`ico\`) | With `output_format:"ico"`, wraps the one generated image in a **single-entry Windows `.ico`** at `width` (a square dimension — one of `16/20/24/32/40/48/64/72/96/128/256`; default `256`). The render is **square by default** — the configured default aspect ratio is not applied to icons; pass `aspect_ratio`/`height` explicitly to render non-square. If the model supports exact pixels (fal object `image_size`), it renders `width`×`width` directly; otherwise the model renders at a supportable size ≥ `width` and the result is **downscaled to exactly `width`** with a slight sharpen — **never upscaled** (a too-small model output errors, and a non-allowlist `width` is rejected before generation). A **non-square** model result is fitted whole onto the square canvas (`square_fit:"pad"`, the default — `pad_color` sets the fill; `"crop"` opts into the old center-crop), and the reply always states which was done. The untouched original is kept as `<name>-original.png`. |
| `generate_image` (constraints) | **`palette`** pins the accent colours (hex list) — compiled into an exact-colour instruction (plus "no <other hue families>"), mapped to a native palette field where the model has one (fal Recraft `colors[]`), and the result is **measured** against it (share of accent pixels on each colour + the dominant off-palette accent). **`exclude`** lists what must not appear ("text", "watermark", "cable", …) — known terms are expanded to the phrasing that actually suppresses them and sent as the model's own `negative_prompt` where it has one. **`background`** (`transparent` / a hex / a colour word / free text) is mapped natively where possible (OpenRouter `background`, fal Recraft `background_color`) and verified against the result's border. **`reference_mode`** picks what a reference image is FOR — `subject` (condition on its object design/geometry) or `style` (adopt its look/medium); a mode the configured model cannot provide is refused **before** generating, naming what it does provide. |
| `image_to_video` | Turn stills into motion. `output_format:"mp4"` (default) animates reference image(s) with the configured model (single / first+last frame / multi-reference); extra frames a model cannot take (fal sends one image) are refused before anything is billed, `provider_options` passes model-native fields, and a video file handed in as `image` is rejected. `output_format:"gif"` assembles supplied frames — `image` (first), `images_inner` (ordered middle), `image_last` — into an **animated GIF locally** (no gateway, no cost): per-frame timing via `fps` (a number, or an array of one fps per frame), `loop`, 1-bit transparency, and an automatic palette/size optimization (knee of the quality-vs-size curve). |
| `generate_video` | Generate a video from a text prompt. Async by default: poll with just `{ job_id }` (the `prompt` is only needed to submit). With a `model` override the configured default resolution/fps/duration (chosen for the configured model) are not applied. |
| `remove_background` | Local background removal (BiRefNet / BRIA / IS-Net / BEN2) → transparent PNG (no gateway). |
| `crop_media` | Crop an exact pixel region from an **image** (sharp `.extract`) or **video** (ffmpeg). |
| `transform_media` | One tool to **downsize** (sharp MKS-2021 / ffmpeg, shrink-only), **convert format** (png/jpg/webp/avif — Tinify when configured, else sharp), **extract a still frame** from a video (skips mostly-black frames), and/or change `output_mode`. With only `output_mode` it returns the file unchanged. Requesting a video format for an image errors → use `image_to_video`. `image` accepts an array for **batching** (each processed independently; `inline_preview` is forced off) or, with `output_format:"ico"`, to **build a multi-size / merged Windows icon**: each image must already be a square allowed ICO size (no resizing — use `generate_image` to downscale instead), existing `.ico` files are parsed and merged, and duplicate sizes are rejected. Pass **`sizes`** to DECLARE the set the icon must contain: the result must equal it exactly or the call fails and writes nothing, and with one size per input a file whose real dimensions differ from its declared slot is reported by name (use `build_icon_set` when you want the sizes derived rather than validated). Either way every entry is reported with the input it came from. An **ICO input with a non-ico image `output_format`** (png/jpg/webp/avif) **unpacks every size** into its own file named `<stem>-<WxH>.<ext>` (e.g. `favicon-256x256.png`; `stem` is the source filename minus extension, or `icon` for a URL/data:URL/base64 input). Existing files are never overwritten — if a name is taken the whole set gets a numbered stem (`icon-2-48x48.png`) — and `save:false` writes nothing. `width`/`height` are ignored when unpacking. |
| `build_icon_set` | Build a whole icon set in **one** verifiable operation: every declared size is derived from the intended source by downscaling (never re-generated), emitted as its own exact-`WxH` file, and assembled into a multi-size `.ico` that is checked to contain **exactly** the declared set. `variants` points specific sizes at a simplified source (e.g. a mark without the wordmark for 16/24/32) while they stay part of the same set. Non-square sources are padded, not cropped, by default (`square_fit`). The reply lists every entry with the source it came from, and duplicate/unknown/un-derivable sizes fail before anything is written — every size is derived and the icon verified in memory first, so a failure never leaves a partial set on disk. |
| `health_status` | Detailed health: gateway, configured models/options, execution provider, logging, and any wizard-time or runtime errors. |
| `restart` | Soft reload — re-read `config.json`, re-init the gateway + ONNX session, clear errors (connection stays alive). All-or-nothing: if the new config can't be applied (e.g. a missing token file), the previous configuration stays fully active and the error is reported. On success the tool list and option schemas are refreshed for the new gateway/model (clients are notified via `tools/list_changed`). |
| `shutdown` | Gracefully flush logs and stop the process. |

`generate_video` appears only when the active gateway supports text-to-video (so Mistral
never shows it). `image_to_video` is **always** available — its `output_format:"gif"` mode
runs locally, so it works under any gateway; only its `mp4` mode needs an image-to-video
model. `remove_background` appears unless the background model is set to `none`.
The generation tools accept a `provider_options` object to pass gateway/model-specific fields
(e.g. OpenRouter `image_config`, MiniMax `prompt_optimizer`/camera commands, Veo `generate_audio`;
Mistral's image tool takes none — they are ignored there and the reply says so). Notes like
`Note: … generated WITHOUT: resolution, fps` tell you when a request had to be adapted.

## Requirements

- **Node.js ≥ 20**
- One or more gateway API tokens, each as a **plain text file in the project root**
  (token only, no prefix):
  - `openrouter token.txt`
  - `mistral ai token.txt`
  - `eden ai token.txt`
- *(optional)* A **Tinify** key as `tinify com token.txt` — enables PNG compression + WebP output.
- *(optional)* **ffmpeg** on your PATH — required only for **video** crop/downsize; image editing and everything else work without it.

## Install

```bash
npm install
npm run build
```

## Configure

Run the interactive wizard:

```bash
npm run configure
```

It walks you through:

1. **Gateway** selection.
2. **Token** source (auto-detects the root `*.txt` file).
3. **Image model** — pulled live from the gateway API, with Artificial Analysis
   leaderboard top-10 matches marked `⭐ #N` and floated to the top of the list
   (best rank first; the rest follow latest-first). Ranked models the gateway
   doesn't offer can't be selected, so the wizard prints a note listing them
   (e.g. OpenRouter doesn't carry `#2` GPT Image 1.5, so it's absent)
   (see [docs/UPDATING-LEADERBOARDS.md](docs/UPDATING-LEADERBOARDS.md) to refresh those lists).
4. **Default aspect ratio** (from the API, or a curated preset list with explanations — default `4:3`).
5. **Default resolution** (from the API, defaulting to the highest; custom input otherwise).
6. **Sync vs async** — right after selecting each model, you choose whether generation runs as an **async background job** (default: returns a `job_id` to poll, so a slow generation never trips a client timeout) or **synchronous** (the call blocks until the result is ready). Set separately for image, image-to-video and text-to-video; override per call with `wait:true`/`wait:false`.
7. **Image-to-video** & **text-to-video** (if the gateway supports them): model, sync/async, FPS, resolution, duration. (Whether an i2v model accepts multiple reference images is derived from the gateway, not asked.)
8. **Background removal** — the wizard asks for the **ONNX execution provider first** (`auto`/`cpu`/`dml`/`webgpu`/`cuda`/`coreml`), shows your free/total **RAM and VRAM**, then lists the models annotated with their empirical RAM/VRAM use **for that provider** (and whether each one actually runs on it). Models: `none`, `birefnet-general` (default, best quality), `birefnet-massive` (broader training), `bria-rmbg` (BRIA RMBG-2.0), `isnet-general-use` (lighter IS-Net). **Heads-up:** BiRefNet and bria-rmbg break DirectML regardless of VRAM. On **CPU** they need ≈7.5 GB free RAM (≈25 s). On **WebGPU** the server transparently converts them to a GPU-compatible (cascaded) variant on first use (≈7–8 s) — `isnet-general-use` (IS-Net) also runs on WebGPU directly and is fastest (≈2.5 s, ≈1.3 GB VRAM). If free RAM is too low the tool fails with a clear "needs ~N GB free, you have Y GB" message (override the check with `BG_RAM_CHECK=off`).
9. **Logging policy** — `none`, `today` (default), or `persistent-daily`.

The result is written to `config.json`, along with a `diagnostics` block recording any
errors or missing data hit while pulling model lists (surfaced by `health_status`).

Re-running the wizard when a `config.json` already exists **pre-selects your current
settings** as the default for each prompt, so you can press Enter through the ones you
want to keep and only change what you need. (Switching to a different gateway resets the
gateway-specific choices — model, token, aspect ratio, resolution, video — to their
standard defaults, since the old selections no longer apply.)

> `config.json` and the token `*.txt` files are git-ignored — they hold secrets.

## Run

For **stdio** (the usual case) you don't run the server yourself — register it
(below) and your MCP client spawns it on demand. `npm start` is only for a manual
stdio smoke test. **HTTP** mode is the one you start yourself:

```bash
npm start                # stdio — normally launched by the client, not by you
npm start -- --http      # Streamable HTTP transport (host/port from config.json)
```

The HTTP endpoint is `http://<host>:<port>/mcp` (default `127.0.0.1:8765`). It is **unauthenticated unless
`http.authToken` is set** — the wizard offers to generate one (saved as `mcp http token.txt`). With a token
configured, every request must carry `Authorization: Bearer <token>` (or `X-API-Key: <token>`) and anything
else gets a plain `401`. Set one before exposing the port beyond localhost: the tools read and write local paths.

Without a token the server still refuses requests whose `Host` or `Origin` header names a foreign domain
(`403`). This guards against **DNS rebinding**, where a malicious web page reaches `127.0.0.1` through its own
domain and drives the tools from your browser. Loopback names (`localhost`) and IP literals are always
accepted. To reach a token-less server through another hostname (e.g. a LAN name), list it in
`http.allowedHosts`. With a token set the check is skipped, so a tunnel's public hostname just works.
Sessions idle for `http.sessionIdleMinutes` (default 30) are closed; a client using an expired session id
gets a `404` and re-initializes, as the MCP spec prescribes.

### Register with Claude Code

```bash
claude mcp add ai-image-router -- node /absolute/path/to/ai-image-router-mcp/dist/index.js
```

### Register with Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "ai-image-router": {
      "command": "node",
      "args": ["V:/MCP/ai-image-router-mcp/dist/index.js"]
    }
  }
}
```

### Register with Pi

Add the server to Pi's MCP config. Global (all projects) lives at
`~/.pi/agent/mcp.json`; project-scoped servers go in `.pi/mcp.json` instead:

```json
{
  "mcpServers": {
    "ai-image-router": {
      "type": "stdio",
      "command": "node",
      "args": ["V:/MCP/ai-image-router-mcp/dist/index.js"],
      "env": {}
    }
  }
}
```

Pi discovers MCP servers at startup. If Pi is already running, you don't need to
quit and restart it — run `/reload` in the Pi chat to re-read the config and pick
up the newly registered server without leaving the session.

After `/reload` the server may appear in Pi's MCP list but show as
**not connected** (`mcp({})` / `/mcp`). Reconnect it in the chat with:

```
/mcp reconnect ai-image-router
```

(equivalently `mcp({ connect: "ai-image-router" })`). Once connected, the tools
show up under `ai-image-router_*`.

### Using with Le Chat / Mistral Vibe

#### Le Chat (custom MCP connector, over HTTP)

Le Chat connects from Mistral's cloud, so the server must be reachable at a **public HTTPS URL with a valid
TLS certificate** — `localhost` cannot work.

1. Run `npm run configure` and enable HTTP with an auth token (writes `mcp http token.txt`), or set
   `http.enabled: true` and `http.authToken` in `config.json`. Then `npm start -- --http`.
2. Expose it, e.g. with a tunnel: `cloudflared tunnel --url http://127.0.0.1:8765` (use the printed
   `https://….trycloudflare.com` URL + `/mcp`).
3. In Le Chat: **Connectors → Add connector → Add a custom connector**. Give it a name (**letters/digits
   only** — e.g. `aiimagerouter`; an underscore keeps the form disabled), the URL (`https://<tunnel-host>/mcp`)
   and a description. Auto-detect selects **API Token Authentication → Bearer**; paste the token and click
   **Add connector** — the page should then show *Valid* and the tool list. Verify the public path first with
   `npx tsx scripts/connector-test.ts https://<tunnel-host>/mcp`. Adding a connector is an admin action (the
   account owner on Free/Pro).
4. Tools only — Le Chat does not use MCP resources/prompts. Each tool has an "Always allow" toggle.

Notes: the server deliberately answers an unauthenticated request with a plain `401` (no
`WWW-Authenticate` challenge) so Le Chat offers token entry instead of attempting OAuth. Returned file
paths are on the **server's** disk — a later tool call can read them (chaining by path works), but you
cannot open them from Le Chat; use `output_mode:"base64"` for media you want to see there.

#### Mistral Vibe CLI

Vibe reads `~/.vibe/config.toml` (or a trusted project `./.vibe/config.toml`); each server is a
`[[mcp_servers]]` entry and its tools appear as `{name}_{tool}` (e.g. `air_generate_image`).

stdio (Vibe spawns the server; `BG_NO_PREWARM` skips the ~1 GB background-model load at startup):

```toml
[[mcp_servers]]
name = "air"
transport = "stdio"
command = "node"
args = ["V:/MCP/ai-image-router-mcp/dist/index.js"]
env = { BG_NO_PREWARM = "1" }
startup_timeout_sec = 60
tool_timeout_sec = 300
```

HTTP (server started separately with `npm start -- --http`; Vibe has no OAuth, so use a static header):

```toml
[[mcp_servers]]
name = "air"
transport = "streamable-http"   # "http" also accepted
url = "http://127.0.0.1:8765/mcp"
headers = { Authorization = "Bearer <token from mcp http token.txt>" }
startup_timeout_sec = 60
tool_timeout_sec = 300
```

In Vibe, `/mcp` lists the servers and `/mcp air` lists that server's tools.

## Generated media & previews

Files are written to the configured **output directory** (default `output/`) with
descriptive, timestamped names. Tools return the absolute file path as a `resource_link`,
plus an inline image preview for small images (downscaled automatically if needed). This
keeps large videos out of the conversation while still giving you the file.

When a call **fails**, the result is `isError: true` with a `text` block describing what
went wrong. Where the underlying cause is an account/config issue the gateway reports
opaquely, the result may also include actionable **possible-cause hints** (e.g. an
OpenRouter provider on your *Ignored Providers* list, or a key with *Include BYOK*
enabled while OpenRouter credit remains). Each hint is a `text` block prefixed
`Possible cause:` and tagged with `_meta."ai-image-router/category" = "possibleCause"`,
so it both displays in any client and is detectable programmatically. These are
best-effort guesses, not guarantees.

## Image compression & WebP (Tinify)

Provide a [Tinify](https://tinify.com/developers) key (default file `tinify com token.txt`,
or set it in the wizard) to optimise `generate_image` output via direct REST calls (no
Tinify SDK):

- `generate_image` gains an `output_format` of `png`, `webp`, `jpg`, or `avif`.
- **`png`** (default): the model is steered to PNG, the raw PNG is kept as
  `<name>-original.png`, and a Tinify-**compressed** PNG is saved as `<name>.png` and returned.
- **`webp`** / **`jpg`** / **`avif`**: the source PNG is kept as `<name>.png` and a Tinify-**converted**
  `<name>.webp` / `<name>.jpg` / `<name>.avif` is saved and returned. This always goes through Tinify (even for
  models that can emit those formats natively) because Tinify produces noticeably smaller files (`avif` is usually the smallest).
- If Tinify fails, the original PNG is saved and a warning is included — a generation is never lost.

> Typical results on a 1 MB generated PNG: compressed PNG ≈ −46–64%, WebP ≈ −95%.

## Media editing (`crop_media` & `transform_media`)

`crop_media` and `transform_media` work on **images and videos** and take a file path, http(s)
URL, data: URL, or base64:

- **Images** use **sharp** — crop is a pixel-exact `.extract({left, top, width, height})`;
  downsize uses the **Magic Kernel Sharp 2021** kernel and only ever shrinks (preserves aspect).
- **`transform_media`** is a Swiss-army tool: pass `width`/`height` to **downsize**, `output_format`
  (`png`/`jpg`/`webp`/`avif`) to **convert** (Tinify when configured, else sharp), nothing but
  `output_mode` to return the file **unchanged**, or an image `output_format` on a **video** to
  **extract a representative still** (it samples from 10% in and skips mostly-black frames).
  `output_format:"mp4"` on a **video** converts it to an H.264/AAC mp4 (webm/mov/mkv/avi → mp4; an
  mp4 passes through unchanged). Asking for a video format on an image errors and points you at
  `image_to_video`. `save:false` writes nothing (inline previews instead, when enabled) — including
  when building an `.ico`.
- **ICO inputs** are read with the project's own decoder: PNG-compressed entries (the 256 px entry in
  most modern favicons), 1/4/8-bpp paletted, 16/24/32-bpp bitmaps, and the AND transparency mask.
- **`output_mode`** (on every media tool): `filePath` (default — saves and returns the path) or
  `base64` (also saves, but returns the full bytes inline; large for video). A PNG returned as
  `base64` while Tinify is enabled is compressed first (the uncompressed copy is kept as `-original`).
- **Videos** use **ffmpeg from your PATH** (frame extraction needs `ffprobe` too, which ships with
  ffmpeg). If `ffmpeg` is not installed, video operations return a clear message (image editing is unaffected).

## Configuration reference (`config.json`)

| Key | Notes |
|-----|-------|
| `gateway` | `openrouter` \| `mistral` \| `edenai` \| `fal` |
| `token` | `{ type: "file" \| "inline" \| "env", value }` |
| `image` | `model`, `edenProvider`, `defaultAspectRatio`, `defaultResolution` (not sent to a model that has no resolution parameter — e.g. gpt-image-2.5; the wizard skips the question for such a model), `async` (`true`=async background job, default), supported lists. `width` (px) is the size lever (height derived from `aspect_ratio`, default square); `output_format:"ico"` uses `width` as the square icon dimension (default `256`). |
| `imageToVideo` / `textToVideo` | `enabled`, `model`, `defaultFps`, `defaultResolution`, `defaultDuration`, `async` (`true`=async background job, default) (+ `multiReference` for i2v) |
| `backgroundRemoval` | `model` (`none`/`birefnet-general`/`birefnet-massive`/`bria-rmbg`/`isnet-general-use`/`ben2-base`), `executionProvider` (`auto`/`dml`/`cuda`/`coreml`/`webgpu`/`cpu`). `auto` = **WebGPU on Windows**, CoreML on macOS, CUDA on Linux x64, else CPU (the runtime, the wizard and `health_status` resolve it the same way). A provider the bundled ONNX Runtime doesn't ship on your platform (CUDA = Linux x64, CoreML = macOS, DirectML = Windows) isn't offered and falls back to CPU. BiRefNet & bria-rmbg run on CPU (~7.5 GB RAM) or WebGPU (auto-converted to a cascaded variant on first use); not DirectML — with `dml` configured they fall back to CPU up front. `isnet-general-use` and `ben2-base` run on any provider. |
| `tinify` | `{ token }` or `null` — when set, enables PNG compression + WebP output in `generate_image` |
| `logging` | `policy` (`none`/`today`/`persistent-daily`), `dir` |
| `output` | `dir`, `inlinePreview`, `previewMaxBytes` |
| `http` | `enabled`, `host`, `port`, `authToken` (`{ type, value }` or `null` = no auth; default file `mcp http token.txt`). When set, every HTTP request needs `Authorization: Bearer <token>` or `X-API-Key: <token>`. A token that resolves **empty** (blank inline value or env var, empty file) is a configuration error — the server refuses to start rather than run without auth. `allowedHosts` (default `[]`): extra hostnames accepted in `Host`/`Origin` while no token is set (loopback names and IP literals always are — the DNS-rebinding guard). `sessionIdleMinutes` (default `30`): an HTTP session with no request for this long is closed. |
| `diagnostics` | wizard timestamp + recorded issues/sources (read-only telemetry) |

Set `AIR_MCP_CONFIG=/path/to/config.json` to use a config file outside the project root.

## Development

```bash
npm run dev            # run the server from source via tsx
npm run typecheck      # tsc --noEmit
npm test               # unit + integration:nonpayment (no network, no cost)
npm run unit           # pure unit tests only
npm run integration:nonpayment   # real subsystems, no paid API
npm run integration:paid         # LIVE billed API tests (tests/paid/**) — needs tokens/cost, run explicitly
npx tsx scripts/smoke.ts list openrouter            # list a gateway's image models
npx tsx scripts/smoke.ts genimg openrouter "<prompt>" <model>   # one-off generation
npx tsx scripts/mcp-test.ts                         # spawn the server and exercise it as a client
```

**Working on the code?** Start with [CLAUDE.md](CLAUDE.md) — architecture, conventions, the
documentation map, and the hard-won gotchas. [docs/API-NOTES.md](docs/API-NOTES.md) holds the exact
gateway/endpoint contracts the clients are built against, and
[docs/UPDATING-LEADERBOARDS.md](docs/UPDATING-LEADERBOARDS.md) covers refreshing the wizard's
leaderboard highlights.

## License

MIT — see [LICENSE](LICENSE).
