/**
 * Wizard steps for everything that is local to this machine rather than a
 * gateway: background removal (ONNX), Tinify, logging/output, and the MCP
 * transport (stdio vs HTTP + auth). Each `configure*` returns its config fragment.
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import prompts from 'prompts';
import { BG_MODELS, providerAvailable, resolveExecutionProvider, type BgExecutionProvider, type BgModelKey } from '../bgremoval/models.js';
import { fromRoot, resolvePath } from './paths.js';
import { AppConfig, configSchema, HTTP_AUTH_TOKEN_FILE, TINIFY_TOKEN_FILE } from './schema.js';
import { memInfo, gpuInfo, type GpuInfo } from '../util/sysinfo.js';
import { ask, askTokenSource, choiceIndex, log } from './wizardPrompt.js';

// ---------------------------------------------------------------------------
// Background removal
// ---------------------------------------------------------------------------

const gbOfRam = (mb?: number) => (mb ? `${(mb / 1024).toFixed(1)} GB RAM` : '');
const gbOfVram = (v?: number | 'over-16gb') =>
  v === 'over-16gb' ? '>16 GB VRAM' : typeof v === 'number' ? `${(v / 1024).toFixed(1)} GB VRAM` : '';

/** `⚠ low free RAM/VRAM` suffix when the model's measured need exceeds what this machine has free. */
function fitWarnings(u: { ramMB?: number; vramMB?: number | 'over-16gb' }, freeRamMB: number, gpu: GpuInfo | null): string {
  const lowRam = u.ramMB && u.ramMB + 512 > freeRamMB ? ' ⚠ low free RAM' : '';
  const lowVram = typeof u.vramMB === 'number' && gpu && u.vramMB > gpu.freeMB ? ' ⚠ low free VRAM' : '';
  return lowRam + lowVram;
}

/** One-line, EP-aware annotation of a background-removal model for the wizard choice list. */
function bgModelAnnotation(key: BgModelKey, ep: BgExecutionProvider, freeRamMB: number, gpu: GpuInfo | null): string {
  const spec = BG_MODELS[key];
  const u = spec.usage[ep];
  const cpuRam = gbOfRam(spec.usage.cpu?.ramMB);

  if (!u) return `untested on ${ep.toUpperCase()} — CPU needs ~${cpuRam}`;
  if (!u.runs) return `✗ won't run on ${ep.toUpperCase()} (${u.note ?? 'unsupported ops'}) — use CPU (~${cpuRam})`;
  const parts = [gbOfRam(u.ramMB), gbOfVram(u.vramMB)].filter(Boolean);
  return `✓ ~${parts.join(' · ~')}${u.note ? ` (${u.note})` : ''}${fitWarnings(u, freeRamMB, gpu)}`;
}

/** Print what this machine offers (RAM / GPU) plus the EP caveats; the figures feed the model annotations. */
async function showMachineInfo(): Promise<{ freeMB: number; gpu: GpuInfo | null }> {
  const mem = memInfo();
  const gpu = await gpuInfo();
  log(`  Your machine: RAM ${(mem.freeMB / 1024).toFixed(1)} / ${(mem.totalMB / 1024).toFixed(1)} GB free` +
    (gpu ? ` · GPU ${gpu.name}, VRAM ${(gpu.freeMB / 1024).toFixed(1)} / ${(gpu.totalMB / 1024).toFixed(1)} GB free` : ' · no NVIDIA GPU detected'));
  log('  Note: BiRefNet & BRIA RMBG-2.0 cannot run on DirectML (they fall back to CPU, ~7.5 GB RAM each);');
  log('  on WebGPU they run via a one-time converted copy of the model. IS-Net (light, ~1.3 GB VRAM) and');
  log('  BEN2 (higher quality, ~3.8 GB VRAM) run on every GPU provider. Pick the provider first:');
  return { freeMB: mem.freeMB, gpu };
}

async function chooseExecutionProvider(prev: AppConfig['backgroundRemoval']['executionProvider'] | undefined): Promise<AppConfig['backgroundRemoval']['executionProvider']> {
  const autoEP = resolveExecutionProvider('auto');
  const platformDefault = { webgpu: 'WebGPU', coreml: 'CoreML', cuda: 'CUDA', dml: 'DirectML', cpu: 'CPU' }[autoEP];
  // Only the providers the bundled onnxruntime ships HERE (CUDA = Linux x64, CoreML = macOS,
  // DirectML = Windows) — picking one that isn't there silently ran on CPU.
  const epChoices = [
    { title: `auto (recommended — ${platformDefault})`, value: 'auto' },
    { title: 'WebGPU (Windows/Linux x64/macOS, GPU)', value: 'webgpu' },
    { title: 'DirectML (Windows DirectX 12, GPU)', value: 'dml' },
    { title: 'CUDA (Linux x64 GPU, needs CUDA 12 + cuDNN 9)', value: 'cuda' },
    { title: 'CoreML (macOS)', value: 'coreml' },
    { title: 'CPU (slowest, supports most models, ~7.5 GB RAM)', value: 'cpu' },
  ].filter((c) => c.value === 'auto' || providerAvailable(c.value as BgExecutionProvider));
  const { ep } = await ask<'ep'>({
    type: 'select',
    name: 'ep',
    message: 'ONNX execution provider:',
    choices: epChoices,
    initial: choiceIndex(epChoices.map((c) => c.value), prev),
  });
  return ep as AppConfig['backgroundRemoval']['executionProvider'];
}

