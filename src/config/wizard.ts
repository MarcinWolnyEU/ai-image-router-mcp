#!/usr/bin/env node
/**
 * Interactive configuration wizard for ai-image-router-mcp.
 *   npm run configure
 *
 * Guides the user through gateway + token + per-tool model/option selection,
 * pulling live model lists and highlighting Artificial Analysis leaderboard
 * top-10 matches. Persists config.json plus a diagnostics block recording any
 * errors/missing entries hit while pulling data.
 *
 * This file is the entry point and the top-level sequence; the sections live in
 * `wizardModels.ts` (image/video models), `wizardLocal.ts` (bg removal, Tinify,
 * logging, transport) and `wizardPrompt.ts` (shared prompt plumbing).
 */
import { existsSync } from 'node:fs';
import { CONFIG_PATH, fromRoot } from './paths.js';
import {
  AppConfig,
  configSchema,
  ConfigError,
  DEFAULT_TOKEN_FILES,
  GATEWAY_LABELS,
  GATEWAYS,
  GatewayId,
  loadConfig,
  resolveToken,
  saveConfig,
  TokenSource,
} from './schema.js';
import { Logger } from '../logging/logger.js';
import { createGateway } from '../gateways/registry.js';
import type { Gateway, ModelInfo } from '../gateways/types.js';
import { ask, askTokenSource, choiceIndex, IssueLog, log } from './wizardPrompt.js';
import { configureImage, configureVideoTools } from './wizardModels.js';
import { configureBackgroundRemoval, configureOutput, configureTinify, configureTransport } from './wizardLocal.js';

const WIZARD_VERSION = '0.1.0';

async function selectGateway(existing: AppConfig | null): Promise<GatewayId> {
  const { gateway } = await ask<'gateway'>({
    type: 'select',
    name: 'gateway',
    message: 'Which LLM gateway do you want to use?',
    choices: GATEWAYS.map((g) => ({ title: GATEWAY_LABELS[g], value: g })),
    initial: choiceIndex(GATEWAYS, existing?.gateway),
  });
  return gateway as GatewayId;
}

function selectToken(gateway: GatewayId, prev: TokenSource | null): Promise<TokenSource> {
  const defaultFile = DEFAULT_TOKEN_FILES[gateway];
  return askTokenSource(
    {
      defaultFile,
      defaultExists: existsSync(fromRoot(defaultFile)),
      methodMessage: 'Where is your API token?',
      defaultTitle: `Token file: ${defaultFile} (found in project root)`,
      pasteTitle: 'Paste the token now (stored in config.json)',
      pathMessage: 'Path to the token file:',
      pastePrompt: 'Paste your API token:',
    },
    prev,
  );
}

/**
 * The wizard's menus need raw keyboard input (arrow keys). Node only exposes
 * that when stdin is a real console: `process.stdin.isTTY` is true in a Windows
 * console, PowerShell, cmd, ConPTY (Windows Terminal / VS Code), or under
 * `winpty`. In bare Git Bash (mintty) stdin is a pipe — isTTY is false and arrow
 * keys silently do nothing. Detect that up front and tell the user how to fix it
 * rather than letting them get stuck on the first menu.
 *
 * The headless test harness drives the wizard via `prompts.inject` with no TTY,
 * so it sets AIR_WIZARD_SKIP_TTY_CHECK to bypass this guard.
 */
function assertInteractiveTty(): void {
  if (process.env.AIR_WIZARD_SKIP_TTY_CHECK) return;
  if (process.stdin.isTTY) return;

  const lines = [
    '',
    'This configuration wizard needs an interactive terminal (raw keyboard input)',
    'for its arrow-key menus, but stdin is not a TTY here — arrow keys and Enter',
    'will not work.',
    '',
  ];
  if (process.env.MSYSTEM) {
    // MSYSTEM (MINGW64/MINGW32/MSYS) => Git Bash / mintty, which doesn't give
    // Node a real console. winpty fixes it only when it's the outermost command.
    lines.push(
      "You're in Git Bash (mintty), which doesn't expose a real console to Node.",
      'Build first, then run the wizard under winpty:',
      '',
      '  npm run build && winpty node dist/config/wizard.js',
      '',
      'Or launch the wizard from PowerShell, cmd, or a Git Bash tab inside Windows',
      'Terminal / VS Code (those use ConPTY and work without winpty).',
    );
  } else {
    lines.push(
      'Run the wizard directly in an interactive terminal (PowerShell, cmd, or',
      'Windows Terminal) — do not pipe or redirect its input.',
    );
  }
  lines.push('');
  process.stderr.write(lines.join('\n') + '\n');
  process.exit(1);
}

async function loadExistingConfig(): Promise<AppConfig | null> {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const existing = await loadConfig();
    log(`Found an existing config (gateway: ${existing.gateway}). It will be overwritten when you finish.\n`);
    return existing;
  } catch {
    return null; // ignore invalid existing config
  }
}

