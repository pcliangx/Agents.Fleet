import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CommandEnvelope,
  type CommandKind,
  PLATFORM_MATRIX_VERSION,
  RUNTIME_LIMIT_PROFILE_VERSION,
  type SessionDeltaBatch,
} from "@agents-fleet/contracts";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { KeychainCapabilityProofVerifier } from "../../../../packages/daemon/src/auth/keychain-capability-proof-verifier.js";
import type { CommandRouter } from "../../../../packages/daemon/src/control-dispatcher.js";
import { type StartedServer, startServer } from "../../../../packages/daemon/src/server.js";

// RT-T-01 / RT-T-02 — real Electron lifecycle evidence. The fixture uses the
// production preload, Desktop Bridge IPC binding, Main daemon client and both
// authenticated Unix-socket transports. Renderer reload/reopen creates a new
// Attachment while the daemon fixture-owned Agent process identity stays alive.

const itMacArm64 = process.platform === "darwin" && process.arch === "arm64" ? it : it.skip;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const token = new TextEncoder().encode("r1-08-desktop-lifecycle-e2e");

interface FixtureResult {
  readonly probes: readonly {
    readonly attachmentId: string;
    readonly agentPid: number;
    readonly inputOk: boolean;
    readonly frame: readonly number[];
  }[];
}

class LifecycleRouter implements CommandRouter {
  readonly activeAttachments = new Set<string>();
  readonly closedAttachments: string[] = [];
  inputCount = 0;
  #nextAttachment = 1;

  constructor(readonly agentPid: number) {}

  handles(kind: string): boolean {
    return [
      "Attach",
      "AcquireControl",
      "RenewControl",
      "WriteSessionInput",
      "CloseAttachment",
    ].includes(kind);
  }

  async execute(kind: CommandKind, envelope: CommandEnvelope): Promise<unknown> {
    if (kind === "Attach") {
      const sessionId = (envelope.payload as { readonly sessionId?: unknown }).sessionId;
      if (sessionId !== "se_e2e") throw new Error("unexpected Session identity");
      const attachmentId = `att_e2e_${this.#nextAttachment++}`;
      this.activeAttachments.add(attachmentId);
      return {
        attachmentId,
        mode: "Live",
        sessionId,
        generation: 1,
        snapshot: { coversThroughSeq: 0, bytes: [] },
      };
    }
    const attachmentId = envelope.attachmentId;
    if (typeof attachmentId !== "string" || !this.activeAttachments.has(attachmentId)) {
      throw new Error("Attachment is not active");
    }
    if (kind === "AcquireControl" || kind === "RenewControl") {
      return {
        sessionId: "se_e2e",
        generation: 1,
        attachmentId,
        fencingToken: 1,
        expiresAt: Date.now() + 60_000,
      };
    }
    if (kind === "WriteSessionInput") {
      this.inputCount += 1;
      return {
        inputIntentId: `ii_${this.inputCount}`,
        sessionId: "se_e2e",
        generation: 1,
        attachmentId,
        fencingToken: 1,
        source: "Keyboard",
        status: "Dispatched",
        dataGap: false,
        agentPid: this.agentPid,
      };
    }
    if (kind === "CloseAttachment") {
      this.#close(attachmentId);
      return { closed: true };
    }
    throw new Error(`unexpected command: ${kind}`);
  }

  onControlConnectionClosed(attachmentIds: readonly string[]): void {
    for (const attachmentId of attachmentIds) this.#close(attachmentId);
  }

  readSessionDelta(attachmentId: string, fromSeq: number): SessionDeltaBatch {
    if (!this.activeAttachments.has(attachmentId)) throw new Error("Attachment is not active");
    return {
      attachmentId: attachmentId as never,
      sessionId: "se_e2e" as never,
      generation: 1 as never,
      durableThroughSeq: 1 as never,
      nextSeq: 2 as never,
      frames:
        fromSeq === 1
          ? [
              {
                header: {
                  frameType: "PtyOutput",
                  sessionId: "se_e2e" as never,
                  generation: 1 as never,
                  seq: 1 as never,
                  payloadLength: 4,
                },
                bytes: new Uint8Array([0, 255, 1, 128]),
              },
            ]
          : [],
    };
  }

  #close(attachmentId: string): void {
    if (!this.activeAttachments.delete(attachmentId)) return;
    this.closedAttachments.push(attachmentId);
  }
}

const isAlive = (process: ChildProcess): boolean => {
  if (process.pid === undefined || process.exitCode !== null) return false;
  try {
    process.kill(0);
    return true;
  } catch {
    return false;
  }
};

