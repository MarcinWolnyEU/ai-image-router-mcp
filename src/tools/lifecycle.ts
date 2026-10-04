import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runtime } from '../state/runtime.js';
import { GATEWAY_LABELS } from '../config/schema.js';
import { BG_MODELS, plannedProviders, requiredFreeMB, type BgExecutionProvider, type BgModelKey, type EpUsage } from '../bgremoval/models.js';
import type { OptionList } from '../gateways/types.js';
import { memInfo, gpuInfo, type GpuInfo } from '../util/sysinfo.js';
import { textResult, type ToolResult } from './helpers.js';

type AppConfig = typeof runtime.config;
type Health = typeof runtime.health;

const isoOrNull = (t: number | null): string | null => (t ? new Date(t).toISOString() : null);

/** The measured resource facts for a model on one execution provider (null where unknown). */
function providerUsageFields(u: EpUsage | undefined): { runsOnProvider: boolean | null; peakRamMB: number | null; peakVramMB: number | 'over-16gb' | null; note: string | null } {
  return { runsOnProvider: u?.runs ?? null, peakRamMB: u?.ramMB ?? null, peakVramMB: u?.vramMB ?? null, note: u?.note ?? null };
}

/** Whether the configured bg model fits in free RAM on the provider it will use (null when removal is off). */
function backgroundRemovalMemory(freeMB: number): Record<string, unknown> | null {
  const cfg = runtime.config.backgroundRemoval;
  if (cfg.model === 'none') return null;
  // Before the session exists, report the provider the runtime WILL use — the same plan
  // `init` follows (an unavailable or known-broken provider is already replaced by CPU).
  const spec = BG_MODELS[cfg.model as BgModelKey];
  const ep = (runtime.health.activeExecutionProvider ?? plannedProviders(spec, cfg.executionProvider).eps[0]) as BgExecutionProvider;
  const need = requiredFreeMB(spec, ep);
  const usage = providerUsageFields(spec.usage[ep]);
  return {
    model: cfg.model,
    provider: ep,
    runsOnProvider: usage.runsOnProvider,
    requiredFreeRamMB: need,
    enoughFreeRam: freeMB >= need,
    peakRamMB: usage.peakRamMB,
    peakVramMB: usage.peakVramMB,
    note: usage.note,
  };
}

/** Free RAM/VRAM + whether the configured bg model can run on its provider right now. */
function memorySnapshot(gpu: GpuInfo | null): Record<string, unknown> {
  const mem = memInfo();
  const out: Record<string, unknown> = {
    ram: { freeMB: mem.freeMB, totalMB: mem.totalMB },
    gpu: gpu ? { name: gpu.name, freeVramMB: gpu.freeMB, totalVramMB: gpu.totalMB } : null,
  };
  const bg = backgroundRemovalMemory(mem.freeMB);
  if (bg) out.backgroundRemoval = bg;
  return out;
}

function imageToolSnapshot(cfg: AppConfig): Record<string, unknown> {
  return {
    model: cfg.image.model,
    defaultAspectRatio: cfg.image.defaultAspectRatio,
    defaultResolution: cfg.image.defaultResolution,
    // What reference images MEAN for this model (subject conditioning vs style
    // transfer) — the caller needs this BEFORE generating, not after.
    referenceSemantics: runtime.gateway.referenceSemantics?.(cfg.image.model ?? '') ?? null,
    // Per-model knobs as the gateway currently knows them (live capability API
    // where available — OpenRouter `/images/models/{id}/endpoints`).
    options: imageOptionsSnapshot(),
  };
}

function imageToVideoSnapshot(cfg: AppConfig): Record<string, unknown> | 'disabled' {
  const c = cfg.imageToVideo;
  return c.enabled
    ? { model: c.model, multiReference: c.multiReference, fps: c.defaultFps, resolution: c.defaultResolution, duration: c.defaultDuration }
    : 'disabled';
}

function textToVideoSnapshot(cfg: AppConfig): Record<string, unknown> | 'disabled' {
  const c = cfg.textToVideo;
  return c.enabled ? { model: c.model, fps: c.defaultFps, resolution: c.defaultResolution, duration: c.defaultDuration } : 'disabled';
}

function backgroundRemovalSnapshot(cfg: AppConfig, h: Health): Record<string, unknown> {
  return {
    model: cfg.backgroundRemoval.model,
    executionProvider: cfg.backgroundRemoval.executionProvider,
    activeExecutionProvider: h.activeExecutionProvider,
    status: h.backgroundModelStatus,
    error: h.backgroundModelError,
  };
}

/** `none`, or `bearer token (<source>)` — the source (file path / env name) only, never the secret. */
function httpAuthDescription(cfg: AppConfig): string {
  const tok = cfg.http.authToken;
  if (!runtime.httpAuthToken) return 'none';
  return `bearer token (${tok?.type === 'inline' ? 'inline' : `${tok?.type}: ${tok?.value}`})`;
}

