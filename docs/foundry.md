# Microsoft Foundry model connection

The tutor runs its bounded agent loop and tools in the Next.js server. Models stay hosted on **Microsoft Foundry**. No remote agent or new cloud deployment is required.

Two SDK connections are supported. Configure exactly one endpoint; mixing endpoints fails validation rather than silently selecting another service.

| Connection          | Endpoint variable                                                                          | SDK                                                             | Authentication               |
| ------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ---------------------------- |
| Foundry project     | `FOUNDRY_PROJECT_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project>` | `@azure/ai-projects`, using `AIProjectClient.getOpenAIClient()` | Entra ID                     |
| Foundry resource v1 | `FOUNDRY_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/openai/v1`                    | `openai`, as documented by Microsoft for Foundry v1             | Resource API key or Entra ID |

The resource SDK always receives your explicit Azure base URL. It never uses the public OpenAI API. Project URLs and resource URLs are distinct; do not put a resource URL in `FOUNDRY_PROJECT_ENDPOINT`. Resource endpoints under `services.ai.azure.com/openai/v1` are also supported.

Use Node.js 22 or newer. Copy `.env.example` to `.env.local` only if it does not already exist. Set `FOUNDRY_MODEL` to an existing deployment supporting the Responses API and strict JSON-schema structured output.

For resource key authentication, set `FOUNDRY_CREDENTIAL=api_key` and `FOUNDRY_API_KEY` locally. The API key is supported only in resource mode. This mode does not require Azure CLI login or access to a subscription through the CLI. Keep keys out of source control and browser code.

For local Entra authentication, set `FOUNDRY_CREDENTIAL=default` and sign in to Azure CLI using the account and tenant that own the resource. Azure Identity's `DefaultAzureCredential` reads that sign-in. The identity needs the relevant Foundry data-plane role. For Azure hosting, select `managed_identity`, enable that identity on the application, and grant it appropriate access. Set `AZURE_CLIENT_ID` only for a user-assigned identity. If the credential is omitted, a configured resource key selects key authentication; otherwise production defaults to managed identity and development to the default credential chain. Explicitly use `default` when testing a production build locally with Azure CLI credentials.

Restart the app after editing `.env.local`.

## Connection check and diagnostics

```sh
npm run tutor:check
```

This command validates configuration, then makes one small real model request with strict structured output. It has a 60-second deadline and exits nonzero on failure. It prints connection mode, deployment name, elapsed time, token counts, and a safe error category; it does not print credentials, response content, or raw provider errors. Successful configuration alone does not imply a working model connection.

| Code                      | Next action                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `configuration`           | Set exactly one endpoint with the correct URL shape, a deployment name, and a compatible credential mode.         |
| `authentication`          | Verify the resource API key or Entra account, role assignments, and resource access policy.                       |
| `deployment`              | Check the deployment name and endpoint. A model catalog listing alone does not prove a deployment can be invoked. |
| `request`                 | Verify Responses and strict structured-output support.                                                            |
| `rate_limit`              | Check deployment quota and retry after the service limit clears.                                                  |
| `timeout` / `unavailable` | Check service health, network access, and model latency.                                                          |
| `incomplete`              | Check model output limits and response policy.                                                                    |
| `invalid_output`          | Check structured-output compatibility.                                                                            |

The tutor API returns a safe category and a readable failure message. Server logs include the request identifier, category, HTTP status when known, and a fixed remediation message; raw provider errors, prompts, source answers, and credentials are excluded.

The SDK performs no automatic retries. The application permits one transient retry within a four-call, 60-second run budget. The last call is reserved for a final answer; tool results use the same labeled representation in production and evaluation. The SDK request timeout is 55 seconds. `FOUNDRY_MAX_OUTPUT_TOKENS` defaults to 4096 and accepts 512–16384, including reasoning tokens. Requests set `store: false`. Operational traces contain usage and safe error categories rather than prompt or answer text. Practice, grading, and source answer reveal remain available when the model is unavailable.

## Live evaluation

Run a small smoke selection first:

```sh
node --env-file-if-exists=.env.local --import tsx agents/ai-tutor/harness/live.ts --case=1,6,12
```

Omit `--case` to execute all 28 documented cases plus three progressive hint stages. Each case uses invented content, permits at most four model calls, and has a 60-second overall deadline. These are real model requests and incur your deployment's usage charges. Endpoint and deployment configuration are checked before any request. Authentication/permission/deployment HTTP errors stop the remaining suite.

Results are written incrementally under ignored `data/tutor-evals/`. They contain deployment name, prompt hash, synthetic context, parsed actions, token counts when supplied, tool permission decisions, and the expected/failure rubric. Provider error messages and credentials are omitted. A service-filtered case stays recorded as `content_filter`, with no parser pass or invented model reply; it does not stop unrelated cases. `strictParser: "pass"` records output conformance only; every result retains `humanReview: "pending"`. Review the saved responses against their rubrics before claiming disclosure prevention, source fidelity, or teaching quality passed. The re-hidden case excludes all revealed conversation history; production retains only separately scoped hidden-phase context.

Offline provider and evaluation-harness tests run with `node --import tsx --test tests/foundry.test.ts`. They use synthetic fixtures and mocked responses; they do not require Azure access or verify model behavior.

References: [Microsoft AI Projects SDK](https://learn.microsoft.com/javascript/api/overview/azure/ai-projects-readme), [Azure Identity](https://learn.microsoft.com/javascript/api/overview/azure/identity-readme), [Foundry access control](https://learn.microsoft.com/azure/ai-foundry/concepts/rbac-foundry?view=foundry).

References: [Microsoft AI Projects SDK](https://learn.microsoft.com/javascript/api/overview/azure/ai-projects-readme), [Microsoft Foundry v1 SDK examples](https://learn.microsoft.com/azure/ai-foundry/openai/api-version-lifecycle), [Azure Identity](https://learn.microsoft.com/javascript/api/overview/azure/identity-readme).

The [memory layer](tutor-memory.md) adds one bounded compaction call when older conversation crosses a threshold. Set `FOUNDRY_CONTEXT_WINDOW_TOKENS` to the deployment’s real context capacity. Run `npm run tutor:memory:live` to verify real compaction and recall in an isolated database.
