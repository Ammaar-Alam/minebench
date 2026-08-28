"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  loadGalleryAdminPerson,
  mutateGalleryAdmin,
} from "@/app/admin/gallery/actions";
import type {
  getGalleryAdminDashboard,
  getGalleryAdminPerson,
} from "@/lib/gallery/service";

type Dashboard = Awaited<ReturnType<typeof getGalleryAdminDashboard>>;
type Person = Awaited<ReturnType<typeof getGalleryAdminPerson>>;
type PromptFilter = "latest" | "reported" | "hidden" | "selected";
type PeopleFilter = "online" | "all" | "suspended";
type Mutation =
  | { type: "candidate_hidden"; publicId: string; hidden: boolean }
  | { type: "example_hidden"; exampleId: string }
  | { type: "candidate_selected"; publicId: string; selected: boolean }
  | { type: "account_suspended"; userId: string; suspended: boolean; reason?: string }
  | { type: "votes_blocked"; personId: string; blocked: boolean }
  | { type: "hosted_generation_limit"; userId: string; limit: number };

const dateTime = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(value: string | null): string {
  return value ? dateTime.format(new Date(value)) : "No recent activity";
}

function searchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function targetLabel(value: string): string {
  if (value === "CANDIDATE") return "prompt";
  if (value === "EXAMPLE") return "build";
  return value.replaceAll("_", " ").toLowerCase();
}

function FilterButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`relative min-h-10 px-1 text-sm transition-colors focus-visible:outline-none focus-visible:text-accent ${
        active ? "font-semibold text-fg" : "text-muted hover:text-fg"
      } after:absolute after:inset-x-1 after:bottom-0 after:h-px after:origin-left after:bg-fg after:transition-transform after:duration-200 after:ease-out motion-reduce:after:transition-none ${
        active ? "after:scale-x-100" : "after:scale-x-0"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SuspendDialog({
  target,
  pending,
  error,
  onClose,
  onSuspend,
}: {
  target: { userId: string; email: string } | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSuspend: (reason: string) => Promise<boolean>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (target && !dialog.open) {
      setReason("");
      dialog.showModal();
    }
    if (!target && dialog.open) dialog.close();
  }, [target]);

  function closeDialog() {
    ref.current?.close();
    onClose();
  }

  if (!target) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby="suspend-account-title"
      className="mb-dialog m-auto w-[min(32rem,calc(100%-2rem))] rounded-md border border-border bg-bg p-0 text-fg backdrop:bg-black/55"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) closeDialog();
      }}
    >
      <form
        className="space-y-6 p-6 sm:p-7"
        onSubmit={(event) => {
          event.preventDefault();
          void onSuspend(reason).then((ok) => {
            if (ok) closeDialog();
          });
        }}
      >
        <div className="space-y-2">
          <p className="mb-eyebrow">Gallery access</p>
          <h2 id="suspend-account-title" className="text-2xl font-semibold tracking-tight">Suspend publishing</h2>
          <p className="break-all text-sm text-muted">{target.email}</p>
        </div>
        <label className="block space-y-2">
          <span className="text-sm font-medium text-fg">Reason <span className="font-normal text-muted">optional</span></span>
          <input
            autoFocus
            className="mb-field h-11"
            maxLength={240}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {error ? <p aria-live="polite" className="text-sm text-danger">{error}</p> : null}
        <div className="grid gap-2 sm:grid-cols-2">
          <button type="submit" disabled={pending} className="mb-btn mb-btn-danger h-11">
            {pending ? "Suspending…" : "Suspend"}
          </button>
          <button type="button" disabled={pending} className="mb-btn h-11" onClick={closeDialog}>Cancel</button>
        </div>
      </form>
    </dialog>
  );
}

function PersonInspector({
  person,
  loading,
  pending,
  onBack,
  onReload,
  onMutate,
  onSuspend,
}: {
  person: Person | null;
  loading: boolean;
  pending: boolean;
  onBack: () => void;
  onReload: () => void;
  onMutate: (mutation: Mutation) => Promise<boolean>;
  onSuspend: (target: { userId: string; email: string }) => void;
}) {
  if (loading) return <p className="py-8 text-sm text-muted">Loading person…</p>;
  if (!person) {
    return (
      <div className="space-y-4 py-8">
        <p className="text-sm text-muted">Person unavailable.</p>
        <button type="button" className="mb-btn h-10" onClick={onReload}>Retry</button>
      </div>
    );
  }
  const userId = person.userId;

  return (
    <div className="min-h-0 min-w-0 space-y-5">
      <div className="min-w-0 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            className="group -ml-2 inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted transition-colors hover:bg-card/40 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label="Back to people"
            onClick={onBack}
          >
            <span aria-hidden="true" className="transition-transform duration-200 group-hover:-translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none">←</span>
            <span>All people</span>
          </button>
          <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${person.online ? "text-success" : "text-muted"}`}>
            <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${person.online ? "bg-success" : "bg-muted/40"}`} />
            {person.online ? "Online" : "Offline"}
          </span>
        </div>
        <div className="min-w-0 space-y-0.5">
          <h3 className="truncate text-lg font-semibold text-fg" title={person.label}>{person.label}</h3>
          {person.email ? <p className="truncate font-mono text-xs text-muted" title={person.email}>{person.email}</p> : null}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3 text-xs">
        <div className="min-w-0 rounded-md border border-border/60 bg-card/20 p-2.5">
          <dt className="text-muted">Last active</dt>
          <dd className="mt-1 truncate font-medium text-fg" title={formatDate(person.lastSeenAt)}>{formatDate(person.lastSeenAt)}</dd>
        </div>
        <div className="min-w-0 rounded-md border border-border/60 bg-card/20 p-2.5">
          <dt className="text-muted">Location</dt>
          <dd className="mt-1 truncate font-medium text-fg" title={person.location ?? "Unavailable"}>{person.location ?? "Unavailable"}</dd>
        </div>
        {userId ? (
          <>
            <div className="min-w-0 rounded-md border border-border/60 bg-card/20 p-2.5">
              <dt className="text-muted">Total generations</dt>
              <dd className="mt-1 font-medium tabular-nums text-fg">{(person.totalGenerationCount ?? 0).toLocaleString()}</dd>
            </div>
            <div className="min-w-0 rounded-md border border-border/60 bg-card/20 p-2.5">
              <dt className="text-muted">Hosted generations</dt>
              <dd className="mt-1 font-medium tabular-nums text-fg">
                {(person.hostedGenerationCount ?? 0).toLocaleString()} / {(person.hostedGenerationLimit ?? 0).toLocaleString()}
              </dd>
            </div>
          </>
        ) : null}
      </dl>

      {userId ? (
        <form
          key={`${person.id}:${person.hostedGenerationLimit}`}
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const limit = Number(new FormData(event.currentTarget).get("limit"));
            void onMutate({ type: "hosted_generation_limit", userId, limit });
          }}
        >
          <label className="min-w-0 flex-1 space-y-1">
            <span className="text-xs font-medium text-muted">Hosted limit</span>
            <input
              className="mb-field h-9"
              type="number"
              name="limit"
              min={0}
              max={2_147_483_647}
              step={1}
              required
              defaultValue={person.hostedGenerationLimit ?? 0}
            />
          </label>
          <button type="submit" disabled={pending} className="mb-btn h-9 text-xs">
            {pending ? "Saving…" : "Save"}
          </button>
        </form>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {person.userId && person.email ? (
          person.suspended ? (
            <button
              type="button"
              disabled={pending}
              className="mb-btn h-9 text-xs"
              onClick={() => void onMutate({ type: "account_suspended", userId: person.userId!, suspended: false })}
            >
              Restore
            </button>
          ) : (
            <button type="button" disabled={pending} className="mb-btn h-9 text-xs" onClick={() => onSuspend({ userId: person.userId!, email: person.email! })}>Suspend</button>
          )
        ) : null}
        <button
          type="button"
          disabled={pending}
          className={`mb-btn h-9 text-xs${person.voteBlocked ? "" : " mb-btn-danger"}`}
          onClick={() => void onMutate({ type: "votes_blocked", personId: person.id, blocked: !person.voteBlocked })}
        >
          {person.voteBlocked ? "Unblock votes" : "Block votes"}
        </button>
      </div>
      {person.suspensionReason ? <p className="break-words text-xs text-muted">{person.suspensionReason}</p> : null}

      {person.userId ? (
        <section className="min-w-0 space-y-2.5">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">Prompts</h4>
            <span className="text-[11px] tabular-nums text-muted">{person.contributions.length}</span>
          </div>
          <div className={person.contributions.length > 0 ? "max-h-40 min-w-0 divide-y divide-border/60 overflow-y-auto rounded-md border border-border/60 bg-card/10 px-3" : ""}>
            {person.contributions.map((candidate) => {
              const content = (
                <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="min-w-0 truncate font-medium" title={candidate.prompt}>{candidate.prompt}</span>
                  <span className="shrink-0 text-xs text-muted">{candidate.status}</span>
                </div>
              );
              const className = "flex min-h-10 min-w-0 items-center py-2 text-xs";
              return candidate.status === "Hidden" || candidate.status === "Removed" ? (
                <div key={candidate.publicId} className={className}>{content}</div>
              ) : (
                <Link key={candidate.publicId} href={`/gallery/${candidate.publicId}`} className={`${className} hover:text-accent`}>{content}</Link>
              );
            })}
            {person.contributions.length === 0 ? <p className="py-3 text-xs text-muted">No prompts</p> : null}
          </div>
        </section>
      ) : null}

      <section className="min-w-0 space-y-2.5">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">Vote history</h4>
          <span className="text-[11px] tabular-nums text-muted">{person.votes.length}</span>
        </div>
        <div className={person.votes.length > 0 ? "max-h-80 min-w-0 space-y-2 overflow-y-auto pr-1" : ""}>
          {person.votes.map((vote) => (
            <article key={vote.id} className="min-w-0 rounded-lg border border-border/70 bg-card/20 p-3 transition-colors hover:border-border hover:bg-card/40">
              <div className="flex items-center justify-between gap-2">
                <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  vote.source === "Arena"
                    ? "border border-border/80 bg-bg/70 text-muted"
                    : "border border-accent/30 bg-accent/10 text-accent"
                }`}>
                  {vote.source === "Gallery" ? (
                    <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                  ) : null}
                  {vote.source}
                </span>
                <time className="shrink-0 text-[11px] tabular-nums text-muted" dateTime={vote.createdAt}>
                  {dateTime.format(new Date(vote.createdAt))}
                </time>
              </div>

              <p className="mt-2 truncate text-xs font-medium text-fg" title={vote.prompt}>
                {vote.prompt}
              </p>

              {vote.source === "Arena" && vote.modelA && vote.modelB ? (
                <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs">
                  <span
                    className={`inline-flex min-w-0 max-w-[44%] items-center gap-1 rounded px-2 py-0.5 text-[11px] ${
                      vote.choice === "A"
                        ? "border border-accent/40 bg-accent/15 font-semibold text-accent"
                        : "border border-border/60 bg-bg/40 text-muted"
                    }`}
                    title={`${vote.modelA}${vote.choice === "A" ? " (Voted)" : ""}`}
                  >
                    {vote.choice === "A" ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /> : null}
                    <span className="truncate">{vote.modelA}</span>
                  </span>

                  <span className="shrink-0 text-[10px] font-medium text-muted/60">vs</span>

                  <span
                    className={`inline-flex min-w-0 max-w-[44%] items-center gap-1 rounded px-2 py-0.5 text-[11px] ${
                      vote.choice === "B"
                        ? "border border-accent/40 bg-accent/15 font-semibold text-accent"
                        : "border border-border/60 bg-bg/40 text-muted"
                    }`}
                    title={`${vote.modelB}${vote.choice === "B" ? " (Voted)" : ""}`}
                  >
                    {vote.choice === "B" ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /> : null}
                    <span className="truncate">{vote.modelB}</span>
                  </span>

                  {vote.choice === "TIE" ? (
                    <span className="ml-auto shrink-0 rounded border border-border/80 bg-bg/70 px-1.5 py-0.5 text-[10px] font-medium text-muted">
                      Tie
                    </span>
                  ) : vote.choice === "BOTH_BAD" ? (
                    <span className="ml-auto shrink-0 rounded border border-danger/30 bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger">
                      Both bad
                    </span>
                  ) : null}
                </div>
              ) : null}

              {vote.source === "Gallery" && vote.href ? (
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[11px] text-muted">Upvoted prompt</span>
                  <Link
                    href={vote.href}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-accent transition-colors hover:underline focus-visible:outline-none focus-visible:underline"
                  >
                    <span>View in gallery</span>
                    <span aria-hidden="true">→</span>
                  </Link>
                </div>
              ) : null}
            </article>
          ))}
          {person.votes.length === 0 ? <p className="py-3 text-xs text-muted">No public votes</p> : null}
        </div>
      </section>
    </div>
  );
}