const BG_MODEL_ORDER: BgModelKey[] = ['birefnet-general', 'birefnet-massive', 'bria-rmbg', 'isnet-general-use', 'ben2-base'];

/**
 * Default to the previously-configured model ('none' is the last choice), else
 * the provider-appropriate recommendation.
 */
function bgModelInitial(prevBg: string | undefined, recommended: BgModelKey): number {
  if (prevBg === 'none') return BG_MODEL_ORDER.length;
  if (prevBg && BG_MODEL_ORDER.includes(prevBg as BgModelKey)) return BG_MODEL_ORDER.indexOf(prevBg as BgModelKey);
  return Math.max(0, BG_MODEL_ORDER.indexOf(recommended));
}

/** Model second — annotated with empirical RAM/VRAM for the chosen provider. */
async function chooseBgModel(
  bgEP: AppConfig['backgroundRemoval']['executionProvider'],
  effEP: BgExecutionProvider,
  prevBg: string | undefined,
  machine: { freeMB: number; gpu: GpuInfo | null },
): Promise<AppConfig['backgroundRemoval']['model']> {
  const recommended: BgModelKey = effEP === 'cpu' ? 'birefnet-general' : 'isnet-general-use';
  const choices = BG_MODEL_ORDER.map((key) => ({
    title: `${BG_MODELS[key].label}${key === recommended ? ' (recommended)' : ''} — ${bgModelAnnotation(key, effEP, machine.freeMB, machine.gpu)}`,
    value: key as string,
  }));
  choices.push({ title: 'none (disable the tool)', value: 'none' });
  const { bgModel } = await ask<'bgModel'>({
    type: 'select',
    name: 'bgModel',
    message: `Background removal model (provider: ${effEP.toUpperCase()}${bgEP === 'auto' ? ' via auto' : ''}):`,
    choices,
    initial: bgModelInitial(prevBg, recommended),
  });
  if (bgModel !== 'none') {
    log(`  The model (~${BG_MODELS[bgModel as BgModelKey].approxMB} MB) will be downloaded automatically on first use.`);
  }
  return bgModel as AppConfig['backgroundRemoval']['model'];
}

export async function configureBackgroundRemoval(existing: AppConfig | null): Promise<AppConfig['backgroundRemoval']> {
  log('\n— Background removal (runs locally via ONNX) —');
  const machine = await showMachineInfo();
  // EP first — so per-model RAM/VRAM can be shown for the chosen provider.
  const prev = existing?.backgroundRemoval;
  const executionProvider = await chooseExecutionProvider(prev?.executionProvider);
  const model = await chooseBgModel(executionProvider, resolveExecutionProvider(executionProvider), prev?.model, machine);
  return { model, executionProvider, modelsDir: prev?.modelsDir ?? 'models' };
}

// ---------------------------------------------------------------------------
// Tinify
// ---------------------------------------------------------------------------

export async function configureTinify(existing: AppConfig | null): Promise<AppConfig['tinify']> {
  log('\n— Image compression (Tinify, optional) —');
  const tinifyFileExists = existsSync(fromRoot(TINIFY_TOKEN_FILE));
  const { useTinify } = await ask<'useTinify'>({
    type: 'toggle',
    name: 'useTinify',
    message: `Enable Tinify (compress PNGs + WebP output in generate_image)?${tinifyFileExists ? ` — found ${TINIFY_TOKEN_FILE}` : ''}`,
    initial: existing ? existing.tinify !== null : tinifyFileExists,
    active: 'yes',
    inactive: 'no',
  });
  if (!useTinify) return null;
  const token = await askTokenSource(
    {
      defaultFile: TINIFY_TOKEN_FILE,
      defaultExists: tinifyFileExists,
      methodMessage: 'Tinify token source:',
      defaultTitle: `Token file: ${TINIFY_TOKEN_FILE} (found)`,
      pasteTitle: 'Paste the token now',
      pathMessage: 'Path to the Tinify token file:',
      pastePrompt: 'Paste your Tinify token:',
    },
    existing?.tinify?.token ?? null,
  );
  return { token };
}

// ---------------------------------------------------------------------------
// Logging & output
// ---------------------------------------------------------------------------

