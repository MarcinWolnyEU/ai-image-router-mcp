/**
 * cascade-wide-ops — rewrite an ONNX model so any Concat with too many inputs, or Split with too
 * many outputs, becomes a *cascade* of narrower (≤CHUNK-wide) ops. This keeps every shader's
 * storage-buffer bindings under WebGPU's `maxStorageBuffersPerShaderStage` limit (16 on most
 * adapters), which is what otherwise stops the BiRefNet family (incl. bria-rmbg) from running on
 * the WebGPU EP. Keeping the ops on-GPU (vs forcing splits to CPU) also avoids the D3D12 OOM.
 *
 * Used both by the runtime (auto-convert on first WebGPU use) and the `scripts/cascade-wide-ops.ts`
 * CLI. Pure JS via onnx-proto (protobufjs). Decoding a ~1 GB model fits the default Node heap
 * (weights are off-heap typed arrays); no raised --max-old-space-size is required.
 */
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import onnxProto from 'onnx-proto'; // CJS module — default import (named export isn't ESM-detectable)

const onnx = onnxProto.onnx;
type INodeProto = onnxProto.onnx.INodeProto;
type IAttributeProto = onnxProto.onnx.IAttributeProto;
type ITensorProto = onnxProto.onnx.ITensorProto;

const DEFAULT_CHUNK = 8; // max inputs/outputs per op (+1 data buffer ⇒ ≤9 ≤ 16)
const INT64 = onnx.TensorProto.DataType.INT64;
const ATTR_INT = onnx.AttributeProto.AttributeType.INT;

const toNum = (v: unknown): number =>
  v == null ? 0 : typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : (v as { toNumber(): number }).toNumber();

function* chunks<T>(arr: T[], n: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n);
}

function axisOf(node: INodeProto): number {
  const a = (node.attribute ?? []).find((x) => x.name === 'axis');
  return a ? toNum(a.i) : 0;
}

function axisAttr(axis: number): IAttributeProto {
  return { name: 'axis', type: ATTR_INT, i: axis };
}

/** int64 1-D initializer encoded as little-endian raw_data (avoids Long handling on write). */
function int64Initializer(name: string, values: number[]): ITensorProto {
  const raw = Buffer.allocUnsafe(values.length * 8);
  values.forEach((v, i) => raw.writeBigInt64LE(BigInt(v), i * 8));
  return { name, dataType: INT64, dims: [values.length], rawData: raw };
}

/** Read an int64 1-D tensor (split sizes), from int64Data or little-endian rawData. */
function readInt64Tensor(t: ITensorProto): number[] {
  if (t.int64Data && t.int64Data.length) return t.int64Data.map(toNum);
  if (t.rawData && t.rawData.length) {
    const b = Buffer.from(t.rawData);
    const out: number[] = [];
    for (let i = 0; i + 8 <= b.length; i += 8) out.push(Number(b.readBigInt64LE(i)));
    return out;
  }
  return [];
}

function decomposeConcat(node: INodeProto, axis: number, out: INodeProto[], chunk: number, uid: { n: number }): void {
  let inputs = [...(node.input ?? [])];
  let level = 0;
  while (inputs.length > chunk) {
    const next: string[] = [];
    for (const grp of chunks(inputs, chunk)) {
      if (grp.length === 1) { next.push(grp[0]!); continue; }
      const name = `${node.name}_cc${level}_${uid.n++}`;
      out.push({ opType: 'Concat', input: grp, output: [name], name, attribute: [axisAttr(axis)] });
      next.push(name);
    }
    inputs = next;
    level++;
  }
  out.push({ opType: 'Concat', input: inputs, output: [node.output![0]!], name: `${node.name}_ccfinal`, attribute: [axisAttr(axis)] });
}

function decomposeSplit(
  node: INodeProto, axis: number, sizes: number[],
  out: INodeProto[], inits: ITensorProto[], chunk: number, uid: { n: number },
): void {
  const outputs = node.output ?? [];
  const dataIn = node.input![0]!;
  const pairs = outputs.map((o, i) => ({ o, s: sizes[i]! }));
  const groups = [...chunks(pairs, chunk)];
  if (groups.length > chunk) throw new Error(`${node.name}: ${groups.length} groups needs recursion (raise CHUNK)`);

  const mkSplit = (inp: string, outs: string[], szs: number[], tag: string) => {
    const szName = `${node.name}_sz_${tag}_${uid.n++}`;
    inits.push(int64Initializer(szName, szs));
    out.push({ opType: 'Split', input: [inp, szName], output: outs, name: `${node.name}_sp_${tag}_${uid.n++}`, attribute: [axisAttr(axis)] });
  };

  if (groups.length === 1) { mkSplit(dataIn, outputs as string[], sizes, 'L1'); return; }
  const groupTensors = groups.map((_, gi) => `${node.name}_grp${gi}_${uid.n++}`);
  const groupSizes = groups.map((grp) => grp.reduce((a, p) => a + p.s, 0));
  mkSplit(dataIn, groupTensors, groupSizes, 'L1'); // level 1: data → groups
  groups.forEach((grp, gi) => mkSplit(groupTensors[gi]!, grp.map((p) => p.o), grp.map((p) => p.s), `L2g${gi}`)); // level 2
}

