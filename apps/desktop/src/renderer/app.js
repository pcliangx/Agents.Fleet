// SV1-ELECTRON-04 — all daemon/repository/PTY text is assigned through
// textContent or fed as bounded binary to Terminal Surface. No innerHTML.

import "@xterm/xterm/css/xterm.css";
import { XtermTerminalSurface } from "@agents-fleet/terminal/renderer";
import { decodeFrame } from "@agents-fleet/transport/binary-frame";

const api = window.agentsFleet;
const connectionStatus = document.getElementById("status");
const workspaceInput = document.getElementById("workspace-id");
const refreshButton = document.getElementById("refresh");
const taskForm = document.getElementById("new-task");
const taskGoal = document.getElementById("task-goal");
const tasksElement = document.getElementById("tasks");
const fleetMeta = document.getElementById("fleet-meta");
const projectionWarning = document.getElementById("projection-warning");
const terminalElement = document.getElementById("terminal");
const terminalMeta = document.getElementById("terminal-meta");
const acquireControlButton = document.getElementById("acquire-control");

let lastProjection = null;
let activeTerminal = null;

const currentWorkspaceId = () => workspaceInput.value.trim();

const statusText = (task) => {
  const phase = task.taskView.phase.value;
  return phase === null ? task.taskView.status.value : `${task.taskView.status.value} · ${phase}`;
};

const addText = (parent, className, text) => {
  const element = document.createElement("span");
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
};

const renderTasks = (projection, locallyStale = false) => {
  tasksElement.replaceChildren();
  const stale = locallyStale || projection.freshness === "Stale";
  projectionWarning.textContent = stale
    ? "Projection is stale — lifecycle facts below may be out of date."
    : projection.dataGap
      ? "Projection has a data gap. Missing history is not inferred."
      : "";
  fleetMeta.textContent = `${projection.tasks.length} Tasks · v${projection.stateVersion}`;

  for (const task of projection.tasks) {
    const article = document.createElement("article");
    article.className = "task-card";
    const heading = document.createElement("div");
    heading.className = "task-heading";
    const id = document.createElement("code");
    id.textContent = task.taskId;
    heading.append(id);
    addText(heading, `status status-${task.taskView.status.value.toLowerCase()}`, statusText(task));
    article.append(heading);

    const attempt = task.currentAttempt ?? task.lastAttempt;
    const details = document.createElement("p");
    details.className = "task-details";
    details.textContent =
      attempt === null
        ? "Draft · no Attempt"
        : `${attempt.commandKind} Attempt ${attempt.attemptId} · ${attempt.status}`;
    article.append(details);

    if (attempt?.agentProfileSnapshot) {
      const profile = document.createElement("p");
      profile.className = "task-details";
      profile.textContent = `${attempt.agentProfileSnapshot.agentId} · Profile ${attempt.agentProfileSnapshot.profileId} v${attempt.agentProfileSnapshot.profileVersion}`;
      article.append(profile);
    }

    const reason = task.taskView.waitingReason.value ?? task.taskView.terminalReason.value;
    if (reason !== null) {
      const reasonElement = document.createElement("p");
      reasonElement.className = "task-reason";
      reasonElement.textContent = `Reason: ${reason}`;
      article.append(reasonElement);
    }

    if (task.recentObservation !== null) {
      const observation = document.createElement("p");
      observation.className = "provenance";
      observation.textContent = `Observation: ${task.recentObservation.type} · ${task.recentObservation.confidence} · ${task.recentObservation.observedAt}`;
      article.append(observation);
    }

    const provenance = document.createElement("p");
    provenance.className = "provenance";
    provenance.textContent = `${task.taskView.status.source.confidence} · observed ${task.taskView.status.source.observedAt}`;
    article.append(provenance);

    if (attempt?.sessionId) {
      const attach = document.createElement("button");
      attach.type = "button";
      attach.textContent = "Attach Terminal";
      attach.addEventListener("click", () => void attachTerminal(attempt.sessionId));
      article.append(attach);
    }
    tasksElement.append(article);
  }

  if (projection.tasks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No Tasks in this Workspace.";
    tasksElement.append(empty);
  }
};

const refreshProjection = async () => {
  const workspaceId = currentWorkspaceId();
  if (workspaceId.length === 0) {
    projectionWarning.textContent = "Enter a Workspace ID.";
    return;
  }
  const result = await api.getFleetProjection(workspaceId);
  if (!result.ok) {
    projectionWarning.textContent = `${result.error.code}: ${result.error.message}`;
    if (lastProjection !== null) renderTasks(lastProjection, true);
    return;
  }
  lastProjection = result.result;
  renderTasks(result.result);
};

