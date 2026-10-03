import { askTutor, foundryConfiguration } from "../lib/foundry";
import { tutorFailure } from "../lib/tutor-errors";

async function main() {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const configuration = foundryConfiguration();
    console.log(
      JSON.stringify({
        check: "configuration",
        status: "pass",
        mode: configuration.mode,
        credential: configuration.credential,
        model: configuration.model,
        maxOutputTokens: configuration.maxOutputTokens,
      }),
    );
    const started = Date.now();
    let usage;
    await Promise.race([
      askTutor({
        system:
          "Return the requested JSON fields with short plain text: message, concept, nextStep.",
        input: "Confirm that the tutor connection works. No exam content is needed.",
        signal: controller.signal,
        onUsage: (value) => {
          usage = value;
        },
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new DOMException("Timed out", "TimeoutError"));
        }, 60_000);
      }),
    ]);
    console.log(
      JSON.stringify({
        check: "model_response",
        status: "pass",
        elapsedMs: Date.now() - started,
        usage,
      }),
    );
  } catch (error) {
    const failure = tutorFailure(error);
    console.error(JSON.stringify({ check: "foundry", outcome: "fail", ...failure }));
    console.error(
      "Choose exactly one endpoint: FOUNDRY_PROJECT_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project> (Entra), or FOUNDRY_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/openai/v1 (API key or Entra). See docs/foundry.md.",
    );
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
void main();
