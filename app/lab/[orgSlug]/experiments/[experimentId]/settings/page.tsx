import Link from "next/link";
import { CheckpointBuildUploads } from "@/components/lab/CheckpointBuildUploads";
import { EvaluationStatus } from "@/components/lab/EvaluationStatus";
import { formatDate, titleCase } from "@/components/lab/format";
import { GenerationPoller } from "@/components/lab/GenerationPoller";
import { LabDisclosure } from "@/components/lab/LabDisclosure";
import { LifecycleActionButton } from "@/components/lab/LifecycleActionButton";
import { EndpointRequestOverrides } from "@/components/lab/EndpointRequestOverrides";
import {
  closeEvaluationAction,
  configureEndpointAction,
  createUploadCheckpointAction,
  deleteDraftEvaluationAction,
  disableEndpointAction,
  queueBuildUploadAction,
  updateEvaluationAction,
} from "../../../actions";
import { loadEvaluationWorkspace } from "../data";

function needsEndpointKey(checkpoint: {
  source: string;
  status: string;
  credentialConfigured: boolean;
  generatedBuildCount: number;
  expectedBuildCount: number;
}): boolean {
  return (
    checkpoint.source === "ENDPOINT" &&
    !checkpoint.credentialConfigured &&
    checkpoint.generatedBuildCount < checkpoint.expectedBuildCount &&
    (checkpoint.status === "DRAFT" || checkpoint.status === "GENERATING")
  );
}