// The schema's own defaults stand in for a missing previous config (one source of truth).
const OUTPUT_DEFAULTS = configSchema.shape.output.parse(undefined);
const LOGGING_DEFAULTS = configSchema.shape.logging.parse(undefined);

export async function configureOutput(existing: AppConfig | null): Promise<{ output: AppConfig['output']; logging: AppConfig['logging'] }> {
  const prevOutput = existing?.output ?? OUTPUT_DEFAULTS;
  const prevLogging = existing?.logging ?? LOGGING_DEFAULTS;
  log('\n— Logging & output —');
  const logChoices = [
    { title: 'today — keep only the current day’s log (default)', value: 'today' },
    { title: 'persistent daily — keep one log file per day', value: 'persistent-daily' },
    { title: 'no logs (stderr only)', value: 'none' },
  ];
  const { logPolicy } = await ask<'logPolicy'>({
    type: 'select',
    name: 'logPolicy',
    message: 'Logging policy:',
    choices: logChoices,
    initial: choiceIndex(logChoices.map((c) => c.value), prevLogging.policy),
  });
  const { outputDir } = await ask<'outputDir'>({ type: 'text', name: 'outputDir', message: 'Output directory for generated media:', initial: prevOutput.dir });
  const { inlinePreview } = await ask<'inlinePreview'>({ type: 'toggle', name: 'inlinePreview', message: 'Return inline image previews to the client?', initial: prevOutput.inlinePreview, active: 'yes', inactive: 'no' });
  return {
    output: { dir: outputDir || 'output', inlinePreview, previewMaxBytes: prevOutput.previewMaxBytes },
    logging: { policy: logPolicy as AppConfig['logging']['policy'], dir: prevLogging.dir },
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function chooseHttpTransport(existingEnabled: boolean): Promise<boolean> {
  log('\n— Transport —');
  log('How MCP clients connect to this server. stdio suits virtually all local use;');
  log('HTTP is a niche choice for remote / networked deployments (details per option).');
  const { transport } = await ask<'transport'>({
    type: 'select',
    name: 'transport',
    message: 'Transport layer:',
    choices: [
      {
        title: 'stdio (recommended)',
        value: 'stdio',
        description:
          'The client spawns the server on demand and talks to it over a local pipe. ' +
          'Best for Claude Code, Copilot, Kilo, Codex, Cline, Hermes Agent, etc.',
      },
      {
        title: 'http (niche uses)',
        value: 'http',
        description:
          'Run as a long-lived Streamable HTTP service on a host/port; clients connect by URL. ' +
          'Becomes the DEFAULT transport (plain `npm start` serves HTTP, so stdio registrations stop ' +
          'connecting); optional bearer-token auth. Only for remote / containerised / ' +
          'multi-client / web-based setups, such as Le Chat custom connectors (via an HTTPS tunnel), Rovo, Azure DevOps remote MCP, etc.',
      },
    ],
    initial: existingEnabled ? 1 : 0,
  });
  return transport === 'http';
}

async function askHttpBinding(host: string, port: number): Promise<{ host: string; port: number }> {
  const r = await ask<'host' | 'port'>([
    { type: 'text', name: 'host', message: 'HTTP host:', initial: host },
    { type: 'number', name: 'port', message: 'HTTP port:', initial: port },
  ] as unknown as prompts.PromptObject<'host' | 'port'>);
  return { host: (r as { host: string }).host, port: (r as { port: number }).port };
}

/** The saved token file reference; generates a random token file first when none exists yet. */
async function ensureHttpAuthTokenFile(): Promise<NonNullable<AppConfig['http']['authToken']>> {
  const file = HTTP_AUTH_TOKEN_FILE;
  const p = resolvePath(file);
  if (!existsSync(p)) {
    await writeFile(p, randomBytes(24).toString('base64url') + '\n', 'utf8');
    log(`Generated a random HTTP auth token in "${file}" (send it as "Authorization: Bearer <token>").`);
  }
  return { type: 'file', value: file };
}

async function chooseHttpAuth(current: AppConfig['http']['authToken']): Promise<AppConfig['http']['authToken']> {
  const { requireAuth } = await ask<'requireAuth'>({
    type: 'confirm',
    name: 'requireAuth',
    message: 'Require a bearer token on /mcp? (strongly recommended if the port is exposed, e.g. via a tunnel — tools read local files)',
    initial: true,
  });
  if (!requireAuth) return null;
  return current ?? (await ensureHttpAuthTokenFile());
}

const HTTP_DEFAULTS = configSchema.shape.http.parse(undefined);

export async function configureTransport(existing: AppConfig | null): Promise<AppConfig['http']> {
  const prev = existing?.http ?? HTTP_DEFAULTS;
  const enabled = await chooseHttpTransport(prev.enabled);
  if (!enabled) return { ...prev, enabled };
  const { host, port } = await askHttpBinding(prev.host, prev.port);
  return { ...prev, enabled, host, port, authToken: await chooseHttpAuth(prev.authToken) };
}
