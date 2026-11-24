# Code safety — non-negotiable

These bind equally in a prototype, a scaffold, and production code.

<!-- Core-owned skeleton, written once by workflow-core's init; the three sections
     below are generic and travel unchanged. Fill in `## Invariants that bind code`
     with THIS product's rules — the things that must fire without reading any
     other file. -->

## Secrets boundary
- A credential that bypasses access control (an admin or service-role key, a payment or mail provider key) is server-only: never in client-side code, never in a public build variable, never in a client bundle, never committed.
- If a key is needed in code that could run client-side, that is the signal the logic belongs on the server — move it, don't expose the key.
- Anything reachable from a client-side entry point is client-side. Trace the import chain before wiring a secret.
- Real credentials — an account password, a shared login, an API key used outside code — belong in a password manager, never in a repo file, gitignored or not. The `gh` token sits in `~/.config/gh/hosts.yml`, outside git.

## Personal-data boundary
- A person who does not know this project holds a record of them — a cold prospect, an interviewee, someone named in a review — never goes into a tracked file, an issue body or an issue comment. Their record lives in gitignored `private/`; the repo refers to them by a handle. Git never forgets, so a slip is permanent: report it rather than deleting the line.
- A person in a relationship with the project — a collaborator, contractor or partner — is written in full, name and role and what is outstanding. Storing that is lawful and minimising it makes the record worse.

## Supervision priors (build accordingly)
- Presentational code takes the same tests, docs and review as any other code (the core's `docs/code-standards-base.md` §0). A review reads the risk paths first — those the base's §0 defines and your code-standards local file names — since a defect missed there costs most.
- **Mutation-test every new guarantee: break the fix, confirm that specific test fails, then reverse the break.** Where a branch cannot be reached in-process, extract a callable seam or state it unverified — never count it as covered, and report which mutations ran rather than "it is tested".
- **A red gate, a hung command or an unexplained failure takes `diagnosing-bugs` first — a feedback loop before any hypothesis.**
- **Verify before you assert:** the check behind claiming an absence, a config edit in force, a checker's verdict, an error's identity, a restated external source, or a passing mutation test is in the core's `docs/agents/verification.md`.

## Invariants that bind code

<!-- THIS product's rules. Reasoning may live in a longer document; these must fire
     without reading it. Delete the section if the product has none yet. -->