/** Build a token-free snapshot of the current config + runtime/diagnostic state. */
function healthSnapshot(gpu: GpuInfo | null): Record<string, unknown> {
  const cfg = runtime.config;
  const h = runtime.health;
  return {
    server: 'ai-image-router-mcp',
    uptimeSeconds: h.uptimeSeconds(),
    reloadedAt: isoOrNull(h.reloadedAt),
    gateway: { id: cfg.gateway, label: GATEWAY_LABELS[cfg.gateway] },
    capabilities: runtime.gateway.capabilities,
    token: { type: cfg.token.type, ref: cfg.token.type === 'inline' ? '(inline)' : cfg.token.value },
    tools: {
      image: imageToolSnapshot(cfg),
      imageToVideo: imageToVideoSnapshot(cfg),
      textToVideo: textToVideoSnapshot(cfg),
      backgroundRemoval: backgroundRemovalSnapshot(cfg, h),
    },
    memory: memorySnapshot(gpu),
    tinify: runtime.tinifyToken ? 'enabled (PNG compression + WebP)' : 'disabled',
    output: { dir: runtime.outputDir(), inlinePreview: cfg.output.inlinePreview },
    logging: { policy: cfg.logging.policy, dir: cfg.logging.dir },
    http: { enabled: cfg.http.enabled, host: cfg.http.host, port: cfg.http.port, auth: httpAuthDescription(cfg) },
    counters: { generations: h.generationCount, lastImageAt: isoOrNull(h.lastImageAt), lastVideoAt: isoOrNull(h.lastVideoAt) },
    wizardDiagnostics: {
      configuredAt: cfg.diagnostics.configuredAt || null,
      wizardVersion: cfg.diagnostics.wizardVersion || null,
      sources: cfg.diagnostics.sources,
      issues: cfg.diagnostics.issues,
    },
    recentRuntimeErrors: h.recentErrors(15),
  };
}

const optionValues = (o: OptionList | null): { values: string[]; source: string } | null => (o ? { values: o.values, source: o.source } : null);

const RESOLUTION_NOT_SENT =
  'none — the model has no resolution parameter (renders at its native full size; a configured default tier is not sent)';

/** Resolution tiers, or a note when the API says the model has no resolution parameter. */
function resolutionTiersSnapshot(res: OptionList | null): Record<string, unknown> | string | null {
  if (!res) return null;
  if (res.values.length > 0) return optionValues(res);
  return res.source === 'api' ? RESOLUTION_NOT_SENT : null;
}

function backgroundModesSnapshot(bg: OptionList | null): Record<string, unknown> | string | null {
  if (!bg) return null;
  if (bg.values.length === 0) return 'no native background field';
  return { values: bg.values, transparent: bg.values.includes('transparent'), source: bg.source };
}

/** The configured image model's advertised options (aspect ratios, resolution tiers, quality, background). */
function imageOptionsSnapshot(): Record<string, unknown> {
  const model = runtime.config.image.model ?? '';
  const gw = runtime.gateway;
  return {
    aspectRatios: optionValues(gw.imageAspectRatios?.(model) ?? null),
    resolutionTiers: resolutionTiersSnapshot(gw.imageResolutions?.(model) ?? null),
    quality: optionValues(gw.imageQualityLevels?.(model) ?? null),
    background: backgroundModesSnapshot(gw.imageBackgroundModes?.(model) ?? null),
  };
}

/** `a, b [source]` for an advertised option list, the note itself for a string, `unknown` when absent. */
function formatOption(v: unknown): string {
  if (v == null) return 'unknown';
  if (typeof v === 'string') return v;
  const o = v as { values: string[]; source: string };
  return `${o.values.join(', ')} [${o.source}]`;
}

const videoModelLabel = (c: { enabled: boolean; model?: string | null }): string => (c.enabled ? c.model ?? '(no model)' : 'disabled');
const gb = (mb: number): string => (mb / 1024).toFixed(1);

function imageLines(cfg: AppConfig): string[] {
  const refSem = runtime.gateway.referenceSemantics?.(cfg.image.model ?? '') ?? null;
  const opt = imageOptionsSnapshot();
  return [
    `Image model: ${cfg.image.model ?? '(none configured)'}`,
    `Reference images: ${refSem ? `${refSem.native} conditioning via ${refSem.field} (modes: ${refSem.supported.join(', ')})` : 'not supported by this model'}`,
    `Image options: aspect ratios ${formatOption(opt['aspectRatios'])} · resolution tiers ${formatOption(opt['resolutionTiers'])} · quality ${formatOption(opt['quality'])} · background ${formatOption(opt['background'])}`,
  ];
}