export default async function EvaluationSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; experimentId: string }>;
  searchParams: Promise<{ checkpoint?: string }>;
}) {
  const { orgSlug, experimentId } = await params;
  const basePath = `/lab/${orgSlug}/experiments/${experimentId}`;
  const { checkpoint: refreshCheckpointId } = await searchParams;
  const { workspace } = await loadEvaluationWorkspace(orgSlug, experimentId);
  const selectedCheckpoint = workspace.checkpoints.find(
    (checkpoint) => checkpoint.id === refreshCheckpointId,
  );
  const refreshEndpoint =
    selectedCheckpoint?.source === "ENDPOINT" &&
    (selectedCheckpoint.status === "DRAFT" ||
      (selectedCheckpoint.status === "READY" && !selectedCheckpoint.promptCohortCurrent))
      ? selectedCheckpoint
      : null;
  const uploadCheckpoint =
    selectedCheckpoint?.source === "UPLOAD" &&
    (selectedCheckpoint.status === "DRAFT" || selectedCheckpoint.status === "GENERATING")
      ? selectedCheckpoint
      : null;
  const refreshUpload =
    selectedCheckpoint?.source === "UPLOAD" &&
    selectedCheckpoint.status === "READY" &&
    !selectedCheckpoint.promptCohortCurrent
      ? selectedCheckpoint
      : null;
  const configureAction = configureEndpointAction.bind(null, orgSlug, experimentId);
  const createUploadAction = createUploadCheckpointAction.bind(null, orgSlug, experimentId);
  const queueUploadAction = queueBuildUploadAction.bind(null, orgSlug, experimentId);
  const updateAction = updateEvaluationAction.bind(null, orgSlug, experimentId);
  const closeAction = closeEvaluationAction.bind(null, orgSlug, experimentId);
  const deleteAction = deleteDraftEvaluationAction.bind(null, orgSlug, experimentId);
  const readOnly = workspace.status === "CLOSED";
  const closing = !readOnly && Boolean(workspace.endedAt);
  const mutable = !readOnly && !closing;
  const checkpointSetOpen = mutable && workspace.checkpointSetFrozenAt === null;
  const identityFrozen = workspace.status !== "DRAFT";
  const draftDeletable =
    workspace.status === "DRAFT" &&
    workspace.checkpoints.every(
      (checkpoint) => checkpoint.persistedBuildCount === 0 && checkpoint.totalVotes === 0,
    );
  const uploadProcessing = Boolean(
    uploadCheckpoint?.latestGenerationRun?.results.some(
      (result) =>
        (result.status === "QUEUED" && result.uploadPending) ||
        result.status === "GENERATING" ||
        result.status === "VALIDATING",
    ),
  );

  return (
    <div className="space-y-8">
      <GenerationPoller active={uploadProcessing} />
      <section aria-labelledby="settings-heading">
        <h2 id="settings-heading" className="text-2xl font-semibold tracking-tight text-fg">
          Settings
        </h2>

        <dl className="mt-5 grid gap-x-8 gap-y-5 text-sm sm:grid-cols-2 lg:grid-cols-5">
          <div className="min-w-0">
            <dt className="text-[10px] text-muted">Name</dt>
            <dd className="mt-1 truncate text-fg">{workspace.name}</dd>
          </div>
          <div>
            <dt className="text-[10px] text-muted">Vote goal</dt>
            <dd className="mt-1 text-fg">
              {workspace.targetDecisiveVotes
                ? `${workspace.targetDecisiveVotes.toLocaleString()} per checkpoint${
                    workspace.pauseAtGoal ? " · Pause at goal" : ""
                  }`
                : "No goal"}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] text-muted">Vote export</dt>
            <dd className="mt-1 text-fg">
              {workspace.exportPolicy === "DEIDENTIFIED_VOTES" ? "Deidentified votes" : "Aggregates only"}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] text-muted">Retention</dt>
            <dd className="mt-1 text-fg">
              {workspace.retentionDays} days
              {workspace.retentionDeleteAt ? ` · Deletes ${formatDate(workspace.retentionDeleteAt)}` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] text-muted">Checkpoint set</dt>
            <dd className="mt-1 text-fg">{workspace.checkpointSetFrozenAt ? "Frozen" : "Open"}</dd>
          </div>
        </dl>

        {mutable ? (
          <LabDisclosure
            title={<span className="text-sm font-medium text-fg">Evaluation settings</span>}
            className="mt-6 border-t border-border/60"
            panelClassName="pb-1 pt-4"
          >
            <form action={updateAction} className="flex max-w-5xl flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:gap-x-5">
              {!identityFrozen ? (
                <label className="w-full space-y-2 text-sm font-medium text-fg sm:w-80">
                  <span>Name</span>
                  <input
                    name="name"
                    required
                    maxLength={140}
                    defaultValue={workspace.name}
                    className="mb-field h-11"
                  />
                </label>
              ) : null}
              <label className="w-full space-y-2 text-sm font-medium text-fg sm:w-72">
                <span>Decisive vote goal</span>
                <input
                  name="targetDecisiveVotes"
                  type="number"
                  min={1}
                  max={1_000_000}
                  defaultValue={workspace.targetDecisiveVotes ?? ""}
                  className="mb-field h-11"
                />
              </label>
              <label className="flex min-h-11 items-center gap-3 text-sm text-fg">
                <input
                  name="pauseAtGoal"
                  type="checkbox"
                  defaultChecked={workspace.pauseAtGoal}
                  className="h-4 w-4 accent-accent"
                />
                Pause at goal
              </label>
              <button type="submit" className="mb-btn mb-btn-primary min-h-11 px-5 text-sm">
                Save
              </button>
            </form>
          </LabDisclosure>
        ) : null}
      </section>

      <section aria-labelledby="checkpoint-settings-heading">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="checkpoint-settings-heading" className="text-xl font-semibold tracking-tight text-fg">
            Checkpoints
          </h2>
          <span className="font-mono text-xs text-muted">{workspace.checkpoints.length}</span>
        </div>

        <div className="mt-4 divide-y divide-border/50 overflow-hidden rounded-md border border-border/70">
          {workspace.checkpoints.map((checkpoint) => (
            <div key={checkpoint.id} className="flex min-h-16 items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-fg">{checkpoint.codename}</div>
                <div className="mt-1 text-xs text-muted">
                  {titleCase(checkpoint.source)}
                  {needsEndpointKey(checkpoint) ? " · Needs key" : ""}
                  {checkpoint.status === "READY" && !checkpoint.promptCohortCurrent
                    ? " · Refresh required"
                    : ""}
                </div>
              </div>
              <div className="flex items-center justify-end gap-3 shrink-0">
                <EvaluationStatus
                  status={
                    checkpoint.lastGenerationError && checkpoint.status === "DRAFT"
                      ? "FAILED"
                      : checkpoint.status
                  }
                />
                {checkpoint.source === "ENDPOINT" &&
                checkpoint.status === "DRAFT" &&
                checkpoint.credentialConfigured ? (
                  <Link
                    href={`${basePath}/builds`}
                    className="inline-flex items-center text-xs font-medium text-accent hover:underline"
                  >
                    Generate builds &rarr;
                  </Link>
                ) : null}
                {mutable &&
                checkpoint.source === "UPLOAD" &&
                (checkpoint.status === "DRAFT" ||
                  checkpoint.status === "GENERATING" ||
                  (checkpoint.status === "READY" && !checkpoint.promptCohortCurrent)) ? (
                  <Link
                    href={`?checkpoint=${encodeURIComponent(checkpoint.id)}`}
                    className="inline-flex items-center text-xs font-medium text-accent hover:underline"
                  >
                    {checkpoint.status === "READY"
                      ? "Refresh"
                      : checkpoint.generatedBuildCount > 0
                        ? "Review uploads"
                        : "Upload builds"}
                  </Link>
                ) : null}
                {mutable &&
                checkpoint.source === "ENDPOINT" &&
                (checkpoint.status === "DRAFT" ||
                  (checkpoint.status === "READY" && !checkpoint.promptCohortCurrent)) ? (
                  <Link
                    href={`?checkpoint=${encodeURIComponent(checkpoint.id)}`}
                    className="inline-flex items-center text-xs font-medium text-muted transition hover:text-fg"
                  >
                    {checkpoint.status === "READY" ? "Refresh" : "Edit"}
                  </Link>
                ) : null}
                {mutable && checkpoint.credentialConfigured ? (
                  <form
                    action={disableEndpointAction.bind(
                      null,
                      orgSlug,
                      experimentId,
                      checkpoint.id,
                    )}
                    className="inline-flex items-center"
                  >
                    <button
                      type="submit"
                      className="inline-flex items-center text-xs font-medium text-muted transition hover:text-danger"
                    >
                      Disable
                    </button>
                  </form>
                ) : null}
              </div>
            </div>
          ))}
          {workspace.checkpoints.length === 0 ? (
            <div className="px-4 py-8 text-sm text-muted">No checkpoints</div>
          ) : null}
        </div>

        {checkpointSetOpen ? (
          <div className="mt-5 overflow-hidden rounded-md border border-border/70">
            <LabDisclosure
              title={
                <span className="text-sm font-medium text-fg">
                  {refreshEndpoint
                    ? refreshEndpoint.status === "READY"
                      ? `Refresh ${refreshEndpoint.codename}`
                      : `Edit ${refreshEndpoint.codename}`
                    : "Connect endpoint"}
                </span>
              }
              className="border-b border-border/55"
              buttonClassName="px-4"
              panelClassName="px-4 pb-5 pt-2 sm:px-5"
              defaultOpen={Boolean(refreshEndpoint)}
            >
          <form action={configureAction} className="space-y-5">
            {refreshEndpoint ? (
              <>
                <input type="hidden" name="variantId" value={refreshEndpoint.id} />
                <input type="hidden" name="codename" value={refreshEndpoint.codename} />
              </>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              {refreshEndpoint ? (
                <div className="space-y-2 text-sm font-medium text-fg">
                  <span>Checkpoint</span>
                  <div className="flex h-11 items-center">{refreshEndpoint.codename}</div>
                </div>
              ) : (
                <label className="space-y-2 text-sm font-medium text-fg">
                  <span>Codename</span>
                  <input name="codename" required maxLength={80} className="mb-field h-11" />
                </label>
              )}
              <label className="space-y-2 text-sm font-medium text-fg">
                <span>Model</span>
                <input name="modelId" required autoComplete="off" className="mb-field h-11" />
              </label>
              <label className="space-y-2 text-sm font-medium text-fg">
                <span>Protocol</span>
                <select name="protocol" defaultValue="openai-compatible" className="mb-field h-11">
                  <option value="openai-compatible">OpenAI compatible</option>
                  <option value="openrouter">OpenRouter</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Gemini</option>
                </select>
              </label>
              <label className="space-y-2 text-sm font-medium text-fg sm:col-span-2">
                <span>Endpoint · OpenAI compatible</span>
                <input name="endpointUrl" type="url" autoComplete="url" className="mb-field h-11" />
              </label>
              <label className="space-y-2 text-sm font-medium text-fg">
                <span>API key</span>
                <input
                  name="apiKey"
                  type="password"
                  required
                  autoComplete="new-password"
                  spellCheck={false}
                  className="mb-field h-11"
                />
              </label>
              <label className="space-y-2 text-sm font-medium text-fg">
                <span>Reasoning</span>
                <select name="reasoning" defaultValue="" className="mb-field h-11">
                  <option value="">Provider default</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </label>
              <label className="space-y-2 text-sm font-medium text-fg">
                <span>Output limit</span>
                <input
                  name="maxOutputTokens"
                  type="number"
                  min={2_048}
                  max={1_000_000}
                  inputMode="numeric"
                  className="mb-field h-11"
                />
              </label>
              <fieldset className="flex flex-wrap gap-x-6 gap-y-2 sm:col-span-2">
                <legend className="sr-only">Endpoint capabilities</legend>
                <label className="flex min-h-11 items-center gap-3 text-sm text-fg">
                  <input
                    name="requireStructuredOutput"
                    type="checkbox"
                    defaultChecked
                    className="h-4 w-4 accent-accent"
                  />
                  Structured output
                </label>
                <label className="flex min-h-11 items-center gap-3 text-sm text-fg">
                  <input
                    name="enableTools"
                    type="checkbox"
                    defaultChecked
                    className="h-4 w-4 accent-accent"
                  />
                  Tool support
                </label>
              </fieldset>
              <EndpointRequestOverrides />
            </div>
            <div className="flex items-center justify-end gap-3">
              {refreshEndpoint ? (
                <Link
                  href={`${basePath}/settings`}
                  className="mb-btn mb-btn-ghost min-h-11 px-4 text-sm"
                >
                  Cancel
                </Link>
              ) : null}
              <LifecycleActionButton
                label={
                  refreshEndpoint
                    ? refreshEndpoint.status === "READY"
                      ? "Save & refresh"
                      : "Save changes"
                    : "Connect"
                }
                pendingLabel="Saving…"
                tone="primary"
              />
            </div>
          </form>
            </LabDisclosure>
            <LabDisclosure
              title={
                <span className="text-sm font-medium text-fg">
                  {refreshUpload
                    ? `Refresh ${refreshUpload.codename}`
                    : uploadCheckpoint
                      ? `Upload ${uploadCheckpoint.codename}`
                      : "Upload builds"}
                </span>
              }
              buttonClassName="px-4"
              panelClassName="px-4 pb-5 pt-2 sm:px-5"
              defaultOpen={Boolean(uploadCheckpoint || refreshUpload)}
            >
              {uploadCheckpoint?.latestGenerationRun ? (
                <CheckpointBuildUploads
                  slots={uploadCheckpoint.latestGenerationRun.results.map((result) => ({
                    resultId: result.resultId,
                    prompt: result.prompt,
                    status: result.status,
                    error: result.error,
                    uploadPending: result.uploadPending,
                  }))}
                  signUrl={`/api/lab/organizations/${encodeURIComponent(orgSlug)}/experiments/${encodeURIComponent(experimentId)}/build-uploads`}
                  queueAction={queueUploadAction}
                />
              ) : (
                <form action={createUploadAction} className="space-y-5">
                  {refreshUpload ? (
                    <>
                      <input type="hidden" name="variantId" value={refreshUpload.id} />
                      <input type="hidden" name="codename" value={refreshUpload.codename} />
                      <div className="max-w-sm space-y-2 text-sm font-medium text-fg">
                        <span>Checkpoint</span>
                        <div className="flex h-11 items-center">{refreshUpload.codename}</div>
                      </div>
                    </>
                  ) : (
                    <label className="block max-w-sm space-y-2 text-sm font-medium text-fg">
                      <span>Codename</span>
                      <input name="codename" required maxLength={80} className="mb-field h-11" />
                    </label>
                  )}
                  <p className="max-w-xl text-sm leading-6 text-muted">
                    {refreshUpload
                      ? "Start a new upload for the current prompt set."
                      : "Create the checkpoint, then upload each prompt as its own JSON file."}
                  </p>
                  <div className="flex justify-end">
                    <LifecycleActionButton
                      label={refreshUpload ? "Refresh checkpoint" : "Create checkpoint"}
                      pendingLabel={refreshUpload ? "Refreshing…" : "Creating…"}
                      tone="primary"
                    />
                  </div>
                </form>
              )}
            </LabDisclosure>
          </div>
        ) : null}
      </section>

      <section className="space-y-4 border-t border-danger/30 pt-6" aria-labelledby="lifecycle-heading">
        <div>
          <h2 id="lifecycle-heading" className="text-xl font-semibold tracking-tight text-fg">
            Lifecycle
          </h2>
          <p className="mt-1 text-sm text-muted">
            {readOnly
              ? "This evaluation is read-only."
              : closing
                ? "Close is ready to finish."
              : draftDeletable
                ? "Unused drafts can be deleted."
                : "Closing is final and stops Arena sampling."}
          </p>
        </div>
        {draftDeletable ? (
          <form action={deleteAction} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
            <label className="flex min-h-11 items-center gap-3 text-sm text-fg">
              <input type="checkbox" required className="h-4 w-4 accent-danger" />
              Delete this draft
            </label>
            <button type="submit" className="mb-btn mb-btn-danger min-h-11 px-5 text-sm">
              Delete
            </button>
          </form>
        ) : !readOnly ? (
          <form action={closeAction} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
            <label className="flex min-h-11 items-center gap-3 text-sm text-fg">
              <input type="checkbox" required className="h-4 w-4 accent-danger" />
              Close this evaluation
            </label>
            <button type="submit" className="mb-btn mb-btn-danger min-h-11 px-5 text-sm">
              {closing ? "Retry close" : "Close"}
            </button>
          </form>
        ) : null}
      </section>
    </div>
  );
}
