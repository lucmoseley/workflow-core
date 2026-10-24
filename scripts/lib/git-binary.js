/*
 * git-binary.js — the `git` a Node script spawns, injected at one named point,
 * WFC_GIT, so a test feeding git chosen output stubs it there rather than on
 * PATH (base §N7, workflow-core#2581, workflow-core#2589). Read on every call, as the in-process runner
 * swaps process.env between runs. Only the modules the suite stubs git for
 * read it yet; the rest still find `git` on PATH (workflow-core#2636).
 */

const gitBinary = () => process.env.WFC_GIT || "git";

module.exports = { gitBinary };
