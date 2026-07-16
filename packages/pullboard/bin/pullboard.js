#!/usr/bin/env node
import { run } from "@pullboard/cli";

process.exitCode = await run(process.argv.slice(2));