/** Constant-node outputs by name (a Split's size tensor may come from one). */
function constantTensors(graph: onnxProto.onnx.IGraphProto): Map<string, ITensorProto> {
  const out = new Map<string, ITensorProto>();
  for (const n of graph.node ?? []) {
    if (n.opType !== 'Constant') continue;
    const v = (n.attribute ?? []).find((a) => a.name === 'value')?.t;
    if (v && n.output?.[0]) out.set(n.output[0], v);
  }
  return out;
}

function initializersByName(graph: onnxProto.onnx.IGraphProto): Map<string, ITensorProto> {
  const out = new Map<string, ITensorProto>();
  for (const t of graph.initializer ?? []) if (t.name) out.set(t.name, t);
  return out;
}

/** Look up a Split node's size tensor — a Constant-node output or a graph initializer. */
function splitSizeResolver(graph: onnxProto.onnx.IGraphProto): (node: INodeProto) => number[] {
  const constants = constantTensors(graph);
  const inits = initializersByName(graph);
  return (n) => {
    const nm = n.input?.[1];
    const t = nm ? (constants.get(nm) ?? inits.get(nm)) : undefined;
    return t ? readInt64Tensor(t) : [];
  };
}

const isWideConcat = (n: INodeProto, chunk: number): boolean => n.opType === 'Concat' && (n.input?.length ?? 0) > chunk;
const isWideSplit = (n: INodeProto, chunk: number): boolean => n.opType === 'Split' && (n.output?.length ?? 0) > chunk;

/** Rewrite every Concat/Split wider than `chunk` into a cascade; other nodes pass through unchanged. */
function cascadeNodes(nodes: INodeProto[], sizesOf: (node: INodeProto) => number[], chunk: number) {
  const newNodes: INodeProto[] = [];
  const newInits: ITensorProto[] = [];
  const uid = { n: 0 };
  let nConcat = 0;
  let nSplit = 0;
  for (const node of nodes) {
    if (isWideConcat(node, chunk)) {
      decomposeConcat(node, axisOf(node), newNodes, chunk, uid);
      nConcat++;
    } else if (isWideSplit(node, chunk)) {
      const sizes = sizesOf(node);
      if (sizes.length !== node.output!.length) throw new Error(`${node.name}: split sizes (${sizes.length}) != outputs (${node.output!.length})`);
      decomposeSplit(node, axisOf(node), sizes, newNodes, newInits, chunk, uid);
      nSplit++;
    } else {
      newNodes.push(node);
    }
  }
  return { newNodes, newInits, nConcat, nSplit };
}

/**
 * Write to a sibling temp file and rename it into place: the runtime reuses `dst` forever
 * once it exists, so an interrupted write (crash, kill, full disk) must never leave a
 * truncated model under the final name.
 */
async function writeModelAtomically(model: onnxProto.onnx.IModelProto, dst: string): Promise<void> {
  const tmp = `${dst}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, onnx.ModelProto.encode(model).finish());
    await rename(tmp, dst);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Rewrite `src` → `dst`, cascading every Concat/Split wider than `chunk`. Returns counts.
 * Original output names are preserved, so downstream consumers are unaffected.
 */
export async function cascadeWideOps(src: string, dst: string, chunk = DEFAULT_CHUNK): Promise<{ nConcat: number; nSplit: number; nodes: number }> {
  const model = onnx.ModelProto.decode(await readFile(src));
  const g = model.graph!;
  const { newNodes, newInits, nConcat, nSplit } = cascadeNodes(g.node ?? [], splitSizeResolver(g), chunk);
  g.node = newNodes;
  g.initializer = [...(g.initializer ?? []), ...newInits];
  await writeModelAtomically(model, dst);
  return { nConcat, nSplit, nodes: newNodes.length };
}
