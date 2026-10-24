/*
 * project-slug.js — how the harness names a project's directory under
 * `<config-dir>/projects/`, spelled once for every site that builds such a
 * path in production.
 *
 * ONE SITE SITS OUTSIDE IT, deliberately: `scripts/proving-run.ts` restates the
 * regex because a harness must not borrow the logic it checks.
 * `scripts/snapshot-memory.sh` is shell, which cannot `require` this file, but
 * it shells out to `node -e` to call `slugForRepo` rather than restating the
 * rule (mantahostels#2008) — so it derives from here too, at one remove.
 *
 * A LEAF ON PURPOSE: `node:path` and nothing else. `arbiter-core.js` is one of
 * its callers and its own header declares it the one leaf of the arbiter graph,
 * so it could not require `guard-fires.js`, where mantahostels#1963 first extracted this
 * function. Keep it that way: a require added here is a require added to every
 * guard invocation.
 */

const { hostRoot } = require("./host-root.js");

/**
 * How the harness spells a project path as a directory name: every character
 * that is not a letter or a digit becomes a hyphen, one hyphen per character —
 * `/.claude` gives two dashes, not one (mantahostels#1963).
 *
 * Case is preserved. RESIDUAL: no sampled path held an underscore or a space, so those
 * two rest on the class rather than on evidence.
 *
 * UTF-16, NOT CODE POINTS: `String.replace` walks code units, so a character
 * outside the BMP is two units and gives TWO hyphens. guard-log.sh's bash
 * restatement gives one, and the two are unequal there — an accepted residual,
 * not a bug to close (mantahostels#2096). Its locale limb IS fixed, at that file's
 * `local LC_ALL=C.UTF-8`. They agree on every BMP path, which is every path
 * this repo has.
 *
 * RESIDUAL ON THE DEFAULT: the cwd is what the HARNESS keys a transcript
 * directory on, so it is right for a hook, which runs at the project root. It
 * is wrong for a script a session may invoke from a subdirectory — those pass
 * `repoRoot()` (`arbiter-core.js`) or `slugForRepo()` below.
 *
 * @param {string} [cwd]
 * @returns {string}
 */
const projectSlug = (cwd = process.cwd()) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * The project directory a record is filed under when the repo root could not be
 * resolved at all (mantahostels#2438) — `scripts/lib/guard-log.sh`'s fail-open path, where
 * `gr_root` is the stub guard-root.sh leaves behind when it cannot be sourced.
 *
 * A NAME, not the empty string projectSlug() would give: `projects/` + "" is
 * `projects/` itself, a file beside the project directories that
 * check-guard-errors.js does not open.
 *
 * IT DOES NOT COLLIDE WITH A REAL SLUG, structurally (#1): a real one is a
 * host root, and both spellings of that (`host-root.js`'s hostRoot(), which
 * `arbiter-core.js`'s repoRoot() is, and `guard-root.sh`'s gr_root)
 * dereference the path, so even a relatively-spelled CLAUDE_PROJECT_DIR comes
 * back absolute. An absolute path slugs its leading `/` to a dash and so cannot
 * begin with a letter. Only a root that cannot be resolved at all keeps the
 * spelling it came in with, which is the one case left.
 *
 * RESTATED IN BASH at guard-log.sh's `${slug:-unresolved-root}`, which cannot
 * require this file on the path it runs. guard-log.test.ts pins the two equal.
 */
const UNRESOLVED_ROOT_SLUG = "unresolved-root";

/**
 * The slug of the HOST repo, whatever directory the caller was invoked from.
 * For a script with no root of its own: a bare `projectSlug()` would follow the
 * cwd, the same defect as the hard-coded literal it replaced.
 *
 * FROM THE SEAM, not `__dirname` (#1). The checkout this file is in is the
 * PLUGIN CACHE in a plugin install, so a script-relative slug named a transcript
 * directory the harness never writes to. `hostRoot()` still answers with a
 * worktree's own path, and costs a `git rev-parse` only where
 * CLAUDE_PROJECT_DIR is unset — memoised per cwd, so once per process.
 *
 * @returns {string}
 */
const slugForRepo = () => projectSlug(hostRoot());

module.exports = { projectSlug, slugForRepo, UNRESOLVED_ROOT_SLUG };
