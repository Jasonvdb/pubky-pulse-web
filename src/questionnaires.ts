/**
 * Questionnaire fetching and response saving. These calls are synchronous
 * developer-facing requests — a person is waiting on the result of a tap — so
 * unlike ingest they are a single attempt and failures are thrown rather than
 * buffered.
 */

import { ENVIRONMENT, SDK_NAME, SDK_VERSION } from "./types";
import { REQUEST_TIMEOUT_MS } from "./transport";

export type PulseQuestionnaireQuestionType =
  | "text"
  | "single_choice"
  | "multi_choice"
  | "rating"
  | "nps";

export interface PulseQuestionnaireOption {
  id: string;
  label: string;
}

interface QuestionBase {
  id: string;
  title: string;
  subtitle?: string;
  required: boolean;
}

export interface PulseQuestionnaireTextQuestion extends QuestionBase {
  type: "text";
  placeholder?: string;
  multiline: boolean;
}

export interface PulseQuestionnaireSingleChoiceQuestion extends QuestionBase {
  type: "single_choice";
  options: PulseQuestionnaireOption[];
}

export interface PulseQuestionnaireMultiChoiceQuestion extends QuestionBase {
  type: "multi_choice";
  options: PulseQuestionnaireOption[];
}

export interface PulseQuestionnaireRatingQuestion extends QuestionBase {
  type: "rating";
  /** Highest selectable value. Version 1 schemas always use 5. */
  scale: number;
}

export interface PulseQuestionnaireNpsQuestion extends QuestionBase {
  type: "nps";
}

export type PulseQuestionnaireQuestion =
  | PulseQuestionnaireTextQuestion
  | PulseQuestionnaireSingleChoiceQuestion
  | PulseQuestionnaireMultiChoiceQuestion
  | PulseQuestionnaireRatingQuestion
  | PulseQuestionnaireNpsQuestion;

export interface PulseQuestionnaireSchema {
  version: number;
  questions: PulseQuestionnaireQuestion[];
}

export interface PulseQuestionnaire {
  id: string;
  slug: string;
  name: string;
  description?: string;
  schema: PulseQuestionnaireSchema;
}

/** Wire shape of one answer: text / option id, option ids, or a number. */
export type PulseQuestionnaireAnswerValue = string | string[] | number;

export type PulseQuestionnaireAnswers = Record<string, PulseQuestionnaireAnswerValue>;

/** An unsubmitted response the caller can resume. */
export interface PulseQuestionnaireDraft {
  responseId: string;
  answers: PulseQuestionnaireAnswers;
}

export type PulseQuestionnaireIneligibleReason =
  | "already_responded"
  | "globally_dismissed"
  | "inactive";

/**
 * Result of a fetch. Exactly one of `questionnaire` and `ineligibleReason` is
 * set: an ineligible questionnaire is a normal outcome, not an error.
 */
export interface PulseQuestionnaireFetchResult {
  questionnaire?: PulseQuestionnaire;
  inProgress?: PulseQuestionnaireDraft;
  ineligibleReason?: PulseQuestionnaireIneligibleReason;
}

export interface PulseQuestionnaireReceipt {
  id: string;
  createdAt: Date;
  /**
   * True only on the call that flipped the response from draft to submitted,
   * so a resumed flow shows its success state exactly once.
   */
  wasSubmitted: boolean;
}

export type PulseQuestionnaireErrorReason =
  | "not_configured"
  | "not_found"
  | "invalid_answers"
  | "already_responded"
  | "globally_dismissed"
  | "inactive"
  | "server_error"
  | "network_error";

export class PulseQuestionnaireError extends Error {
  readonly reason: PulseQuestionnaireErrorReason;
  readonly status?: number;

  constructor(reason: PulseQuestionnaireErrorReason, message: string, status?: number) {
    super(`Pubky Pulse: ${message}`);
    this.name = "PulseQuestionnaireError";
    this.reason = reason;
    if (status !== undefined) this.status = status;
  }
}

/** Everything a questionnaire request needs from the configured SDK. */
export interface QuestionnaireContext {
  endpoint: string;
  apiKey: string;
  bundleId?: string;
  userId?: string;
  sessionId?: string;
  appVersion?: string;
  isDev: boolean;
}

