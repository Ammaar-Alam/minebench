import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentAccount } from "@/lib/auth/account";
import { getGalleryAdminDashboard } from "@/lib/gallery/service";
import { AdminConfirmButton } from "@/components/gallery/AdminConfirmButton";
import {
  blockVoteIdentityAction,
  hideCandidateAction,
  hideExampleAction,
  restoreAccountAction,
  reverseVoteBlockAction,
  selectCandidateAction,
  suspendAccountAction,
} from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Gallery Admin",
  robots: { index: false, follow: false },
};

function snapshotText(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  for (const key of ["prompt", "content", "model"]) {
    if (typeof snapshot[key] === "string") return snapshot[key].slice(0, 240);
  }
  return null;
}

export default async function GalleryAdminPage() {
  const account = await getCurrentAccount();
  if (!account) redirect("/sign-in?next=/admin/gallery");
  if (!account.isMineBenchAdmin) notFound();
  const dashboard = await getGalleryAdminDashboard(account.id);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-12 py-6 sm:py-12">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-7">
        <div>
          <p className="mb-eyebrow">MineBench</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">Gallery admin</h1>
        </div>
        <Link href="/gallery" className="mb-btn h-10">View Gallery</Link>
      </header>

      <section className="space-y-4" aria-labelledby="moderation-title">
        <h2 id="moderation-title" className="text-xl font-semibold text-fg">Moderation</h2>
        <div className="divide-y divide-border border-y border-border">
          {dashboard.moderation.map((record) => (
            <article key={record.id} className="grid gap-3 py-4 text-sm lg:grid-cols-[9rem_1fr_auto] lg:items-start">
              <div>
                <p className="font-medium text-fg">{record.kind.replaceAll("_", " ")}</p>
                <p className="mt-1 text-xs text-muted">{new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(record.createdAt)}</p>
              </div>
              <div className="min-w-0">
                <p className="break-words text-fg">{snapshotText(record.safeSnapshot) ?? record.action ?? record.reportReason ?? record.target}</p>
                {record.note ? <p className="mt-1 break-words text-muted">{record.note}</p> : null}
              </div>
              <div className="flex flex-wrap gap-2 lg:justify-end">
                {record.candidate?.publicId ? (
                  <form action={hideCandidateAction}>
                    <input type="hidden" name="publicId" value={record.candidate.publicId} />
                    <AdminConfirmButton message="Hide this prompt from Gallery?">Hide prompt</AdminConfirmButton>
                  </form>
                ) : null}
                {record.exampleId ? (
                  <form action={hideExampleAction}>
                    <input type="hidden" name="exampleId" value={record.exampleId} />
                    <AdminConfirmButton message="Hide this example and remove its full artifacts?">Hide example</AdminConfirmButton>
                  </form>
                ) : null}
                {record.actorUserId || record.sessionHash || record.ipHmac ? (
                  <form action={blockVoteIdentityAction}>
                    <input type="hidden" name="recordId" value={record.id} />
                    <AdminConfirmButton message="Silently block voting from the known identities on this record?">Block votes</AdminConfirmButton>
                  </form>
                ) : null}
              </div>
            </article>
          ))}
          {dashboard.moderation.length === 0 ? <p className="py-8 text-sm text-muted">No moderation records</p> : null}
        </div>
      </section>

      <section className="space-y-4" aria-labelledby="candidates-title">
        <h2 id="candidates-title" className="text-xl font-semibold text-fg">Candidates</h2>
        <div className="divide-y divide-border border-y border-border">
          {dashboard.candidates.map((candidate) => (
            <article key={candidate.publicId} className="grid gap-4 py-4 lg:grid-cols-[1fr_auto] lg:items-center">
              <div className="min-w-0">
                <Link href={`/gallery/${candidate.publicId}`} className="font-medium text-fg hover:text-accent">{candidate.promptText}</Link>
                <p className="mt-1 text-xs text-muted">{candidate.upvoteCount} votes · {candidate.uploader.publicNickname ?? candidate.uploader.email}{candidate.selectedAt ? " · Selected" : ""}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {!candidate.selectedAt ? (
                  <form action={selectCandidateAction}>
                    <input type="hidden" name="publicId" value={candidate.publicId} />
                    <button className="mb-btn mb-btn-primary h-9" type="submit">Select</button>
                  </form>
                ) : null}
                <form action={hideCandidateAction}>
                  <input type="hidden" name="publicId" value={candidate.publicId} />
                  <AdminConfirmButton message="Hide this prompt from Gallery?">Hide</AdminConfirmButton>
                </form>
                {!candidate.uploader.gallerySuspendedAt ? (
                  <form action={suspendAccountAction} className="flex gap-2">
                    <input type="hidden" name="userId" value={candidate.uploaderId} />
                    <input className="mb-field h-9 max-w-48" name="reason" aria-label="Safe suspension reason" placeholder="Reason" maxLength={240} />
                    <AdminConfirmButton message="Suspend this account from Gallery publishing?">Suspend</AdminConfirmButton>
                  </form>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="grid gap-8 lg:grid-cols-2">
        <div className="space-y-4">
          <h2 className="text-xl font-semibold text-fg">Suspended accounts</h2>
          <div className="divide-y divide-border border-y border-border">
            {dashboard.suspendedAccounts.map((user) => (
              <div key={user.id} className="flex items-center justify-between gap-4 py-4 text-sm">
                <div className="min-w-0"><p className="truncate text-fg">{user.publicNickname ?? user.email}</p><p className="truncate text-muted">{user.gallerySuspensionReason ?? "No public reason"}</p></div>
                <form action={restoreAccountAction}>
                  <input type="hidden" name="userId" value={user.id} />
                  <button className="mb-btn h-9" type="submit">Restore</button>
                </form>
              </div>
            ))}
            {dashboard.suspendedAccounts.length === 0 ? <p className="py-8 text-sm text-muted">No suspended accounts</p> : null}
          </div>
        </div>
        <div className="space-y-4">
          <h2 className="text-xl font-semibold text-fg">Vote blocks</h2>
          <div className="divide-y divide-border border-y border-border">
            {dashboard.voteBlocks.map((block) => (
              <div key={block.id} className="flex items-center justify-between gap-4 py-4 text-sm">
                <div><p className="text-fg">{block.userId ? "Account and known identities" : "Anonymous identities"}</p><p className="text-muted">{block.internalNote ?? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(block.createdAt)}</p></div>
                <form action={reverseVoteBlockAction}>
                  <input type="hidden" name="blockId" value={block.id} />
                  <button className="mb-btn h-9" type="submit">Reverse</button>
                </form>
              </div>
            ))}
            {dashboard.voteBlocks.length === 0 ? <p className="py-8 text-sm text-muted">No active vote blocks</p> : null}
          </div>
        </div>
      </section>
    </div>
  );
}
