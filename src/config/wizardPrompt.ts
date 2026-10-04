/**
 * Shared plumbing for the configuration wizard (`wizard.ts` and the `wizard*.ts`
 * step modules): stdout logging, the cancel-aware `ask`, the issue log that ends
 * up in `config.diagnostics`, and the token-source prompt used for every secret.
 */
import prompts from 'prompts';
import type { Diagnostics, TokenSource } from './schema.js';
import type { ListModelsResult } from '../gateways/types.js';

export function log(msg = ''): void {
  process.stdout.write(msg + '\n');
}

const onCancel = (): never => {
  log('\nConfiguration cancelled. No changes were written.');
  process.exit(1);
};

export async function ask<T extends string>(question: prompts.PromptObject<T>): Promise<prompts.Answers<T>> {
  return prompts(question, { onCancel });
}

/** Issues collected while pulling data — stored in config.diagnostics. */
export class IssueLog {
  issues: Diagnostics['issues'] = [];
  sources: Diagnostics['sources'] = {};
  add(severity: 'error' | 'warning', area: string, message: string): void {
    this.issues.push({ severity, area, message });
    log(`  ${severity === 'error' ? '⚠️ ' : 'ℹ️ '} ${message}`);
  }
  recordSource(tool: string, r: ListModelsResult): void {
    this.sources[tool] = { listed: r.models.length > 0, source: r.source, count: r.models.length };
    for (const w of r.warnings) this.add('warning', tool, w);
    // Informational by design (e.g. "fal has no model-list API") — shown, never recorded as an
    // issue, so health_status does not report "Configuration-time issues" for a healthy setup.
    for (const n of r.notes ?? []) log(`  ℹ️  ${n}`);
  }
}

/** Index of a choice by `value`, clamped to a valid range (falls back to 0). */
export function choiceIndex(values: readonly string[], want: string | null | undefined): number {
  if (!want) return 0;
  return Math.max(0, values.indexOf(want));
}

/** Which token-source method a previously-saved source corresponds to. */
function tokenMethod(prev: TokenSource | null, defaultFile: string, defaultExists: boolean): string | null {
  if (!prev) return null;
  if (prev.type === 'file') return prev.value === defaultFile && defaultExists ? 'default' : 'file';
  return prev.type; // 'inline' | 'env'
}

/** The wording that differs between the gateway-token and Tinify-token prompts. */
export interface TokenPromptSpec {
  /** Project-root file offered as the first choice when it exists. */
  defaultFile: string;
  defaultExists: boolean;
  methodMessage: string;
  defaultTitle: string;
  pasteTitle: string;
  pathMessage: string;
  pastePrompt: string;
}

/** Ask where a secret lives (default file / other file / pasted / env var) and build the TokenSource. */
export async function askTokenSource(spec: TokenPromptSpec, prev: TokenSource | null): Promise<TokenSource> {
  const { defaultFile, defaultExists } = spec;
  const choices = [
    ...(defaultExists ? [{ title: spec.defaultTitle, value: 'default' }] : []),
    { title: 'A different token file', value: 'file' },
    { title: spec.pasteTitle, value: 'inline' },
    { title: 'An environment variable', value: 'env' },
  ];
  const { method } = await ask<'method'>({
    type: 'select',
    name: 'method',
    message: spec.methodMessage,
    choices,
    initial: choiceIndex(choices.map((c) => c.value), tokenMethod(prev, defaultFile, defaultExists)),
  });
  if (method === 'default') return { type: 'file', value: defaultFile };
  if (method === 'file') {
    const initialPath = prev?.type === 'file' ? prev.value : defaultFile;
    const { path } = await ask<'path'>({ type: 'text', name: 'path', message: spec.pathMessage, initial: initialPath });
    return { type: 'file', value: path };
  }
  if (method === 'env') {
    const { name } = await ask<'name'>({ type: 'text', name: 'name', message: 'Environment variable name:', initial: prev?.type === 'env' ? prev.value : '' });
    return { type: 'env', value: name };
  }
  // Never pre-fill the secret itself into a password field.
  const { token } = await ask<'token'>({ type: 'password', name: 'token', message: spec.pastePrompt });
  return { type: 'inline', value: token };
}
