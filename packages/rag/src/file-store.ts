import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class SerializedFileStore<T> {
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(
    private readonly filePath: string,
    private readonly createDefault: () => T,
  ) {}

  public async snapshot(): Promise<T> {
    await this.writeChain;
    const store = await this.readUnlocked();
    return structuredClone(store);
  }

  public async overwrite(nextValue: T): Promise<void> {
    await this.serialize(async () => {
      await this.writeUnlocked(nextValue);
    });
  }

  public async mutate<R>(mutator: (current: T) => R | Promise<R>): Promise<R> {
    return this.serialize(async () => {
      const current = await this.readUnlocked();
      const result = await mutator(current);
      await this.writeUnlocked(current);
      return result;
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
      return JSON.parse(stripLeadingBom(raw)) as T;
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
    await writeFile(this.filePath, `${JSON.stringify(value)}\n`, "utf8");
  }
}

function stripLeadingBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}
