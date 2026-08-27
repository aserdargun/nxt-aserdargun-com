import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { withE2eStack } from "../scripts/e2e-stack.mjs";
import { inspectProcess } from "../scripts/stop-local-core.mjs";

const exists = (path) => access(path).then(() => true, () => false);

test("a failed test stops its writer before the next deterministic stack generation is seeded", async (context) => {
  const checkout = await mkdtemp(join(tmpdir(), "nxt-per-test-stack-"));
  const bin = await mkdtemp(join(tmpdir(), "nxt-per-test-bin-"));
  const fakePnpm = join(bin, "pnpm");
  const calls = join(bin, "calls.jsonl");
  const generation = join(bin, "generation");
  const writerReady = join(bin, "writer-ready");
  const writerExited = join(bin, "writer-exited");
  const writerPidPath = join(bin, "writer-pid");
  await writeFile(fakePnpm, [
    "#!/usr/bin/env node",
    'const { spawn } = require("node:child_process");',
    'const { appendFile, mkdir, readFile, rm, writeFile, access } = require("node:fs/promises");',
    'const { join } = require("node:path");',
    'const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
    'const waitFor = async (path) => { for (let i = 0; i < 400; i += 1) { try { await access(path); return; } catch {} await pause(5); } throw new Error(`Timed out waiting for ${path}`); };',
    '(async () => {',
    '  const command = process.argv[2];',
    '  await appendFile(process.env.NXT_TEST_CALLS, `${command}\\n`);',
    '  const local = join(process.cwd(), ".nxt-local");',
    '  const root = join(local, "fixtures", "playwright");',
    '  if (command === "dev:codex") {',
    '    let value = 0;',
    '    try { value = Number(await readFile(process.env.NXT_TEST_GENERATION, "utf8")); } catch {}',
    '    value += 1;',
    '    await writeFile(process.env.NXT_TEST_GENERATION, String(value));',
    '    await mkdir(root, { recursive: true });',
    '    await writeFile(join(root, "seed.txt"), `generation-${value}\\n`);',
    '    await rm(process.env.NXT_TEST_WRITER_READY, { force: true });',
    '    await rm(process.env.NXT_TEST_WRITER_EXITED, { force: true });',
    '    const source = `const { writeFileSync } = require("node:fs"); const { join } = require("node:path"); writeFileSync(process.env.NXT_TEST_WRITER_READY, "ready"); process.on("SIGTERM", () => { writeFileSync(join(process.env.NXT_TEST_FIXTURE_ROOT, "late-write.txt"), "old generation late write\\\\n"); writeFileSync(process.env.NXT_TEST_WRITER_EXITED, "exited"); process.exit(0); }); setInterval(() => {}, 1000);`;',
    '    const writer = spawn(process.execPath, ["-e", source], { cwd: process.cwd(), detached: true, stdio: "ignore", env: { ...process.env, NXT_TEST_FIXTURE_ROOT: root } });',
    '    writer.unref();',
    '    await writeFile(process.env.NXT_TEST_WRITER_PID, String(writer.pid));',
    '    await waitFor(process.env.NXT_TEST_WRITER_READY);',
    '  } else if (command === "stop:codex") {',
    '    const pid = Number(await readFile(process.env.NXT_TEST_WRITER_PID, "utf8"));',
    '    try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }',
    '    await waitFor(process.env.NXT_TEST_WRITER_EXITED);',
    '    await rm(local, { recursive: true });',
    '  } else process.exitCode = 2;',
    '})().catch((error) => { process.stderr.write(`${error.stack}\\n`); process.exitCode = 1; });'
  ].join("\n"), { mode: 0o700 });
  await chmod(fakePnpm, 0o700);

  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    NXT_TEST_CALLS: calls,
    NXT_TEST_GENERATION: generation,
    NXT_TEST_WRITER_READY: writerReady,
    NXT_TEST_WRITER_EXITED: writerExited,
    NXT_TEST_WRITER_PID: writerPidPath
  };
  context.after(async () => {
    const pid = Number(await readFile(writerPidPath, "utf8").catch(() => "0"));
    if ((await inspectProcess(pid)) !== null) {
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
    }
    await rm(checkout, { recursive: true, force: true });
    await rm(bin, { recursive: true, force: true });
  });

  const firstFailure = await withE2eStack({
    checkout,
    environment,
    use: async () => {
      assert.equal(await readFile(join(checkout, ".nxt-local", "fixtures", "playwright", "seed.txt"), "utf8"), "generation-1\n");
      throw new Error("intentional test failure");
    }
  }).then(() => undefined, (error) => error);
  if (firstFailure instanceof AggregateError) {
    throw new Error(firstFailure.errors.map((error) => `${error?.stack ?? String(error)}\nSTDERR: ${error?.stderr ?? "none"}\nCAUSE: ${error?.cause?.stack ?? error?.cause ?? "none"}`).join("\n--- teardown ---\n"));
  }
  assert.match(firstFailure?.message ?? "", /intentional test failure/u);
  assert.equal(await exists(join(checkout, ".nxt-local")), false, "failed test did not finish exact Stop");

  await withE2eStack({
    checkout,
    environment,
    use: async () => {
      const root = join(checkout, ".nxt-local", "fixtures", "playwright");
      assert.equal(await readFile(join(root, "seed.txt"), "utf8"), "generation-2\n");
      assert.equal(await exists(join(root, "late-write.txt")), false, "old server write crossed into the fresh generation");
    }
  });
  assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), ["dev:codex", "stop:codex", "dev:codex", "stop:codex"]);
  assert.equal(await exists(join(checkout, ".nxt-local")), false);
});
