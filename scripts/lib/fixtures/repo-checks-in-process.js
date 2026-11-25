// #5734
const { main } = require("../../repo-checks.js");
const { inProcessSpawn } = require("./stub-checker.js");

main(inProcessSpawn);
