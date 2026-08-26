"use client";

import { useState } from "react";

export function GalleryVoteButton({
  candidateId,
  initialCount,
  initialUpvoted,
}: {
  candidateId: string;
  initialCount: number;
  initialUpvoted: boolean;
}) {
  const [upvoted, setUpvoted] = useState(initialUpvoted);
  const [count, setCount] = useState(initialCount);
  const [pending, setPending] = useState(false);

  async function setVote(next: boolean) {
    if (pending) return;
    const previous = { upvoted, count };
    setUpvoted(next);
    setCount((value) => Math.max(0, value + (next ? 1 : -1)));
    setPending(true);
    try {
      const response = await fetch(`/api/gallery/candidates/${encodeURIComponent(candidateId)}/vote`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upvoted: next }),
      });
      if (!response.ok) throw new Error("Vote failed");
      const result = (await response.json()) as { upvoted: boolean; count: number };
      setUpvoted(result.upvoted);
      setCount(result.count);
    } catch {
      setUpvoted(previous.upvoted);
      setCount(previous.count);
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      aria-label={`${upvoted ? "Remove vote" : "Upvote"}. ${count} votes`}
      aria-pressed={upvoted}
      disabled={pending}
      onClick={() => void setVote(!upvoted)}
      className={`inline-flex min-h-11 items-center gap-2 px-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-65 motion-reduce:transition-none ${upvoted ? "text-accent" : "text-muted hover:text-fg"}`}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill={upvoted ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.7">
        <path d="m12 4 7 7h-4v8H9v-8H5l7-7Z" strokeLinejoin="round" />
      </svg>
      <span>{count}</span>
    </button>
  );
}
