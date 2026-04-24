import { SerializedFileStore } from "./file-store";

export interface ImportedFileState {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface RagImportState {
  lastRunAt?: string;
  files: ImportedFileState[];
}

export class FileImportStateRepository {
  private readonly store: SerializedFileStore<RagImportState>;

  public constructor(filePath: string) {
    this.store = new SerializedFileStore(filePath, () => ({
      files: [],
    }));
  }

  public async read(): Promise<RagImportState> {
    return this.store.snapshot();
  }

  public async write(state: RagImportState): Promise<void> {
    await this.store.overwrite(state);
  }
}

