#!/usr/bin/env -S tsx
/**
 * Render fixed views of every build in a judge-data snapshot with the Arena viewer.
 *
 * Each build goes through the same preparation the Arena serves as its full variant,
 * then the local-only /dev/judge-render page captures eight views around it (every 45
 * degrees from a fixed camera height, starting from the Arena's opening angle) and one
 * from above. Each view is fit to the build as seen from that angle, so a still frame
 * isn't padded for the whole spin. Starts its own next dev server and drives the
 * installed Chrome headlessly.
 * Re-running skips builds whose images already exist and refuses a changed view protocol;
 * index.jsonl records the commit each build was rendered at.
 *
 * Usage:
 *   pnpm judge:render --snapshot judge-data/2026-10-07
 *   pnpm judge:render --snapshot judge-data/2026-10-07 --ids <buildId>,<buildId>
 */

import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { chromium } from "playwright-core";
import { prepareArenaBuild } from "../lib/arena/buildArtifacts";
import {
  createSnapshotArtifactPayload,
  encodeBinarySnapshotArtifactPayload,
} from "../lib/arena/buildSnapshotArtifacts";
import { LOCAL_BUILD_STORAGE_BUCKET } from "../lib/storage/config";

const PORT = 3217;
const SIZE = 512; // css px, the export renderer doubles it to 1024
// light theme --viewer-bg from app/globals.css
const BACKGROUND = "hsl(220 20% 97%)";
// one camera height for every build instead of the arena's height-dependent angle
const RING_ELEVATION = (30 * Math.PI) / 180;
const VIEWS: { name: string; rotationY: number; elevation?: number }[] = [
  ...Array.from({ length: 8 }, (_, k) => ({
    name: `r${String(k * 45).padStart(3, "0")}`,
    rotationY: (k * Math.PI) / 4,
    elevation: RING_ELEVATION,
  })),
  // turned 45 degrees so the top view sits square instead of as a diamond
  { name: "top", rotationY: Math.PI / 4, elevation: (85 * Math.PI) / 180 },
  // eye level, looking straight at each side (the ring starts on a corner)
  ...Array.from({ length: 4 }, (_, k) => ({
    name: `e${String(45 + k * 90).padStart(3, "0")}`,
    rotationY: Math.PI / 4 + (k * Math.PI) / 2,
    elevation: 0,
  })),
];
const BUILD_TIMEOUT_MS = 10 * 60_000;

type SnapshotBuild = {
  id: string;
  gridSize: number;
  palette: string;
  blockCount: number;
  payloadFile: string | null;
  payloadBytes: number | null;
};

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? (process.argv[idx + 1] ?? null) : null;
}

