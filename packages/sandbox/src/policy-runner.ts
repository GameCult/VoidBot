import {
  type SandboxCommandRequest,
  type SandboxExecutionResult,
  type SandboxProfileName,
} from "@voidbot/shared";

import { defaultSandboxProfiles } from "./profiles";

export class PolicySandboxRunner {
  public getProfile(profileName: SandboxProfileName) {
    return defaultSandboxProfiles[profileName];
  }

  public async run(request: SandboxCommandRequest): Promise<SandboxExecutionResult> {
    const profile = this.getProfile(request.profile);

    if (!profile.allowedCommands.includes(request.command)) {
      return {
        status: "denied",
        stdout: "",
        stderr: "",
        exitCode: 1,
        deniedReason: `Command "${request.command}" is not allowed for profile "${request.profile}".`,
        dryRun: true,
      };
    }

    if (request.networkAccess && !profile.networkAccess) {
      return {
        status: "denied",
        stdout: "",
        stderr: "",
        exitCode: 1,
        deniedReason: `Profile "${request.profile}" does not permit network access.`,
        dryRun: true,
      };
    }

    if (profile.requiresApproval && !request.approved) {
      return {
        status: "denied",
        stdout: "",
        stderr: "",
        exitCode: 1,
        deniedReason: `Profile "${request.profile}" requires explicit approval before execution.`,
        dryRun: true,
      };
    }

    return {
      status: "planned",
      stdout: "",
      stderr: "",
      exitCode: 0,
      dryRun: true,
    };
  }
}

