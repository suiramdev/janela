export interface Hello {
  readonly protocolVersion: number;

  readonly minimumSupported: number;

  readonly clientName: string;

  readonly credential?: Credential;
}

export type Credential = { readonly kind: "bearerToken"; readonly token: string };

export type HandshakeRefusal =
  | {
      readonly kind: "incompatibleVersion";
      readonly daemonMinimum: number;
      readonly daemonCurrent: number;
    }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "protocolViolation" };

export const PROTOCOL_VERSION = 13;

export const MINIMUM_SUPPORTED_VERSION = 13;

export function isCompatible(mine: Hello, other: Hello): boolean {
  return (
    other.protocolVersion >= mine.minimumSupported && mine.protocolVersion >= other.minimumSupported
  );
}
