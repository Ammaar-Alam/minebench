# Private Checkpoint Evaluations

MineBench can run blind, Arena-style evaluations for unreleased model
checkpoints. Private evaluations are available to approved organizations and
report only to authorized organization members and MineBench administrators.

Each private matchup contains exactly one codenamed checkpoint and one public
MineBench model. Voters see neither identity before acting. After a vote or
skip, the public model is named normally and the private model is revealed only
as its codename. Private checkpoints never appear on the public leaderboard.

## Eligibility and Access

MineBench approves an organization before private evaluation work begins. The
organization's Admins can invite teammates by exact email address and assign
either Admin or Member access.

- **Admin:** all evaluation operations plus teammate invitations, removals, and
  role changes.
- **Member:** evaluation creation, checkpoint configuration, generation,
  upload, activation, pause, resume, close, reporting, and permitted exports.

MineBench administrative access is separate from organization membership and is
used for support, security, and operational control. Organization members can see
only organizations and evaluations to which they have active access.

## Evaluation Lifecycle

An evaluation is a testing program containing one or more related private
checkpoints. Draft evaluations can add checkpoints. Activation freezes the
checkpoint set so the evaluated population does not change while Arena sampling
is running. A new checkpoint after activation requires a new evaluation.

Private evaluations use these top-level states:

- Draft
- Generating
- Ready
- Active
- Paused
- Closed

Pause is reversible. Close is final. An unused draft with no generated builds,
matchups, or votes may be deleted; evaluations with generated or voting history
are closed and retained for the agreed review period.

## Checkpoint Cohorts

A checkpoint cohort can be provided in either of two ways:

- **Endpoint-generated:** MineBench calls a supported private checkpoint endpoint
  using the fixed benchmark prompt cohort and standard generation settings.
- **Provider-uploaded:** the organization uploads one complete build for each
  prompt in the current cohort.

Both paths use the same prompt, grid, palette, mode, output validation, checksum,
storage, and artifact requirements used by MineBench's Arena pipeline. Incomplete
or invalid uploaded cohorts are rejected with prompt-specific feedback. Accepted
builds are immutable; replacing a valid accepted build requires a new checkpoint
in a new draft evaluation. Private cohort preparation never changes a prompt's
public eligibility. A running endpoint or upload operation reserves its checkpoint,
and a persisted build is accepted only after its required artifacts and the open
evaluation lifecycle are revalidated.

Endpoint credentials are encrypted immediately and are never displayed again.
They are retained only while a partial run can validly resume, then deleted when
the cohort completes, the credential is disabled, the checkpoint is withdrawn, or
the evaluation closes.

## Arena Sampling

Private Arena sampling uses the ordinary MineBench Arena surface with a strict
boundary: every private matchup contains one private checkpoint and one public
model. Private-versus-private and cross-organization private matchups are not
used.

Private votes update only the private checkpoint's rating state. The public model
acts as a read-only anchor. Public ratings, rankings, counters, coverage,
leaderboard metrics, rank snapshots, benchmark surfaces, and publication data are
unchanged by private matchups or votes.

Goal-based pauses are reconciled after vote processing and by later idle drains, so
a transient reconciliation failure remains recoverable after the vote job commits.

Checkpoint comparisons inside an evaluation are estimates based on each
checkpoint's independently calibrated public-anchor results. They should not be
read as a direct head-to-head record unless a separate evaluation design
explicitly supports that interpretation.

## Reporting and Exports

Authorized organization members can inspect build cohorts, generation progress,
sanitized prompt-level errors, attempt counts, operational provenance, aggregate
results, uncertainty, prompt performance, public-opponent performance, vote
volume, coverage, side balance, ties, and both-bad outcomes.

Deidentified vote export is available only when the evaluation policy permits it.
Exports exclude direct and pseudonymous voter identifiers such as account IDs,
session IDs, vote IDs, matchup IDs, IP addresses, request headers, and exact
timestamps.

Private checkpoint identities, organization identity, private results, raw votes,
and evaluation materials are not published or shared outside the authorized
organization unless the organization authorizes disclosure or an applicable
agreement requires it.

## Retention and Release Isolation

Closed evaluations remain read-only for the agreed retention window so authorized
members can review and export results. Unless an evaluation agreement states
otherwise, private evaluation data is deleted from active systems within thirty
days after closure, final delivery, or termination. Agreement-specific retention
terms control when they differ.

If a private checkpoint later becomes a public model, its public leaderboard
record starts with fresh public votes. Private ratings, votes, rank estimates,
and private reports do not transfer into public rankings.

## Request Access

Organizations interested in a private evaluation can contact
[ammaar@princeton.edu](mailto:ammaar@princeton.edu).

Related documentation:

- [Privacy Policy](./privacy-policy.md)
- [Arena Ranking](./arena-ranking-system.md)
