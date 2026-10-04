/**
 * Wizard steps that pick generation models: the image model (+ aspect ratio,
 * resolution, async mode) and the two optional video tools. Each `configure*`
 * returns the finished config fragment, so `wizard.ts` just sequences them.
 */
import { readFileSync } from 'node:fs';
import prompts from 'prompts';
import { ASPECT_RATIOS_PATH, CAPABILITY_CACHE_PATH } from './paths.js';
import { FileCapabilityCache } from '../state/capabilityCache.js';
import { AppConfig, GATEWAY_LABELS, GatewayId } from './schema.js';
import type { Gateway, ListModelsResult, ModelInfo, VideoKind } from '../gateways/types.js';
import {
  Leaderboard,
  LeaderboardKind,
  leaderboardHint,
  loadLeaderboard,
  matchLeaderboard,
} from '../gateways/leaderboards.js';
import { ask, IssueLog, log } from './wizardPrompt.js';

interface AspectRatioDef {
  value: string;
  label: string;
  description: string;
  decimal: number;
}

function loadAspectRatios(): { default: string; ratios: AspectRatioDef[] } {
  const raw = JSON.parse(readFileSync(ASPECT_RATIOS_PATH, 'utf8')) as { default: string; ratios: AspectRatioDef[] };
  return raw;
}

type ModelToolKey = 'image' | 'imageToVideo' | 'textToVideo';

const LEADERBOARD_FOR: Record<ModelToolKey, LeaderboardKind> = {
  image: 'text-to-image',
  imageToVideo: 'image-to-video',
  textToVideo: 'text-to-video',
};

/**
 * Build prompts choices from models, marking leaderboard top-10 hits and
 * floating any ranked model to the top (best rank first) so it's always visible
 * — the gateway returns models newest-first, which otherwise buries them.
 * Non-ranked models keep the gateway's original (date) order beneath.
 */
function modelChoices(models: ModelInfo[], lb: Leaderboard | null): prompts.Choice[] {
  const decorated = models.map((m, order) => {
    const hit = lb ? matchLeaderboard(lb, m.id, m.name) : null;
    const date = m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : '';
    const star = hit ? `⭐ #${hit.rank} ` : '';
    return {
      rank: hit ? hit.rank : null,
      order,
      choice: {
        title: `${star}${m.name ?? m.id}`,
        value: m.id,
        description: [hit ? leaderboardHint(lb!, hit) : '', date ? `released ${date}` : '', m.id]
          .filter(Boolean)
          .join(' · '),
      } satisfies prompts.Choice,
    };
  });
  decorated.sort((a, b) => {
    if (a.rank !== null && b.rank !== null) return a.rank - b.rank; // both ranked → by rank
    if (a.rank !== null) return -1; // ranked before unranked
    if (b.rank !== null) return 1;
    return a.order - b.order; // both unranked → keep gateway (date) order
  });
  return decorated.map((d) => d.choice);
}

/** Free-text model id entry; blank means "skip" (null). */
async function askManualModel(message: string, initial?: string): Promise<ModelInfo | null> {
  const { manual } = await ask<'manual'>({ type: 'text', name: 'manual', message, initial });
  return manual ? { id: manual, name: manual } : null;
}

/** The gateway's model list for a tool, or null when the gateway can't list that kind. */
async function listModelsFor(gw: Gateway, toolKey: ModelToolKey, kind: VideoKind | null): Promise<ListModelsResult | null> {
  if (toolKey === 'image') return await gw.listImageModels();
  if (gw.listVideoModels && kind) return await gw.listVideoModels(kind);
  return null;
}

async function loadLeaderboardOrNull(toolKey: ModelToolKey): Promise<Leaderboard | null> {
  try {
    return await loadLeaderboard(LEADERBOARD_FOR[toolKey]);
  } catch {
    return null;
  }
}

/**
 * Explain any gap in the highlighted ranks: a leaderboard model the gateway
 * doesn't carry can't be made selectable (you can't generate with a model the
 * gateway lacks), so note it rather than leaving the user wondering why, e.g.,
 * "#1" and "#2" are absent.
 */
function noteMissingRanks(gw: Gateway, lb: Leaderboard, models: ModelInfo[]): void {
  const presentRanks = new Set<number>();
  for (const m of models) {
    const hit = matchLeaderboard(lb, m.id, m.name);
    if (hit) presentRanks.add(hit.rank);
  }
  const missing = lb.models.filter((e) => !presentRanks.has(e.rank)).sort((a, b) => a.rank - b.rank);
  if (missing.length === 0) return;
  log(`Note: ${GATEWAY_LABELS[gw.id]} does not offer these leaderboard-ranked models, so they aren't selectable here:`);
  for (const e of missing) log(`  #${e.rank} ${e.name}`);
}