/** Everything gateway-bound: which gateway, its token, and a live client for the list calls that follow. */
async function configureGateway(
  existing: AppConfig | null,
  issues: IssueLog,
): Promise<{ gateway: GatewayId; token: TokenSource; gw: Gateway; prevForGateway: AppConfig | null }> {
  const gateway = await selectGateway(existing);
  // Gateway-specific choices (token, models, aspect/resolution, video settings)
  // are only meaningful defaults when the gateway is unchanged; switching gateway
  // makes the old selections belong to a different namespace, so fall back to the
  // standard defaults there. Gateway-agnostic sections seed from `existing`.
  const prevForGateway = existing && existing.gateway === gateway ? existing : null;
  const token = await selectToken(gateway, prevForGateway?.token ?? null);

  // Validate the token by constructing the gateway and doing a cheap list call.
  const logger = new Logger('none', 'logs');
  await logger.init();
  let resolvedToken = '';
  try {
    resolvedToken = await resolveToken(token);
  } catch (err) {
    issues.add('error', 'token', `Token could not be resolved: ${(err as Error).message}`);
  }
  return { gateway, token, gw: createGateway(gateway, resolvedToken, logger), prevForGateway };
}

/** For Mistral the "image model" is the orchestrator LLM; otherwise keep the previous choice / default. */
function mistralAgentModelFor(gateway: GatewayId, imageModel: ModelInfo | null, existing: AppConfig | null): string {
  if (gateway === 'mistral' && imageModel) return imageModel.id;
  return existing?.mistralAgentModel ?? 'mistral-medium-latest';
}

function printSavedSummary(gateway: GatewayId, draft: AppConfig, issues: IssueLog): void {
  const { image, imageToVideo, textToVideo, backgroundRemoval: bg } = draft;
  const imageShape = image.defaultAspectRatio
    ? `  [${image.defaultAspectRatio}${image.defaultResolution ? ', ' + image.defaultResolution : ''}]`
    : '';
  // The real target: AIR_MCP_CONFIG may redirect it away from the project's config.json.
  log(`\n✅ Saved configuration to ${CONFIG_PATH}\n`);
  log(`Gateway:        ${GATEWAY_LABELS[gateway]}`);
  log(`Image model:    ${image.model ?? '(none)'}${imageShape}`);
  log(`Image→Video:    ${imageToVideo.enabled ? imageToVideo.model : 'disabled'}`);
  log(`Text→Video:     ${textToVideo.enabled ? textToVideo.model : 'disabled'}`);
  log(`Bg removal:     ${bg.model}${bg.model !== 'none' ? ` (${bg.executionProvider})` : ''}`);
  log(`Tinify:         ${draft.tinify ? 'enabled (PNG compression + WebP)' : 'disabled'}`);
  log(`Logging:        ${draft.logging.policy}`);
  if (issues.issues.length > 0) {
    log(`\n${issues.issues.length} issue(s) were recorded during configuration (visible via the health_status tool).`);
  }
}

/**
 * Next steps. For stdio (the usual case) the MCP client *spawns* the server
 * itself from the command you register — you don't run it by hand. Only HTTP
 * mode is something you start yourself.
 */
function printNextSteps(http: AppConfig['http']): void {
  const entry = fromRoot('dist/index.js').replace(/\\/g, '/');
  log('\nNext step — register this server with your MCP client. The client then');
  log('launches it for you over stdio (you do NOT run `npm start` yourself):');
  log('');
  log('  Claude Code:');
  log(`    claude mcp add ai-image-router -- node "${entry}"`);
  log('');
  log('  Claude Desktop (claude_desktop_config.json → "mcpServers"):');
  log(`    "ai-image-router": { "command": "node", "args": ["${entry}"] }`);
  log('');
  log('  (Run `npm run build` first if dist/ is missing or out of date.)');
  if (http.enabled) {
    log('');
    log('HTTP mode is the one mode you start yourself, then point the client at the URL:');
    log(`    npm start -- --http      # listens on http://${http.host}:${http.port}`);
  }
  log('');
}

async function main(): Promise<void> {
  assertInteractiveTty();
  log('\n=== ai-image-router-mcp configuration ===\n');

  const existing = await loadExistingConfig();
  const issues = new IssueLog();
  const { gateway, token, gw, prevForGateway } = await configureGateway(existing, issues);
  const image = await configureImage(gw, issues, prevForGateway?.image ?? null);
  const { imageToVideo, textToVideo } = await configureVideoTools(gw, gateway, issues, prevForGateway);
  const backgroundRemoval = await configureBackgroundRemoval(existing);
  const tinify = await configureTinify(existing);
  const { output, logging } = await configureOutput(existing);
  const http = await configureTransport(existing);

  const draft: AppConfig = {
    version: 1,
    gateway,
    token,
    mistralAgentModel: mistralAgentModelFor(gateway, image.model, existing),
    output,
    logging,
    http,
    image: image.config,
    imageToVideo,
    textToVideo,
    backgroundRemoval,
    tinify,
    diagnostics: {
      configuredAt: new Date().toISOString(),
      wizardVersion: WIZARD_VERSION,
      issues: issues.issues,
      sources: issues.sources,
    },
  };

  // Validate + save.
  const parsed = configSchema.safeParse(draft);
  if (!parsed.success) {
    throw new ConfigError(`Internal: produced an invalid config: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  await saveConfig(parsed.data);

  printSavedSummary(gateway, draft, issues);
  printNextSteps(http);
}

main().catch((err) => {
  process.stderr.write(`\nConfiguration failed: ${(err as Error).message}\n`);
  process.exit(1);
});