const closeActiveTerminal = async () => {
  if (activeTerminal === null) return;
  const terminal = activeTerminal;
  activeTerminal = null;
  terminal.disposeInput();
  terminal.port.close();
  await api.closeTerminal(terminal.attached.attachmentId);
  terminalElement.replaceChildren();
  terminalMeta.textContent = "No Session attached";
  acquireControlButton.disabled = true;
};

const attachTerminal = async (sessionId) => {
  await closeActiveTerminal();
  terminalMeta.textContent = `Attaching ${sessionId}…`;
  const opened = await api.attachTerminal({ sessionId });
  if (!opened.ok) {
    terminalMeta.textContent = `${opened.error.code}: ${opened.error.message}`;
    return;
  }
  const attached = opened.result;
  const surface = new XtermTerminalSurface({
    cols: 100,
    rows: 32,
    element: terminalElement,
    preferWebGL2: true,
    maxPendingWriteBytes: 4_194_304,
  });
  try {
    await surface.restoreSnapshot(attached.snapshot.bytes);
  } catch (error) {
    opened.port.close();
    terminalMeta.textContent = `Snapshot rejected: ${String(error)}`;
    return;
  }

  const state = {
    attached,
    port: opened.port,
    surface,
    lease: null,
    apply: Promise.resolve(),
    disposeInput: () => {},
  };
  state.disposeInput = surface.onInput((input) => {
    if (state.lease === null) return;
    void api.writeTerminalInput({ lease: state.lease, ...input });
  });
  opened.port.onmessage = (event) => {
    const message = event.data;
    if (
      typeof message !== "object" ||
      message === null ||
      message.type !== "session-frame" ||
      message.attachmentId !== attached.attachmentId ||
      message.sessionId !== attached.sessionId ||
      message.generation !== attached.generation ||
      !(message.bytes instanceof ArrayBuffer)
    ) {
      opened.port.close();
      terminalMeta.textContent = "Rejected a cross-Attachment stream frame.";
      return;
    }
    state.apply = state.apply
      .then(async () => {
        const frame = decodeFrame(new Uint8Array(message.bytes));
        await surface.feed(frame.payload, frame.header);
        opened.port.postMessage({
          type: "frame-applied",
          attachmentId: attached.attachmentId,
          sessionId: attached.sessionId,
          generation: attached.generation,
          rendererFrameIdentity: message.rendererFrameIdentity,
          seq: frame.header.seq,
        });
      })
      .catch((error) => {
        opened.port.close();
        terminalMeta.textContent = `Terminal stream stopped: ${String(error)}`;
      });
  };
  opened.port.start();
  activeTerminal = state;
  terminalMeta.textContent = `${attached.sessionId} · generation ${attached.generation} · ObserveOnly`;
  acquireControlButton.disabled = false;
};

taskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const workspaceId = currentWorkspaceId();
  const goal = taskGoal.value.trim();
  if (workspaceId.length === 0 || goal.length === 0) return;
  void api.createTask({ workspaceId, spec: { goal } }).then((result) => {
    if (!result.ok) {
      projectionWarning.textContent = `${result.error.code}: ${result.error.message}`;
      return;
    }
    taskGoal.value = "";
    void refreshProjection();
  });
});

refreshButton.addEventListener("click", () => void refreshProjection());
acquireControlButton.addEventListener("click", () => {
  if (activeTerminal === null) return;
  void api.acquireTerminalControl(activeTerminal.attached.attachmentId).then((result) => {
    if (!result.ok) {
      terminalMeta.textContent = `${result.error.code}: ${result.error.message}`;
      return;
    }
    activeTerminal.lease = result.result;
    terminalMeta.textContent = `${result.result.sessionId} · generation ${result.result.generation} · Control`;
    acquireControlButton.disabled = true;
  });
});
window.addEventListener("beforeunload", () => {
  if (activeTerminal !== null) {
    activeTerminal.disposeInput();
    activeTerminal.port.close();
  }
});
document.addEventListener("visibilitychange", () => {
  if (
    document.visibilityState === "hidden" &&
    activeTerminal !== null &&
    activeTerminal.lease !== null
  ) {
    void closeActiveTerminal();
  }
});

const pollConnection = async () => {
  try {
    connectionStatus.textContent = await api.getConnectionInfo();
  } catch (error) {
    connectionStatus.textContent = `error: ${String(error)}`;
  }
};

void pollConnection();
void refreshProjection();
setInterval(() => void pollConnection(), 1_000);
setInterval(() => void refreshProjection(), 1_000);