/** The autocomplete pick over a non-empty model list (plus a manual-entry escape hatch). */
async function pickModel(
  models: ModelInfo[],
  lb: Leaderboard | null,
  promptMessage: string,
  initialModel: string | null,
): Promise<ModelInfo | null> {
  const choices = modelChoices(models, lb);
  choices.push({ title: '✏️  Enter a model id manually…', value: '__manual__' });
  // Pre-select the previously-configured model when it's present in the list
  // (autocomplete resolves a string `initial` to the matching choice value);
  // an unknown id resolves to nothing and simply leaves the first choice active.
  const { choice } = await ask<'choice'>({
    type: 'autocomplete',
    name: 'choice',
    message: promptMessage,
    choices,
    limit: 12,
    initial: initialModel ?? undefined,
  });
  if (choice === '__manual__') return askManualModel('Model id:');
  return models.find((m) => m.id === choice) ?? { id: String(choice), name: String(choice) };
}

/** List models for a tool, attaching leaderboard hints; returns the chosen ModelInfo (or null). */
async function chooseModel(
  gw: Gateway,
  issues: IssueLog,
  toolKey: ModelToolKey,
  kind: VideoKind | null,
  promptMessage: string,
  initialModel: string | null,
): Promise<ModelInfo | null> {
  log(`\nFetching ${toolKey} models from ${GATEWAY_LABELS[gw.id]}…`);
  let result: ListModelsResult | null;
  try {
    result = await listModelsFor(gw, toolKey, kind);
  } catch (err) {
    issues.add('error', toolKey, `Could not list ${toolKey} models: ${(err as Error).message}`);
    issues.sources[toolKey] = { listed: false, source: 'manual', count: 0 };
    return askManualModel(`Enter a ${toolKey} model id manually (blank to skip):`, initialModel ?? '');
  }
  if (!result) return null;
  issues.recordSource(toolKey, result);
  if (result.models.length === 0) {
    return askManualModel(`No models listed. Enter a ${toolKey} model id manually (blank to skip):`, initialModel ?? '');
  }

  const lb = await loadLeaderboardOrNull(toolKey);
  if (lb) noteMissingRanks(gw, lb, result.models);
  return pickModel(result.models, lb, promptMessage, initialModel);
}

async function chooseAspectRatio(
  gw: Gateway,
  model: string,
  initialValue: string | null,
): Promise<{ value: string; supported: string[] | null }> {
  const fromApi = gw.imageAspectRatios?.(model) ?? null;
  if (fromApi && fromApi.values.length > 0) {
    const want = initialValue && fromApi.values.includes(initialValue) ? initialValue : '1:1';
    const { value } = await ask<'value'>({
      type: 'select',
      name: 'value',
      message: 'Default aspect ratio:',
      choices: fromApi.values.map((v) => ({ title: v, value: v })),
      initial: Math.max(0, fromApi.values.indexOf(want)),
    });
    return { value, supported: fromApi.values };
  }
  // Fallback curated list with explanations.
  const fallback = loadAspectRatios();
  const wantVal = initialValue && fallback.ratios.some((r) => r.value === initialValue) ? initialValue : fallback.default;
  const initialIdx = Math.max(0, fallback.ratios.findIndex((r) => r.value === wantVal));
  const { value } = await ask<'value'>({
    type: 'select',
    name: 'value',
    message: 'Default aspect ratio (the gateway does not advertise its own — these are general presets):',
    choices: fallback.ratios.map((r) => ({ title: `${r.value} — ${r.label}`, value: r.value, description: r.description })),
    initial: initialIdx,
  });
  return { value, supported: null };
}

type ResolutionChoice = { value: string | null; supported: string[] | null };
type AdvertisedResolutions = { values: string[]; source: string } | null;

/** The API says this model has NO resolution parameter (distinct from "no such concept"). */
function hasNoResolutionParam(fromApi: AdvertisedResolutions): boolean {
  return !!fromApi && fromApi.source === 'api' && fromApi.values.length === 0;
}

async function pickAdvertisedResolution(values: string[], initialValue: string | null): Promise<ResolutionChoice> {
  const prevIdx = initialValue ? values.indexOf(initialValue) : -1;
  const { value } = await ask<'value'>({
    type: 'select',
    name: 'value',
    message: 'Default resolution (defaulting to the highest available):',
    choices: values.map((v) => ({ title: v, value: v })),
    initial: prevIdx >= 0 ? prevIdx : values.length - 1, // previous, else highest
  });
  return { value, supported: values };
}

