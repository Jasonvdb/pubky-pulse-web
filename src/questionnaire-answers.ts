/**
 * Pure helpers for collecting questionnaire answers. They hold no state of
 * their own and never touch the network, so a host app can drive its own form
 * — React state, a Svelte store, plain DOM — and still get the exact answer
 * set the server expects.
 */

import type {
  PulseQuestionnaireAnswers,
  PulseQuestionnaireAnswerValue,
  PulseQuestionnaireQuestion,
  PulseQuestionnaireSchema,
} from "./questionnaires";

/** Answers collected so far, keyed by question id. Treat it as immutable. */
export type PulseQuestionnaireAnswerStore = Readonly<PulseQuestionnaireAnswers>;

/** Option ids, deduplicated and sorted so a re-save produces a stable body. */
function normalizeChoices(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizeValue(
  value: PulseQuestionnaireAnswerValue,
): PulseQuestionnaireAnswerValue | undefined {
  if (typeof value === "string") return value.trim().length > 0 ? value : undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const choices = normalizeChoices(value.filter((entry) => typeof entry === "string"));
    return choices.length > 0 ? choices : undefined;
  }
  return undefined;
}

/**
 * Start a store, optionally pre-filled from the `inProgress` draft of a fetch
 * result. Unusable values in the draft are dropped rather than trusted.
 */
export function createAnswerStore(
  prefill?: PulseQuestionnaireAnswers,
): PulseQuestionnaireAnswerStore {
  const store: PulseQuestionnaireAnswers = {};
  if (prefill) {
    for (const [id, value] of Object.entries(prefill)) {
      const normalized = normalizeValue(value);
      if (normalized !== undefined) store[id] = normalized;
    }
  }
  return store;
}

/**
 * Return a new store with one answer set. `undefined` or `null` — and any
 * value that normalises to nothing, such as an empty selection — clears it.
 */
export function setAnswer(
  store: PulseQuestionnaireAnswerStore,
  questionId: string,
  value: PulseQuestionnaireAnswerValue | undefined | null,
): PulseQuestionnaireAnswerStore {
  const next: PulseQuestionnaireAnswers = { ...store };
  const normalized = value === undefined || value === null ? undefined : normalizeValue(value);
  if (normalized === undefined) {
    delete next[questionId];
  } else {
    next[questionId] = normalized;
  }
  return next;
}

/** True when the question has a usable answer of the right shape. */
export function isAnswered(
  store: PulseQuestionnaireAnswerStore,
  question: PulseQuestionnaireQuestion,
): boolean {
  const value = store[question.id];
  if (value === undefined) return false;

  switch (question.type) {
    case "text":
      return typeof value === "string" && value.trim().length > 0;
    case "single_choice":
      return typeof value === "string" && value.length > 0;
    case "multi_choice":
      return Array.isArray(value) && value.length > 0;
    case "rating":
    case "nps":
      return typeof value === "number" && Number.isFinite(value);
  }
}

/** True when every question marked `required` has an answer. */
export function hasAllRequired(
  store: PulseQuestionnaireAnswerStore,
  schema: PulseQuestionnaireSchema,
): boolean {
  return schema.questions.every((question) => !question.required || isAnswered(store, question));
}

/**
 * The answer set to send: only ids the schema still knows about, text trimmed,
 * multi-choice ids sorted. Unanswered questions are omitted entirely.
 */
export function collected(
  store: PulseQuestionnaireAnswerStore,
  schema: PulseQuestionnaireSchema,
): PulseQuestionnaireAnswers {
  const answers: PulseQuestionnaireAnswers = {};
  for (const question of schema.questions) {
    if (!isAnswered(store, question)) continue;
    const value = store[question.id] as PulseQuestionnaireAnswerValue;
    if (question.type === "text" && typeof value === "string") {
      answers[question.id] = value.trim();
    } else if (Array.isArray(value)) {
      answers[question.id] = normalizeChoices(value);
    } else {
      answers[question.id] = value;
    }
  }
  return answers;
}

/**
 * Index of the first unanswered question, for landing a resumed flow where the
 * user left off. When everything is answered it returns the last index so the
 * flow shows the page with the submit control, and 0 for an empty schema.
 */
export function firstUnansweredIndex(
  store: PulseQuestionnaireAnswerStore,
  schema: PulseQuestionnaireSchema,
): number {
  const index = schema.questions.findIndex((question) => !isAnswered(store, question));
  if (index !== -1) return index;
  return Math.max(0, schema.questions.length - 1);
}
