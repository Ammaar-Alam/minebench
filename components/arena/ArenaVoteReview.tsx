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
          <span className="block truncate text-sm font-semibold text-fg" title={`${session.label} · ${session.sessionId}`}>{session.label}</span>
          {session.lastVoteAt ? <time className="block text-xs text-muted" dateTime={session.lastVoteAt}>{formatDate(session.lastVoteAt)}</time> : <span className="block text-xs text-muted">No recent votes</span>}
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
  const [votesError, setVotesError] = useState<string | null>(null);
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<"remove" | "block" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const listRequest = useRef(0);
  const votesRequest = useRef(0);
  const activeSession = useRef<string | null>(null);

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
    if (sessionId !== activeSession.current) return;
    const request = ++votesRequest.current;
    setVotesLoading(true);
    setVotesError(null);
    try {
      const result = await loadArenaVotePage(sessionId, cursor ?? undefined);
      if (request !== votesRequest.current || sessionId !== activeSession.current) return;
      if (!result.ok) {
        setVotesError(result.error);
        return;
      }
      const voteIds = result.data.votes.map((vote) => vote.id);
      setVotes((current) => append ? [...current, ...result.data.votes] : result.data.votes);
      setLoadedSessionId(sessionId);
      setPageVoteIds(voteIds);
      setNextCursor(result.data.nextCursor);
      if (!append) {
        const liveIds = new Set(voteIds);
        setSelectedVoteIds((current) => new Set([...current].filter((id) => liveIds.has(id))));
      }
    } catch {
      if (request === votesRequest.current) setVotesError("Could not load vote history.");
    } finally {
      if (request === votesRequest.current) setVotesLoading(false);
    }
  }, []);

  const selectSession = useCallback((sessionId: string | null) => {
    if (sessionId === activeSession.current) return;
    activeSession.current = sessionId;
    votesRequest.current += 1;
    setLoadedSessionId(null);
    setVotesError(null);
    setSelectedSessionId(sessionId);
    setSelectedVoteIds(new Set());
    setVotes([]);
    setPageVoteIds([]);
    setNextCursor(null);
    setNotice(null);
  }, []);

  useEffect(() => {
    void loadList();
    return () => { listRequest.current += 1; };
  }, [loadList, refreshedAt]);

  useEffect(() => {
    if (!selectedSessionId) return;
    void loadVotes(selectedSessionId);
    return () => { votesRequest.current += 1; };
  }, [loadVotes, selectedSessionId]);

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

  useEffect(() => {
    if (selectedSessionId && sessions.some((session) => session.sessionId === selectedSessionId)) return;
    selectSession(sessions[0]?.sessionId ?? null);
  }, [sessions, selectedSessionId, selectSession]);

  const selectedSession = useMemo(() => (
    data?.sessions.find((session) => session.sessionId === selectedSessionId) ?? null
  ), [data, selectedSessionId]);
  const busy = votesLoading || pendingAction !== null;
  const pageSelected = pageVoteIds.length > 0 && pageVoteIds.every((id) => selectedVoteIds.has(id));
  const hasNewVotes = loadedSessionId === selectedSessionId && selectedSession?.lastVoteAt &&
    (!votes[0] || selectedSession.lastVoteAt > votes[0].createdAt ||
      (selectedSession.lastVoteAt === votes[0].createdAt && (selectedSession.lastVoteId ?? "") > votes[0].id));

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
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border pb-2">
        <h2 id="arena-vote-review-title" className="sr-only">Votes</h2>
        <div className="flex flex-wrap items-center gap-5" aria-label="Vote session filters">
          {([
            ["suspicious", "Suspicious", counts.suspicious],
            ["all", "All", counts.all],
            ["restricted", "Restricted", counts.restricted],
          ] as const).map(([key, label, count]) => (
            <FilterButton key={key} active={filter === key} onClick={() => setFilter(key)}>
              {label} <span className="ml-1 text-xs text-muted">{count.toLocaleString()}</span>
            </FilterButton>
          ))}
        </div>
        <div className="flex items-center gap-4">
          <span className="text-xs text-muted" title={data ? `${formatDate(data.since)} – ${formatDate(data.until)}` : undefined}>Last 24 hours</span>
          <label className="w-48 sm:w-60">
            <span className="sr-only">Search vote sessions</span>
            <input className="mb-field h-10" type="search" placeholder="Search sessions" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
        </div>
      </div>

      {sessions.length === 0 ? (
        <div className="flex min-h-48 flex-1 flex-col items-center justify-center gap-3 py-8 text-center">
          {listLoading && !data ? <p role="status" className="text-sm text-muted">Loading votes...</p> : null}
          {data ? <p className="text-sm text-muted">No matching sessions.</p> : null}
          {data && filter === "suspicious" && counts.all > 0 ? (
            <button type="button" className="mb-btn h-10" onClick={() => setFilter("all")}>Show all</button>
          ) : null}
        </div>
      ) : <div className="grid gap-8 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(15rem,0.7fr)_minmax(0,1.6fr)] lg:overflow-hidden">
        <section className="min-w-0 lg:flex lg:min-h-0 lg:flex-col" aria-label="Vote sessions">
          <div className="divide-y divide-border border-b border-border lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain lg:pr-2">
            {sessions.map((session) => (
              <SessionRow
                key={session.sessionId}
                session={session}
                selected={session.sessionId === selectedSessionId}
                disabled={pendingAction !== null}
                onSelect={() => selectSession(session.sessionId)}
              />
            ))}
          </div>
        </section>

        {selectedSession ? <section className="min-w-0 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:pr-2" aria-labelledby="arena-vote-detail-title">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-bg px-1 pb-3 pt-2 lg:sticky lg:top-0 lg:z-10">
            <div className="min-w-0 space-y-1">
              <h3 id="arena-vote-detail-title" className="truncate text-lg font-semibold text-fg" title={selectedSession?.label ?? undefined}>
                {selectedSession?.label ?? "Session"}
              </h3>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="mb-btn h-10" disabled={busy || pageVoteIds.length === 0} onClick={togglePage}>
                {pageSelected ? "Clear page" : "Select page"}
              </button>
              <button type="button" className="mb-btn mb-btn-danger h-10" disabled={busy || selectedVoteIds.size === 0} onClick={() => void removeSelectedVotes()}>
                {pendingAction === "remove" ? "Removing..." : selectedVoteIds.size ? `Remove ${selectedVoteIds.size.toLocaleString()}` : "Remove"}
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

          {selectedSession ? (
            <p className="flex flex-wrap gap-x-4 gap-y-1 py-3 text-xs text-muted">
              <span>{metric(selectedSession.votes, "votes in 24h")}</span>
              <span>{metric(selectedSession.upsets, "ranking upsets")}</span>
              <span>Median gap {formatGap(selectedSession.medianGapSeconds)}</span>
              <span>{votes.length.toLocaleString()} loaded · {selectedVoteIds.size.toLocaleString()} selected</span>
              {hasNewVotes && !votesError ? <button type="button" className="font-medium text-accent underline underline-offset-4" disabled={busy} onClick={() => selectedSessionId && void loadVotes(selectedSessionId)}>New votes</button> : null}
            </p>
          ) : null}
          <div className="divide-y divide-border">
            {selectedSession && !votesError && (votesLoading || loadedSessionId !== selectedSessionId) && votes.length === 0 ? <p role="status" className="py-8 text-sm text-muted">Loading votes...</p> : null}
            {votesError ? <div className="flex items-center gap-3 py-4"><p role="alert" className="text-sm text-danger">{votesError}</p><button type="button" className="mb-btn h-10" disabled={busy} onClick={() => selectedSessionId && void loadVotes(selectedSessionId)}>Retry</button></div> : null}
            {!votesLoading && !votesError && selectedSession && loadedSessionId === selectedSessionId && votes.length === 0 ? <p className="py-8 text-sm text-muted">No votes in this session.</p> : null}
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
          {nextCursor ? (
            <div className="flex justify-center py-4">
              <button type="button" className="mb-btn h-10 px-5" disabled={busy || !selectedSessionId} onClick={() => selectedSessionId && void loadVotes(selectedSessionId, nextCursor, true)}>
                {votesLoading ? "Loading..." : "Load more"}
              </button>
            </div>
          ) : null}
          <details className="mt-4 text-sm text-muted">
            <summary className="min-h-11 cursor-pointer py-3 text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">Review signals</summary>
            <div className="space-y-3 pb-4 leading-relaxed">
              {selectedSession ? <p>A {selectedSession.choiceA} · B {selectedSession.choiceB} · Tie {selectedSession.ties} · Both bad {selectedSession.bothBad}. {selectedSession.rankedVotes} ranked votes, {selectedSession.largeUpsets} large upsets, {selectedSession.fastVotes} fast votes, {selectedSession.repeatVotes} repeats.</p> : null}
              <p>Ranking flags require at least 10 ranked votes: 80% lower-ranked picks, or three wins by bottom-half models against the top 15%. At 20 votes, flags also cover half of gaps below two seconds, 90% same-side decisive choices, 50% repeated matchups, or at least 10 both-bad votes making up 40% of votes.</p>
              <p>These patterns need review; they do not establish abuse or remove votes automatically. Ranks use the latest snapshot{data?.rankingAt ? ` from ${formatDate(data.rankingAt)}` : ""}.</p>
              <p>IP matches use retained hashes, not raw addresses. Shared IPs may include other visitors. <a className="text-fg underline underline-offset-4" href={PRIVACY_POLICY_URL} target="_blank" rel="noreferrer">Privacy policy</a></p>
            </div>
          </details>
        </section> : null}
      </div>}
      {data?.truncated ? <p className="text-xs text-muted">Showing the first 1,000 sessions plus retained restrictions.</p> : null}
    </section>
  );
}
