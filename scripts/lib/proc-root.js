/*
 * proc-root.js — the repo's /proc seam (workflow-core#3505): `procRoot` names the root,
 * which WFC_PROC replaces with a fixture tree lib/proc-fake.ts writes, and
 * every reader that takes a `proc` argument defaults it to `procRoot` (workflow-core#3530);
 * `REAL_PROC` is the root a reader that must never follow it names; and
 * `meminfoPath` names the meminfo file, whose own seam is WFC_MEMINFO (workflow-core#3592).
 *
 * A leaf: it depends on nothing.
 */

/** The kernel's own /proc, for a reader whose acts are real (workflow-core#3538). */
const REAL_PROC = "/proc";

const procRoot = () => process.env.WFC_PROC || REAL_PROC;

/** A WFC_PROC fake carries no meminfo (workflow-core#3587). */
const meminfoPath = () => process.env.WFC_MEMINFO || `${REAL_PROC}/meminfo`;

module.exports = { procRoot, REAL_PROC, meminfoPath };
