import { describe, expect, it } from "vitest";
import {
  collected,
  createAnswerStore,
  firstUnansweredIndex,
  hasAllRequired,
  isAnswered,
  setAnswer,
} from "../src/questionnaire-answers";
import type {
  PulseQuestionnaireQuestion,
  PulseQuestionnaireSchema,
} from "../src/questionnaires";

const text: PulseQuestionnaireQuestion = {
  id: "how",
  type: "text",
  title: "How is it going?",
  required: true,
  multiline: false,
};
const single: PulseQuestionnaireQuestion = {
  id: "pick",
  type: "single_choice",
  title: "Pick one",
  required: false,
  options: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
};
const multi: PulseQuestionnaireQuestion = {
  id: "uses",
  type: "multi_choice",
  title: "What do you use?",
  required: true,
  options: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" },
  ],
};
const rating: PulseQuestionnaireQuestion = {
  id: "stars",
  type: "rating",
  title: "Rate us",
  required: false,
  scale: 5,
};
const nps: PulseQuestionnaireQuestion = {
  id: "score",
  type: "nps",
  title: "Recommend us?",
  required: false,
};

const schema: PulseQuestionnaireSchema = {
  version: 1,
  questions: [text, single, multi, rating, nps],
};

describe("createAnswerStore", () => {
  it("starts empty", () => {
    expect(createAnswerStore()).toEqual({});
  });

  it("keeps usable draft values and sorts multi-choice ids", () => {
    const store = createAnswerStore({ how: "fine", uses: ["c", "a"], score: 0 });

    expect(store).toEqual({ how: "fine", uses: ["a", "c"], score: 0 });
  });

  it("drops values a question could never use", () => {
    const store = createAnswerStore({ how: "   ", uses: [], stars: Number.NaN });

    expect(store).toEqual({});
  });

  it("does not alias the prefill object", () => {
    const prefill = { how: "fine" };
    const store = setAnswer(createAnswerStore(prefill), "how", "changed");

    expect(prefill.how).toBe("fine");
    expect(store.how).toBe("changed");
  });
});

describe("setAnswer", () => {
  it("returns a new store and leaves the old one alone", () => {
    const first = createAnswerStore();
    const second = setAnswer(first, "how", "fine");

    expect(first).toEqual({});
    expect(second).toEqual({ how: "fine" });
  });

  it("deduplicates and sorts multi-choice values", () => {
    const store = setAnswer(createAnswerStore(), "uses", ["c", "a", "c"]);

    expect(store.uses).toEqual(["a", "c"]);
  });

  it("clears an answer set to null, undefined or an empty selection", () => {
    const store = createAnswerStore({ how: "fine", uses: ["a"], score: 3 });

    expect(setAnswer(store, "how", undefined)).toEqual({ uses: ["a"], score: 3 });
    expect(setAnswer(store, "score", null)).toEqual({ how: "fine", uses: ["a"] });
    expect(setAnswer(store, "uses", [])).toEqual({ how: "fine", score: 3 });
  });

  it("keeps a zero rating, which is a real NPS answer", () => {
    expect(setAnswer(createAnswerStore(), "score", 0)).toEqual({ score: 0 });
  });
});

describe("isAnswered", () => {
  it("requires text with more than whitespace", () => {
    expect(isAnswered({ how: "fine" }, text)).toBe(true);
    expect(isAnswered({ how: "   " }, text)).toBe(false);
    expect(isAnswered({}, text)).toBe(false);
  });

  it("requires at least one selection for multi choice", () => {
    expect(isAnswered({ uses: ["a"] }, multi)).toBe(true);
    expect(isAnswered({ uses: [] }, multi)).toBe(false);
  });

  it("accepts any finite number for rating and nps", () => {
    expect(isAnswered({ stars: 4 }, rating)).toBe(true);
    expect(isAnswered({ score: 0 }, nps)).toBe(true);
  });

  it("rejects a value of the wrong shape for the question", () => {
    expect(isAnswered({ pick: ["a"] }, single)).toBe(false);
    expect(isAnswered({ stars: "4" }, rating)).toBe(false);
  });
});

describe("hasAllRequired", () => {
  it("is false until every required question is answered", () => {
    const store = createAnswerStore({ how: "fine" });

    expect(hasAllRequired(store, schema)).toBe(false);
    expect(hasAllRequired(setAnswer(store, "uses", ["b"]), schema)).toBe(true);
  });

  it("ignores optional questions", () => {
    expect(hasAllRequired({ how: "fine", uses: ["a"] }, schema)).toBe(true);
  });
});

describe("collected", () => {
  it("trims text, sorts choices and omits unanswered questions", () => {
    const store = createAnswerStore({ how: "  fine  ", uses: ["c", "b"], score: 9 });

    expect(collected(store, schema)).toEqual({ how: "fine", uses: ["b", "c"], score: 9 });
  });

  it("drops answers whose question left the schema", () => {
    const store = createAnswerStore({ how: "fine", removed: "stale" });

    expect(collected(store, schema)).toEqual({ how: "fine" });
  });
});

describe("firstUnansweredIndex", () => {
  it("finds the first gap", () => {
    expect(firstUnansweredIndex({ how: "fine" }, schema)).toBe(1);
  });

  it("lands on the last question once everything is answered", () => {
    const store = createAnswerStore({
      how: "fine",
      pick: "a",
      uses: ["a"],
      stars: 5,
      score: 10,
    });

    expect(firstUnansweredIndex(store, schema)).toBe(schema.questions.length - 1);
  });

  it("returns zero for an empty schema", () => {
    expect(firstUnansweredIndex({}, { version: 1, questions: [] })).toBe(0);
  });
});
