/**
 * cascade-wide-ops.ts — CLI wrapper around src/bgremoval/cascade.ts. Rewrites an ONNX model so
 * wide Concat/Split become cascades of ≤8-wide ops, so it fits WebGPU's 16-binding limit (what
 * lets the BiRefNet family run on the WebGPU EP). The runtime calls the same `cascadeWideOps`
 * automatically on first WebGPU use; this CLI is for manual/offline conversion.
 *
 *   npx tsx scripts/cascade-wide-ops.ts <in.onnx> <out.onnx>
 *
 * ── SYMPTOMS THIS FIXES (running a stock BiRefNet/bria-rmbg .onnx on the WebGPU EP) ──────────────
 * onnxruntime-node throws at a decoder Split (or Concat) node, e.g.:
 *
 *     Non-zero status code returned while running Split node. Name:'/decoder/Split_33'
 *     Status Message: .../webgpu/shader_helper.cc:293 ...
 *     numbers_storage_buffers_ <= limits_.maxStorageBuffersPerShaderStage was false.
 *     Too many storage buffers in shader. Current: 17, Max is 16
 *
 * Why: each Concat/Split compiles to ONE compute shader that binds 1 buffer per input/output. The
 * BiRefNet decoder has Split nodes with 16–32 outputs and Concat nodes with up to 1024 inputs, so a
 * single shader needs 17–1025 storage buffers — far past `maxStorageBuffersPerShaderStage`. That
 * limit is a *binding count*, NOT VRAM and NOT an ORT cap: it's whatever the WebGPU adapter (Dawn)
 * reports. "Current: 17, Max is 16" ⇒ a Split with 16 outputs (16 + 1 data input). It fails with
 * tons of free VRAM — it is not memory pressure. (Tracked upstream: microsoft/onnxruntime#21968.)
 *
 * Can't I just raise the limit? Only up to the adapter's own max. The WebGPU spec floor is 8;
 * Chrome ≥146 and most desktop Dawn report 16; older Apple Silicon 10. You request more via
 * `adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: N } })` — but N may not
 * exceed `adapter.limits.maxStorageBuffersPerShaderStage`, and BiRefNet needs up to 1025 anyway. In
 * onnxruntime-NODE you can't even try: the native EP builds its own Dawn device, and the `device`
 * option that could carry raised limits is web-only. So 16 is a hard ceiling → graph surgery is the
 * fix (and ORT batches Concat upstream but not Split-with-many-outputs).
 *
 * Other symptoms of the same model that this does NOT fix (different root causes):
 *  • forceCpuNodeNames workaround: pin the Splits to CPU and the binding error clears, but you then
 *    hit `WebGPU validation failed. [Invalid Buffer] is invalid due to a previous error`, whose root
 *    (validationMode:'full') is `ID3D12Device::CreateCommittedResource ... CheckOutOfMemoryHRESULT`
 *    — a D3D12 buffer OOM caused by CPU-pinned splits thrashing giant tensors across the bus. Forcing
 *    more nodes just relocates the OOM. (Graph surgery keeps everything on-GPU, so it avoids this.)
 *  • DirectML EP: `Non-zero status code ... DmlFusedNode... 8007000E` (E_OUTOFMEMORY) on the
 *    deformable-conv ASPP node — a DML kernel bug, unrelated to binding count. Cascading does NOT
 *    help DML; for these models the only GPU path is WebGPU + the cascaded model.
 *
 * ── KEYWORDS (so this is findable when you hit the error) ────────────────────────────────────────
 * BiRefNet WebGPU not working · run BiRefNet in the browser / on GPU · BiRefNet onnxruntime-web ·
 * BiRefNet transformers.js WebGPU · BRIA RMBG-2.0 WebGPU · rembg WebGPU · IS-Net / isnet onnx ·
 * "Too many storage buffers in shader" · "Current: 17, Max is 16" · maxStorageBuffersPerShaderStage
 * exceeded · numbers_storage_buffers_ · shader_helper.cc:293 · Split / Concat too many inputs outputs ·
 * WebGPU storage buffer binding limit · increase maxStorageBuffersPerShaderStage · requiredLimits ·
 * Dawn adapter limits · onnx graph surgery / rewrite · decompose / cascade wide Concat Split ·
 * split large Concat operator onnx · "Invalid Buffer is invalid due to a previous error" ·
 * ID3D12Device::CreateCommittedResource out of memory · DmlFusedNode 8007000E E_OUTOFMEMORY ·
 * DirectML deformable conv (deform_conv2d) · onnxruntime background removal / image matting on GPU.
 *
 * ── REFERENCES ───────────────────────────────────────────────────────────────────────────────────
 *  • Upstream tracking issue:  https://github.com/microsoft/onnxruntime/issues/21968
 *  • ORT Concat-batching fix (#25390) / node WebGPU EP options incl. forceCpuNodeNames (#26099)
 *  • rembg model source:       https://github.com/danielgatis/rembg
 *  • Prior-art Concat splitter: https://gist.github.com/sevagh/23209e01b906bf25cccb4532fb3fd81f
 *  • WebGPU limit discussion:   https://github.com/gpuweb/gpuweb/issues/4235
 */
import { cascadeWideOps } from '../src/bgremoval/cascade.js';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) { console.error('usage: cascade-wide-ops.ts <in.onnx> <out.onnx>'); process.exit(2); }
const { nConcat, nSplit, nodes } = await cascadeWideOps(src, dst);
console.error(`[cascade] decomposed ${nConcat} Concat, ${nSplit} Split; nodes now ${nodes}; saved ${dst}`);