async function waitForServer(url: string, server: ReturnType<typeof spawn>) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`next dev exited with code ${server.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms);
  });
  // a pending timer keeps the settled race, and its images, alive until it fires
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function main() {
  const snapshot = argValue("--snapshot");
  if (!snapshot) throw new Error("Pass --snapshot judge-data/<date>");
  const snapshotDir = path.resolve(snapshot);
  const repoRoot = process.cwd();
  const outDir = path.join(snapshotDir, "renders");
  fs.mkdirSync(outDir, { recursive: true });

  const ids = argValue("--ids")?.split(",").filter(Boolean) ?? null;
  const builds = fs
    .readFileSync(path.join(snapshotDir, "builds.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SnapshotBuild)
    .filter((build) => !ids || ids.includes(build.id));
  const missingViews = (id: string) => VIEWS.filter((view) => !fs.existsSync(path.join(outDir, id, `${view.name}.png`)));
  const isDone = (id: string) => missingViews(id).length === 0;
  const todo = builds.filter((build) => build.payloadFile && !isDone(build.id));
  console.log(`${builds.length} builds, ${builds.length - todo.length} already rendered or without payload`);

  const commit = execSync("git rev-parse HEAD").toString().trim();
  const protocol = { sizePx: SIZE * 2, framing: "each view fit to the build", background: BACKGROUND, views: VIEWS };
  const manifestPath = path.join(outDir, "views.json");
  // skipped images were made under the recorded protocol, so a different one must not share the directory;
  // views appended after the recorded ones are fine, since existing images stay as they are
  if (fs.existsSync(manifestPath)) {
    const existing = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    const recordedViews = existing.views ?? [];
    const sameBase = JSON.stringify({ ...existing, gitCommit: undefined, views: undefined }) === JSON.stringify({ ...protocol, views: undefined });
    if (!sameBase || JSON.stringify(recordedViews) !== JSON.stringify(VIEWS.slice(0, recordedViews.length))) {
      throw new Error(`${outDir} was rendered with a different view protocol; move it aside to render again`);
    }
    if (recordedViews.length < VIEWS.length) {
      fs.writeFileSync(manifestPath, `${JSON.stringify({ ...existing, views: VIEWS, viewsAddedAt: { [commit]: VIEWS.slice(recordedViews.length).map((v) => v.name) } }, null, 2)}\n`);
    }
  } else {
    fs.writeFileSync(manifestPath, `${JSON.stringify({ gitCommit: commit, ...protocol }, null, 2)}\n`);
  }
  if (todo.length === 0) return;

  // a server left behind by a crashed run would answer instead of this one
  const portInUse = await fetch(`http://localhost:${PORT}/`).then(() => true, () => false);
  if (portInUse) throw new Error(`Port ${PORT} is already serving; stop the leftover server (lsof -iTCP:${PORT}) and re-run`);

  // own process group so stopping it also stops the workers next dev starts
  const server = spawn("pnpm", ["exec", "next", "dev", "-p", String(PORT)], { stdio: "ignore", detached: true });
  const stopServer = () => {
    if (server.exitCode === null && server.pid) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  };
  process.on("exit", stopServer);

  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const harnessUrl = `http://localhost:${PORT}/dev/judge-render`;
    await waitForServer(harnessUrl, server);
    const page = await browser.newPage({ colorScheme: "light" });
    const bodies = new Map<string, Uint8Array>();
    await page.route("**/__judge/build/*", async (route) => {
      const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
      const body = bodies.get(id);
      if (!body) return route.fulfill({ status: 404 });
      await route.fulfill({ status: 200, contentType: "application/octet-stream", body: Buffer.from(body) });
    });
    await page.goto(harnessUrl);
    await page.waitForFunction(() => typeof window.judgeRender === "function", undefined, { timeout: 300_000 });

    // the arena's own preparation, reading the snapshot file through the local storage bucket
    const prepare = async (build: SnapshotBuild) => {
      const prepared = await prepareArenaBuild({
        id: build.id,
        gridSize: build.gridSize,
        palette: build.palette,
        blockCount: build.blockCount,
        voxelByteSize: build.payloadBytes,
        voxelCompressedByteSize: null,
        // each build renders once, so no stored checksum keeps it out of the arena's in-memory cache
        voxelSha256: null,
        voxelData: null,
        voxelStorageBucket: LOCAL_BUILD_STORAGE_BUCKET,
        voxelStoragePath: path.relative(repoRoot, path.join(snapshotDir, build.payloadFile!)),
        voxelStorageEncoding: "gzip",
      });
      return encodeBinarySnapshotArtifactPayload(createSnapshotArtifactPayload(prepared, "full"));
    };

    const index = fs.openSync(path.join(outDir, "index.jsonl"), "a");
    let failures = 0;
    let next = todo.length ? prepare(todo[0]) : null;
    for (const [i, build] of todo.entries()) {
      const started = Date.now();
      const current = next!;
      // Node prepares the next build while the browser renders this one
      next = i + 1 < todo.length ? prepare(todo[i + 1]) : null;
      next?.catch(() => undefined);
      try {
        bodies.set(build.id, await current);
        const missing = missingViews(build.id);
        const images = await withTimeout(
          page.evaluate(
            (job) => window.judgeRender!(job),
            {
              buildId: build.id,
              palette: build.palette === "advanced" ? "advanced" : "simple",
              views: missing.map(({ rotationY, elevation }) => ({ rotationY, elevation })),
              size: SIZE,
              background: BACKGROUND,
            } as const,
          ),
          BUILD_TIMEOUT_MS,
        );
        const buildDir = path.join(outDir, build.id);
        fs.mkdirSync(buildDir, { recursive: true });
        images.forEach((dataUrl, v) => {
          fs.writeFileSync(path.join(buildDir, `${missing[v].name}.png`), Buffer.from(dataUrl.split(",")[1], "base64"));
        });
        fs.writeSync(index, `${JSON.stringify({ id: build.id, ok: true, ms: Date.now() - started, commit })}\n`);
      } catch (err) {
        failures += 1;
        const error = err instanceof Error ? err.message : String(err);
        fs.writeSync(index, `${JSON.stringify({ id: build.id, ok: false, ms: Date.now() - started, commit, error })}\n`);
        console.error(`failed ${build.id}: ${error}`);
        // a timed out render can leave the harness mid-job
        await page.reload();
        await page.waitForFunction(() => typeof window.judgeRender === "function");
      } finally {
        bodies.delete(build.id);
      }
      console.log(`rendered ${i + 1}/${todo.length} (${Date.now() - started} ms)`);
    }
    fs.closeSync(index);
    console.log(`done, ${failures} failed`);
    if (failures) process.exitCode = 1;
  } finally {
    await browser.close();
    stopServer();
  }
}

// arena build caches hold open handles, so exit explicitly once rendering is done
main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
