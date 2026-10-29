/*
 * proc-root.js — the repo's /proc seam (#3505): `procRoot` names the root,
 * which WFC_PROC replaces with a fixture tree lib/proc-fake.ts writes, and
 * every reader that takes a `proc` argument defaults it to `procRoot` (#3530);
 * `REAL_PROC` is the root a reader that must never follow it names.
 *
 * A leaf: it depends on nothing.
 */

/** The kernel's own /proc, for a reader whose acts are real (#3538). */
const REAL_PROC = "/proc";

const procRoot = () => process.env.WFC_PROC || REAL_PROC;

module.exports = { procRoot, REAL_PROC };
