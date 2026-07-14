import pc from "picocolors";
import type { Logger } from "./types.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Minimal console logger with a self-contained spinner (no `ora` dependency).
 * The spinner degrades to plain lines when stdout is not a TTY (CI, piped).
 */
export class ConsoleLogger implements Logger {
  constructor(private readonly quiet = false) {}

  info(msg: string): void {
    console.log(msg);
  }

  success(msg: string): void {
    console.log(`${pc.green("✔")} ${msg}`);
  }

  warn(msg: string): void {
    console.warn(`${pc.yellow("!")} ${pc.yellow(msg)}`);
  }

  error(msg: string): void {
    console.error(`${pc.red("✖")} ${pc.red(msg)}`);
  }

  step(msg: string): void {
    console.log(`${pc.cyan("›")} ${pc.bold(msg)}`);
  }

  detail(msg: string): void {
    if (!this.quiet) console.log(`  ${pc.dim(msg)}`);
  }

  async task<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const isTty = process.stdout.isTTY && !this.quiet;
    if (!isTty) {
      console.log(`${pc.cyan("›")} ${label}...`);
      try {
        const result = await fn();
        console.log(`${pc.green("✔")} ${label}`);
        return result;
      } catch (err) {
        console.log(`${pc.red("✖")} ${label}`);
        throw err;
      }
    }

    let i = 0;
    const render = () => {
      const frame = SPINNER_FRAMES[i % SPINNER_FRAMES.length];
      process.stdout.write(`\r${pc.cyan(frame ?? "-")} ${label}   `);
      i++;
    };
    render();
    const timer = setInterval(render, 80);
    const clearLine = () => {
      clearInterval(timer);
      process.stdout.write(`\r${" ".repeat(label.length + 6)}\r`);
    };

    try {
      const result = await fn();
      clearLine();
      this.success(label);
      return result;
    } catch (err) {
      clearLine();
      this.error(label);
      throw err;
    }
  }
}

export const color = pc;
