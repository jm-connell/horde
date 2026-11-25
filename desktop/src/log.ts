// One rotating log for the shell and the server's output: horde.log plus four
// older files of at most 5 MB each. Password reset codes are read from here
// (ADR 0012), so "Open logs" opens this file.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;
const FILES = 5;

export class RotatingLog {
  readonly file: string;
  private size: number;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "horde.log");
    this.size = existsSync(this.file) ? statSync(this.file).size : 0;
  }

  /** A line from the shell itself. */
  shell(message: string): void {
    this.write(`${new Date().toISOString()} [shell] ${message}\n`);
  }

  /** Output of the server, already split into lines. */
  server(line: string): void {
    this.write(`${line}\n`);
  }

  private write(text: string): void {
    try {
      if (this.size + text.length > MAX_BYTES) this.rotate();
      appendFileSync(this.file, text, "utf8");
      this.size += Buffer.byteLength(text);
    } catch (err) {
      // The log is the last place to report to; stderr is all that is left.
      process.stderr.write(`horde: could not write the log: ${String(err)}\n`);
    }
  }

  private rotate(): void {
    rmSync(`${this.file}.${FILES - 1}`, { force: true });
    for (let i = FILES - 2; i >= 1; i--) {
      if (existsSync(`${this.file}.${i}`)) {
        renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      }
    }
    if (existsSync(this.file)) renameSync(this.file, `${this.file}.1`);
    this.size = 0;
  }
}