const stopChild = async (child: ChildProcess): Promise<void> => {
  if (!isAlive(child)) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
  ]);
  if (isAlive(child)) child.kill("SIGKILL");
};

const rendererProbe = `
(async () => {
  const opened = await window.agentsFleet.attachTerminal({ sessionId: "se_e2e" });
  if (!opened.ok) throw new Error("attach failed: " + JSON.stringify(opened.error));
  const attached = opened.result;
  const framePromise = new Promise((resolveFrame, rejectFrame) => {
    const timer = setTimeout(() => rejectFrame(new Error("frame timeout")), 5000);
    opened.port.onMessage((message) => {
      if (!message || message.type !== "session-frame") return;
      clearTimeout(timer);
      opened.port.postMessage({
        type: "frame-applied",
        attachmentId: attached.attachmentId,
        sessionId: attached.sessionId,
        generation: attached.generation,
        rendererFrameIdentity: message.rendererFrameIdentity,
        seq: message.seq,
      });
      resolveFrame(Array.from(new Uint8Array(message.bytes)));
    });
  });
  const acquired = await window.agentsFleet.acquireTerminalControl(attached.attachmentId);
  if (!acquired.ok) throw new Error("acquire failed: " + JSON.stringify(acquired.error));
  const input = await window.agentsFleet.writeTerminalInput({
    lease: acquired.result,
    source: "Keyboard",
    bytes: new Uint8Array([104, 105]),
  });
  if (!input.ok) throw new Error("input failed: " + JSON.stringify(input.error));
  return {
    attachmentId: attached.attachmentId,
    agentPid: input.result.agentPid,
    inputOk: input.ok,
    frame: await framePromise,
  };
})()
`;

const fixtureMainSource = (input: {
  readonly preloadPath: string;
  readonly htmlPath: string;
  readonly daemonClientPath: string;
  readonly desktopBridgePath: string;
  readonly desktopBridgeIpcPath: string;
}): string => `
import { app, BrowserWindow } from "electron";
import { DaemonClient } from ${JSON.stringify(input.daemonClientPath)};
import { DesktopBridgeCore } from ${JSON.stringify(input.desktopBridgePath)};
import { registerDesktopBridgeIpc } from ${JSON.stringify(input.desktopBridgeIpcPath)};

const emit = (value, code) => {
  process.stdout.write("AF_RESULT=" + JSON.stringify(value) + "\\n");
  app.exit(code);
};

app.whenReady().then(async () => {
  const token = new Uint8Array(Buffer.from(process.env.AF_TOKEN_BASE64, "base64"));
  const client = await DaemonClient.connect({
    socketPath: process.env.AF_SOCKET_PATH,
    token,
    clientInstanceId: "desktop-lifecycle-fixture",
  });
  const bridge = new DesktopBridgeCore({ sender: client });
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: ${JSON.stringify(input.preloadPath)},
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const ipc = registerDesktopBridgeIpc({
    context: { expectedWebContents: win.webContents, allowedOrigin: "file:///" },
    bridge,
    streamSocketPath: process.env.AF_STREAM_SOCKET_PATH,
    token,
    clientInstanceId: "desktop-lifecycle-fixture",
  });
  await win.loadFile(${JSON.stringify(input.htmlPath)});
  const probes = [];
  const probe = async () => probes.push(await win.webContents.executeJavaScript(
    ${JSON.stringify(rendererProbe)},
    true,
  ));
  await probe();
  const reloadCount = Number(process.env.AF_RELOAD_COUNT);
  for (let index = 0; index < reloadCount; index += 1) {
    await new Promise((resolveReload, rejectReload) => {
      win.webContents.once("did-finish-load", resolveReload);
      win.webContents.once("did-fail-load", (_event, code, description) => {
        rejectReload(new Error("reload failed " + code + ": " + description));
      });
      win.webContents.reload();
    });
    await probe();
  }
  win.destroy();
  ipc.closeAll();
  client.close();
  emit({ probes }, 0);
}).catch((error) => emit({ error: String(error), stack: error?.stack }, 1));
`;

