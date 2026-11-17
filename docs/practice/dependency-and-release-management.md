# dependency-and-release-management

Researched: 2026-10-21

## Vendored code and licence drift

- Gate licence policy by failing the check, not warning: a licence outside the allowed or recorded one fails. OSS Review Toolkit (`severeRuleViolationThreshold` defaults to WARNING, so a warning-level violation fails the exit code); cargo-deny ("all licenses are denied unless explicitly allowed"); GitHub dependency-review-action (`allow-licenses` fails the PR; an undetectable licence only informs). Three adopters, so no default beyond the warnings entry below [unverified]
- Keep the commit hook offline: run the network step (fetch, scan, licence lookup) once at update time or in CI, commit its result beside the lock (revision or content hash, declared licence, any approval with its reason), and have the offline check compare the tree with that record, failing on a mismatch. Go `go.sum` and `vendor/modules.txt`; cargo-vet `--frozen`; cargo-deny `clarify` (a recorded licence bound to file hashes, voided when the files change); Chromium `README.chromium` with `restrictive_license_approval.textproto`. Four adopters, no default [unverified]
- An approved exception is a committed file carrying a reason from a fixed list, never a skipped check. ORT resolutions (`.ort.yml`); Chromium's approval textproto. Two adopters, no default [unverified]
- Upstream re-licensing is a base-level supply-chain threat; review and record each component's licence. OpenSSF S2C2F (threat table, SCA-2 at L1); OpenChain ISO/IEC 5230 2.1 §3.3.1 (paywalled ISO copy unread). Neither sets warn or block [standard or field body]
- Chromium departs: a licence outside its allowlist only prompts (y/N) at upload unless an approval file covers it, though missing or malformed metadata blocks. depot_tools `metadata/fields/custom/license.py` [standard or field body]
- Developers ignore warnings: make a check an error or do not show it, and block only a check with few false positives and a clear fix. Sadowski et al., "Lessons from Building Static Analysis Tools at Google", CACM 2018, and Software Engineering at Google ch. 20 (one organisation) [named expert]; Johnson et al., ICSE 2013 (developer interviews); Lin et al., NCSU 2025 [survey or curated list]
- No free study measures commit-time licence-drift warnings specifically [unverified]

## Release notes for adopters

- Write each entry to say what changed and its effect on the user, so it makes sense alone; name the affected hook, flag or feature. Common Changelog, Keep a Changelog 1.1.0 [standard or field body]; Kubernetes release-notes guide [named expert]
- State whether the adopter must act; a new default-on behaviour that needs nothing says so, and one that can break a workflow is marked (Breaking, "action required") with how to turn it off. Common Changelog, Keep a Changelog [standard or field body]; Kubernetes release-notes guide [named expert]
- Treat a new compatible behaviour as a minor-level change. SemVer 2.0.0, Keep a Changelog (Added), Common Changelog [standard or field body]
- Link the issue or PR behind each entry. Common Changelog, Keep a Changelog [standard or field body]; Kubernetes release-notes guide [named expert]
- Leave out tests, build and dev-tool changes, formatting and raw commit lists. Keep a Changelog, Common Changelog [standard or field body]; Kubernetes release-notes guide [named expert]

## Publishing a private repo's code

- Publishing a repo publishes its history: a file deleted from the tree stays readable in every earlier commit, so scrub before the code is public or publish without the history. GitHub "Setting repository visibility" (Actions history and logs too) [standard or field body]; Google Open Source "Preparing for release"; GitGuardian, "Safely open source software" [named expert]
- Scan the tree you publish, and any history published with it, with a secrets scanner, not only the patterns you already know: gitleaks (v8.30.1, read 2026-10-26) or GitHub secret scanning, and a read for names, emails, internal hosts and code names, which no scanner finds. Google Open Source "Preparing for release" [named expert]; GitHub secret scanning runs over every branch once the repo is public [standard or field body]
- Default the Actions token to read-only and grant write per job; avoid `pull_request_target`; never run a self-hosted runner for a public repo, since anyone can open a pull request. GitHub "Security hardening for GitHub Actions" [standard or field body]
- The same guide asks for CODEOWNERS on `.github/workflows`. A repo with one maintainer, where no outside pull request runs its workflows unreviewed, gains nothing from it: there is no second reviewer for it to require. Derived from the guide's reason, so it sets no default [unverified]

## Installs in CI

