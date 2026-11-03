#!/usr/bin/env node
import { main } from "../dist/cli.js";

main(process.argv.slice(2)).catch((error) => {
  console.error(`auto-work: ${error instanceof Error ? error.message : String(error)}`);
  if (process.env.DEBUG && error instanceof Error) console.error(error.stack);
  process.exitCode = 1;
});
