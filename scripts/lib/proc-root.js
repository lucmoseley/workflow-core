/*
 * proc-root.js — the repo's /proc seam (#3505): `procRoot` names the root,
 * which WFC_PROC replaces with a fixture tree lib/proc-fake.ts writes, and
 * every reader that takes a `proc` argument defaults it to `procRoot` (#3530).
 *
 * A leaf: it depends on nothing.
 */

const procRoot = () => process.env.WFC_PROC || "/proc";

module.exports = { procRoot };
