import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runtime } from './state/runtime.js';
import { instrumentToolLogging } from './logging/toolLogging.js';
import { registerGenerateImage } from './tools/generateImage.js';
import { registerImageToVideo } from './tools/imageToVideo.js';
import { registerGenerateVideo } from './tools/generateVideo.js';
import { registerRemoveBackground } from './tools/removeBackground.js';
import { registerMediaEditTools } from './tools/mediaEdit.js';
import { registerBuildIconSet } from './tools/iconSet.js';
import { registerLifecycleTools } from './tools/lifecycle.js';
import { refreshOnReload } from './tools/reloadable.js';

export const SERVER_NAME = 'ai-image-router-mcp';
export const SERVER_VERSION = '0.1.0';

/**
 * Build a fully-wired MCP server. A fresh instance is created per stdio process
 * and per HTTP session.
 *
 * Gated tools are always registered but only ENABLED (listed) when they apply:
 * `generate_video` when the active gateway supports text-to-video (so e.g. Mistral
 * never advertises one), `remove_background` when a model is configured. Both are
 * re-evaluated after a `restart` (and the client is sent `tools/list_changed`), as are
 * the config-derived schemas of generate_image / image_to_video. Whether a tool is
 * actually *configured* is still checked at call time.
 *
 * `image_to_video` is ALWAYS enabled: its `output_format:"gif"` mode assembles
 * frames into an animated GIF locally (no gateway), so it must work even when the
 * gateway has no image-to-video support; the mp4 mode checks capability at call time.
 *
 * Listed: generate_image, image_to_video, crop_media, transform_media, build_icon_set, health_status,
 * restart, shutdown (always); generate_video (if the gateway supports text-to-video); remove_background
 * (if a model is configured).
 */
export function buildServer(): McpServer {
  // A reload updates several tools in one tick; coalesce their list_changed into ONE notification.
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { debouncedNotificationMethods: ['notifications/tools/list_changed'] });
  instrumentToolLogging(server); // wrap registerTool: log every request/response (must precede registrations)
  registerGenerateImage(server);
  registerImageToVideo(server);
  registerGated(server, registerGenerateVideo(server), () => runtime.gateway.capabilities.textToVideo);
  registerGated(server, registerRemoveBackground(server), () => runtime.config.backgroundRemoval.model !== 'none');
  registerMediaEditTools(server);
  registerBuildIconSet(server);
  registerLifecycleTools(server);
  return server;
}

/** Show `tool` only while `applies()` holds — now, and again after every successful reload. */
function registerGated(server: McpServer, tool: RegisteredTool, applies: () => boolean): void {
  if (!applies()) tool.disable();
  refreshOnReload(server, tool, () => ({ enabled: applies() }));
}
