#!/usr/bin/env node
import { main } from "./cli.js";

main(process.argv).catch((err: unknown) => {
  // @inquirer throws ExitPromptError when the user hits Ctrl-C; exit quietly.
  const name = (err as { name?: string })?.name;
  if (name === "ExitPromptError") {
    process.exit(130);
  }
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
