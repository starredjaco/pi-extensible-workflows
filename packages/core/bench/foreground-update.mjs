// Bench for the foreground workflow update path: counts host->TUI updates, the
// bytes they carry, process I/O, and the per-frame cost of the progress block.
// Run with: node packages/core/bench/foreground-update.mjs
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workflowExtension, { formatWorkflowProgress, truncateWorkflowProgress } from "../dist/src/index.js";
import { testExtensionApi } from "../dist/test/support.js";
import { testTransport } from "../dist/test/test-transport.js";

const AGENTS = Number(process.env.BENCH_AGENTS ?? 4);
const TOOL_CALLS = Number(process.env.BENCH_TOOL_CALLS ?? 150);
const FRAMES = Number(process.env.BENCH_FRAMES ?? 2000);
const WIDTH = 120;

function procIo() {
  try {
    const entries = readFileSync("/proc/self/io", "utf8").split("\n");
    const value = (key) => Number(entries.find((line) => line.startsWith(`${key}:`))?.split(":")[1] ?? 0);
    return { rchar: value("rchar"), wchar: value("wchar"), syscr: value("syscr"), syscw: value("syscw") };
  } catch { return { rchar: 0, wchar: 0, syscr: 0, syscw: 0 }; }
}

function session(index) {
  let listener;
  const message = { role: "assistant", content: [{ type: "text", text: "done" }] };
  return {
    sessionId: `bench-${String(index)}`,
    messages: [message],
    getSessionStats: () => ({ tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, total: 30 }, cost: 0.01 }),
    subscribe(candidate) { listener = candidate; return () => { listener = undefined; }; },
    async prompt() {
      for (let call = 0; call < TOOL_CALLS; call += 1) {
        const toolCallId = `call-${String(index)}-${String(call)}`;
        listener?.({ type: "tool_execution_start", toolCallId, toolName: "read", args: {} });
        await Promise.resolve();
        listener?.({ type: "tool_execution_end", toolCallId, toolName: "read", isError: false });
        await Promise.resolve();
      }
      listener?.({ type: "message_end", message });
    },
    steer: async () => {},
    dispose() {},
  };
}

async function runWorkflow() {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-bench-"));
  const tools = [];
  let index = 0;
  workflowExtension(
    testExtensionApi({ registerTool(tool) { tools.push(tool); }, getActiveTools: () => ["workflow", "read"] }),
    home,
    undefined,
    testTransport(async () => session(index += 1)),
  );
  const workflow = tools.find(({ name }) => name === "workflow");
  const branches = Array.from({ length: AGENTS }, (_, agent) => `a${String(agent)}: () => agent("work ${String(agent)}", { tools: ["read"] })`).join(", ");
  let updates = 0;
  let contentBytes = 0;
  let lastRun;
  const io = procIo();
  const cpu = process.cpuUsage();
  const started = performance.now();
  await workflow.execute(
    "bench",
    { name: "bench", script: `return parallel("batch", { ${branches} });`, concurrency: AGENTS, foreground: true },
    new AbortController().signal,
    (update) => {
      updates += 1;
      contentBytes += update.content?.[0]?.text?.length ?? 0;
      lastRun = update.details?.run;
    },
    { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } },
  );
  const wallMs = performance.now() - started;
  const cpuUsed = process.cpuUsage(cpu);
  const ioUsed = procIo();
  return {
    updates,
    contentBytes,
    wallMs,
    cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
    reads: ioUsed.syscr - io.syscr,
    writes: ioUsed.syscw - io.syscw,
    readBytes: ioUsed.rchar - io.rchar,
    writeBytes: ioUsed.wchar - io.wchar,
    run: lastRun,
  };
}

function benchFrames(run) {
  const started = performance.now();
  for (let frame = 0; frame < FRAMES; frame += 1) {
    const spinner = ["◐", "◓", "◑", "◒"][frame % 4];
    truncateWorkflowProgress(formatWorkflowProgress(run, spinner, undefined, Date.now(), false, WIDTH, false), WIDTH);
  }
  return (performance.now() - started) / FRAMES;
}

const result = await runWorkflow();
const frameMs = result.run ? benchFrames(result.run) : 0;
console.log(JSON.stringify({
  config: { agents: AGENTS, toolCalls: TOOL_CALLS, frames: FRAMES },
  updates: result.updates,
  updateContentBytes: result.contentBytes,
  wallMs: Math.round(result.wallMs),
  cpuMs: Math.round(result.cpuMs),
  fsReadSyscalls: result.reads,
  fsWriteSyscalls: result.writes,
  fsReadBytes: result.readBytes,
  fsWriteBytes: result.writeBytes,
  progressFrameMs: Number(frameMs.toFixed(3)),
  spinnerFramesPerSecondCost: Number((frameMs * 12.5).toFixed(2)),
}, null, 2));
