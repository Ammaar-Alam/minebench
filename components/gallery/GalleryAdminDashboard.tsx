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
  | { type: "votes_blocked"; personId: string; blocked: boolean };

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

  return (
    <div className="min-h-0 space-y-5">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <button
            type="button"
            className="group -ml-2 inline-flex min-h-10 min-w-10 items-center justify-center text-muted transition-colors duration-150 hover:text-fg focus-visible:outline-none focus-visible:text-accent"
            aria-label="Back to people"
            onClick={onBack}
          >
            <span aria-hidden="true" className="transition-transform duration-200 group-hover:-translate-x-0.5 motion-reduce:transform-none motion-reduce:transition-none">←</span>
          </button>
          <span className={`text-xs font-medium ${person.online ? "text-success" : "text-muted"}`}>
            {person.online ? "Online" : "Offline"}
          </span>
        </div>
        <div className="min-w-0 space-y-1">
          <h3 className="truncate text-lg font-semibold text-fg">{person.label}</h3>
          {person.email ? <p className="truncate text-xs text-muted">{person.email}</p> : null}
        </div>
      </div>

      <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <div><dt className="text-xs text-muted">Last active</dt><dd className="mt-1 text-fg">{formatDate(person.lastSeenAt)}</dd></div>
        <div><dt className="text-xs text-muted">Location</dt><dd className="mt-1 text-fg">{person.location ?? "Unavailable"}</dd></div>
      </dl>

      <div className="flex flex-wrap gap-2">
        {person.userId && person.email ? (
          person.suspended ? (
            <button
              type="button"
              disabled={pending}
              className="mb-btn h-10"
              onClick={() => void onMutate({ type: "account_suspended", userId: person.userId!, suspended: false })}
            >
              Restore
            </button>
          ) : (
            <button type="button" disabled={pending} className="mb-btn h-10" onClick={() => onSuspend({ userId: person.userId!, email: person.email! })}>Suspend</button>
          )
        ) : null}
        <button
          type="button"
          disabled={pending}
          className={`mb-btn h-10${person.voteBlocked ? "" : " mb-btn-danger"}`}
          onClick={() => void onMutate({ type: "votes_blocked", personId: person.id, blocked: !person.voteBlocked })}
        >
          {person.voteBlocked ? "Unblock votes" : "Block votes"}
        </button>
      </div>
      {person.suspensionReason ? <p className="text-sm text-muted">{person.suspensionReason}</p> : null}

      {person.userId ? (
        <section className="space-y-3">
          <h4 className="text-sm font-semibold text-fg">Prompts</h4>
          <div className={person.contributions.length > 0 ? "max-h-40 divide-y divide-border overflow-y-auto border-y border-border" : ""}>
            {person.contributions.map((candidate) => {
              const content = (
                <><span className="truncate">{candidate.prompt}</span><span className="shrink-0 text-xs text-muted">{candidate.status}</span></>
              );
              const className = "flex min-h-11 items-center justify-between gap-3 py-2 text-sm";
              return candidate.status === "Hidden" || candidate.status === "Removed" ? (
                <div key={candidate.publicId} className={className}>{content}</div>
              ) : (
                <Link key={candidate.publicId} href={`/gallery/${candidate.publicId}`} className={`${className} hover:text-accent`}>{content}</Link>
              );
            })}
            {person.contributions.length === 0 ? <p className="text-sm text-muted">No prompts</p> : null}
          </div>
        </section>
      ) : null}

      <section className="space-y-3">
        <h4 className="text-sm font-semibold text-fg">Votes</h4>
        <div className={person.votes.length > 0 ? "max-h-72 divide-y divide-border overflow-y-auto border-y border-border" : ""}>
          {person.votes.map((vote) => {
            const content = (
              <>
                <span className="min-w-0"><span className="block truncate text-fg">{vote.prompt}</span><span className="text-xs text-muted">{vote.source} · {vote.result}</span></span>
                <time className="shrink-0 text-[11px] text-muted" dateTime={vote.createdAt}>{dateTime.format(new Date(vote.createdAt))}</time>
              </>
            );
            return vote.href ? (
              <Link key={vote.id} href={vote.href} className="flex min-h-12 items-center justify-between gap-3 py-2 text-sm hover:text-accent">{content}</Link>
            ) : (
              <div key={vote.id} className="flex min-h-12 items-center justify-between gap-3 py-2 text-sm">{content}</div>
            );
          })}
          {person.votes.length === 0 ? <p className="text-sm text-muted">No public votes</p> : null}
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
    if (selectedPersonId && (mutation.type === "account_suspended" || mutation.type === "votes_blocked")) {
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
      <div className="grid items-start gap-10 lg:h-[calc(100dvh-8rem)] lg:grid-cols-[minmax(0,1.7fr)_minmax(20rem,0.8fr)]">
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

        <aside className="grid min-h-0 gap-8 lg:sticky lg:top-24 lg:h-full lg:grid-rows-[minmax(18rem,3fr)_minmax(14rem,2fr)] lg:border-l lg:border-border lg:pl-8">
          <section className="flex min-h-0 flex-col" aria-labelledby="admin-people-title">
            {selectedPersonId ? (
              <div className="min-h-0 overflow-y-auto pr-1">
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
                      <span className="min-w-0"><span className="block truncate text-sm font-medium">{entry.label}</span><span className="block truncate text-xs text-muted">{entry.location ?? formatDate(entry.lastSeenAt)}</span></span>
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
