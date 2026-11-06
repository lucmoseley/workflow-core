/*
 * lander-worktree.js — where the queue lander's local tester checks out the
 * sha it tests, relative to the main checkout. The session reaper leaves this
 * tree alone (#4421). A leaf, so the hooks that load the reaper pay for no more.
 */

const path = require("node:path");

const LANDER_WORKTREE = path.join(".claude", "worktrees", "lander");

module.exports = { LANDER_WORKTREE };
