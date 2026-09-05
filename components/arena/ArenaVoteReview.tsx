"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  blockArenaReviewSession,
  loadArenaVotePage,
  loadArenaVoteReview,
  removeArenaReviewVotes,
} from "@/app/admin/gallery/actions";
import type {
  VoteReviewData,
  VoteReviewPage,
  VoteReviewSession,
} from "@/lib/arena/voteReview";

type Filter = "suspicious" | "all" | "restricted";
type Vote = VoteReviewPage["votes"][number];

const MAX_SELECTED_VOTES = 1000;
const PRIVACY_POLICY_URL = "https://github.com/Ammaar-Alam/minebench/blob/master/docs/privacy-policy.md";

const dateTime = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatDate(value: string | null | undefined): string {
  return value ? dateTime.format(new Date(value)) : "Unavailable";
}

function formatGap(value: number | null): string {
  if (value == null) return "No gap";
  if (value < 60) return `${value.toFixed(value < 10 ? 1 : 0)}s`;
  return `${Math.round(value / 60)}m`;
}

function searchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function choiceLabel(choice: string): string {
  if (choice === "BOTH_BAD") return "Both bad";
  if (choice === "TIE") return "Tie";
  return choice;
}

function rankLabel(rank: number | null): string {
  return rank == null ? "unranked" : `#${rank}`;
}

function FilterButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
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

function metric(value: number, label: string): string {
  return `${value.toLocaleString()} ${label}`;
}

function sessionMatches(session: VoteReviewSession, query: string): boolean {
  if (!query) return true;
  return `${session.label} ${session.sessionId} ${session.location ?? ""} ${session.networkLabel ?? ""}`
    .toLocaleLowerCase()
    .includes(query);
}

function sessionMatchesFilter(session: VoteReviewSession, filter: Filter): boolean {
  if (filter === "restricted") return session.blocked;
  if (filter === "suspicious") return session.flags.length > 0;
  return true;
}