function pipelineLines(cfg: AppConfig, h: Health, gpu: GpuInfo | null): string[] {
  const mem = memInfo();
  return [
    `Image→Video: ${videoModelLabel(cfg.imageToVideo)} | Text→Video: ${videoModelLabel(cfg.textToVideo)}`,
    `Background removal: ${cfg.backgroundRemoval.model} [${h.backgroundModelStatus}${h.activeExecutionProvider ? ', EP=' + h.activeExecutionProvider : ''}]`,
    `Memory: RAM ${gb(mem.freeMB)}/${gb(mem.totalMB)} GB free` + (gpu ? ` · ${gpu.name} VRAM ${gb(gpu.freeMB)}/${gb(gpu.totalMB)} GB free` : ''),
  ];
}

function serviceLines(cfg: AppConfig): string[] {
  return [
    `Tinify: ${runtime.tinifyToken ? 'enabled' : 'disabled'} | Logging: ${cfg.logging.policy} | Output: ${runtime.outputDir()}`,
  ];
}

function issueLines(cfg: AppConfig): string[] {
  const issues = cfg.diagnostics.issues;
  if (issues.length === 0) return [`\nNo configuration-time issues recorded.`];
  return [`\nConfiguration-time issues (${issues.length}):`, ...issues.map((i) => `  [${i.severity}] ${i.area}: ${i.message}`)];
}

function recentErrorLines(h: Health): string[] {
  const recent = h.recentErrors(5);
  if (recent.length === 0) return [];
  return [`\nRecent runtime errors:`, ...recent.map((e) => `  ${e.time} ${e.where}: ${e.message}`)];
}

async function renderHealth(): Promise<string> {
  // One async GPU probe per call (cached, never blocking the event loop), shared by both sections.
  const gpu = await gpuInfo();
  const snapshot = healthSnapshot(gpu);
  const cfg = runtime.config;
  const h = runtime.health;
  const lines = [
    `ai-image-router-mcp — health`,
    `Gateway: ${GATEWAY_LABELS[cfg.gateway]} (${cfg.gateway})`,
    `Uptime: ${h.uptimeSeconds()}s${h.reloadedAt ? ` (reloaded ${new Date(h.reloadedAt).toISOString()})` : ''}`,
    ...imageLines(cfg),
    ...pipelineLines(cfg, h, gpu),
    ...serviceLines(cfg),
    ...issueLines(cfg),
    ...recentErrorLines(h),
    `\nFull JSON:\n\`\`\`json\n${JSON.stringify(snapshot, null, 2)}\n\`\`\``,
  ];
  return lines.join('\n');
}

export function registerLifecycleTools(server: McpServer): void {
  server.registerTool(
    'health_status',
    {
      title: 'Health & configuration status',
      description:
        'Report detailed server health: active gateway, configured models/options, the execution provider for background removal, ' +
        'logging/output settings, any errors or missing entries recorded by the config wizard, and recent runtime errors. No secrets are returned.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> => textResult(await renderHealth()),
  );

  server.registerTool(
    'restart',
    {
      title: 'Restart (soft reload)',
      description:
        'Soft-restart the server in place: re-read config.json, re-resolve the token, re-init the gateway client and clear the ' +
        'background-removal session and error state. The MCP connection stays alive. Use after editing the configuration. ' +
        'All-or-nothing: if the new configuration cannot be applied, the previous one stays fully active and the error is reported; ' +
        'on success the tool list and option schemas are refreshed for the new gateway/model.',
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      const res = await runtime.reload();
      return { content: [{ type: 'text', text: `${res.ok ? '✅' : '❌'} ${res.message}\n\n${await renderHealth()}` }], ...(res.ok ? {} : { isError: true }) };
    },
  );

  server.registerTool(
    'shutdown',
    {
      title: 'Shutdown',
      description:
        'Gracefully shut the server down: flush logs and exit the process. The MCP client will need to relaunch the server ' +
        '(or call this only when you intend to stop it).',
      inputSchema: {
        reason: z.string().optional().describe('Optional reason recorded in the logs.'),
        delay_ms: z.number().int().min(0).max(10_000).optional().describe('Delay before exit so this response can flush (default 300ms).'),
      },
    },
    async (args): Promise<ToolResult> => {
      const reason = args.reason ?? 'shutdown tool invoked';
      const delay = args.delay_ms ?? 300;
      runtime.logger?.info('Shutdown tool invoked', { reason, delay });
      // Schedule the actual stop AFTER returning, so the client receives this reply.
      setTimeout(() => {
        void runtime.requestShutdown(reason);
      }, delay);
      return textResult(`Shutting down in ${delay}ms (${reason}). The client will need to relaunch the server to use it again.`);
    },
  );
}
