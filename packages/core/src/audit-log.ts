import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { type AuditEvent } from "@voidbot/shared";

export type AuditEventInput = Omit<AuditEvent, "id" | "timestamp"> &
  Partial<Pick<AuditEvent, "id" | "timestamp">>;

export class FileAuditLog {
  public constructor(private readonly auditFile: string) {}

  public async record(input: AuditEventInput): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: input.id ?? randomUUID(),
      timestamp: input.timestamp ?? new Date().toISOString(),
      type: input.type,
      actorId: input.actorId,
      jobId: input.jobId,
      provider: input.provider,
      details: input.details,
    };

    await mkdir(dirname(this.auditFile), { recursive: true });
    await appendFile(this.auditFile, `${JSON.stringify(event)}\n`, "utf8");

    return event;
  }
}

