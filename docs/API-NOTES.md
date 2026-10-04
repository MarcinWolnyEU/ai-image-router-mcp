# Gateway & dependency API notes

Authoritative implementation notes captured 2026-06-05 from live APIs + official docs.
These are the contracts the gateway clients in `src/gateways/` are built against. Update
this file when a gateway changes its API.

> Design rule: **direct REST only — no vendor SDKs.** All auth is `Authorization: Bearer <token>`.

> **Retry rule (`src/util/http.ts`, all gateways):** a **POST is never re-sent after an ambiguous failure** —
> timeout, connection reset, `5xx`, or a `200` whose body won't parse — because the provider may already be
> running (and billing) it. A POST is retried only when the failure proves it was not processed: **`429`**, or
> a connection that never opened (`ECONNREFUSED`/`ENOTFOUND`/`EAI_AGAIN`/connect timeout). GET/HEAD/PUT/DELETE
> keep full retries (`408`/`429`/`5xx`/network/truncated JSON). A POST that is harmless to repeat opts back in with
> `idempotent: true` (only Mistral agent creation does). Gateway-level fallbacks (OpenRouter `/videos` core-only,
> fal core-only — on a submit `422` only, never a submit `5xx` — and the OpenRouter image single 5xx retry) are explicit and documented per gateway below.

---

## OpenRouter — `https://openrouter.ai/api/v1`

### Image generation (synchronous, dedicated router)
- `POST /api/v1/images` with body (the dedicated Image API, NOT `/chat/completions`):
  ```json
  {
    "model": "google/gemini-2.5-flash-image",
    "prompt": "<prompt>",
    "aspect_ratio": "16:9",
    "resolution": "2K",
    "input_references": [{ "type": "image_url", "image_url": { "url": "<data: or http url>" } }]
  }
  ```
- Optional headers: `HTTP-Referer`, `X-Title` (attribution).
- `aspect_ratio`: `1:1`(def),`2:3`,`3:2`,`3:4`,`4:3`,`4:5`,`5:4`,`9:16`,`16:9`,`21:9` (+extended `1:4`,`4:1`,`1:8`,`8:1`,`1:2`,`2:1`,`9:21`,`21:9`,`auto`). Providers clamp to their subset.
- `resolution`: `512`(def),`1K`,`2K`,`4K`. `size` is a convenience shorthand (`"2K"` or `"2048x2048"`).
- `output_format`: `png`(def),`jpeg`,`webp`,`svg`; `quality`: `auto`,`low`,`medium`,`high`; `background`: `auto`,`transparent`,`opaque`; `seed`; `n` (1–10).
- `input_references`: reference images for image-to-image generation — array of `{ type:"image_url", image_url:{ url } }`, HTTP(S)/data URLs, max 16.
- **Output:** `{ created, data:[{ b64_json, media_type }], usage:{ cost } }`. `b64_json` is base64; `media_type` reflects the real format (`image/svg+xml` for vector models). Synchronous (or SSE via `stream:true`); **no native async job** and **no streaming in this MCP server**.
- **Errors:** failed/safety-blocked generations return a **502** (never a partial result; not billed). OpenRouter can also relay an upstream failure as HTTP 200 with an `error` body — `apiErrorMessage()` surfaces it. Every failure is run through `explainOpenRouterError()` (`src/gateways/openrouterImages.ts`) — see **Error codes** below.
- `generate_image`'s `reference_images` → `input_references` (gated on the `imageReferenceImages` capability); references are resolved to bytes & validated as images **before** the call (remote URLs downloaded), so generation never runs with a missing/unreadable reference.
- **Structured constraints → this endpoint**: `generate_image`'s `background` maps to the `background` field, whose enum is only `auto|transparent|opaque` — so `transparent` maps through and ANY specific colour maps to `opaque` (never a hex, which would 400); the exact colour rides along in the compiled prompt constraint. There is **no `negative_prompt`** on `/images`, so `exclude` is prompt-only here. `palette` has no native field either (prompt-only).
- **Reference semantics**: `input_references` is generic image-to-image conditioning — it constrains the **subject/geometry**. There is no style-only field, so `reference_mode:"style"` is honoured by steering the prompt (`Gateway.referenceSemantics()` reports `native:'subject'`, `steered:['style']`).

### Per-model capabilities (the request is built from THIS — `src/gateways/openrouterImages.ts`)
- `GET /api/v1/images/models` → `{ data:[{ id, name, architecture, supported_parameters, supports_streaming, endpoints }] }` — every image model with the **union** of its endpoints' parameters.
- `GET /api/v1/images/models/{author}/{slug}/endpoints` → `{ id, endpoints:[{ provider_name, provider_slug, provider_tag, supported_parameters, allowed_passthrough_parameters, supports_streaming, pricing[] }] }` — the definitive per-endpoint record. **Bearer auth works; no cost.**
- `supported_parameters` values are typed descriptors: `{type:"enum", values:[…]}` | `{type:"range", min, max}` | `{type:"boolean"}`. **An absent key = the parameter is unsupported by that endpoint.** Keys seen: `aspect_ratio`, `resolution`, `quality`, `background`, `n`, `input_references`, `output_compression`, `seed`.
- The gateway fetches + caches this per model (`OpenRouterGateway.fetchImageCapabilities`, warmed by `prepare()` from `runtime.applyConfig` and the wizard; 10 s timeout, best-effort → static fallback lists). The answer is also **persisted** in `.cache/capabilities.json` (`FileCapabilityCache`, key `openrouter:image-caps:<model>`): a stored record ≤ 7 days old is used with no network call and refreshed in the background once older than 1 h — so only a cold start waits on this endpoint (stdio clients spawn a server per session, Vibe CLI per tool call) and `buildOpenRouterImageBody()` uses it to: send `resolution` only when the model lists it (else drop it + note), validate `aspect_ratio`/`quality`/`background`/`n`/reference count against the descriptors **before** the request (an off-enum value throws — nothing billed), and map explicit `width`×`height` to `size`.
- **Live facts — `openai/gpt-image-2.5-sunburst` (and `-flare`), captured 2026-09-09** (`npx tsx scripts/or-image-caps.ts <model>`):
  - `aspect_ratio`: `1:1, 3:2, 2:3, 4:3, 3:4, 16:9, 9:16, 21:9, auto` · `quality`: `auto, low, medium, high, xhigh, max` (gpt-image-2 / -1 stop at `high`) · `background`: **`auto, opaque` only — NO `transparent`** (gpt-image-1 / 1-mini do have it) · `n`: 1–10 · `input_references`: 0–16 · `output_compression`: 0–100 · passthrough: `moderation` · streaming: yes. **No `resolution`, no `size`, no `seed`, no `output_format` advertised.**
  - `resolution:"512"` / `"2K"` → **200, silently ignored** (output 1536×1024 / 1448×1086 — the model picks its own size, not a downscale). So the tier is now not sent, and the native full-size output is stored as-is.
  - No `aspect_ratio` → the model chooses (1536×1024). `16:9` → 1536×1024. `1:1` → 1024×1024.
  - `size:"1024x1024"` / `"2048x2048"` → **honoured exactly** despite not being advertised (`size` is normalised by OpenRouter per provider). `size:"256x256"` → **400** `Invalid size '256x256'. Requested resolution is below the current minimum pixel budget.` (`metadata.provider_name:"OpenAI"`) → the gateway retries once without `size` (`isSizeRejection`).
  - `output_format:"webp"` → honoured (`media_type:"image/webp"`) although not advertised — forwarded to the provider. Not used by us (we convert locally/Tinify).
  - `background:"transparent"` → **400** `No provider for openai/gpt-image-2.5-sunburst supports the requested parameter(s): quality "low", background "transparent". Provider rejections: OpenAI: background: not supported. Accepted: auto, opaque` (`metadata.failed_routing_step:"Filter by Image Capabilities"`). ⚠️ the "requested parameter(s)" list echoes EVERY capability-checked field (quality was fine) — only the "Provider rejections" clause names the offender.
  - Invalid enum value (`quality:"banana"`) → **400** with a raw **Zod** body: `{ "error": { "name":"ZodError", "message":"[ {code, values, path:[\"quality\"], message} ]" } }` — `explainOpenRouterError` parses it into `quality: Invalid option: expected one of …`.
  - Cost at `quality:"low"` ≈ $0.005/image (158–215 image tokens × $30/M); `2048x2048` low ≈ $0.012. `usage` carries `completion_tokens_details.image_tokens`, `cost_details.upstream_inference_*`, `is_byok`. Response headers: `x-generation-id: gen-img-…`, `x-provider-name`.

