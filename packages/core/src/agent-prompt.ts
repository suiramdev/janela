import { Option, Schema } from "effect";

export const AGENT_PROMPT_REPORT = "prompt";

export const MAX_FORWARDED_PROMPT_BYTES = 6144;

const SEPARATOR = ";";

const BASE64_LENGTH_PER_TRIPLE = 4;

const BYTES_PER_TRIPLE = 3;

const MAX_ENCODED_LENGTH =
  Math.ceil(MAX_FORWARDED_PROMPT_BYTES / BYTES_PER_TRIPLE) * BASE64_LENGTH_PER_TRIPLE;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

const PROMPT_KEY = /"prompt"\s*:\s*"/u;

const UNICODE_ESCAPE = /^[0-9A-Fa-f]{4}$/u;

const HEX_DIGITS = 4;

const HEX_RADIX = 16;

const ESCAPED: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

const HookPayload = Schema.Struct({ prompt: Schema.String });

const decodeHookPayload = Schema.decodeUnknownOption(Schema.fromJsonString(HookPayload));

const decodeBase64 = Option.liftThrowable((encoded: string): Uint8Array => {
  const binary = atob(encoded);

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
});

const utf8 = new TextDecoder("utf-8");

export function parseAgentPrompt(payload: string): string | undefined {
  const [kind, encoded, ...rest] = payload.split(SEPARATOR);

  if (kind !== AGENT_PROMPT_REPORT || encoded === undefined || rest.length > 0) return undefined;

  if (encoded.length > MAX_ENCODED_LENGTH || !BASE64.test(encoded)) return undefined;

  const bytes = Option.getOrUndefined(decodeBase64(encoded));

  if (bytes === undefined) return undefined;

  const text = utf8.decode(bytes);
  const prompt = Option.getOrUndefined(decodeHookPayload(text))?.prompt ?? truncatedPrompt(text);

  return prompt === undefined || prompt.trim().length === 0 ? undefined : prompt;
}

function truncatedPrompt(text: string): string | undefined {
  const key = PROMPT_KEY.exec(text);

  if (key === null) return undefined;

  let index = key.index + key[0].length;
  let prompt = "";

  while (index < text.length) {
    const character = text.charAt(index);

    if (character === '"') return prompt;

    if (character !== "\\") {
      prompt += character;
      index += 1;

      continue;
    }

    const escape = text.charAt(index + 1);

    if (escape === "u") {
      const hex = text.slice(index + 2, index + 2 + HEX_DIGITS);

      if (!UNICODE_ESCAPE.test(hex)) return prompt;

      prompt += String.fromCharCode(Number.parseInt(hex, HEX_RADIX));
      index += 2 + HEX_DIGITS;

      continue;
    }

    const unescaped = ESCAPED[escape];

    if (unescaped === undefined) return prompt;

    prompt += unescaped;
    index += 2;
  }

  return prompt;
}
