import { TutorServiceError } from "./tutor-errors";

export type TutorTextDelta = {
  field: "approach" | "message" | "concept" | "nextStep";
  text: string;
};
const fields = ["approach", "message", "concept", "nextStep"] as const;
const keys = new Set(["type", "tool", "arguments", ...fields, "relatedQuestionIds"]);
const fail = () => new TutorServiceError("invalid_output");

/** Incrementally decodes only top-level learner strings. All emitted text is provisional. */
export class StreamedTutorJson {
  private raw = "";
  private state: "start" | "keyOrEnd" | "key" | "colon" | "value" | "after" | "done" = "start";
  private key = "";
  private seen = new Set<string>();
  private values = new Map<string, unknown>();
  private text = new Map<TutorTextDelta["field"], string>();
  private emitted = new Map<TutorTextDelta["field"], number>();
  private string: "key" | "value" | null = null;
  private decoded = "";
  private escaped = false;
  private unicode: string | null = null;
  private highSurrogate = "";
  private scalar: string | null = null;
  private nested = "";
  private stack: string[] = [];
  private nestedString = false;
  private nestedEscape = false;

  constructor(private readonly onDelta: (delta: TutorTextDelta) => void) {}

  push(chunk: string) {
    if (typeof chunk !== "string" || this.raw.length + chunk.length > 32_000) throw fail();
    this.raw += chunk;
    for (const char of chunk) this.consume(char);
    this.flush();
  }

  finish(): unknown {
    if (this.state !== "done" || this.string || this.scalar !== null || this.stack.length)
      throw fail();
    try {
      return JSON.parse(this.raw);
    } catch {
      throw fail();
    }
  }

  private field(): TutorTextDelta["field"] | undefined {
    return fields.find((field) => field === this.key);
  }

  private append(char: string) {
    this.decoded += char;
    if (this.string === "value") {
      const field = this.field();
      if (field) {
        if (this.decoded.length > (field === "approach" ? 1000 : 8000)) throw fail();
        this.text.set(field, this.decoded);
      }
    }
  }

  private decodedChar(char: string) {
    // Buffer UTF-16 high surrogates so a callback never splits an emoji in half.
    if (this.highSurrogate) {
      if (char.length === 1 && /[\uDC00-\uDFFF]/.test(char)) {
        this.append(this.highSurrogate + char);
        this.highSurrogate = "";
        return;
      }
      throw fail();
    }
    if (char.length === 1 && /[\uD800-\uDBFF]/.test(char)) this.highSurrogate = char;
    else if (char.length === 1 && /[\uDC00-\uDFFF]/.test(char)) throw fail();
    else this.append(char);
  }

  private stringChar(char: string) {
    if (this.unicode !== null) {
      if (!/^[0-9a-fA-F]$/.test(char)) throw fail();
      this.unicode += char;
      if (this.unicode.length === 4) {
        const decoded = String.fromCharCode(parseInt(this.unicode, 16));
        this.unicode = null;
        this.decodedChar(decoded);
      }
      return;
    }
    if (this.escaped) {
      this.escaped = false;
      if (char === "u") {
        this.unicode = "";
        return;
      }
      const escapes: Record<string, string> = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      if (!(char in escapes)) throw fail();
      this.decodedChar(escapes[char]);
      return;
    }
    if (char === "\\") {
      this.escaped = true;
      return;
    }
    if (char === '"') {
      if (this.highSurrogate) throw fail();
      const purpose = this.string;
      this.string = null;
      if (purpose === "key") {
        if (!keys.has(this.decoded) || this.seen.has(this.decoded)) throw fail();
        this.key = this.decoded;
        this.seen.add(this.key);
        this.state = "colon";
      } else this.value(this.decoded);
      return;
    }
    if (char.charCodeAt(0) < 0x20) throw fail();
    this.decodedChar(char);
  }

  private value(value: unknown) {
    this.values.set(this.key, value);
    this.state = "after";
  }

  private consume(char: string): void {
    if (this.string) {
      this.stringChar(char);
      return;
    }
    if (this.stack.length) {
      this.nested += char;
      if (this.nestedString) {
        if (this.nestedEscape) this.nestedEscape = false;
        else if (char === "\\") this.nestedEscape = true;
        else if (char === '"') this.nestedString = false;
      } else if (char === '"') this.nestedString = true;
      else if (char === "{" || char === "[") this.stack.push(char);
      else if (char === "}" || char === "]") {
        if (this.stack.pop() !== (char === "}" ? "{" : "[")) throw fail();
        if (!this.stack.length) {
          let value: unknown;
          try {
            value = JSON.parse(this.nested);
          } catch {
            throw fail();
          }
          this.value(value);
          this.nested = "";
        }
      }
      return;
    }
    if (this.scalar !== null) {
      if (!/[\s,}]/.test(char)) {
        this.scalar += char;
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(this.scalar);
      } catch {
        throw fail();
      }
      this.scalar = null;
      this.value(value);
      this.consume(char);
      return;
    }
    if (/\s/.test(char)) return;
    if (this.state === "start") {
      if (char !== "{") throw fail();
      this.state = "keyOrEnd";
    } else if (this.state === "keyOrEnd" || this.state === "key") {
      if (char === "}" && this.state === "keyOrEnd") {
        this.state = "done";
        return;
      }
      if (char !== '"') throw fail();
      this.string = "key";
      this.decoded = "";
    } else if (this.state === "colon") {
      if (char !== ":") throw fail();
      this.state = "value";
    } else if (this.state === "value") {
      if (char === '"') {
        this.string = "value";
        this.decoded = "";
      } else if (char === "{" || char === "[") {
        this.stack = [char];
        this.nested = char;
      } else if (/[-0-9tfn]/.test(char)) this.scalar = char;
      else throw fail();
    } else if (this.state === "after") {
      if (char === ",") this.state = "key";
      else if (char === "}") this.state = "done";
      else throw fail();
    } else throw fail();
  }

  private flush() {
    if (
      this.values.get("type") !== "final" ||
      !this.values.has("tool") ||
      this.values.get("tool") !== null ||
      !this.values.has("arguments") ||
      this.values.get("arguments") !== null
    )
      return;
    for (const field of fields) {
      const text = this.text.get(field) ?? "";
      const offset = this.emitted.get(field) ?? 0;
      if (text.length > offset) {
        this.emitted.set(field, text.length);
        this.onDelta({ field, text: text.slice(offset) });
      }
    }
  }
}