const INELIGIBLE_REASONS = new Set<string>([
  "already_responded",
  "globally_dismissed",
  "inactive",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseOptions(raw: unknown): PulseQuestionnaireOption[] {
  if (!Array.isArray(raw)) return [];
  const options: PulseQuestionnaireOption[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    if (typeof entry.id !== "string" || typeof entry.label !== "string") continue;
    options.push({ id: entry.id, label: entry.label });
  }
  return options;
}

/**
 * Parse one question, or return null for a shape this SDK version does not
 * understand. Skipping beats throwing: a newer question type added server-side
 * must not break an already-shipped client.
 */
function parseQuestion(raw: unknown): PulseQuestionnaireQuestion | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || typeof raw.title !== "string") return null;

  const base: QuestionBase = {
    id: raw.id,
    title: raw.title,
    required: raw.required === true,
  };
  const subtitle = optionalString(raw.subtitle);
  if (subtitle) base.subtitle = subtitle;

  switch (raw.type) {
    case "text": {
      const question: PulseQuestionnaireTextQuestion = {
        ...base,
        type: "text",
        multiline: raw.multiline === true,
      };
      const placeholder = optionalString(raw.placeholder);
      if (placeholder) question.placeholder = placeholder;
      return question;
    }
    case "single_choice":
      return { ...base, type: "single_choice", options: parseOptions(raw.options) };
    case "multi_choice":
      return { ...base, type: "multi_choice", options: parseOptions(raw.options) };
    case "rating":
      return {
        ...base,
        type: "rating",
        scale: typeof raw.scale === "number" && raw.scale > 0 ? raw.scale : 5,
      };
    case "nps":
      return { ...base, type: "nps" };
    default:
      return null;
  }
}

function parseSchema(raw: unknown): PulseQuestionnaireSchema {
  if (!isRecord(raw) || !Array.isArray(raw.questions)) {
    throw new PulseQuestionnaireError("server_error", "questionnaire schema is malformed");
  }
  const questions: PulseQuestionnaireQuestion[] = [];
  for (const entry of raw.questions) {
    const question = parseQuestion(entry);
    if (question) questions.push(question);
  }
  return {
    version: typeof raw.version === "number" ? raw.version : 1,
    questions,
  };
}

function parseQuestionnaire(raw: unknown): PulseQuestionnaire {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    typeof raw.slug !== "string" ||
    typeof raw.name !== "string"
  ) {
    throw new PulseQuestionnaireError("server_error", "questionnaire payload is malformed");
  }
  const questionnaire: PulseQuestionnaire = {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    schema: parseSchema(raw.schema),
  };
  const description = optionalString(raw.description);
  if (description) questionnaire.description = description;
  return questionnaire;
}

function parseAnswerValue(raw: unknown): PulseQuestionnaireAnswerValue | undefined {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (Array.isArray(raw)) {
    const ids = raw.filter((entry): entry is string => typeof entry === "string");
    return ids.length > 0 ? ids : undefined;
  }
  return undefined;
}

function parseAnswers(raw: unknown): PulseQuestionnaireAnswers {
  if (!isRecord(raw)) return {};
  const answers: PulseQuestionnaireAnswers = {};
  for (const [key, value] of Object.entries(raw)) {
    const parsed = parseAnswerValue(value);
    if (parsed !== undefined) answers[key] = parsed;
  }
  return answers;
}

function parseDraft(raw: unknown): PulseQuestionnaireDraft | undefined {
  if (!isRecord(raw) || typeof raw.response_id !== "string") return undefined;
  return { responseId: raw.response_id, answers: parseAnswers(raw.answers) };
}

