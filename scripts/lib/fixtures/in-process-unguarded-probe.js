#!/usr/bin/env node

require("node:fs").writeSync(1, "ran for real, unguarded\n");
