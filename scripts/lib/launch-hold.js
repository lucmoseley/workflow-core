/*
 * launch-hold.js — the refill loop's launch-hold bound, shared by
 * refill-loop.js, which refuses a longer `set --hold-launches`, and
 * wsl-disk-compaction.js, which renews a hold of that length each poll.
 */

/* Untraced: the longest launch hold `set` takes, so a typo cannot hold the
 * loop for a day; a pause is the tool for longer. */
const HOLD_MAX_MINUTES = 60;

module.exports = { HOLD_MAX_MINUTES };
