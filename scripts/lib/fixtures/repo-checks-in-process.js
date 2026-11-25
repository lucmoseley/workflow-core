// #5734
const { main } = require("../../repo-checks.js");
const { inProcessSpawn } = require("../repo-check-launch-fake.js");

main(inProcessSpawn);
