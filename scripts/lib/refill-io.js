/*
 * refill-io.js — where the refill loop's CLI and its tick print, log and
 * look: the loop's files, `say` and `log`, and the roots a scope serves
 * (#3392, #4821). scripts/refill-loop.js's commands and lib/refill-tick.js's
 * tick take them here, so a command that runs no tick — `status`, which the
 * panel polls every few seconds — loads none of the tick's modules.
 */

const { buildLoopLogLine, loopFiles } = require("./refill-files.js");
const loop = require("./refill-loop.js");
const { readExclusionWhy } = require("./refill-repos.js");
const { writeFd } = require("./write-fd.js");

const files = loopFiles();

/** @param {string} line */
const say = (line) => writeFd(1, `${line}\n`);

/** @param {string} line */
const log = (line) => writeFd(1, buildLoopLogLine(line));

/**
 * The roots a scope serves now.
 * @param {import("./refill-loop.js").Scope} scope
 */
const servedRoots = (scope) => loop.scopeRoots(scope, readExclusionWhy);

module.exports = { files, log, say, servedRoots };