const runElectron = async (
  electronPath: string,
  appDir: string,
  server: StartedServer,
  reloadCount: number,
): Promise<FixtureResult> => {
  return await new Promise<FixtureResult>((resolveRun, rejectRun) => {
    const child = spawn(electronPath, [appDir], {
      env: {
        HOME: process.env.HOME ?? "/tmp",
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        AF_SOCKET_PATH: server.socketPath,
        AF_STREAM_SOCKET_PATH: server.streamSocketPath,
        AF_TOKEN_BASE64: Buffer.from(token).toString("base64"),
        AF_RELOAD_COUNT: String(reloadCount),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error("Electron lifecycle fixture timed out"));
    }, 100_000).unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const line = stdout.split("\n").find((candidate) => candidate.startsWith("AF_RESULT="));
      if (code !== 0 || line === undefined) {
        rejectRun(
          new Error(
            `Electron lifecycle fixture failed (exit ${String(code)})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }
      resolveRun(JSON.parse(line.slice("AF_RESULT=".length)) as FixtureResult);
    });
  });
};

describe("Desktop Bridge lifecycle in real Electron", () => {
  const roots: string[] = [];
  const servers: StartedServer[] = [];
  const children: ChildProcess[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const child of children.splice(0)) await stopChild(child);
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  itMacArm64(
    "survives 10 Renderer reloads and a full app reopen without restarting the Agent",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "af-desktop-lifecycle-"));
      roots.push(root);
      const appDir = join(root, "app");
      await mkdir(appDir, { recursive: true });
      const agent = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
      children.push(agent);
      if (agent.pid === undefined) throw new Error("Agent process did not start");

      const router = new LifecycleRouter(agent.pid);
      const server = await startServer({
        socketDir: join(root, "socket"),
        config: {
          supportedProtocolVersions: [1],
          daemonId: "daemon-desktop-lifecycle" as never,
          daemonGeneration: 1 as never,
          platformMatrixVersion: PLATFORM_MATRIX_VERSION,
          runtimeLimitProfileVersion: RUNTIME_LIMIT_PROFILE_VERSION,
        },
        verifier: new KeychainCapabilityProofVerifier(token),
        token,
        router,
        streams: router,
      });
      servers.push(server);

      const htmlPath = join(appDir, "index.html");
      const preloadPath = join(appDir, "preload.cjs");
      await writeFile(htmlPath, "<!doctype html><html><body>lifecycle fixture</body></html>");
      await writeFile(
        join(appDir, "package.json"),
        JSON.stringify({ name: "af-desktop-lifecycle", version: "0.0.0", main: "main.mjs" }),
      );
      await build({
        entryPoints: [join(REPOSITORY_ROOT, "apps/desktop/src/preload/index.ts")],
        outfile: preloadPath,
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node24",
        external: ["electron"],
      });
      const mainEntry = join(appDir, "main-entry.ts");
      await writeFile(
        mainEntry,
        fixtureMainSource({
          preloadPath,
          htmlPath,
          daemonClientPath: join(REPOSITORY_ROOT, "apps/desktop/src/main/daemon-client.ts"),
          desktopBridgePath: join(REPOSITORY_ROOT, "apps/desktop/src/main/desktop-bridge.ts"),
          desktopBridgeIpcPath: join(
            REPOSITORY_ROOT,
            "apps/desktop/src/main/desktop-bridge-ipc.ts",
          ),
        }),
      );
      await build({
        entryPoints: [mainEntry],
        outfile: join(appDir, "main.mjs"),
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node24",
        external: ["electron"],
      });
      const requireFromDesktop = createRequire(
        join(REPOSITORY_ROOT, "apps", "desktop", "package.json"),
      );
      const electronPath = requireFromDesktop("electron") as string;

      const firstRun = await runElectron(electronPath, appDir, server, 10);
      expect(firstRun.probes).toHaveLength(11);
      expect(new Set(firstRun.probes.map((probe) => probe.attachmentId))).toHaveLength(11);
      expect(firstRun.probes.every((probe) => probe.inputOk)).toBe(true);
      expect(firstRun.probes.map((probe) => probe.frame.slice(-4))).toEqual(
        Array.from({ length: 11 }, () => [0, 255, 1, 128]),
      );
      expect(firstRun.probes.every((probe) => probe.frame.length > 4)).toBe(true);
      expect(firstRun.probes.every((probe) => probe.agentPid === agent.pid)).toBe(true);
      expect(isAlive(agent)).toBe(true);

      const reopened = await runElectron(electronPath, appDir, server, 0);
      expect(reopened.probes).toHaveLength(1);
      expect(reopened.probes[0]).toMatchObject({
        agentPid: agent.pid,
        inputOk: true,
      });
      expect(reopened.probes[0]?.frame.slice(-4)).toEqual([0, 255, 1, 128]);
      expect(isAlive(agent)).toBe(true);
      expect(router.inputCount).toBe(12);
      expect(router.activeAttachments.size).toBe(0);
      expect(router.closedAttachments).toHaveLength(12);
    },
    120_000,
  );
});
