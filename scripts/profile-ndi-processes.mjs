// Opt-in macOS diagnostics for explicitly selected, already-running processes.
// Never starts/stops media, opens a source, or claims a soak passed from RSS alone.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
export function parseProcess(line) {
  const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/);
  if (!match) throw new Error("Unrecognized ps output; refusing to guess process identity");
  return { pid: Number(match[1]), rssMiB: Number(match[2]) / 1024,
    cpuPercent: Number(match[3]), started: match[4].replace(/\s+/g, " "), command: match[5] };
}
export function parseFootprint(output) {
  const match = output.match(/^Physical footprint:\s+([\d.]+)([KMGT]?)\s*$/m);
  if (!match) throw new Error("Physical footprint unavailable");
  return Number(match[1]) * ({ "": 1 / 1048576, K: 1 / 1024, M: 1, G: 1024, T: 1048576 }[match[2]]);
}
export function summarize(samples, pid, warmupSeconds = 300) {
  const values = samples.filter(s => s.elapsedSeconds >= warmupSeconds)
    .flatMap(s => s.processes.filter(p => p.pid === pid).map(p => ({ ...p, seconds: s.elapsedSeconds })));
  if (!values.length) return { pid, afterWarmup: 0 };
  const trend = field => {
    const points = values.filter(p => Number.isFinite(p[field]));
    if (!points.length) return null;
    const first = points[0], last = points.at(-1);
    return { samples: points.length, firstMiB: first[field], lastMiB: last[field],
      minMiB: Math.min(...points.map(p => p[field])), maxMiB: Math.max(...points.map(p => p[field])),
      endpointMiBPerMinute: last.seconds > first.seconds
        ? (last[field] - first[field]) / ((last.seconds - first.seconds) / 60) : null };
  };
  return { pid, afterWarmup: values.length, rss: trend("rssMiB"), physicalFootprint: trend("physicalFootprintMiB") };
}

async function processSnapshot(pids) {
  const { stdout } = await exec("/bin/ps", ["-p", pids.join(","), "-o", "pid=,rss=,%cpu=,lstart=,args="],
    { timeout: 5000, maxBuffer: 128 * 1024 });
  const found = stdout.trim().split("\n").filter(Boolean).map(parseProcess);
  if (pids.some(pid => !found.some(p => p.pid === pid))) throw new Error("A selected process exited; this run is incomplete");
  return found;
}

async function main() {
  if (process.platform !== "darwin") throw new Error("This profiler requires macOS ps/vmmap");
  const [durationArg, mode, ...pidArgs] = process.argv.slice(2);
  const seconds = Number(durationArg), pids = pidArgs.map(Number);
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 7200 || !mode ||
      !pids.length || pids.length > 8 || pids.some(pid => !Number.isInteger(pid) || pid < 2) || new Set(pids).size !== pids.length) {
    throw new Error("Usage: node scripts/profile-ndi-processes.mjs <10..7200 seconds> <scenario-label> <pid> [pid...]");
  }
  const baseline = await processSnapshot(pids);
  const directory = await mkdtemp(path.join(tmpdir(), "sauce-ndi-profile-"));
  const output = await open(path.join(directory, "samples.jsonl"), "wx");
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => controller.abort());
  const startedAt = Date.now(), samples = [];
  let status = "completed", error = null, nextFootprint = 0;
  console.log(JSON.stringify({ directory, startedAt: new Date(startedAt).toISOString(), durationSeconds: seconds,
    scenario: mode, processes: baseline, note: "Read-only process measurement. Media state and acceptance require separate verification." }));
  try {
    while (!controller.signal.aborted) {
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      const processes = await processSnapshot(pids);
      for (const current of processes) {
        const expected = baseline.find(p => p.pid === current.pid);
        if (current.started !== expected.started || current.command !== expected.command)
          throw new Error("Process identity changed; refusing to combine separate runs");
      }
      const footprintDue = elapsedSeconds >= nextFootprint || elapsedSeconds >= seconds;
      if (footprintDue) {
        await Promise.all(processes.map(async current => {
          try {
            const { stdout } = await exec("/usr/bin/vmmap", ["-summary", String(current.pid)], { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
            current.physicalFootprintMiB = parseFootprint(stdout);
          } catch (error) { current.footprintError = error.message; }
        }));
        nextFootprint = elapsedSeconds + 300;
      }
      const sample = { elapsedSeconds, at: new Date().toISOString(), processes };
      samples.push(sample); await output.write(JSON.stringify(sample) + "\n");
      if (footprintDue) console.log(JSON.stringify(sample));
      if (elapsedSeconds >= seconds) break;
      await delay(Math.min(20000, Math.max(1, seconds * 1000 - (Date.now() - startedAt))), undefined, { signal: controller.signal });
    }
    if (controller.signal.aborted) status = "interrupted";
  } catch (cause) {
    status = controller.signal.aborted ? "interrupted" : "incomplete"; error = cause.message;
  } finally { await output.close(); }
  const largestSampleGapSeconds = samples.reduce((gap, sample, i) => i
    ? Math.max(gap, sample.elapsedSeconds - samples[i - 1].elapsedSeconds) : gap, 0);
  const summary = { status, error, scenario: mode, durationSeconds: (Date.now() - startedAt) / 1000,
    requestedSeconds: seconds, largestSampleGapSeconds, warmupSeconds: 300,
    measuredProcesses: pids.map(pid => summarize(samples, pid)),
    limitations: ["RSS is affected by paging and diagnostic access; physical footprint is sampled separately.",
      "Other media/GPU services are not included unless explicitly selected.",
      "A completed measurement is not an acceptance verdict. Verify live media, workload, gaps, and memory trend."] };
  await writeFile(path.join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ directory, ...summary }));
  if (status !== "completed") process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
