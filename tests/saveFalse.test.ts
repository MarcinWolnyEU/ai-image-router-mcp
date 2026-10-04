/**
 * `save:false` means "write nothing" — for the two paths that ignored it: building an
 * `.ico` with `transform_media` (always wrote the icon) and `image_to_video`
 * `output_format:"gif"` (always wrote the GIF, plus `z-download-` copies of remote frames).
 * Real tools over an in-memory MCP transport; remote frames from a local node:http server.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readdirSync } from 'node:fs';
import sharp from 'sharp';
import { makeFakeGateway, startMcpHarness, textOf, type McpHarness } from './helpers/mcp.js';

let h: McpHarness;
let outDir: string;
let http: Server;
let base = '';
let red16: Buffer;
let blue16: Buffer;

const call = (name: string, args: Record<string, unknown>) => h.call(name, args);
const dataUrl = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`;

before(async () => {
  red16 = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ff0000' } }).png().toBuffer();
  blue16 = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#0000ff' } }).png().toBuffer();
  http = createServer((req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(req.url === '/blue.png' ? blue16 : red16));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const addr = http.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;

  h = await startMcpHarness({
    gateway: makeFakeGateway(),
    image: { model: 'x/y' },
    inlinePreview: true,
    previewMaxBytes: 1_000_000,
    clientName: 'save-false-test',
    tmpPrefix: 'air-nosave-',
  });
  outDir = h.outDir;
});

after(async () => {
  await new Promise<void>((r) => http.close(() => r()));
  await h.close();
});

describe('save:false writes nothing', () => {
  it('transform_media ico: the icon is built and previewed, but no file is written', async () => {
    const r = await call('transform_media', { image: [dataUrl(red16)], output_format: 'ico', save: false, inline_preview: true });
    assert.equal(r.isError, undefined, textOf(r));
    assert.deepEqual(readdirSync(outDir), [], 'nothing on disk');
    assert.match(textOf(r), /not saved \(save:false\)/);
    assert.equal(r.content.filter((c) => c.type === 'resource_link').length, 0);
    assert.equal(r.content.filter((c) => c.type === 'image').length, 1, 'inline preview of the largest entry');
  });

  it('image_to_video gif: the GIF is encoded and previewed, but neither it nor remote-frame copies are written', async () => {
    const r = await call('image_to_video', { output_format: 'gif', image: `${base}/red.png`, image_last: `${base}/blue.png`, save: false });
    assert.equal(r.isError, undefined, textOf(r));
    assert.deepEqual(readdirSync(outDir), [], 'no .gif and no z-download- copies');
    assert.match(textOf(r), /not saved \(save:false\)/);
    assert.equal(r.content.filter((c) => c.type === 'resource_link').length, 0);
    const preview = r.content.find((c) => c.type === 'image');
    assert.equal(preview?.mimeType, 'image/gif', 'the animation itself is returned inline');
  });

  it('image_to_video gif with save:true (default) still writes the GIF', async () => {
    const r = await call('image_to_video', { output_format: 'gif', image: dataUrl(red16), image_last: dataUrl(blue16) });
    assert.equal(r.isError, undefined, textOf(r));
    assert.equal(readdirSync(outDir).filter((f) => f.endsWith('.gif')).length, 1);
  });
});