function SessionRow({
  session,
  selected,
  disabled,
  onSelect,
}: {
  session: VoteReviewSession;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      className={`w-full py-4 text-left transition-colors focus-visible:outline-none focus-visible:text-accent ${
        selected ? "text-fg" : "text-muted hover:text-fg"
      }`}
      onClick={onSelect}
    >
      <span className="flex min-w-0 items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-fg" title={session.label}>{session.label}</span>
          <span className="block truncate font-mono text-[11px] text-muted" title={session.sessionId}>{session.sessionId}</span>
        </span>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${
          session.blocked
            ? "border border-danger/35 bg-danger/10 text-danger"
            : session.flags.length > 0
              ? "border border-accent/30 bg-accent/10 text-accent"
              : "border border-border/70 bg-bg/60 text-muted"
        }`}>
          {session.blocked ? "Restricted" : session.flags.length > 0 ? "Suspicious" : "Clear"}
        </span>
      </span>
      <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
        <span>{metric(session.votes, "votes")}</span>
        <span>{metric(session.rankedVotes, "ranked")}</span>
        <span>{metric(session.upsets, "upsets")}</span>
        <span>{metric(session.largeUpsets, "large")}</span>
        <span>{formatGap(session.medianGapSeconds)}</span>
      </span>
      <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
        <span>{session.location ?? "Location unavailable"}</span>
        <span>{session.networkLabel ?? "No network hash"}</span>
        <span>{metric(session.matchingSessions, "matched sessions")}</span>
      </span>
      {session.flags.length > 0 ? (
        <span className="mt-2 flex flex-wrap gap-1.5">
          {session.flags.map((flag) => (
            <span key={flag} className="rounded border border-border/70 bg-card/20 px-1.5 py-0.5 text-[11px] text-muted">
              {flag}
            </span>
          ))}
        </span>
      ) : null}
    </button>
  );
}

function VoteCard({
  checked,
  disabled,
  vote,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  vote: Vote;
  onToggle: () => void;
}) {
  return (
    <article className="grid gap-3 py-4 sm:grid-cols-[auto_minmax(0,1fr)]">
      <label className="flex min-h-11 items-start gap-3 text-sm text-fg">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 accent-current"
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
        />
        <span className="sr-only">Select vote {vote.id}</span>
      </label>
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <time className="text-xs tabular-nums text-muted" dateTime={vote.createdAt}>
            {formatDate(vote.createdAt)}
          </time>
          <span className="rounded border border-border/70 bg-bg/60 px-1.5 py-0.5 text-[11px] font-medium text-muted">
            {choiceLabel(vote.choice)}
          </span>
        </div>
        <p className="break-words text-sm font-medium text-fg">{vote.prompt}</p>
        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <span className={`min-w-0 rounded-md border px-2.5 py-2 ${
            vote.choice === "A" ? "border-accent/45 bg-accent/10 text-accent" : "border-border/70 bg-card/20 text-muted"
          }`}>
            <span className="block truncate font-medium" title={vote.modelA}>A · {vote.modelA}</span>
            <span className="mt-0.5 block tabular-nums">{rankLabel(vote.rankA)}</span>
          </span>
          <span className={`min-w-0 rounded-md border px-2.5 py-2 ${
            vote.choice === "B" ? "border-accent/45 bg-accent/10 text-accent" : "border-border/70 bg-card/20 text-muted"
          }`}>
            <span className="block truncate font-medium" title={vote.modelB}>B · {vote.modelB}</span>
            <span className="mt-0.5 block tabular-nums">{rankLabel(vote.rankB)}</span>
          </span>
        </div>
        <p className="break-all font-mono text-[11px] text-muted">{vote.id}</p>
      </div>
    </article>
  );
}

export function ArenaVoteReview({ refreshedAt }: { refreshedAt: string }) {
  const [data, setData] = useState<VoteReviewData | null>(null);
  const [filter, setFilter] = useState<Filter>("suspicious");
  const [query, setQuery] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [votes, setVotes] = useState<Vote[]>([]);
  const [pageVoteIds, setPageVoteIds] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<VoteReviewPage["nextCursor"]>(null);
  const [selectedVoteIds, setSelectedVoteIds] = useState<Set<string>>(new Set());
  const [listLoading, setListLoading] = useState(true);
  const [votesLoading, setVotesLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<"remove" | "block" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const listRequest = useRef(0);
  const votesRequest = useRef(0);

  const loadList = useCallback(async () => {
    const request = ++listRequest.current;
    setListLoading(true);
    setNotice(null);
    try {
      const result = await loadArenaVoteReview();
      if (request !== listRequest.current) return;
      if (result.ok) setData(result.data);
      else setNotice(result.error);
    } catch {
      if (request === listRequest.current) setNotice("Could not load vote review.");
    } finally {
      if (request === listRequest.current) setListLoading(false);
    }
  }, []);

  const loadVotes = useCallback(async (
    sessionId: string,
    cursor?: VoteReviewPage["nextCursor"],
    append = false,
  ) => {
    const request = ++votesRequest.current;
    setVotesLoading(true);
    setNotice(null);
    if (!append) {
      setVotes([]);
      setPageVoteIds([]);
    }
    try {
      const result = await loadArenaVotePage(sessionId, cursor ?? undefined);
      if (request !== votesRequest.current || sessionId !== selectedSessionId) return;
      if (!result.ok) {
        setNotice(result.error);
        return;
      }
      const voteIds = result.data.votes.map((vote) => vote.id);
      setVotes((current) => append ? [...current, ...result.data.votes] : result.data.votes);
      setPageVoteIds(voteIds);
      setNextCursor(result.data.nextCursor);
      const liveIds = new Set(voteIds);
      setSelectedVoteIds((current) => append
        ? current
        : new Set([...current].filter((id) => liveIds.has(id))));
    } catch {
      if (request === votesRequest.current) setNotice("Could not load vote history.");
    } finally {
      if (request === votesRequest.current) setVotesLoading(false);
    }
  }, [selectedSessionId]);

  useEffect(() => {
    void loadList();
    return () => { listRequest.current += 1; };
  }, [loadList, refreshedAt]);

  useEffect(() => {
    if (!data) return;
    if (selectedSessionId && data.sessions.some((session) => session.sessionId === selectedSessionId)) return;
    const firstSession = data.sessions.find((session) => session.flags.length > 0) ?? data.sessions[0] ?? null;
    setSelectedSessionId(firstSession?.sessionId ?? null);
    setSelectedVoteIds(new Set());
    setVotes([]);
    setPageVoteIds([]);
    setNextCursor(null);
  }, [data, selectedSessionId]);

  useEffect(() => {
    if (!selectedSessionId) return;
    void loadVotes(selectedSessionId);
    return () => { votesRequest.current += 1; };
  }, [loadVotes, selectedSessionId, refreshedAt]);

  const counts = useMemo(() => {
    const sessions = data?.sessions ?? [];
    return {
      all: sessions.length,
      suspicious: sessions.filter((session) => session.flags.length > 0).length,
      restricted: sessions.filter((session) => session.blocked).length,
    };
  }, [data]);

  const sessions = useMemo(() => {
    const text = searchText(query);
    return (data?.sessions ?? []).filter((session) => (
      sessionMatchesFilter(session, filter) && sessionMatches(session, text)
    ));
  }, [data, filter, query]);

  const selectedSession = useMemo(() => (
    data?.sessions.find((session) => session.sessionId === selectedSessionId) ?? null
  ), [data, selectedSessionId]);
  const busy = listLoading || votesLoading || pendingAction !== null;
  const pageSelected = pageVoteIds.length > 0 && pageVoteIds.every((id) => selectedVoteIds.has(id));

  function selectSession(sessionId: string) {
    votesRequest.current += 1;
    setSelectedSessionId(sessionId);
    setSelectedVoteIds(new Set());
    setVotes([]);
    setPageVoteIds([]);
    setNextCursor(null);
    setNotice(null);
  }

  function toggleVote(voteId: string) {
    if (!selectedVoteIds.has(voteId) && selectedVoteIds.size >= MAX_SELECTED_VOTES) {
      setNotice("Selection limit is 1,000 votes.");
      return;
    }
    setSelectedVoteIds((current) => {
      const next = new Set(current);
      if (next.has(voteId)) next.delete(voteId);
      else next.add(voteId);
      return next;
    });
  }

  function togglePage() {
    if (!pageSelected) {
      const newIds = pageVoteIds.filter((id) => !selectedVoteIds.has(id));
      if (selectedVoteIds.size + newIds.length > MAX_SELECTED_VOTES) {
        setNotice("Selection limit is 1,000 votes.");
      }
    }
    setSelectedVoteIds((current) => {
      const next = new Set(current);
      if (pageSelected) {
        pageVoteIds.forEach((id) => next.delete(id));
        return next;
      }
      for (const id of pageVoteIds) {
        if (next.size >= MAX_SELECTED_VOTES) break;
        next.add(id);
      }
      return next;
    });
  }

  async function refreshSelectedSession() {
    await loadList();
    if (selectedSessionId) await loadVotes(selectedSessionId);
  }

  async function removeSelectedVotes() {
    if (!selectedSessionId || selectedVoteIds.size === 0 || busy) return;
    const ids = [...selectedVoteIds];
    if (!window.confirm(`Remove ${ids.length.toLocaleString()} selected votes? This is permanent.`)) return;
    setPendingAction("remove");
    setNotice(null);
    try {
      const result = await removeArenaReviewVotes(selectedSessionId, ids);
      if (!result.ok) {
        setNotice(result.error);
        return;
      }
      setSelectedVoteIds(new Set());
      await refreshSelectedSession();
      setNotice(`Removed ${result.removed.toLocaleString()} votes.`);
    } catch {
      setNotice("Could not remove votes.");
    } finally {
      setPendingAction(null);
    }
  }

  async function toggleRestriction() {
    if (!selectedSession || busy) return;
    const blocked = !selectedSession.blocked;
    const action = blocked ? "Block" : "Unblock";
    const explanation = "Restricts the account when known, plus recorded browser sessions and IP addresses. Shared IPs can affect other visitors.";
    if (!window.confirm(`${explanation}\n\n${action} votes for ${selectedSession.label}?`)) return;
    setPendingAction("block");
    setNotice(null);
    try {
      const result = await blockArenaReviewSession(selectedSession.sessionId, blocked);
      if (!result.ok) {
        setNotice(result.error);
        return;
      }
      await refreshSelectedSession();
      setNotice(blocked ? "Votes restricted." : "Voting restriction removed.");
    } catch {
      setNotice("Could not update this restriction.");
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <section className="flex min-h-0 flex-col gap-4 lg:flex-1" aria-labelledby="arena-vote-review-title">
      {notice ? <p role="alert" className="text-sm text-danger">{notice}</p> : null}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
        <div className="min-w-0">
          <h2 id="arena-vote-review-title" className="text-xl font-semibold text-fg">Votes</h2>
          <p className="mt-1 text-sm text-muted">
            {data ? `${formatDate(data.since)} - ${formatDate(data.until)}` : `Updated ${formatDate(refreshedAt)}`}
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
          <label className="min-w-0 flex-1 sm:w-72 sm:flex-none">
            <span className="sr-only">Search vote sessions</span>
            <input
              className="mb-field h-10"
              type="search"
              placeholder="Search sessions"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <button type="button" className="mb-btn mb-btn-ghost h-10" disabled={busy} onClick={() => void loadList()}>
            {listLoading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-5 border-b border-border py-1" aria-label="Vote session filters">
        {([
          ["suspicious", "Suspicious", counts.suspicious],
          ["all", "All", counts.all],
          ["restricted", "Restricted", counts.restricted],
        ] as const).map(([key, label, count]) => (
          <FilterButton key={key} active={filter === key} onClick={() => setFilter(key)}>
            {label} <span className="text-xs text-muted">{count.toLocaleString()}</span>
          </FilterButton>
        ))}
      </div>

      <div className="grid gap-8 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(16rem,0.85fr)_minmax(0,1.4fr)] lg:overflow-hidden">
        <section className="min-w-0 lg:flex lg:min-h-0 lg:flex-col" aria-label="Vote sessions">
          <div className="divide-y divide-border border-b border-border lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain lg:pr-2">
            {listLoading && !data ? <p className="py-8 text-sm text-muted">Loading votes...</p> : null}
            {sessions.map((session) => (
              <SessionRow
                key={session.sessionId}
                session={session}
                selected={session.sessionId === selectedSessionId}
                disabled={pendingAction !== null}
                onSelect={() => selectSession(session.sessionId)}
              />
            ))}
            {!listLoading && data && sessions.length === 0 ? (
              <div className="space-y-3 py-8">
                <p className="text-sm text-muted">No matching sessions.</p>
                {filter === "suspicious" && counts.all > 0 ? (
                  <button type="button" className="mb-btn h-10" onClick={() => setFilter("all")}>Show all</button>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>

        <section className="min-w-0 lg:flex lg:min-h-0 lg:flex-col" aria-labelledby="arena-vote-detail-title">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
            <div className="min-w-0 space-y-1">
              <h3 id="arena-vote-detail-title" className="truncate text-lg font-semibold text-fg" title={selectedSession?.label ?? undefined}>
                {selectedSession?.label ?? "Session"}
              </h3>
              <p className="max-w-2xl text-sm text-muted">
                Restricts the account when known, plus recorded browser sessions and IP addresses. Shared IPs can affect other visitors.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="mb-btn h-10" disabled={busy || pageVoteIds.length === 0} onClick={togglePage}>
                {pageSelected ? "Clear page" : "Select page"}
              </button>
              <button type="button" className="mb-btn mb-btn-danger h-10" disabled={busy || selectedVoteIds.size === 0} onClick={() => void removeSelectedVotes()}>
                {pendingAction === "remove" ? "Removing..." : `Remove ${selectedVoteIds.size.toLocaleString()}`}
              </button>
              {selectedSession ? (
                <button
                  type="button"
                  className={`mb-btn h-10${selectedSession.blocked ? "" : " mb-btn-danger"}`}
                  disabled={busy}
                  onClick={() => void toggleRestriction()}
                >
                  {pendingAction === "block" ? "Saving..." : selectedSession.blocked ? "Unblock votes" : "Block votes"}
                </button>
              ) : null}
            </div>
          </div>

          <div className="grid gap-3 border-b border-border py-4 text-xs sm:grid-cols-2 xl:grid-cols-4">
            <div className="min-w-0 rounded-md border border-border/60 bg-card/20 p-2.5">
              <p className="text-muted">Choices</p>
              <p className="mt-1 font-medium text-fg">
                A {selectedSession?.choiceA.toLocaleString() ?? 0} · B {selectedSession?.choiceB.toLocaleString() ?? 0}
              </p>
              <p className="mt-1 text-muted">
                Tie {selectedSession?.ties.toLocaleString() ?? 0} · Both bad {selectedSession?.bothBad.toLocaleString() ?? 0}
              </p>
            </div>
            <div className="min-w-0 rounded-md border border-border/60 bg-card/20 p-2.5">
              <p className="text-muted">Ranking signals</p>
              <p className="mt-1 font-medium text-fg">
                {metric(selectedSession?.upsets ?? 0, "upsets")} · {metric(selectedSession?.largeUpsets ?? 0, "large")}
              </p>
              <p className="mt-1 text-muted">{metric(selectedSession?.rankedVotes ?? 0, "ranked votes")}</p>
            </div>
            <div className="min-w-0 rounded-md border border-border/60 bg-card/20 p-2.5">
              <p className="text-muted">Pace</p>
              <p className="mt-1 font-medium text-fg">
                {metric(selectedSession?.repeatVotes ?? 0, "repeat")} · {metric(selectedSession?.fastVotes ?? 0, "fast")}
              </p>
              <p className="mt-1 text-muted">Median {formatGap(selectedSession?.medianGapSeconds ?? null)}</p>
            </div>
            <div className="min-w-0 rounded-md border border-border/60 bg-card/20 p-2.5">
              <p className="text-muted">Network</p>
              <p className="mt-1 truncate font-medium text-fg" title={selectedSession?.location ?? "Location unavailable"}>
                {selectedSession?.location ?? "Location unavailable"}
              </p>
              <p className="mt-1 truncate text-muted" title={selectedSession?.networkLabel ?? "No network hash"}>
                {selectedSession?.networkLabel ?? "No network hash"} · {metric(selectedSession?.matchingSessions ?? 0, "matched")}
              </p>
            </div>
          </div>

          <details className="border-b border-border py-3 text-sm text-muted">
            <summary className="cursor-pointer text-fg">Criteria</summary>
            <p className="mt-2 max-w-3xl">
              Flags identify patterns for manual review: 80% lower-ranked picks or three top-versus-bottom-half upsets across at least 10 ranked votes. At 20 votes, rapid voting, repeated matchups, one-sided choices, and frequent rejections can also qualify. No votes are removed automatically.
            </p>
            <p className="mt-2 max-w-3xl">
              Ranks use the current hourly snapshot{data?.rankingAt ? ` from ${formatDate(data.rankingAt)}` : ""}, so they are context, not vote-time proof.
            </p>
            <p className="mt-2 max-w-3xl">
              IP matching uses existing hashes; locations approximate. <a className="font-medium text-fg underline-offset-4 hover:underline focus-visible:outline-none focus-visible:text-accent" href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer">Privacy policy</a>
            </p>
          </details>

          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 text-xs text-muted">
            <p>
              {votes.length.toLocaleString()} loaded · {selectedVoteIds.size.toLocaleString()} selected
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="mb-btn mb-btn-ghost h-9 text-xs" disabled={busy || !selectedSessionId || !nextCursor} onClick={() => selectedSessionId && void loadVotes(selectedSessionId, nextCursor, true)}>
                {votesLoading ? "Loading..." : "Load more"}
              </button>
            </div>
          </div>

          <div className="divide-y divide-border border-b border-border lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain lg:pr-2">
            {votesLoading && votes.length === 0 ? <p className="py-8 text-sm text-muted">Loading history...</p> : null}
            {!votesLoading && selectedSession && votes.length === 0 ? <p className="py-8 text-sm text-muted">No retained public votes.</p> : null}
            {!selectedSession ? <p className="py-8 text-sm text-muted">Choose a session.</p> : null}
            {votes.map((vote) => (
              <VoteCard
                key={vote.id}
                vote={vote}
                checked={selectedVoteIds.has(vote.id)}
                disabled={busy}
                onToggle={() => toggleVote(vote.id)}
              />
            ))}
          </div>
        </section>
      </div>
      {data?.truncated ? <p className="text-xs text-muted">Showing the first 1,000 sessions plus retained restrictions.</p> : null}
    </section>
  );
}
