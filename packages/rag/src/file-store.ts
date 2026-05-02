import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class SerializedFileStore<T> {
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(
    private readonly filePath: string,
    private readonly createDefault: () => T,
  ) {}

  public async snapshot(): Promise<T> {
    const store = await this.serialize(() => this.withInterprocessLock(() => this.readUnlocked()));
    return structuredClone(store);
  }

  public async overwrite(nextValue: T): Promise<void> {
    await this.serialize(async () => {
      await this.withInterprocessLock(() => this.writeUnlocked(nextValue));
    });
  }

  public async mutate<R>(mutator: (current: T) => R | Promise<R>): Promise<R> {
    return this.serialize(async () => {
      return this.withInterprocessLock(async () => {
        const current = await this.readUnlocked();
        const result = await mutator(current);
        await this.writeUnlocked(current);
        return result;
      });
    });
  }

  public async normalize(): Promise<void> {
    await this.serialize(async () => {
      await this.withInterprocessLock(async () => {
        const current = await this.readUnlocked();
        await this.writeUnlocked(current);
      });
    });
  }

  private async serialize<R>(operation: () => Promise<R>): Promise<R> {
    const pending = this.writeChain.then(operation, operation);
    this.writeChain = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async readUnlocked(): Promise<T> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return parseSerializedValue(stripLeadingBom(raw)) as T;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === "ENOENT") {
        return this.createDefault();
      }

      throw error;
    }
  }

  private async writeUnlocked(value: T): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const serialized = `${JSON.stringify(value)}\n`;

    try {
      await writeFile(tempPath, serialized, "utf8");
      await rm(this.filePath, { force: true });
      await rename(tempPath, this.filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private async withInterprocessLock<R>(operation: () => Promise<R>): Promise<R> {
    const lockPath = `${this.filePath}.lock`;
    await mkdir(dirname(lockPath), { recursive: true });
    const deadline = Date.now() + 30_000;

    for (;;) {
      try {
        const handle = await open(lockPath, "wx");

        try {
          return await operation();
        } finally {
          await handle.close();
          await rm(lockPath, { force: true }).catch(() => undefined);
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;

        if (code !== "EEXIST") {
          throw error;
        }

        const lockIsStale = await isStaleLock(lockPath);

        if (lockIsStale) {
          await rm(lockPath, { force: true }).catch(() => undefined);
          continue;
        }

        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for file lock: ${lockPath}`);
        }

        await delay(100);
      }
    }
  }
}

function stripLeadingBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

function parseSerializedValue(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch (error) {
    const lines = input
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length > 1) {
      return JSON.parse(lines[0]);
    }

    throw error;
  }
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    return Date.now() - lockStat.mtimeMs > 10 * 60 * 1000;
  } catch {
    return false;
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
