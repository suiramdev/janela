import { Option, Schema } from "effect";

export interface TrustBlock {
  readonly key: string;
  readonly hash: string;
}

const TRUST_HEADER = /^\s*\[hooks\.state\.("(?:[^"\\]|\\.)*")\]\s*$/;

const ANY_HEADER = /^\s*\[/;

const TRUSTED_HASH = /^\s*trusted_hash\s*=\s*"([^"]*)"\s*$/;

const decodeKey = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));

export function readTrustBlocks(text: string): readonly TrustBlock[] {
  const blocks: TrustBlock[] = [];
  let key: string | undefined;

  for (const line of text.split("\n")) {
    const header = TRUST_HEADER.exec(line);

    if (header !== null) {
      const quoted = header[1];

      key = quoted === undefined ? undefined : Option.getOrUndefined(decodeKey(quoted));
      continue;
    }

    if (ANY_HEADER.test(line)) {
      key = undefined;
      continue;
    }

    if (key === undefined) continue;

    const hash = TRUSTED_HASH.exec(line);

    if (hash === null) continue;

    const value = hash[1];

    if (value !== undefined) blocks.push({ key, hash: value });

    key = undefined;
  }

  return blocks;
}

export function rewriteTrustBlocks(
  text: string,
  dropped: ReadonlySet<string>,
  added: readonly TrustBlock[],
): string {
  const kept: string[] = [];
  let dropping = false;

  for (const line of text.split("\n")) {
    const header = TRUST_HEADER.exec(line);

    if (header !== null) {
      const quoted = header[1];
      const key = quoted === undefined ? undefined : Option.getOrUndefined(decodeKey(quoted));

      dropping = key !== undefined && dropped.has(key);

      if (dropping) continue;
    } else if (ANY_HEADER.test(line)) {
      dropping = false;
    } else if (dropping) continue;

    kept.push(line);
  }

  while (kept.length > 0 && kept[kept.length - 1]?.trim() === "") kept.pop();

  const body = added
    .map((block) => `[hooks.state.${JSON.stringify(block.key)}]\ntrusted_hash = "${block.hash}"`)
    .join("\n\n");

  if (body.length === 0) return kept.length === 0 ? "" : `${kept.join("\n")}\n`;

  return kept.length === 0 ? `${body}\n` : `${kept.join("\n")}\n\n${body}\n`;
}
