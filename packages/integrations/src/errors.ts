import type { IntegrationID } from "@janela/core";
import { Data } from "effect";

export class UnknownIntegration extends Data.TaggedError("UnknownIntegration")<{
  readonly integration: string;
}> {
  override get message(): string {
    return `no integration named "${this.integration}"`;
  }
}

export class IntegrationConfigUnreadable extends Data.TaggedError("IntegrationConfigUnreadable")<{
  readonly integration: IntegrationID;
  readonly path: string;
}> {
  override get message(): string {
    return `${this.integration} configuration at ${this.path} is not in a shape Janela can edit`;
  }
}
