// 1.2 MB measured, workflow-core#1440
const CHILD_MAX_BUFFER = 64e6;

// guess, workflow-core#5529
const CHILD_ERROR_CHARS = 200;

module.exports = { CHILD_ERROR_CHARS, CHILD_MAX_BUFFER };