export function GalleryAdminDashboard({ dashboard }: { dashboard: Dashboard }) {
  const router = useRouter();
  const [promptFilter, setPromptFilter] = useState<PromptFilter>("latest");
  const [peopleFilter, setPeopleFilter] = useState<PeopleFilter>("online");
  const [promptQuery, setPromptQuery] = useState("");
  const [peopleQuery, setPeopleQuery] = useState("");
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [person, setPerson] = useState<Person | null>(null);
  const [personLoading, setPersonLoading] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [suspendTarget, setSuspendTarget] = useState<{ userId: string; email: string } | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 60_000);
    return () => window.clearInterval(interval);
  }, [router]);

  const prompts = useMemo(() => {
    const query = searchText(promptQuery);
    return dashboard.prompts.filter((prompt) => {
      if (promptFilter === "reported" && prompt.reportCount === 0) return false;
      if (promptFilter === "hidden" && !prompt.hidden) return false;
      if (promptFilter === "selected" && !prompt.selected) return false;
      return !query || `${prompt.prompt} ${prompt.uploader.email} ${prompt.uploader.publicNickname ?? ""}`.toLocaleLowerCase().includes(query);
    });
  }, [dashboard.prompts, promptFilter, promptQuery]);

  const people = useMemo(() => {
    const query = searchText(peopleQuery);
    return dashboard.people.filter((entry) => {
      if (peopleFilter === "online" && !entry.online) return false;
      if (peopleFilter === "suspended" && !entry.suspended) return false;
      return !query || `${entry.label} ${entry.email ?? ""} ${entry.location ?? ""}`.toLocaleLowerCase().includes(query);
    });
  }, [dashboard.people, peopleFilter, peopleQuery]);

  async function loadPerson(personId: string) {
    setSelectedPersonId(personId);
    setPersonLoading(true);
    setPerson(null);
    const result = await loadGalleryAdminPerson(personId);
    setPersonLoading(false);
    if (result.ok) setPerson(result.person);
    else setNotice(result.error);
  }

  async function mutate(mutation: Mutation, key: string = mutation.type): Promise<boolean> {
    setPendingKey(key);
    setNotice(null);
    const result = await mutateGalleryAdmin(mutation);
    setPendingKey(null);
    if (!result.ok) {
      setNotice(result.error);
      return false;
    }
    setNotice(null);
    if (selectedPersonId && (
      mutation.type === "account_suspended" ||
      mutation.type === "votes_blocked" ||
      mutation.type === "hosted_generation_limit"
    )) {
      await loadPerson(selectedPersonId);
    }
    startTransition(() => router.refresh());
    return true;
  }

  function openSuspend(target: { userId: string; email: string }) {
    setNotice(null);
    setSuspendTarget(target);
  }

  return (
    <>
      {notice ? <p role="alert" className="text-sm text-danger">{notice}</p> : null}
      <div className="grid items-start gap-8 lg:h-[calc(100dvh-8rem)] lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <section className="min-w-0 lg:flex lg:h-full lg:min-h-0 lg:flex-col" aria-labelledby="admin-prompts-title">
          <div className="flex flex-wrap items-end justify-between gap-5 border-b border-border pb-4">
            <div>
              <h2 id="admin-prompts-title" className="text-xl font-semibold text-fg">Prompts</h2>
              <p className="mt-1 text-sm text-muted">Newest first</p>
            </div>
            <label className="w-full sm:w-72">
              <span className="sr-only">Search prompts</span>
              <input className="mb-field h-10" type="search" placeholder="Search prompts" value={promptQuery} onChange={(event) => setPromptQuery(event.target.value)} />
            </label>
          </div>
          <div className="flex flex-wrap gap-5 border-b border-border py-2" aria-label="Prompt filters">
            {(["latest", "reported", "hidden", "selected"] as const).map((filter) => (
              <FilterButton key={filter} active={promptFilter === filter} onClick={() => setPromptFilter(filter)}>
                {filter[0].toUpperCase() + filter.slice(1)}
              </FilterButton>
            ))}
          </div>
          <div className="divide-y divide-border border-b border-border lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain lg:pr-1">
            {prompts.map((prompt) => {
              const key = `prompt:${prompt.publicId}`;
              return (
                <article key={prompt.publicId} className="grid gap-4 py-5 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-center">
                  <div className="min-w-0 space-y-2">
                    {prompt.hidden ? (
                      <p className="break-words text-base font-semibold text-fg">{prompt.prompt}</p>
                    ) : (
                      <Link href={`/gallery/${prompt.publicId}`} className="block break-words text-base font-semibold text-fg transition-colors hover:text-accent focus-visible:outline-none focus-visible:text-accent">{prompt.prompt}</Link>
                    )}
                    <p className="break-all text-xs text-muted">{prompt.uploader.email}{prompt.uploader.publicNickname ? ` · ${prompt.uploader.publicNickname}` : ""}</p>
                    <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                      <time dateTime={prompt.publishedAt}>{dateTime.format(new Date(prompt.publishedAt))}</time>
                      <span>{prompt.upvoteCount.toLocaleString()} votes</span>
                      {prompt.hidden ? <span className="font-medium text-danger">Hidden</span> : prompt.selected ? <span className="font-medium text-accent">Selected</span> : <span>Live</span>}
                      {prompt.reportCount > 0 ? <span className="font-medium text-danger">{prompt.reportCount} {prompt.reportCount === 1 ? "report" : "reports"}</span> : null}
                      {prompt.uploader.suspended ? <span>Contributor suspended</span> : null}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 xl:justify-end">
                    {!prompt.hidden || prompt.selected ? (
                      <button type="button" disabled={Boolean(pendingKey)} className={`mb-btn h-10${prompt.selected ? "" : " mb-btn-primary"}`} onClick={() => void mutate({ type: "candidate_selected", publicId: prompt.publicId, selected: !prompt.selected }, key)}>
                        {pendingKey === key ? "Saving…" : prompt.selected ? "Unselect" : "Select"}
                      </button>
                    ) : null}
                    <button type="button" disabled={Boolean(pendingKey)} className="mb-btn h-10" onClick={() => void mutate({ type: "candidate_hidden", publicId: prompt.publicId, hidden: !prompt.hidden }, key)}>
                      {pendingKey === key ? "Saving…" : prompt.hidden ? "Unhide" : "Hide"}
                    </button>
                    {!prompt.uploader.suspended ? (
                      <button type="button" disabled={Boolean(pendingKey)} className="mb-btn h-10" onClick={() => openSuspend({ userId: prompt.uploader.id, email: prompt.uploader.email })}>Suspend</button>
                    ) : null}
                  </div>
                </article>
              );
            })}
            {prompts.length === 0 ? <p className="py-10 text-sm text-muted">No matching prompts</p> : null}
          </div>
        </section>

        <aside className="grid min-h-0 min-w-0 w-full gap-8 lg:sticky lg:top-24 lg:h-full lg:grid-rows-[minmax(18rem,3fr)_minmax(14rem,2fr)] lg:border-l lg:border-border lg:pl-8">
          <section className="flex min-h-0 min-w-0 w-full flex-col" aria-labelledby="admin-people-title">
            {selectedPersonId ? (
              <div className="min-h-0 min-w-0 overflow-y-auto pr-1">
                <PersonInspector
                  person={person}
                  loading={personLoading}
                  pending={Boolean(pendingKey)}
                  onBack={() => { setSelectedPersonId(null); setPerson(null); }}
                  onReload={() => void loadPerson(selectedPersonId)}
                  onMutate={mutate}
                  onSuspend={openSuspend}
                />
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3">
                  <h2 id="admin-people-title" className="text-xl font-semibold text-fg">People</h2>
                  <label className="w-full xl:w-52">
                    <span className="sr-only">Search people</span>
                    <input className="mb-field h-9" type="search" placeholder="Search people" value={peopleQuery} onChange={(event) => setPeopleQuery(event.target.value)} />
                  </label>
                </div>
                <div className="flex gap-4 border-b border-border py-1" aria-label="People filters">
                  {(["online", "all", "suspended"] as const).map((filter) => (
                    <FilterButton key={filter} active={peopleFilter === filter} onClick={() => setPeopleFilter(filter)}>
                      {filter[0].toUpperCase() + filter.slice(1)}
                    </FilterButton>
                  ))}
                </div>
                <div className="max-h-[32rem] min-h-0 flex-1 divide-y divide-border overflow-y-auto border-b border-border pr-1 lg:max-h-none">
                  {people.map((entry) => (
                    <button key={entry.id} type="button" className="flex min-h-14 w-full items-center justify-between gap-3 py-3 text-left transition-colors hover:text-accent focus-visible:outline-none focus-visible:text-accent" onClick={() => void loadPerson(entry.id)}>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{entry.label}</span>
                        <span className="block truncate text-xs text-muted">
                          {entry.totalGenerationCount == null
                            ? entry.location ?? formatDate(entry.lastSeenAt)
                            : `${entry.totalGenerationCount.toLocaleString()} total · ${(entry.hostedGenerationCount ?? 0).toLocaleString()} / ${(entry.hostedGenerationLimit ?? 0).toLocaleString()} hosted`}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-[11px] text-muted">
                        {entry.suspended ? "Suspended" : entry.voteBlocked ? "Votes blocked" : null}
                        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${entry.online ? "bg-success" : "bg-muted/50"}`} />
                        <span className="sr-only">{entry.online ? "Online" : "Offline"}</span>
                      </span>
                    </button>
                  ))}
                  {people.length === 0 ? <p className="py-8 text-sm text-muted">No matching people</p> : null}
                </div>
              </>
            )}
          </section>

          <section className="flex min-h-0 flex-col" aria-labelledby="admin-activity-title">
            <div className="border-b border-border pb-3">
              <h2 id="admin-activity-title" className="text-lg font-semibold text-fg">Activity</h2>
            </div>
            <div className="max-h-[32rem] min-h-0 flex-1 divide-y divide-border overflow-y-auto border-b border-border pr-1 lg:max-h-none">
              {dashboard.activity.map((record) => (
                <article key={record.id} className="space-y-1 py-3 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <p className="break-words font-medium text-fg">{record.summary}</p>
                    <time className="shrink-0 text-[11px] text-muted" dateTime={record.createdAt}>{dateTime.format(new Date(record.createdAt))}</time>
                  </div>
                  <p className="text-xs text-muted">{(record.action ?? record.kind).replaceAll("_", " ").toLowerCase()} · {targetLabel(record.target)}{record.detail ? ` · ${record.detail}` : ""}{record.reason ? ` · ${record.reason.toLowerCase()}` : ""}{record.actor ? ` · ${record.actor}` : ""}{record.subject ? ` · ${record.subject}` : ""}</p>
                  {record.note ? <p className="break-words text-xs text-muted">{record.note}</p> : null}
                  {record.exampleId ? (
                    <button
                      type="button"
                      disabled={Boolean(pendingKey)}
                      className="mt-1 text-xs font-semibold text-fg underline-offset-4 hover:underline focus-visible:outline-none focus-visible:text-accent"
                      onClick={() => void mutate(
                        { type: "example_hidden", exampleId: record.exampleId! },
                        `example:${record.exampleId}`,
                      )}
                    >
                      {pendingKey === `example:${record.exampleId}` ? "Hiding…" : "Hide build"}
                    </button>
                  ) : null}
                </article>
              ))}
              {dashboard.activity.length === 0 ? <p className="py-8 text-sm text-muted">No moderation activity</p> : null}
            </div>
          </section>
        </aside>
      </div>

      <SuspendDialog
        target={suspendTarget}
        pending={Boolean(pendingKey)}
        error={notice}
        onClose={() => setSuspendTarget(null)}
        onSuspend={(reason) => suspendTarget
          ? mutate({ type: "account_suspended", userId: suspendTarget.userId, suspended: true, reason }, `user:${suspendTarget.userId}`)
          : Promise.resolve(false)}
      />
    </>
  );
}
