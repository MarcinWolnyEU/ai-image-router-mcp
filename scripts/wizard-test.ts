/** Drive the wizard non-interactively via prompts.inject to validate its flow. */
import prompts from 'prompts';

// Injected runs have no TTY; skip the wizard's interactive-terminal guard.
process.env.AIR_WIZARD_SKIP_TTY_CHECK = '1';
// Write to a throwaway config so the harness never clobbers the real config.json.
process.env.AIR_MCP_CONFIG = 'config.wizard-test.json';

// Sequence matches the OpenRouter wizard path (see wizard.ts).
prompts.inject([
  'openrouter', // gateway
  'default', // token method (uses "openrouter token.txt")
  'google/gemini-2.5-flash-image', // image model
  '16:9', // aspect ratio
  '2K', // resolution
  false, // enable image-to-video?
  false, // enable text-to-video?
  'auto', // execution provider (asked first now)
  'birefnet-general', // background removal model
  false, // enable Tinify?
  'today', // logging policy
  'output', // output dir
  true, // inline preview?
  false, // http mode?
]);

await import('../src/config/wizard.js');