function parseDate(raw: unknown, label: string): Date {
  if (typeof raw !== "string") {
    throw new PulseQuestionnaireError("server_error", `${label} is missing from the response`);
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new PulseQuestionnaireError("server_error", `${label} is not a valid timestamp`);
  }
  return date;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

function serverMessage(body: unknown, fallback: string): string {
  if (isRecord(body) && typeof body.error === "string" && body.error.length > 0) {
    return body.error;
  }
  return fallback;
}

/** Translate a non-2xx response into the error the caller sees. */
async function failure(
  response: Response,
  label: string,
): Promise<PulseQuestionnaireError> {
  const body = await readJson(response);

  if (response.status === 404) {
    return new PulseQuestionnaireError(
      "not_found",
      serverMessage(body, "questionnaire not found"),
      404,
    );
  }

  if (response.status === 409) {
    const reason = isRecord(body) && typeof body.reason === "string" ? body.reason : undefined;
    if (reason && INELIGIBLE_REASONS.has(reason)) {
      return new PulseQuestionnaireError(
        reason as PulseQuestionnaireIneligibleReason,
        serverMessage(body, `${label} rejected: ${reason}`),
        409,
      );
    }
    return new PulseQuestionnaireError(
      "server_error",
      serverMessage(body, `${label} conflicted`),
      409,
    );
  }

  if (response.status === 400) {
    return new PulseQuestionnaireError(
      "invalid_answers",
      serverMessage(body, `${label} was rejected`),
      400,
    );
  }

  return new PulseQuestionnaireError(
    "server_error",
    serverMessage(body, `${label} failed with ${response.status}`),
    response.status,
  );
}

function networkFailure(err: unknown, label: string): PulseQuestionnaireError {
  const detail = err instanceof Error ? err.message : String(err);
  return new PulseQuestionnaireError("network_error", `${label} failed: ${detail}`);
}

function authHeaders(ctx: QuestionnaireContext): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ctx.apiKey}`,
  };
}

async function request(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw networkFailure(err, label);
  }
}

/**
 * Fetch a questionnaire and the caller's eligibility for it. `force` bypasses
 * the soft gates (already responded, globally dismissed) so a developer can
 * preview the flow; `inactive` is still enforced server-side.
 */
export async function fetchQuestionnaire(
  ctx: QuestionnaireContext,
  slug: string,
  options?: { force?: boolean },
): Promise<PulseQuestionnaireFetchResult> {
  const url = new URL(`${ctx.endpoint}/v1/questionnaires/${encodeURIComponent(slug)}`);
  if (ctx.bundleId !== undefined) url.searchParams.set("bundle_id", ctx.bundleId);
  if (ctx.userId) url.searchParams.set("user_id", ctx.userId);
  if (options?.force) url.searchParams.set("force", "true");

  const response = await request(
    url.toString(),
    { method: "GET", headers: { Authorization: `Bearer ${ctx.apiKey}` } },
    "fetchQuestionnaire",
  );

  if (!response.ok) throw await failure(response, "fetchQuestionnaire");

  const body = await readJson(response);
  if (!isRecord(body)) {
    throw new PulseQuestionnaireError("server_error", "questionnaire response is malformed");
  }

  if (body.eligible === false) {
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    if (!reason || !INELIGIBLE_REASONS.has(reason)) {
      throw new PulseQuestionnaireError(
        "server_error",
        "questionnaire response carried an unknown ineligibility reason",
      );
    }
    return { ineligibleReason: reason as PulseQuestionnaireIneligibleReason };
  }

  const result: PulseQuestionnaireFetchResult = {
    questionnaire: parseQuestionnaire(body.questionnaire),
  };
  const draft = parseDraft(body.in_progress);
  if (draft) result.inProgress = draft;
  return result;
}

/**
 * Save answers. Always send the full accumulated set: the server merges per
 * key, and a completion call validates every required question against it.
 */
export async function saveQuestionnaireResponse(
  ctx: QuestionnaireContext,
  slug: string,
  answers: PulseQuestionnaireAnswers,
  isComplete: boolean,
): Promise<PulseQuestionnaireReceipt> {
  const payload: Record<string, unknown> = {
    bundle_id: ctx.bundleId,
    answers,
    is_complete: isComplete,
    sdk_name: SDK_NAME,
    sdk_version: SDK_VERSION,
    environment: ENVIRONMENT,
    is_dev: ctx.isDev,
  };
  if (ctx.sessionId) payload.session_id = ctx.sessionId;
  if (ctx.userId) payload.user_id = ctx.userId;
  if (ctx.appVersion) payload.app_version = ctx.appVersion;

  const response = await request(
    `${ctx.endpoint}/v1/questionnaires/${encodeURIComponent(slug)}/responses`,
    { method: "POST", headers: authHeaders(ctx), body: JSON.stringify(payload) },
    "saveQuestionnaireResponse",
  );

  if (!response.ok) throw await failure(response, "saveQuestionnaireResponse");

  const body = await readJson(response);
  if (!isRecord(body) || typeof body.id !== "string") {
    throw new PulseQuestionnaireError("server_error", "questionnaire receipt is malformed");
  }
  return {
    id: body.id,
    createdAt: parseDate(body.created_at, "created_at"),
    wasSubmitted: body.was_submitted === true,
  };
}

/** Opt the current user out of every questionnaire. Idempotent server-side. */
export async function dismissQuestionnaires(ctx: QuestionnaireContext): Promise<Date> {
  const payload: Record<string, unknown> = { bundle_id: ctx.bundleId };
  if (ctx.userId) payload.user_id = ctx.userId;

  const response = await request(
    `${ctx.endpoint}/v1/questionnaires/dismiss`,
    { method: "POST", headers: authHeaders(ctx), body: JSON.stringify(payload) },
    "dismissQuestionnaires",
  );

  if (!response.ok) throw await failure(response, "dismissQuestionnaires");

  const body = await readJson(response);
  if (!isRecord(body)) {
    throw new PulseQuestionnaireError("server_error", "dismiss response is malformed");
  }
  return parseDate(body.dismissed_at, "dismissed_at");
}
