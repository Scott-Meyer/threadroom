#!/usr/bin/env node
import { run } from '../lib/cli.js';

try {
  await run(process.argv.slice(2));
} catch (error) {
  console.error(`threadroom-service: ${error.message}`);
  process.exitCode = 1;
}
