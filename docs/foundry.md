# Microsoft Foundry model connection

The tutor uses the Microsoft **AI Projects SDK** (`@azure/ai-projects`) and Azure Identity. `AIProjectClient.getOpenAIClient()` provides the project-scoped Responses client; the SDK chooses the service URL and Entra token audience. The tutor's tools and bounded execution loop run in the Next.js server. No remote agent resource or cloud deployment is created by this application.

Use Node.js 22 or newer. Copy `.env.example` to `.env.local`, and set `FOUNDRY_PROJECT_ENDPOINT` to the **project endpoint** from your Foundry project's overview. Its shape is `https://<resource>.services.ai.azure.com/api/projects/<project>`. Resource endpoints, inference endpoints, and URLs ending in `/openai/v1` are not interchangeable with a project endpoint.

Set `FOUNDRY_MODEL` to an existing deployment name in that project. Choose a deployment that supports the Responses API and strict JSON-schema structured output. The application validates the name locally; successful live evaluation verifies service compatibility and access.

For local development, keep `FOUNDRY_CREDENTIAL=default` and sign in to Azure CLI yourself using the intended tenant/account. Azure Identity's `DefaultAzureCredential` reads that sign-in. The identity needs an appropriate Foundry data-plane role (typically **Azure AI User**, scoped to the relevant project/resource); have your administrator grant the minimum role needed. A configured API key alone is insufficient: the AI Projects SDK supports Entra authentication, and the former `FOUNDRY_API_KEY` variable is no longer consumed.

For Azure hosting, set `FOUNDRY_CREDENTIAL=managed_identity`, enable a managed identity on the application, and grant it the same narrowly scoped access. Set `AZURE_CLIENT_ID` only when selecting a user-assigned managed identity. Without an explicit credential setting, production uses managed identity and other environments use the default development credential chain. For a local production-build smoke test, explicitly retain `FOUNDRY_CREDENTIAL=default`.

The application disables automatic model SDK retries and applies a 55-second request timeout inside the harness's overall deadline. Only transient transport failures and HTTP 408, 429, 500, 502, 503, or 504 qualify for a harness retry; authentication, authorization, configuration, schema, and output-validation failures do not. Requests set `store: false`; operational traces record usage counts rather than prompts, answers, or credentials. Existing anonymous practice, source answer reveal, and progress remain available when Foundry is unconfigured or unavailable.

After configuration, run a real tutor request and the documented live evaluation command. A successful build or an offline mocked provider test does not verify deployment availability, role assignments, private-network access, or model teaching quality. Provider errors should be resolved using the project endpoint, deployment, identity, and network configuration without changing the source answer bank.

## Live evaluation

Run a small smoke selection first:

```sh
node --env-file-if-exists=.env.local --import tsx agents/ai-tutor/harness/live.ts --case=1,6,12
```

Omit `--case` to execute all 28 documented cases plus three progressive hint stages. Each case uses invented content, permits at most four model calls, and has a 60-second overall deadline. These are real model requests and incur your deployment's usage charges. Endpoint and deployment configuration are checked before any request. Authentication/permission/deployment HTTP errors stop the remaining suite.

Results are written incrementally under ignored `data/tutor-evals/`. They contain deployment name, prompt hash, synthetic context, parsed actions, token counts when supplied, tool permission decisions, and the expected/failure rubric. Provider error messages and credentials are omitted. `strictParser: "pass"` records output conformance only; every result retains `humanReview: "pending"`. Review the saved responses against their rubrics before claiming disclosure prevention, source fidelity, or teaching quality passed. The re-hidden case begins with cleared conversation history, as the application does.

Offline provider and evaluation-harness tests run with `node --import tsx --test tests/foundry.test.ts`. They use synthetic fixtures and mocked responses; they do not require Azure access or verify model behavior.

References: [Microsoft AI Projects SDK](https://learn.microsoft.com/javascript/api/overview/azure/ai-projects-readme), [Azure Identity](https://learn.microsoft.com/javascript/api/overview/azure/identity-readme), [Foundry access control](https://learn.microsoft.com/azure/ai-foundry/concepts/rbac-foundry?view=foundry).