async function askCustomResolution(unit: 'image' | 'video', initialValue: string | null): Promise<ResolutionChoice> {
  const { value } = await ask<'value'>({
    type: 'text',
    name: 'value',
    message:
      unit === 'image'
        ? 'Default resolution (custom — e.g. "1024x1024"; check your provider docs for the expected format):'
        : 'Default video resolution (e.g. "720p" or "1280x720"):',
    initial: initialValue ?? (unit === 'video' ? '720p' : '1024x1024'),
  });
  return { value: value || null, supported: null };
}

async function chooseResolution(
  gw: Gateway,
  model: string,
  unit: 'image' | 'video',
  initialValue: string | null,
): Promise<ResolutionChoice> {
  const fromApi = unit === 'image' ? (gw.imageResolutions?.(model) ?? null) : null;
  if (hasNoResolutionParam(fromApi)) {
    log(`  ${model} has no resolution parameter — it renders at its native full size; skipping.`);
    return { value: null, supported: [] };
  }
  if (fromApi && fromApi.values.length > 0) return pickAdvertisedResolution(fromApi.values, initialValue);
  if (unit === 'image' && !gw.capabilities.imageResolutionParam) {
    return { value: null, supported: null }; // e.g. Mistral — no resolution param
  }
  return askCustomResolution(unit, initialValue);
}

async function chooseAsyncMode(label: string, initial: boolean): Promise<boolean> {
  const { async } = await ask<'async'>({
    type: 'toggle',
    name: 'async',
    message:
      `Run ${label} generation as an asynchronous job?` +
      ' (submit → returns a job_id to poll; recommended so a slow generation never trips a client timeout. ' +
      'Off = the call blocks until the result is ready.)',
    initial,
    active: 'yes (async)',
    inactive: 'no (wait)',
  });
  return async;
}

/**
 * Image generation: model → (capability prefetch) → async mode → aspect ratio → resolution.
 * Returns the model too — `wizard.ts` needs it for the Mistral orchestrator default.
 */
export async function configureImage(
  gw: Gateway,
  issues: IssueLog,
  prev: AppConfig['image'] | null,
): Promise<{ model: ModelInfo | null; config: AppConfig['image'] }> {
  log('\n— Image generation —');
  const model = await chooseModel(gw, issues, 'image', null, 'Select the image generation model:', prev?.model ?? null);
  if (!model) {
    issues.add('warning', 'image', 'No image model selected.');
    const none = { value: null, supported: null };
    return { model, config: imageConfig(gw, null, true, none, none) };
  }
  return { model, config: await askImageOptions(gw, model, prev) };
}

/** The per-model image questions (async mode, aspect ratio, resolution) → the finished `image` config. */
async function askImageOptions(gw: Gateway, model: ModelInfo, prev: AppConfig['image'] | null): Promise<AppConfig['image']> {
  // Pull the model's live capabilities (OpenRouter `supported_parameters`) so the
  // aspect-ratio / resolution prompts below offer what THIS model takes — and skip
  // the resolution question entirely for a model that has no such parameter.
  // Also persists the answer, so the server's first start after configuring needn't wait on it.
  if (gw.prepare) await gw.prepare({ imageModel: model.id, cache: new FileCapabilityCache(CAPABILITY_CACHE_PATH) }).catch(() => undefined);
  const async = await chooseAsyncMode('image', prev?.async ?? true);
  const aspect = await chooseAspectRatio(gw, model.id, prev?.defaultAspectRatio ?? null);
  const resolution = await chooseResolution(gw, model.id, 'image', prev?.defaultResolution ?? null);
  return imageConfig(gw, model, async, aspect, resolution);
}

function imageConfig(
  gw: Gateway,
  model: ModelInfo | null,
  async: boolean,
  aspect: { value: string | null; supported: string[] | null },
  resolution: ResolutionChoice,
): AppConfig['image'] {
  return {
    model: model ? model.id : null,
    edenProvider: gw.id === 'edenai' ? (model?.provider ?? null) : null,
    defaultAspectRatio: aspect.value,
    defaultResolution: resolution.value,
    supportedAspectRatios: aspect.supported,
    supportedResolutions: resolution.supported,
    async,
  };
}

type VideoToolKey = 'imageToVideo' | 'textToVideo';
type VideoToolPrev = AppConfig['imageToVideo'] | AppConfig['textToVideo'] | null;

/** The stored model may carry an Eden sub-provider prefix; strip it so it matches the bare model id in the choice list. */
function previousVideoModel(prev: VideoToolPrev): string | null {
  if (prev?.model && prev.edenProvider && prev.model.startsWith(`${prev.edenProvider}/`)) {
    return prev.model.slice(prev.edenProvider.length + 1);
  }
  return prev?.model ?? null;
}

