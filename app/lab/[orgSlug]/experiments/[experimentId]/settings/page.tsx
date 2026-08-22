import { EvaluationStatus } from "@/components/lab/EvaluationStatus";
import { formatDate, titleCase } from "@/components/lab/format";
import {
  closeEvaluationAction,
  configureEndpointAction,
  deleteDraftEvaluationAction,
  disableEndpointAction,
  updateEvaluationAction,
  uploadCohortAction,
} from "../../../actions";
import { loadEvaluationWorkspace } from "../data";

export default async function EvaluationSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; experimentId: string }>;
}) {
  const { orgSlug, experimentId } = await params;
  const { workspace } = await loadEvaluationWorkspace(orgSlug, experimentId);
  const configureAction = configureEndpointAction.bind(null, orgSlug, experimentId);
  const uploadAction = uploadCohortAction.bind(null, orgSlug, experimentId);
  const updateAction = updateEvaluationAction.bind(null, orgSlug, experimentId);
  const closeAction = closeEvaluationAction.bind(null, orgSlug, experimentId);
  const deleteAction = deleteDraftEvaluationAction.bind(null, orgSlug, experimentId);
  const readOnly = workspace.status === "CLOSED";
  const identityFrozen = workspace.status !== "DRAFT";
  const draftDeletable =
    workspace.status === "DRAFT" &&
    workspace.checkpoints.every(
      (checkpoint) => checkpoint.generatedBuildCount === 0 && checkpoint.totalVotes === 0,
    );

  return (
    <div className="space-y-10">
      <section className="space-y-5" aria-labelledby="settings-heading">
        <div className="border-b border-border/70 pb-3">
          <h2 id="settings-heading" className="text-2xl font-semibold tracking-tight text-fg">
            Settings
          </h2>
        </div>

        <dl className="divide-y divide-border/55 border-y border-border/70 text-sm">
          <div className="grid gap-1 py-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <dt className="text-muted">Name</dt>
            <dd className="text-fg">{workspace.name}</dd>
          </div>
          <div className="grid gap-1 py-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <dt className="text-muted">Vote goal</dt>
            <dd className="text-fg">
              {workspace.targetDecisiveVotes
                ? `${workspace.targetDecisiveVotes.toLocaleString()} per checkpoint${
                    workspace.pauseAtGoal ? " · Pause at goal" : ""
                  }`
                : "No goal"}
            </dd>
          </div>
          <div className="grid gap-1 py-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <dt className="text-muted">Vote export</dt>
            <dd className="text-fg">
              {workspace.exportPolicy === "DEIDENTIFIED_VOTES" ? "Deidentified votes" : "Aggregates only"}
            </dd>
          </div>
          <div className="grid gap-1 py-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <dt className="text-muted">Retention</dt>
            <dd className="text-fg">
              {workspace.retentionDays} days
              {workspace.retentionDeleteAt ? ` · Deletes ${formatDate(workspace.retentionDeleteAt)}` : ""}
            </dd>
          </div>
          <div className="grid gap-1 py-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <dt className="text-muted">Checkpoint set</dt>
            <dd className="text-fg">{workspace.checkpointSetFrozenAt ? "Frozen" : "Open"}</dd>
          </div>
        </dl>

        {!readOnly ? (
          <form action={updateAction} className="grid gap-4 border-y border-border/70 py-5 sm:grid-cols-2">
            <label className="space-y-2 text-sm font-medium text-fg">
              <span>Name</span>
              <input
                name="name"
                required={!identityFrozen}
                disabled={identityFrozen}
                maxLength={140}
                defaultValue={workspace.name}
                className="mb-field h-11 disabled:opacity-60"
              />
            </label>
            <label className="space-y-2 text-sm font-medium text-fg">
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
            <div className="flex items-end justify-end">
              <button type="submit" className="mb-btn mb-btn-primary min-h-11 px-5 text-sm">
                Save
              </button>
            </div>
          </form>
        ) : null}
      </section>

      <section className="space-y-5" aria-labelledby="checkpoint-settings-heading">
        <div className="flex items-end justify-between gap-4 border-b border-border/70 pb-3">
          <div>
            <h2 id="checkpoint-settings-heading" className="text-xl font-semibold tracking-tight text-fg">
              Checkpoints
            </h2>
            <p className="mt-1 text-sm text-muted">Credentials are encrypted and shown once.</p>
          </div>
          <span className="font-mono text-xs text-muted">{workspace.checkpoints.length}</span>
        </div>

        <div className="divide-y divide-border/55 border-y border-border/70">
          {workspace.checkpoints.map((checkpoint) => (
            <div key={checkpoint.id} className="flex min-h-16 items-center justify-between gap-4 py-4">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-fg">{checkpoint.codename}</div>
                <div className="mt-1 text-xs text-muted">
                  {titleCase(checkpoint.source)}
                  {checkpoint.credentialConfigured ? " · Credential configured" : ""}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-3">
                <EvaluationStatus status={checkpoint.status} />
                {!readOnly && checkpoint.credentialConfigured ? (
                  <form
                    action={disableEndpointAction.bind(
                      null,
                      orgSlug,
                      experimentId,
                      checkpoint.id,
                    )}
                  >
                    <button type="submit" className="min-h-11 px-2 text-xs text-muted hover:text-danger">
                      Disable
                    </button>
                  </form>
                ) : null}
              </div>
            </div>
          ))}
          {workspace.checkpoints.length === 0 ? (
            <div className="py-8 text-sm text-muted">No checkpoints</div>
          ) : null}
        </div>

        {workspace.status === "DRAFT" ? (
          <form action={configureAction} className="space-y-5 border-y border-border/70 py-6">
            <div>
              <h3 className="text-lg font-medium tracking-tight text-fg">Add checkpoint</h3>
              <p className="mt-1 text-sm text-muted">Connect a confidential endpoint.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-2 text-sm font-medium text-fg">
                <span>Codename</span>
                <input name="codename" required maxLength={80} className="mb-field h-11" />
              </label>
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
            </div>
            <div className="flex justify-end">
              <button type="submit" className="mb-btn mb-btn-primary min-h-11 px-5 text-sm">
                Add checkpoint
              </button>
            </div>
          </form>
        ) : null}

        {workspace.status === "DRAFT" ? (
          <form action={uploadAction} className="space-y-5 border-y border-border/70 py-6">
            <div>
              <h3 className="text-lg font-medium tracking-tight text-fg">Upload cohort</h3>
              <p className="mt-1 text-sm text-muted">Submit one build for every prompt.</p>
            </div>
            <label className="block max-w-sm space-y-2 text-sm font-medium text-fg">
              <span>Codename</span>
              <input name="codename" required maxLength={80} className="mb-field h-11" />
            </label>
            <label className="block space-y-2 text-sm font-medium text-fg">
              <span>Cohort JSON</span>
              <textarea
                name="cohort"
                required
                rows={10}
                spellCheck={false}
                className="mb-field min-h-48 resize-y py-3 font-mono text-xs"
              />
            </label>
            <div className="flex justify-end">
              <button type="submit" className="mb-btn mb-btn-primary min-h-11 px-5 text-sm">
                Upload
              </button>
            </div>
          </form>
        ) : null}
      </section>

      <section className="space-y-4 border-y border-danger/30 py-6" aria-labelledby="lifecycle-heading">
        <div>
          <h2 id="lifecycle-heading" className="text-xl font-semibold tracking-tight text-fg">
            Lifecycle
          </h2>
          <p className="mt-1 text-sm text-muted">
            {readOnly
              ? "This evaluation is read-only."
              : draftDeletable
                ? "Unused drafts can be deleted."
                : "Closing is final and stops Arena sampling."}
          </p>
        </div>
        {draftDeletable ? (
          <form action={deleteAction} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <label className="flex min-h-11 items-center gap-3 text-sm text-fg">
              <input type="checkbox" required className="h-4 w-4 accent-danger" />
              Delete this draft
            </label>
            <button type="submit" className="mb-btn mb-btn-danger min-h-11 px-5 text-sm">
              Delete
            </button>
          </form>
        ) : !readOnly ? (
          <form action={closeAction} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <label className="flex min-h-11 items-center gap-3 text-sm text-fg">
              <input type="checkbox" required className="h-4 w-4 accent-danger" />
              Close this evaluation
            </label>
            <button type="submit" className="mb-btn mb-btn-danger min-h-11 px-5 text-sm">
              Close
            </button>
          </form>
        ) : null}
      </section>
    </div>
  );
}
