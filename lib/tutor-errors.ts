const failures = {
  context_limit: {
    message:
      "This question and its context exceed Chiikawa’s configured limit. Practice and source answers remain available.",
    action:
      "Verify FOUNDRY_CONTEXT_WINDOW_TOKENS against the deployment and inspect context-budget traces.",
  },
  content_filter: {
    message:
      "The model service declined this request. Try asking about the question’s concept in a different way.",
    action:
      "The service content filter rejected the request. Rephrase it; do not change credentials or disable the filter.",
  },
  configuration: {
    message: "Chiikawa’s setup is incomplete. Practice and source answers are still available.",
    action:
      "Check SOUL.MD and prompts/personal-ai-tutor.system.md are packaged and nonempty; restart after edits. Run npm run tutor:check for endpoint, deployment, and credentials.",
  },
  authentication: {
    message: "Chiikawa cannot access its model. Practice progress is saved.",
    action:
      "Verify the configured resource key or Azure identity and its Foundry data-plane access.",
  },
  deployment: {
    message: "Chiikawa’s model is unavailable. Practice progress is saved.",
    action: "Verify that FOUNDRY_MODEL names a deployment available at the configured endpoint.",
  },
  request: {
    message: "Chiikawa’s model could not accept this request. Practice progress is saved.",
    action:
      "Use a deployment supporting Responses and strict JSON output; run npm run tutor:check.",
  },
  rate_limit: {
    message: "Chiikawa is busy. Please wait a moment and try again.",
    action: "Check deployment quota and retry after the service rate limit clears.",
  },
  timeout: {
    message: "Chiikawa took too long to respond. Please try again.",
    action: "Check model latency and network access; run npm run tutor:check.",
  },
  incomplete: {
    message: "Chiikawa could not finish its response. Please try again.",
    action: "Check output budget and model compatibility with npm run tutor:check.",
  },
  invalid_output: {
    message: "Chiikawa returned an unreadable response. Please try again.",
    action: "Check strict structured-output support with npm run tutor:check.",
  },
  unavailable: {
    message:
      "Chiikawa is temporarily unavailable. Your practice progress is saved; please try again.",
    action: "Check network and service availability with npm run tutor:check.",
  },
} as const;

export type TutorFailureCode = keyof typeof failures;

// Never include a provider message, response body, URL, or credential in this error.
export class TutorServiceError extends Error {
  constructor(
    readonly code: TutorFailureCode,
    readonly status?: number,
  ) {
    super(failures[code].message);
    this.name = "TutorServiceError";
  }
}

export function tutorFailure(error: unknown) {
  const value = error as {
    status?: unknown;
    statusCode?: unknown;
    name?: unknown;
    code?: unknown;
    error?: { code?: unknown };
  } | null;
  const rawStatus = value?.status ?? value?.statusCode;
  // The OpenAI SDK subclasses retain Error.name === "Error".
  const errorType =
    error instanceof Error && error.name === "Error" ? error.constructor.name : String(value?.name);
  const status =
    typeof rawStatus === "number" && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : undefined;
  let code: TutorFailureCode = error instanceof TutorServiceError ? error.code : "unavailable";
  if (!(error instanceof TutorServiceError)) {
    if (value?.code === "content_filter" || value?.error?.code === "content_filter")
      code = "content_filter";
    else if (
      status === 401 ||
      status === 403 ||
      [
        "AuthenticationRequiredError",
        "AggregateAuthenticationError",
        "CredentialUnavailableError",
      ].includes(errorType)
    )
      code = "authentication";
    else if (status === 404) code = "deployment";
    else if (status === 400 || status === 422) code = "request";
    else if (status === 429) code = "rate_limit";
    else if (
      status === 408 ||
      ["APIConnectionTimeoutError", "TimeoutError", "AbortError"].includes(errorType)
    )
      code = "timeout";
  }
  return { code, status, ...failures[code] };
}