### Error codes (https://openrouter.ai/docs/api-reference/errors — shared by the Image API)
- Body shape `{ error: { code, message, metadata? } }`; the HTTP status equals `error.code` for request errors, while an error **during** generation may come back as **200** with the same `error` body (or an SSE `error` event when streaming).
- `400` bad request / content policy · `401` invalid key · `402` insufficient credits · `403` forbidden (permission, guardrail, moderation flag — `metadata.reasons[]`, `flagged_input`, `provider_name`, `model_slug`) · `404` unknown model / no endpoint for your data policy · `408` timeout · `413` payload too large · `422` unprocessable · `429` rate limited · `500` internal (upstream message **masked**; `error_type:"server"`) · `502` model down / invalid response / failed generation (not billed) · `503` no provider meets routing requirements · `504` provider timeout.
- `429`/`503` may carry **`Retry-After`** (seconds) — `util/http.ts` honours it (capped 30 s) before retrying. Per the retry rule above, the image POST is HTTP-retried only on `429`; a `5xx` gets **one** gateway-level retry (failed generations are not billed) **unless the body is deterministic** (`isDeterministicFailure`: moderation `metadata.reasons[]`, or `error_type` such as `content_policy_violation`/`refusal`/`invalid_prompt`/`payment_required`) — a 502 safety block is sent exactly once.
- `metadata.error_type` is the stable canonical code (`payment_required`, `rate_limit_exceeded`, `provider_unavailable`, `content_policy_violation`, `refusal`, `invalid_image`, `image_too_large`, `image_download_failed`, …); `metadata.provider_code` = the upstream's own code (omitted on 500s). Mapped to labels in `ERROR_TYPE_LABEL`.
- Our surface: `OpenRouterApiError` (a `GatewayHttpError` whose `providerMessage` is the explanation) → `describeError()` prints `Request failed (HTTP 402): HTTP 402 — Insufficient credits — payment_required: … [model: …]`; `diagnoseFailure()` adds the status/moderation hints as `possibleCause` blocks (plus the existing Ignored-Providers / BYOK probes).
- **402 — OpenRouter's own credit check vs an upstream quota (live 2026-10-04).** OpenRouter's native 402 body is `{"error":{"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits","code":402,"metadata":{"limit_source":"openrouter_credits","remedy_hint":"…"}}}` — it came back with **$0.68 still showing** on `/credits` while background video jobs were running (credit held by in-flight generations / the request's worst-case cost counts against the balance). `metadata.limit_source:"openrouter_credits"` (or that message) means **the account's credit check — never BYOK**; `isOpenRouterCreditLimit()` detects it and the hint says so. The **"Include BYOK"** hint is only for an UPSTREAM quota body (e.g. OpenAI's "You exceeded your current quota", relayed as a 200-with-`error`) while OpenRouter credit remains, and is suppressed when `GET /key` shows `include_byok_in_limit:false` and `byok_usage:0` (BYOK unused). The old "any billing error + balance > $0.10 ⇒ Include BYOK" rule contradicted the top-up hint on every native 402.
- **Exact `size` rejected → keep the shape:** the retry without `size` uses the supported `aspect_ratio` NEAREST to the requested width/height (`nearestAspectRatio`, log scale), not the configured default — a rejected `640x384` used to render as a 1:1 square.

### Image model listing
- `GET /models?output_modalities=image` → `{ data: [...] }`. Image-capable iff `architecture.output_modalities` includes `"image"`.
- Per-param truth is per-endpoint: `GET /models/{author}/{slug}/endpoints` → `data.endpoints[].supported_parameters`.
- `created` (unix secs) → sort latest-first.
- NOTE: `output_modalities` enum is `text,image,audio,embeddings,all` — **no `video`**. Video models are NOT listed here.

### Video generation (asynchronous) — text-to-video AND image-to-video
- Launch: `POST /videos` body: `model` (e.g. `google/veo-3.1`), `prompt` (req), optional `duration`, `resolution` (`720p|1080p|1K|2K|4K`), `aspect_ratio`, `size` (`1280x720`), `frame_images[]` (each `{ frame_type: first_frame|last_frame, ... }` for i2v), `input_references[]` (reference imgs, grok up to 7), `generate_audio` (bool), `seed`, `callback_url`, `provider`.
- Returns `202`: `{ id, polling_url, status: "pending" }`.
- Poll: `GET /videos/{id}` → `status ∈ pending|in_progress|completed|failed`; on completed → `unsigned_urls[]`, `usage.cost`.
- Download: `GET /videos/{id}/content?index=0` → raw MP4 bytes.
- Models: Veo 3.1, Sora 2 / 2 Pro, Seedance 1.5/2.0, Wan 2.6/2.7, Kling Video O1, `x-ai/grok-imagine-video`. No documented programmatic video-model list endpoint → use a curated fallback list + allow manual id entry.
- CONFIDENCE: Medium on exact `frame_images`/`input_references` sub-field names (docs, not live-tested). Verify on first real call.

---

## Mistral — `https://api.mistral.ai`  (image only; NO video)

Image generation is **Agents-API only** (no `/v1/images/generations`). Backed by Black Forest Labs **FLUX1.1 [pro] Ultra**.

1. **Create agent** (once; reuse id): `POST /v1/agents`
   ```json
   { "model": "mistral-medium-latest", "name": "air-mcp image agent",
     "instructions": "Use the image generation tool to create images.",
     "tools": [{ "type": "image_generation" }] }
   ```
   → response `.id` = agent id.
2. **Run**: `POST /v1/conversations` `{ "inputs": "<prompt>", "agent_id": "<id>", "stream": false }`
   → `outputs[]`; find the `message.output` entry; in its `content[]` find `{ type: "tool_file", file_id, file_name, file_type }`.
   - (Alternative: pass `tools:[{type:"image_generation"}]` inline here without a pre-made agent — documented but less-trodden.)
3. **Download bytes**: `GET /v1/files/{file_id}/content` (Accept: application/octet-stream) → raw PNG.
   - Or signed URL: `GET /v1/files/{file_id}/url?expiry=24` → `{ url }`.

- **No structured size/aspect/count params** — steer via the prompt text only.
- **Sampling args (`temperature`/`top_p`) belong on the AGENT** (`completion_args` in the `POST /v1/agents` body), NOT on `POST /v1/conversations` — passing `completion_args` alongside `agent_id` returns **HTTP 422** ("Conversation with an 'agent' can't contain completion_args"). Cache one agent per `(orchestrator + completion_args)` combo.
- Models: `GET /v1/models` → `data[].capabilities {completion_chat, function_calling, vision, ...}`. No image-gen flag; pick an orchestrator with `completion_chat && function_calling`. `aliases[]` hold `*-latest`. `created` (unix) → sort.

---

## Eden AI — `https://api.edenai.run` (EU: `https://api.eu.edenai.run`)

### Image generation (SYNCHRONOUS) — `/v3/universal-ai`
- **`image/generation` is a sync-only universal-ai feature.** `POST /v3/universal-ai/async` answers `400 {"detail":{"error":"Not an async feature","message":"image/generation does not support async execution. Use POST /v3/universal-ai for sync execution."}}` (verified 2026-10-04 for `pruna/p-image`, `openai/gpt-image-1-mini`, `google/gemini-2.5-flash-image`; the gateway used the async endpoint for a while and EVERY Eden image call failed). The tool's own job store (`wait:false` + `job_id`) still gives callers the async/poll UX.
- Request: `POST /v3/universal-ai` body: `{ model:"image/generation/<provider>[/<model>]", input:{text,resolution,num_images}, provider_params:{...} }`. Also accepts `fallbacks`, `show_original_response`.
  - `input.resolution`: `256x256|512x512|1024x1024` (provider-dependent extras); `input.num_images` for multi (1–10).
  - `provider_params`: provider-specific knobs (aspect_ratio, width/height, quality, style, …) — e.g. `{aspect_ratio:"16:9"}` on pruna/p-image → 1344×768 (live). **No generic reference-image field** — `imageReferenceImages` stays `false`.
- Response: `{ status:"success"|"fail", cost:"0.005000000", provider, feature, subfeature, output:{ items:[{ image:"<base64>", image_resource_url:"<url>" }] }, error }`. `cost` is a numeric string; pruna/p-image returns **JPEG** bytes (`/9j/…`). `status:"fail"` (or `error` with no `output`) → surface `error.message`.
- Providers (text-to-image): openai, stabilityai, replicate, amazon, deepai, leonardo, bytedance, google, pruna, ….
- Live-validated after the fix (2026-10-04, pruna/p-image @256): bare, `image_size` 512, `width/height`, `n:2`, webp, ico, palette, exclude, background, `provider_options`, `wait:true` — 13/13, $0.065.

### Video generation (asynchronous) — V2 (text-to-video AND image-to-video, same endpoint)
- Launch: `POST /v2/video/generation_async/` body: `providers`, `text`, `duration` (s), `resolution` (`720p`/`1080P`/`768P`...), `dimension` (`1280x720`), `fps`, `seed`. → `{ public_id }`.
- **Model selection = `providers:"<provider>/<model>"`** (probed 2026-10-04 with `duration:3`, which MiniMax rejects before generating, at cost 0: `providers:"minimax/MiniMax-Hailuo-02"` ran Hailuo-02 instead of the default 2.3; `settings:{minimax:"MiniMax-Hailuo-02"}` also works). A **top-level `model` field is silently IGNORED** — the provider default ran and was billed ($0.56) while the reply claimed the override. `resolution:"bogus"` is also accepted and billed (not validated).
- **Eden does NOT validate the model**: `providers:"minimax/definitely-not-a-model"` is forwarded, MiniMax answers "Invalid model … Available models are: …", and the failed job is still reported with **`cost: 0.56`**. So `EdenAiGateway.checkVideoRequest` validates provider + model against the catalog (below) BEFORE submitting.
- **Catalog: `GET /v2/info/provider_subfeatures?feature__name=video&subfeature__name=generation_async` — public, NO auth** (sending the v3 API key → `401 "Token has no 'exp' claim"`). An array of `{ provider:{name}, models:{models[],default_model}, constraints:{models[],default_model}, pricings[], is_working }`. Live 2026-10-04: minimax `T2V/I2V-01-Director, S2V-01, MiniMax-Hailuo-02, MiniMax-Hailuo-2.3` (default 2.3); google veo-3.x; openai sora-2/2-pro; amazon nova-reel v1:0/v1:1; bytedance seedance/dreamina; pruna p-video*; pixverse; xai grok-imagine-video-1.5. Also the wizard's video model list (cached 1 h in memory).
- i2v: same endpoint + image. Eden field `file` (multipart) or `file_url`; for multi/first+last/subject use **provider-native passthrough** fields (MiniMax: `first_frame_image`, `last_frame_image`, `subject_reference:[{type:"character",image:["<url>"]}]`).
- Poll: `GET /v2/video/generation_async/{public_id}/?response_as_dict=true&show_base_64=false` → `{ status, results:{ "<provider>/<model>": { final_status, cost, video_resource_url, error } } }`. Treat `processing|pending` as keep-polling; `finished|success|succeeded` + a video URL as done. **The result key names the model that actually RAN** — the reply reports it (and notes when it differs from the requested one).
- Providers (wired): `amazon` (Nova Reel, 1280x720@24, dur forced 6), `minimax` (Hailuo-02; dur {6,10}@768P/{6}@1080P; `prompt_optimizer`; camera cmds in prompt `[Push in]` etc.), `bytedance` (Seedance pro/lite), `google` (Veo3 = audio; dur {4,6,8} as `durationSeconds`), `openai` (Sora 2; dur {4,8,12,16,20}), `microsoft` (Azure Sora; dur {4,8,12}).

### Listing
- Image providers/models: `GET /v3/info/image/generation` (v3 info). LLM/Gemini path models: `GET /v3/models`.
- Video models: the public v2 catalog above (curated provider list only as a fallback when it can't be reached).

---

## fal.ai — `https://queue.fal.run` (async queue, one per model endpoint)

**Auth is the exception to the Bearer rule: `Authorization: Key <key_id>:<key_secret>`** (the whole `id:secret` string is the token file's contents; do NOT split it). There's also a synchronous `https://fal.run/{model}` endpoint, but we use the queue uniformly for image AND video (it survives cold starts/load and shares one code path). Captured 2026-06-21 from live API + fal docs; Krea 2 image-gen validated end-to-end.

### Queue flow (every model)
- **Submit:** `POST https://queue.fal.run/{model-id}` with the model's input JSON (e.g. `{ "prompt": "..." }`). Returns `{ request_id, status_url, response_url, cancel_url, queue_position }`.
- **Poll:** `GET {status_url}` → `{ status }` ∈ `IN_QUEUE | IN_PROGRESS | COMPLETED`. On `COMPLETED` an `error`/`error_type` may be present (failure).
- **Result:** `GET {response_url}` → the model output JSON.
- **USE the returned `status_url`/`response_url` verbatim — do NOT reconstruct them.** Models with sub-paths (`krea/v2/large/text-to-image`) have an app base (`krea/v2`) ≠ the submit path; fal's URLs already encode the right app + request id.
- **Cancel: `PUT {cancel_url}`** → `202 {"status":"CANCELLATION_REQUESTED"}`, or `400 {"status":"ALREADY_COMPLETED"}`. Used when a job is still running at our deadline (image 5 min; **10 min with reference images** — Krea `image_style_references` jobs sat `IN_PROGRESS` for 5+ min, 3/3, `inference_time` 196 s and counting; video 20 min): the gateway cancels it so it is not billed after we report failure, and the error says whether the cancel was accepted (`FalTimeoutError`, naming the `request_id`). `ALREADY_COMPLETED` → the finished (paid) result is fetched instead of failing.
- **Unknown model id** → `404 {"detail":"Application \"<last path segment>\" not found"}` on the submit (nothing queued, free). The error is annotated with the full id that was asked for (`definitely-not/a-model`), since fal's text names only the last segment.
- Output media are **hosted URLs** (`...url`), not base64 (unless the model's `sync_mode:true` is set) → download bytes with the `Key` header.

### Image generation — model ids & schemas differ per family (mapped in `src/gateways/fal.ts`)
- **Krea 2** (`krea/v2/large/text-to-image`, `krea/v2/medium/text-to-image`): input `prompt` (req), `aspect_ratio` (`1:1`(def)`,4:3,3:2,16:9,2.35:1,4:5,2:3,9:16`), `creativity` (`raw|low|medium|high`), `seed`, `image_style_references[]`, `styles[]`, `moodboards[]`. **No `image_size`, `num_images`, or `negative_prompt`.** Output `{ images:[{url,content_type,width,height}], seed }`. **Reference images**: map `generate_image`'s `reference_images` → `image_style_references[]` with item shape **`{ image_url, strength? }`** (NOT `{ url }` — a fixed bug; `image_url` is required and must be publicly accessible, `strength` −2…2 default 1); a non-Krea fal image model has no reference field, so the gateway raises a clear error before submitting (no credits). Live-validated on `krea/v2/medium` + `krea/v2/large` with a data-URL reference.
- **Cosmos 3 Super t2i** (`nvidia/cosmos-3-super/text-to-image`): `prompt`, `negative_prompt`, `image_size` (enum `square_hd`(def)`/square/portrait_4_3/portrait_16_9/landscape_4_3/landscape_16_9` or `{width,height}`), `num_images`, `num_inference_steps` (28), `guidance_scale` (4), `seed`, `enable_safety_checker`, `output_format` (`jpeg`|`png`), `enable_prompt_expansion`, agentic_* knobs. Output `{ images:[...], seed, has_nsfw_concepts[] }`.
- **Recraft V3** (`fal-ai/recraft/v3/text-to-image`): the only fal image model with a **structured palette input** — `colors: RGBColor[]` and `background_color: RGBColor`, where `RGBColor` is `{r,g,b}` 0–255. `generate_image`'s `palette` maps to `colors[]` and a hex `background` to `background_color` (`buildFalImageInput`, gated on the spec's `colorFields`); every other model gets the same constraint as the compiled prompt block only.
- **FLUX 2 Pro Edit** (`fal-ai/flux-2-pro/edit`): the one fal endpoint with **subject** conditioning — references map to a flat `image_urls[]` (not Krea's `{image_url}` objects). Its spec entry must precede the generic FLUX entry in `falModels.ts` (the generic regex also matches the edit id).
- **Reference semantics are per-model, and not interchangeable**: Krea's `image_style_references` transfers the reference's **style/medium** (a photo reference makes a photographic result — this is what made "match the reference's design but render a clean 3D icon" impossible), while `image_urls` on the Edit endpoint conditions on the **subject/geometry**. `FalGateway.referenceSemantics(model)` reports which; the tool layer refuses an unsupported `reference_mode` before submitting (no credits).
- **Generic fal image models** (FLUX etc.): generic `image_size`/`num_images`/`seed` path.
- Mapping: the gateway sends `aspect_ratio` for Krea, else maps the ratio onto an `image_size` enum (`1:1→square_hd, 4:3→landscape_4_3, 3:4→portrait_4_3, 16:9→landscape_16_9, 9:16→portrait_16_9`). Everything unsurfaced (creativity, styles, moodboards, explicit image_size, num_images, negative_prompt) goes via `provider_options`.
- **Seeded request defaults (`buildFalImageInput`)**: every image request carries `output_format:"png"`, `safety_tolerance:"5"` (1=strict…5=most permissive), `enable_safety_checker:false`. fal **ignores unknown fields** — it only 422s on an *invalid enum value*, and these are valid — so they're safe across Krea/Cosmos/FLUX (models that lack a field simply ignore it). A caller's `provider_options` merge last, so an explicit value wins. ⚠️ Live probe: flux-pro returned `content_type:image/jpeg` & 2752×1536 even with `image_size:square_hd` + `output_format:png` — fal models frequently ignore/override size & format hints; never trust the request to control them, re-encode via sharp (the ico path does).
- **fals image size field is `image_size` = object `{width,height}` OR an enum tier** — doc'd: *"For custom image sizes, you can pass the width and height as an object: `{"width":1280,"height":720}`"*; `ImageSize` = `{width:integer>0, height:integer>0}` (max 14142). Used by FLUX-family (Flux 2 Pro, Flux Pro, Flux LoRA, Flux/Krea, Flux/dev, Flux/schnell), Recraft V3, and Cosmos 3 Super. **Krea 2 and Ideogram instead take `aspect_ratio`** (a ratio enum — `1:1`/`4:3`/`16:9`/… for Krea; `1:1`/`16:9`/`10:16`/… for Ideogram) with **no** exact-pixel input. So the gateway uses `image_size: {width,height}` where `width`/`height` are requested and the model accepts it, else an enum tier from the ratio, else `aspect_ratio` for Krea/Ideogram.
- **Safety/output knobs are per-model**: `output_format` (`jpeg|png`) + `enable_safety_checker` + `safety_tolerance` (`1`…`5`) exist on FLUX; Cosmos has `output_format`+`enable_safety_checker`; Recraft has `enable_safety_checker` only; Krea/Ideogram have none (Krea adds `styles`/`moodboards`/`creativity`/`image_style_references`; Ideogram adds `style`/`expand_prompt`/`negative_prompt`). **`output_format` is `"png"`, not `"image/png"`** (enum values only; `"image/png"` would 422). The seeded defaults are sent only to models that carry them — see `src/gateways/falModels.ts`.
- **No fal text-to-image model is image-conditioned** except Krea 2's style-only `image_style_references[]` and FLUX 2 Pro's separate Edit endpoint (`image_urls[]`). Passing `reference_images` to a model with no conditioning input throws **before** the queue submit, so no credits are spent.
- **Schema discovery**: no public `/models/{id}/schema` endpoint (404s; `api.fal.ai/...` 404s). But each model's page embeds the OpenAPI spec: fetch `https://fal.ai/models/<id>/api` and the `components.schemas.*Input` object (with `$ref`/`anyOf` following) is the authoritative field list. Submitting an invalid enum value is the live alternative — fal queues it, then returns the accepted literals in the result `detail` array (no image generated, no bill).

### Video generation — Cosmos 3 Super (image-to-video) + any fal video model
- **Cosmos 3 Super i2v** (`nvidia/cosmos-3-super/image-to-video`): `prompt` (req), `image_url` (req — public URL **or data URI**), `negative_prompt`, `image_size`, `num_frames` (189), `frames_per_second` (24), `num_inference_steps` (28), `guidance_scale` (6), `seed`, `enable_safety_checker`, agentic_* knobs. Output `{ video:{url,content_type,fps,duration,num_frames,...}, seed }`. **No text-to-video Cosmos endpoint on fal** (t2i + i2v only).
- Field-name mapping is per-family: Cosmos uses `frames_per_second` + `num_frames` (gateway computes `num_frames = round(duration*fps)`) + `image_size`; other fal models use `fps`/`duration`/`resolution`/`aspect_ratio`. Tuning params are sent separately from the core (`prompt`/`image_url`/`seed`) so a rejection triggers a retry with the **core-only** body (mirrors the OpenRouter `/videos` fallback) — but ONLY when no job is left running: the **submit** was refused with a **`422`** (validation — provably nothing queued, `submitQueue`), or the accepted job **finished as a `422`** on its `response_url`. A **`5xx` on the submit is ambiguous** — fal's edge can fail after the job was enqueued — so it is NOT resubmitted (the error says "not re-sent; check your fal dashboard"). A failure while **polling** an accepted job (status `5xx`, network, deadline) is never resubmitted either (that would bill twice); the error names the accepted `request_id` instead. Both notes ride on `GatewayHttpError.note`, which the user-facing `describeError` appends.
- A core-only resubmit is **never silent**: the reply carries `Note: <model> rejected the tuning parameters (HTTP 422: …); the video was generated WITHOUT: resolution, fps, duration` (live trigger: Cosmos' `duration:2` sent to Hailuo-02 → `Input should be '6' or '10'`). The configured default resolution/fps/duration are no longer applied to a `model` override at all (they were chosen for the configured model).
- **i2v sends ONE image** (`image_url`) for every fal model. `image_last` / `reference_images` are refused before submitting (`checkVideoRequest`) — they used to be dropped while the clip was billed; a model-native end-frame field goes via `provider_options`.
- Output URL is under `video.url` (some models: `videos[].url`).

### Listing
- **No public programmatic model-list API.** Curated fallback lists (Krea 2 L/M + Cosmos 3 t2i for image; Cosmos 3 i2v + Kling/Veo for video) + manual id entry. `listsImageModels`/`listsVideoModels` are `false`.

---

## Capability matrix (what each gateway can do)

| Tool                | OpenRouter | Mistral | Eden AI | fal.ai |
|---------------------|:----------:|:-------:|:-------:|:------:|
| Image generation    | ✅ sync (`/images`) | ✅ agent | ✅ sync (`/v3/universal-ai`) | ✅ queue (Krea 2, Cosmos 3, FLUX) |
| Text-to-video       | ✅ async    | ❌      | ✅ async (v2) | ✅ queue (Veo/Kling/… — not Cosmos) |
| Image-to-video      | ✅ async (frame_images) | ❌ | ✅ async (file/passthrough) | ✅ queue (Cosmos 3, single image_url) |
| Reference images (img gen) | ✅ `input_references` | ❌ | ❌ | ✅ Krea 2 `image_style_references` (only Krea) |
| Reference semantics | subject (`input_references`; style steered by prompt) | — | — | style (Krea `image_style_references`) / subject (`flux-2-pro/edit` `image_urls`) |
| Native constraint fields | `background` (auto/transparent/opaque) | none | none | Recraft `colors[]`+`background_color`; `negative_prompt` (Cosmos/FLUX/Ideogram) |
| Multi reference img (i2v) | ✅ input_references (grok ≤7) | ❌ | ✅ MiniMax subject_reference / first+last | ❌ (single image_url) |
| Async image jobs    | ✅ background task (no native) | ✅ background task | ✅ background task (sync endpoint) | ✅ native `request_id` |
| Provider-specific knobs | passthrough (quality/background/seed/n) | none (prompt only — `provider_options` are ignored, and the reply says so) | image: v3 `provider_params`; video: model via `providers:"p/m"`, extra fields merged | provider_options → merged into fal input |

> **Async generation jobs (`wait:false` + `job_id`) for image, image-to-video, text-to-video:**
> the server runs the (blocking) generation as a detached background job and returns a
> `job_id` immediately, so a slow provider never holds an MCP call open past a client
> timeout. Re-invoking the same tool with `job_id` polls it. For gateways with a native
> async job (fal `request_id`) the id is surfaced on the job; OpenRouter/Mistral/Eden have
> no native image job (Eden's image feature is sync-only), so the server wraps their
> synchronous/agent call; either way the client polls by the opaque `job_id`. Configured per type via
> `{image,imageToVideo,textToVideo}.async` (default **true**, set by the wizard), and
> overridable per call with `wait:true`/`wait:false`. Jobs are in-memory (lost on restart).
> `image_to_video` `output_format:"gif"` is always synchronous (local assembly).

Background removal is **local** (no gateway) — see below.

---

## Background removal — rembg BiRefNet via onnxruntime-node + sharp (local)

### Models (download on startup if missing) — catalog in `src/bgremoval/models.ts`
| key | asset URL | saved file | checksum |
|-----|-----------|------------|----------|
| `birefnet-general` (default) | `…/v0.0.0/BiRefNet-general-epoch_244.onnx` | `birefnet-general.onnx` | md5 `7a35a0141cbbc80de11d9c9a28f52697` |
| `birefnet-massive` | `…/v0.0.0/BiRefNet-massive-TR_DIS5K_TR_TEs-epoch_420.onnx` | `birefnet-massive.onnx` | md5 `33e726a2136a3d59eb0fdf613e31e3e9` |
| `bria-rmbg` (BRIA RMBG-2.0) | `…/v0.0.0/bria-rmbg-2.0.onnx` | `bria-rmbg-2.0.onnx` | **sha256** `5b486f08200f513f460da46dd701db5fbb47d79b4be4b708a19444bcd4e79958` |
| `isnet-general-use` | `…/v0.0.0/isnet-general-use.onnx` | `isnet-general-use.onnx` | md5 `fc16ebd8b0c10d971d3513d564d01e29` |

BiRefNet/bria are ~930–977 MB fp32; **BRIA RMBG-2.0 is itself BiRefNet-architecture** (so it behaves like BiRefNet). `isnet-general-use` is a lighter **IS-Net** (~170 MB). `BgModelSpec.hash` carries `{algo:'md5'|'sha256', value}` (rembg publishes sha256 for bria). HF fp16 BiRefNet mirrors exist (`onnx-community/BiRefNet-*`, ~490 MB) if smaller is wanted.

### Pre/post-processing (must match rembg exactly — per-model `mean`/`std`/`needsSigmoid` in the catalog)
- Preprocess (all four): `convert RGB → resize to 1024×1024 (Lanczos, NOT aspect-preserving)`. Scale: divide by `max(globalMaxPixel, 1e-6)` (≈/255 for normal images). Per-channel `(x-mean)/std`, then HWC→CHW→NCHW `[1,3,1024,1024]` float32.
  - BiRefNet + **bria**: ImageNet mean `[0.485,0.456,0.406]`, std `[0.229,0.224,0.225]`.
  - **isnet**: mean `[0.5,0.5,0.5]`, std `[1.0,1.0,1.0]`.
- Run: feed `session.inputNames[0]`; read `session.outputNames[0]` → `[1,1,1024,1024]` float32.
- Postprocess: **BiRefNet output is logits → apply `sigmoid` first**; **bria + isnet output a 0..1-ish map → NO sigmoid** (this is the only postprocess difference; `needsSigmoid` flag). Then min-max stretch to [0,1] (guard max==min) → ×255 uint8 grayscale → resize back to original (Lanczos) → use as **alpha** channel of original RGB → PNG (RGBA).
- ONNX node names: read `inputNames[0]`/`outputNames[0]` at runtime, don't hard-code. Spatial dims are static 1024×1024.

### Execution providers (onnxruntime-node 1.26.0) — **most rembg models are CPU-only in practice**
- `InferenceSession.create(path, { executionProviders: [accel, 'cpu'] })`.
- Valid EP strings: `'cpu'`, `'cuda'`, `'dml'`, `'coreml'`, `'webgpu'`.
- **Bundled per platform:** DirectML (`'dml'`) on Windows x64/arm64; CUDA (`'cuda'`) on **Linux x64 only** (CUDA 12.x + cuDNN 9.x); CoreML (`'coreml'`) on macOS. A provider the platform lacks is **not offered by the wizard and replaced by CPU up front** (`providerAvailable` in `plannedProviders`) — `cuda`/`coreml` on Windows used to be "accepted", reported as the active EP by the reply and `health_status`, and silently run on CPU (2026-10-04 review).
- Defaults: win→`dml`, mac→`coreml`, linux-x64→`cuda`, else→`cpu`. Always append `'cpu'` fallback; wrap `create()` in try/catch → retry `['cpu']`; log the active EP. **Note `create()` succeeding does NOT mean the model runs** — these failures happen at `session.run()`, which the create try/catch does not catch.
- **GPU compatibility (empirical: Win 11, RTX 5070 Ti 16 GB, ort-node 1.26):**
  - **BiRefNet (general/massive) + bria-rmbg fail on every GPU provider** regardless of free VRAM — DirectML errors `E_OUTOFMEMORY` on the deformable-conv ASPP / fused nodes (an op bug, *not* real VRAM exhaustion — it fails with 14 GB free); WebGPU errors `Too many storage buffers in shader. Current: 17, Max is 16` at a decoder `Split`. → **CPU only** for these.
  - **`isnet-general-use` runs on all providers.** WebGPU ≈2.5 s, CPU ≈2.7 s, DirectML works but the **first call is ~6 min** (kernel compilation). VRAM ≈1.3 GB.
  - **The WebGPU `Split` limit is the device's `maxStorageBuffersPerShaderStage`** (16 here = Dawn's adapter ceiling; spec floor is 8, Chrome ≥146 is 16) — a *binding-count* limit, NOT VRAM, and NOT an ORT-imposed cap. It's a tracked ORT issue specifically for BiRefNet ([microsoft/onnxruntime#21968](https://github.com/microsoft/onnxruntime/issues/21968)). Can't be raised in onnxruntime-**node**: you can only request up to the adapter max, and the `device` EP option that could carry raised limits is web-only (Node's native EP builds its own Dawn device). ORT batched Concat to dodge this ([#25390](https://github.com/microsoft/onnxruntime/commit/7e59947)) but Split-with-many-outputs is not batched yet.
  - **`forceCpuNodeNames` does NOT rescue BiRefNet on WebGPU** (verified, `scripts/webgpu-forcecpu.ts`): pinning all 50 decoder `Split` nodes to CPU clears the binding-limit errors, but BiRefNet then hits `ID3D12Device::CreateCommittedResource` **out-of-memory** at a `Transpose` — *because the CPU-pinned splits force giant tensors across the CPU↔GPU boundary*. Forcing that node too just relocates the OOM. (`forceCpuNodeNames` native support landed in ORT [#26099](https://github.com/microsoft/onnxruntime/commit/4a6c0e5), Oct 2025; it must be a non-empty `string[]` joined with `\n`, omit the key when empty.)
  - **Graph surgery DOES make the whole BiRefNet family run on WebGPU** (`scripts/cascade-wide-ops.ts`). Rewriting the model so every wide `Concat` (≤1024 inputs) / `Split` (≤32 outputs) becomes a *cascade* of ≤8-wide ops keeps every shader under the 16-binding limit AND keeps everything on-GPU (no CPU↔GPU thrash → no OOM). Verified on all three: **birefnet-massive ~6.8 s, birefnet-general ~8.2 s, bria-rmbg ~7.6 s on WebGPU** (vs ~25 s CPU), each with a correct mask. (Each decomposes to the same 4 Concat + 50 Split.)
  - **Graph surgery does NOT help DirectML.** The cascaded models still fail on DML with `DmlFusedNode... E_OUTOFMEMORY` — DML's blocker is the deformable-conv fused node (a kernel bug), unrelated to the Concat/Split binding count that surgery fixes. GPU acceleration for BiRefNet/bria = **WebGPU + cascaded model only**. The tool uses `onnx-proto` (protobufjs) to decode/edit/re-encode; run with `NODE_OPTIONS=--max-old-space-size=8192` (~1 GB model). The decomposition keeps original output names so consumers are unaffected; split sizes for the new Splits are emitted as int64 raw_data initializers; old Constant size-feeders become unused (ORT prunes them at load).

### RAM/VRAM guard + empirical usage (`BgModelSpec.usage`, `requiredFreeMB`, `scripts/ram-test.ts`)
- Peak host RAM (1024² fp32 forward pass): BiRefNet/bria on **CPU ≈ 7.3 GB**, ≈25 s; isnet on CPU ≈ 1.0 GB, ≈2.7 s. Accelerated providers only load weights into host RAM (≈0.6–1.5 GB).
- `usage[ep] = { runs, ramMB, vramMB?, note? }` is empirical (measure with `scripts/ram-test.ts <model> <ep>`; `RAM_TEST_SAVE=1` to dump the cutout, `nvidia-smi` total-`memory.used` delta captures DirectX VRAM that per-process compute-apps misses). `vramMB` may be `'over-16gb'`.
- `BiRefNetRemover.assertEnoughRam(ep)` (in `init()`, the CPU-fallback branch, and at the top of `removeBackground`) throws a clear "needs ~N GB free, you have Y GB — free RAM / pick a lighter model / restart" error when `os.freemem() < requiredFreeMB` (= `usage[ep].ramMB + 512`). Override with `BG_RAM_CHECK=off` (os.freemem understates reclaimable cache). `health_status` reports free RAM/VRAM + whether the configured model fits.

---

## Tinify (TinyPNG) — `https://api.tinify.com` (optional; PNG compression + WebP)

Direct REST, HTTP Basic auth `Authorization: Basic base64("api:" + KEY)`. Two requests each:
- **Compress (PNG→PNG):** `POST /shrink` with the raw bytes as the body → `201` + `Location: https://api.tinify.com/output/{id}` (and a `Compression-Count` header). Then `GET <Location>` → optimised bytes.
- **Convert (PNG→WebP):** `POST /shrink` → `Location`; then `POST <Location>` with `Content-Type: application/json` body `{"convert":{"type":"image/webp"}}` → converted bytes (`Image-Width`/`Image-Height` headers). `type` also accepts `image/png`, `image/jpeg`, **`image/avif`** (confirmed via live round-trip — returns `ftyp…avif`), an array (smallest wins), or `*/*` (smallest of AVIF/WebP/JPEG/PNG). Input formats Tinify ingests: png/jpeg/webp/avif — convert other rasters (gif/bmp/tiff) to PNG first.
- Errors: `401` invalid key, `429` over monthly quota, `5xx` transient. Body is `{error, message}`.
- In `generate_image`: PNG output keeps `<name>-original.png` + saves compressed `<name>.png`; WebP keeps `<name>.png` + saves `<name>.webp`; on failure we fall back to the uncompressed PNG.

## Media editing — sharp (images) + ffmpeg (video)

- **Images (sharp):** crop = `.extract({left, top, width, height})` (exact region); downsize = `.resize({width?, height?, kernel:'mks2021', withoutEnlargement:true})` (shrink-only, preserves aspect). NOTE: sharp resizing a 1-channel raw buffer returns 3 channels (sRGB) — read alpha/mask with the real channel stride.
- **Videos (ffmpeg on PATH):** crop = `-vf crop=W:H:X:Y`; downsize = `-vf scale='min(iw,W)':'min(ih,H)':force_original_aspect_ratio=decrease:force_divisible_by=2` (or `scale='min(iw,W)':-2` for width-only). Re-encode `libx264 -crf 20 -preset veryfast -pix_fmt yuv420p -c:a copy -movflags +faststart`. If `ffmpeg` is not found on PATH, the tool returns an explanatory error.

## Animated GIF — `gifenc` (mattdesl), local (`src/media/gif.ts`)

Local frame→GIF assembly for `image_to_video` `output_format:"gif"`. No HTTP, no gateway. **`gifenc` (npm `gifenc`, v1.0.3, zero runtime deps)** was chosen over `@skyra/gifenc` by an empirical bake-off (13 real images, 256² 1-frame GIFs, shared SSIM composited over mid-gray) — full data in `output/gifbench/REPORT.md`. Decisive: `@skyra/gifenc.setQuality` is a NeuQuant **subsampling** factor (fidelity/speed) that does **not** move file size (≈4.6% median, non-monotonic, palette pinned ~256), whereas `gifenc.quantize(rgba, maxColors)` is a real palette-size axis — so the quality/size knee only exists with `gifenc`. `gifenc` also wins on deps (skyra needs tslib), is synchronous, and is more SSIM-per-byte on all 13 images (10–90% smaller at matched quality; transparency tied).

API (no type defs shipped — typed locally; **load via `createRequire(import.meta.url)('gifenc')`** because its dual CJS/ESM build has no `exports` map, so static named ESM imports resolve to `undefined`):
- `quantize(rgba: Uint8Array, maxColors, { format, oneBitAlpha, clearAlpha })` → `palette` (`number[][]`, `[r,g,b]` or `[r,g,b,a]`). `format`: `'rgb565'` (opaque) or `'rgba4444'` (alpha-aware). `oneBitAlpha` (number = threshold) forces 1-bit alpha into the palette.
- `applyPalette(rgba, palette, format)` → `Uint8Array` of palette indices.
- `GIFEncoder().writeFrame(index, w, h, { palette?, transparent?, transparentIndex?, delay?, repeat? })` then `.finish()` then `.bytes()` (Uint8Array). **Global color table**: pass `palette` on the **first** frame only; later frames omit it and reuse the global table. `repeat` (= loop) is written on the first frame: `0`=forever, `-1`=once, `>0`=count. `delay` is **ms** (rounded `/10` to GIF centiseconds).
- ⚠️ **Footgun:** `quantize`/`applyPalette` do `new Uint32Array(rgba.buffer)` **ignoring byteOffset** — a sharp pooled raw-buffer *view* corrupts quantization. Pass a fresh exact-length `Uint8Array` (offset 0, byteLength === 4·w·h).
- **Transparency** is 1-bit: binarize source alpha at a threshold (default 128); `transparentIndex` = the palette entry with `a===0`; set `transparent:true`.
- **Palette knee** (`media/gif.ts`): quantize a shared global palette across all frames at each power-of-two size, score with **decode-free SSIM** (`util/ssim.ts`, luma over mid-gray — reconstruct from palette+index since LZW is lossless), dedupe identical encodings, pick the max-gain elbow above the (bytes,SSIM) chord.

## MCP TypeScript SDK (`@modelcontextprotocol/sdk` v1.29.0)

- ESM; imports need `.js`: `@modelcontextprotocol/sdk/server/mcp.js` (`McpServer`), `.../server/stdio.js` (`StdioServerTransport`), `.../server/streamableHttp.js` (`StreamableHTTPServerTransport`), `.../types.js` (`isInitializeRequest`, `McpError`).
- `server.registerTool(name, { title, description, inputSchema, outputSchema?, annotations? }, handler)`.
  - `inputSchema` is a **Zod raw shape** (`{ field: z.string() }`), NOT `z.object(...)`.
  - Handler returns `{ content: [...], isError?, structuredContent? }`. With `outputSchema`, MUST return `structuredContent`.
  - Content items: `{type:'text',text}`, `{type:'image',data:<b64>,mimeType}`, `{type:'resource_link',uri:'file:///abs',name,mimeType,description}`, `{type:'resource',resource:{uri,mimeType,text|blob}}`.
- Errors: return `{ isError:true, content:[{type:'text',text}] }` for model-visible failures; `throw new McpError(code,msg)` for protocol errors.
- **stdio: never write to stdout** except protocol — log to stderr.
- HTTP: stateful pattern keeps a `mcp-session-id → transport` map; `POST/GET/DELETE /mcp` all call `transport.handleRequest(req,res,body?)`; build a fresh `McpServer` per session.
- `registerTool` returns a `RegisteredTool` with `update({ paramsSchema?, description?, enabled?, … })`, `enable()`, `disable()`. Each sends `notifications/tools/list_changed` when connected; a **disabled** tool is hidden from `tools/list` and its calls are rejected. We use this (`tools/reloadable.ts` `refreshOnReload`) to re-derive config-dependent schemas and gated tools after `restart`; the subscription is dropped via `server.server.onclose`.

## MCP clients over HTTP/stdio — Le Chat & Mistral Vibe (verified 2026-10-01)

### Our HTTP auth (`src/util/httpAuth.ts`, checked in `createHttpApp().handle` — `src/http/app.ts`)
- `config.http.authToken` (null = off). A token that is configured but resolves **empty** (blank inline value, whitespace-only env var, empty file) is a config error — startup / `restart` fails rather than running without auth, and `isHttpRequestAuthorized` treats an empty expected secret as fail-closed. When set, **every** `/mcp` request (not just `initialize`) must send `Authorization: Bearer <token>` or `X-API-Key: <token>`; compared constant-time over SHA-256 digests. Failure → plain **`401`** JSON-RPC error, **no `WWW-Authenticate` header** (deliberate — see Le Chat below). Rejections are logged (method/url/remote, never the token).
- `health_status` shows the auth state with the token *source* (`file: <path>` / `env: <name>` / `inline`), never the secret.
- **DNS-rebinding guard while no token is set** (MCP spec: local servers must validate `Origin`): binding to 127.0.0.1 does NOT stop a malicious page whose DNS flips to 127.0.0.1 — but the browser then sends the page's own domain in `Host`/`Origin`. So with auth off, `Host` and any `Origin` must be a loopback name (`localhost`), an IP literal, or listed in `config.http.allowedHosts`; otherwise **`403`** before session routing (the opaque `Origin: null` is refused). With a token set the check is skipped (the token protects; a tunnel's public hostname must reach us).
- Request hygiene: unknown/expired `mcp-session-id` → **`404`** (spec: the client starts a new session); body > 64 MiB → **`413`**; malformed JSON → **`400`** with JSON-RPC `-32700`; sessions with no request for `http.sessionIdleMinutes` (default 30) are closed (an open GET/SSE stream keeps one alive).

### Le Chat (now "Vibe" Work mode) — custom MCP connectors
- Connectors → **+ Add Connector → Custom MCP Connector**: name, URL, description. Auth is auto-detected: none, HTTP Bearer/Basic, API-token via custom header, or OAuth 2.1 + DCR. An OAuth server is recognised by answering **401 + `WWW-Authenticate`**, so ours sends a plain 401 to get the token-entry UI instead.
- Mistral's cloud makes the connection: needs **public HTTPS with a valid TLS cert**; `localhost` cannot work → tunnel, e.g. `cloudflared tunnel --url http://127.0.0.1:8765` (URL + `/mcp`).
- Connector **name must be alphanumeric** — `ai_image_router` kept Auto-detect/Add disabled with no error; `aiimagerouter` worked. Auto-detect against our plain 401 offered **API Token Authentication → `Bearer` + token** (stored as the connector's default connection); the connector page then shows *Valid* + the tool list.
- Tools only (no resources/prompts); per-call approval prompt (Allow once / Always allow for this chat) unless the tool is set to always-allow; adding a connector is an admin action (account owner on Free/Pro).
- Returned file paths are on the **server's** disk: chaining tools by path works (server reads its own disk) but the user can't open them from Le Chat → use `output_mode:"base64"` for media.

### Mistral Vibe CLI
- Config: `~/.vibe/config.toml` (or trusted `./.vibe/config.toml`); `[[mcp_servers]]` fields: `name`, `transport` = `"stdio" | "http" | "streamable-http"`, stdio → `command`/`args`/`env`, http → `url` + `headers`, plus `startup_timeout_sec`, `tool_timeout_sec`. Tools surface as `{name}_{tool}`; `/mcp` lists servers, `/mcp <name>` lists tools. **No OAuth in the CLI** → static `headers = { Authorization = "Bearer …" }`.
- **Harness bug (mistral-vibe 2.25.8, `mistralai_vibe_local_harness/protocol.py` `RustResourceLinkContentBlock.icons: list[...]`)**: the MCP Python SDK dumps an absent `icons` as `null`, so ANY `resource_link` fails validation → tool shows `mcp_invalid_result` "The provided tool call failed" although the server returned success. We always send `icons: []` (`normalizeResultForClients`). Vibe keeps only `text` blocks of a result (`_parse_call_result`), and the stdio transport **spawns a new server process per tool call** (so startup cost is paid per call — keep `BG_NO_PREWARM=1`).
- Programmatic smoke: `vibe -p "…" --auto-approve --output json < /dev/null` (stdin must be closed or it hangs); `VIBE_HOME` isolates config.
- stdio entry for this server: `command="node"`, `args=["V:/MCP/ai-image-router-mcp/dist/index.js"]`, `env={BG_NO_PREWARM="1"}`, generous timeouts (full TOML in README).