/** One enabled video tool (image-to-video or text-to-video); null when declined or no model chosen. */
async function configureVideoTool(
  gw: Gateway,
  issues: IssueLog,
  toolKey: VideoToolKey,
  kind: VideoKind,
  prev: VideoToolPrev,
): Promise<AppConfig['textToVideo'] | null> {
  const label = kind;
  const { enable } = await ask<'enable'>({ type: 'toggle', name: 'enable', message: `Enable ${label}?`, initial: prev?.enabled ?? false, active: 'yes', inactive: 'no' });
  if (!enable) return null;

  const model = await chooseModel(gw, issues, toolKey, kind, `Select the ${label} model:`, previousVideoModel(prev));
  if (!model) {
    issues.add('warning', toolKey, `${label} enabled but no model selected — leaving disabled.`);
    return null;
  }
  return askVideoOptions(gw, model, label, prev);
}

/** Default FPS and duration for a video tool. */
async function askVideoTiming(prev: VideoToolPrev): Promise<{ fps: number; duration: number }> {
  const { fps } = await ask<'fps'>({ type: 'number', name: 'fps', message: 'Default FPS:', initial: prev?.defaultFps ?? 24, min: 1, max: 120 });
  const { duration } = await ask<'duration'>({ type: 'number', name: 'duration', message: 'Default duration (seconds):', initial: prev?.defaultDuration ?? 5, min: 1, max: 60 });
  return { fps, duration };
}

/** The per-model video questions (async mode, resolution, FPS, duration) → the enabled tool's config. */
async function askVideoOptions(gw: Gateway, model: ModelInfo, label: string, prev: VideoToolPrev): Promise<AppConfig['textToVideo']> {
  const asyncMode = await chooseAsyncMode(label, prev?.async ?? true);
  const res = await chooseResolution(gw, model.id, 'video', prev?.defaultResolution ?? null);
  const { fps, duration } = await askVideoTiming(prev);
  return {
    enabled: true,
    model: model.provider ? `${model.provider}/${model.id}` : model.id,
    edenProvider: gw.id === 'edenai' ? (model.provider ?? null) : null,
    defaultResolution: res.value,
    defaultFps: fps,
    defaultDuration: duration,
    async: asyncMode,
  };
}

/** A tool's section: heading + prompts when the gateway supports it, else a "skipping" note. */
async function configureVideoSection(
  gw: Gateway,
  gateway: GatewayId,
  issues: IssueLog,
  toolKey: VideoToolKey,
  kind: VideoKind,
  heading: string,
  prev: VideoToolPrev,
): Promise<AppConfig['textToVideo'] | null> {
  if (!gw.capabilities[toolKey]) {
    log(`\n${GATEWAY_LABELS[gateway]} does not support ${kind} — skipping.`);
    return null;
  }
  log(`\n— ${heading} —`);
  return configureVideoTool(gw, issues, toolKey, kind, prev);
}

/** Both video tools; a tool that is unsupported, declined or model-less comes back disabled. */
export async function configureVideoTools(
  gw: Gateway,
  gateway: GatewayId,
  issues: IssueLog,
  prev: AppConfig | null,
): Promise<{ imageToVideo: AppConfig['imageToVideo']; textToVideo: AppConfig['textToVideo'] }> {
  const i2v = await configureVideoSection(gw, gateway, issues, 'imageToVideo', 'image-to-video', 'Image-to-video', prev?.imageToVideo ?? null);
  const t2v = await configureVideoSection(gw, gateway, issues, 'textToVideo', 'text-to-video', 'Text-to-video', prev?.textToVideo ?? null);
  return {
    // Whether a specific model accepts multiple reference images (first+last
    // frame / subject refs) is provider-native per model and not exposed by any
    // listing API (see docs/API-NOTES.md), so a human filling in the wizard
    // can't be expected to answer it. Derive it from the gateway capability
    // instead of asking. This flag only gates a call-time safety check (extra
    // refs are dropped for single-reference gateways) and an explicit `model`
    // argument bypasses it, so an over-permissive value just defers to the API.
    imageToVideo: i2v
      ? { ...i2v, multiReference: gw.capabilities.multiReferenceImages }
      : { enabled: false, model: null, edenProvider: null, defaultResolution: null, defaultFps: null, defaultDuration: null, multiReference: false, async: true },
    textToVideo: t2v ?? { enabled: false, model: null, edenProvider: null, defaultResolution: null, defaultFps: null, defaultDuration: null, async: true },
  };
}
