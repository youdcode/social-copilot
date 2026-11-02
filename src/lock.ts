import { mkdirSync, openSync, readFileSync, unlinkSync, writeSync, closeSync } from 'node:fs';
import path from 'node:path';

export class LockError extends Error {
  override name = 'LockError';
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readPid(file: string): number | undefined {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Takes the single-instance lock, or throws if another live process holds it.
 * A lock left by a dead process is taken over. Released on release() or process exit.
 */
export function acquireLock(file: string): { release(): void } {
  mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      const release = () => {
        if (readPid(file) === process.pid) unlinkSync(file);
        process.off('exit', release);
      };
      process.on('exit', release);
      return { release };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readPid(file);
      if (holder !== undefined && isAlive(holder)) {
        throw new LockError(
          `Another instance is already running (PID ${holder}). Stop it before starting a new one.`,
        );
      }
      unlinkSync(file);
    }
  }
  throw new LockError(`Cannot take the lock ${file}.`);
}
