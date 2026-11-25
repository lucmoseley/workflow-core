const { buildLoopLogLine, loopFiles } = require("./refill-files.js");
const loop = require("./refill-loop.js");
const { readExclusionWhy } = require("./refill-repos.js");
const { writeFd } = require("./write-fd.js");

const files = loopFiles();

/** @param {string} line */
const say = (line) => writeFd(1, `${line}\n`);

/** @param {string} line */
const log = (line) => writeFd(1, buildLoopLogLine(line));

/** @param {import("./refill-loop.js").Scope} scope */
const servedRoots = (scope) => loop.scopeRoots(scope, readExclusionWhy);

module.exports = { files, log, say, servedRoots };