- Install npm dependencies with `npm ci` and scripts off (`--ignore-scripts`), turning a script back on only for a named, version-pinned package (`npm rebuild <pkg>`, `@lavamoat/allow-scripts`, npm 11's `allowScripts`). OWASP NPM Security Cheat Sheet [standard or field body]; npm `ci` and `rebuild` docs for what the commands do [standard or field body, own tool]; LavaMoat, pnpm `allowBuilds` [named expert]
- Install Python dependencies from one compiled file pinning every transitive dependency with its sha256, as `pip install --require-hashes --only-binary :all: -r <file>`: a partly hashed file is refused, and an sdist runs its build code. pip "Secure installs" and "Repeatable installs" [standard or field body]; OpenSSF Scorecard counts a `pip install` pinned only with `--require-hashes` [standard or field body, own tool]
- Compile that file from a hand-edited `.in` with `pip-compile --generate-hashes` (or `uv pip compile --generate-hashes`) and commit both. pip-tools README [named expert]; uv docs for the command [standard or field body, own tool]
- A downloaded tool is pinned to a version and checked against a signature or checksum whose trust does not come from the download host; `--proto '=https' --tlsv1.2` hardens only the transport. OWASP Top 10 CI/CD Risks CICD-SEC-3, NIST SP 800-204D §3.2.1, §4.2, OpenSSF Scorecard Pinned-Dependencies [standard or field body]; rustup PR 1716 [named expert]

## Pinning or floating the plugin (#5221, #208, read 2026-11-15)

- Live at head (every consumer on the provider's current commit) is the leading view for repos inside one organisation, but only where the provider runs its dependents' tests before each change lands, ships a break only after the dependents are updated, and keeps a pin as the escape route. Software Engineering at Google ch. 16 and 21 (Winters) [named expert]; Abseil "Compatibility Guidelines" for Abseil's own policy [standard or field body]
- A tag is a fixed point, so a pin gives reproducibility and a one-edit rollback; its cost is upgrade churn, which the field cures by automating the bump. SemVer 2.0.0 [standard or field body]; Renovate "Dependency Pinning" [named expert]; agentpatterns.ai "Central Repo for Shared Agent Standards" [survey or curated list]
- Batch changes into fewer semver releases rather than shipping each commit: consumers take grouped, scheduled upgrades, not one per change. Renovate "Dependency Pinning" (grouping, schedules) [named expert]; agentpatterns.ai "Central Repo for Shared Agent Standards" (pin to a version, stage the rollout) [survey or curated list]. One adopter for shared agent tooling: `mattpocock/skills`, about one release a fortnight [unverified]
- Claude Code's `ref` and `autoUpdate`: a marketplace or plugin entry's `ref` names a branch or tag, `sha` a full commit that wins over `ref`; auto-update is off by default for third-party marketplaces and is turned on by `extraKnownMarketplaces.<name>.autoUpdate: true` or in `/plugin`; an update arrives only when the computed version changes (`plugin.json` `version`, then the marketplace entry's, then the commit SHA), so a fixed `version` on a moving ref updates nothing; the refresh runs up to 10 minutes after a session's first prompt, and open sessions keep the old hooks until `/reload-plugins`. There are no release channels: one marketplace name per user serves one version. Claude Code docs "Host a marketplace", "Marketplace reference", "Plugin loading" [standard or field body]
- `autoUpdate` never updates an existing install while upstream anthropics/claude-code#83422 stays open (OPEN on 2026-11-15, labelled `reproduced`). #208, #5223 [unverified]
- House: each adopter pins a workflow-core tag in its own repo and moves the pin to take a release; releases are batched to about one a week. Founder ruling #5223 Q1 (A), a ruling for workflow-core's releases and no outside source, so it sets no default beyond them [unverified]

## Tool text inside a file the user owns (#5277, read 2026-11-16)

- Text the tool keeps owning goes in a separate file the tool owns and replaces whole on upgrade; the user's file points to it or the host loads it, and the tool never edits the user's file. Debian Policy §10.7-10.8 (one owner per conffile, `.d` directories) [standard or field body]; systemd.unit(5) drop-ins with the UAPI Configuration Files Specification, counted as one source [standard or field body]; Julio Merino, "Configuration files and .d directories" (2020) [named expert]
- A marked region rewritten in place loses a user's edit inside it without warning, and a changed marker makes the tool insert a second region. Ansible `blockinfile` docs [standard or field body]; Merino [named expert]
- A per-release manual step drifts: users skip it, and unattended upgrades keep the old file. ucf `UCF_FORCE_CONFFOLD` [standard or field body]
- A three-way template update (copier `update`) fits a scaffold the user will own, not text the tool keeps owning: it leaves conflicts to the user and does not stop edits to the tool's text. copier docs [standard or field body]

## In workflow-core

- **Release notes for adopters:** Departure: this repo's notes sit on SemVer patch versions for compatible additions and carry no Added/Changed headings; `scripts/lib/migration-note.js` fixes the note's sections
- **Installs in CI:** Departure: ci.yml's Mod tests take Claude Code's latest release unpinned, since adopters run whatever release they have and a break must surface at once (#828). Its trust rests on the release manifest's GPG signature, checked against the key fingerprint pinned in the workflow (code.claude.com/docs/en/setup, "Binary integrity and code signing")
