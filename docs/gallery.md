# Gallery and saved generations

Gallery is MineBench's public collection of community prompts and builds.

- Browse popular or recent prompts, inspect their builds, and vote
- Reuse a prompt in Sandbox to generate another interpretation
- Sign in to submit prompts and keep generated builds in your account
- Add a saved build to Gallery publicly or anonymously

Saved builds remain outside Gallery until their owner publishes them or an admin
reviews and publishes them anonymously. The original owner keeps control and can
remove the example from Gallery. Admins should review the prompt and build for
personal or sensitive content before publishing; anonymous attribution only hides
the contributor name. Gallery votes and examples are separate from Arena rankings
and benchmark results.
MineBench reviews the highest-voted prompt proposals and can promote them into
the official benchmark; votes guide that editorial decision rather than
changing the benchmark automatically.

The MineBench account also publishes new runs of existing official prompts.
Each example keeps its original run date, so the Gallery can show later retests
and run-to-run variation without replacing the canonical benchmark build.

See [Architecture](./architecture.md) for the data and generation flow.

## Admin vote review

The Votes view summarizes public Arena sessions over the last 24 hours, with
Suspicious, All, and Restricted filters. Selecting a session loads its full public
vote history in pages of 100. Flags identify repeated rapid voting, one-sided
choices, repeated matchups, frequent rejections, and ranking upsets for manual
review. Ranking comparisons use the latest hourly snapshot, not vote-time ranks;
a flag is not evidence of abuse by itself.

Admins can remove explicitly selected votes and block the account when known,
plus its recorded sessions and IPs. Anonymous restrictions use the browser
session and its last recorded IP. IP matching uses existing HMAC hashes and retained approximate
locations; it does not expose raw IPs or add device fingerprinting. Shared IP
restrictions can affect other visitors.

Removal updates public vote counters, processed coverage, and public leaderboard
inputs atomically. Pending vote jobs are removed without decrementing unapplied
counters. Historical Glicko state used for matchup selection is not replayed.
