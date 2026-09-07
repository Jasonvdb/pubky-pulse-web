import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dismissQuestionnaires,
  fetchQuestionnaire,
  PulseQuestionnaireError,
  saveQuestionnaireResponse,
  type QuestionnaireContext,
} from "../src/questionnaires";
import { SDK_VERSION } from "../src/types";
import { resetTestEnvironment } from "./setup";

const ctx: QuestionnaireContext = {
  endpoint: "https://pulse.example.com",
  apiKey: "pulse_client_abc",
  bundleId: "com.example.web",
  userId: "user-1",
  sessionId: "11111111-1111-4111-8111-111111111111",
  appVersion: "1.2.3",
  isDev: true,
};

const schema = {
  version: 1,
  questions: [
    { id: "how", type: "text", title: "How is it going?", required: true, multiline: true },
    {
      id: "pick",
      type: "single_choice",
      title: "Pick one",
      subtitle: "just one",
      required: false,
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    },
    { id: "score", type: "nps", title: "Would you recommend us?", required: false },
    { id: "stars", type: "rating", title: "Rate us", required: false, scale: 5 },
    { id: "future", type: "hologram", title: "From a later SDK", required: true },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

function respond(body: unknown, status = 200): void {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

function lastCall(): [string, RequestInit] {
  return fetchMock.mock.calls.at(-1) as [string, RequestInit];
}

describe("questionnaires", () => {
  beforeEach(() => {
    resetTestEnvironment();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("fetchQuestionnaire", () => {
    it("parses an eligible questionnaire and its in-progress draft", async () => {
      respond({
        eligible: true,
        questionnaire: {
          id: "q1",
          slug: "nps-2026",
          name: "NPS",
          description: "Tell us more",
          schema,
        },
        in_progress: { response_id: "r1", answers: { how: "fine", picks: ["b", "a"], score: 9 } },
      });

      const result = await fetchQuestionnaire(ctx, "nps-2026");

      expect(result.ineligibleReason).toBeUndefined();
      expect(result.questionnaire?.id).toBe("q1");
      expect(result.questionnaire?.description).toBe("Tell us more");
      // The unknown question type is dropped rather than breaking the fetch.
      expect(result.questionnaire?.schema.questions.map((q) => q.id)).toEqual([
        "how",
        "pick",
        "score",
        "stars",
      ]);
      expect(result.questionnaire?.schema.questions[0]).toEqual({
        id: "how",
        type: "text",
        title: "How is it going?",
        required: true,
        multiline: true,
      });
      expect(result.inProgress).toEqual({
        responseId: "r1",
        answers: { how: "fine", picks: ["b", "a"], score: 9 },
      });
    });

    it("sends bundle id, user id and force in the query string", async () => {
      respond({ eligible: false, reason: "inactive" });

      await fetchQuestionnaire(ctx, "nps 2026", { force: true });

      const [url, init] = lastCall();
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/v1/questionnaires/nps%202026");
      expect(parsed.searchParams.get("bundle_id")).toBe("com.example.web");
      expect(parsed.searchParams.get("user_id")).toBe("user-1");
      expect(parsed.searchParams.get("force")).toBe("true");
      expect(init.method).toBe("GET");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer pulse_client_abc",
      );
    });

    it("returns the ineligible reason instead of throwing", async () => {
      respond({ eligible: false, reason: "already_responded" });

      const result = await fetchQuestionnaire(ctx, "nps-2026");

      expect(result).toEqual({ ineligibleReason: "already_responded" });
    });

    it("maps a 404 to a not_found error", async () => {
      respond({ error: "Questionnaire not found" }, 404);

      const error = await fetchQuestionnaire(ctx, "nope").catch((err: unknown) => err);

      expect(error).toBeInstanceOf(PulseQuestionnaireError);
      expect((error as PulseQuestionnaireError).reason).toBe("not_found");
      expect((error as PulseQuestionnaireError).status).toBe(404);
      expect((error as Error).message).toBe("Pubky Pulse: Questionnaire not found");
    });

    it("rejects an unknown ineligibility reason", async () => {
      respond({ eligible: false, reason: "because" });

      await expect(fetchQuestionnaire(ctx, "nps-2026")).rejects.toMatchObject({
        reason: "server_error",
      });
    });

    it("reports a network failure", async () => {
      fetchMock.mockRejectedValue(new Error("offline"));

      await expect(fetchQuestionnaire(ctx, "nps-2026")).rejects.toMatchObject({
        reason: "network_error",
      });
    });

    it("omits the user id when there is none", async () => {
      respond({ eligible: false, reason: "inactive" });

      const { userId: _userId, ...anonymous } = ctx;
      await fetchQuestionnaire(anonymous, "nps-2026");

      expect(new URL(lastCall()[0]).searchParams.has("user_id")).toBe(false);
    });
  });

  describe("saveQuestionnaireResponse", () => {
    it("posts the full answer set and parses the receipt", async () => {
      respond(
        { id: "r1", created_at: "2026-09-04T10:00:00.000Z", was_submitted: true },
        201,
      );

      const receipt = await saveQuestionnaireResponse(
        ctx,
        "nps-2026",
        { how: "great", pick: "a", score: 10 },
        true,
      );

      expect(receipt).toEqual({
        id: "r1",
        createdAt: new Date("2026-09-04T10:00:00.000Z"),
        wasSubmitted: true,
      });
      const [url, init] = lastCall();
      expect(url).toBe("https://pulse.example.com/v1/questionnaires/nps-2026/responses");
      expect(JSON.parse(init.body as string)).toEqual({
        bundle_id: "com.example.web",
        answers: { how: "great", pick: "a", score: 10 },
        is_complete: true,
        sdk_name: "pubky-pulse-web",
        sdk_version: SDK_VERSION,
        environment: "web",
        is_dev: true,
        session_id: "11111111-1111-4111-8111-111111111111",
        user_id: "user-1",
        app_version: "1.2.3",
      });
    });

    it("reports was_submitted false for a draft save", async () => {
      respond({ id: "r1", created_at: "2026-09-04T10:00:00.000Z", was_submitted: false });

      const receipt = await saveQuestionnaireResponse(ctx, "nps-2026", { how: "ok" }, false);

      expect(receipt.wasSubmitted).toBe(false);
      expect(JSON.parse(lastCall()[1].body as string).is_complete).toBe(false);
    });

    it("maps a 409 to its reason", async () => {
      respond({ error: "Already responded", reason: "already_responded" }, 409);

      const error = await saveQuestionnaireResponse(ctx, "nps-2026", {}, true).catch(
        (err: unknown) => err,
      );

      expect((error as PulseQuestionnaireError).reason).toBe("already_responded");
      expect((error as PulseQuestionnaireError).status).toBe(409);
    });

    it("maps a 409 without a known reason to a server error", async () => {
      respond({ error: "Nope", reason: "mystery" }, 409);

      await expect(saveQuestionnaireResponse(ctx, "nps-2026", {}, true)).rejects.toMatchObject({
        reason: "server_error",
      });
    });

    it("maps a 400 to invalid answers", async () => {
      respond({ error: "answer for \"score\" must be 0-10" }, 400);

      await expect(saveQuestionnaireResponse(ctx, "nps-2026", { score: 42 }, true)).rejects.toMatchObject(
        { reason: "invalid_answers" },
      );
    });

    it("rejects a receipt without a usable timestamp", async () => {
      respond({ id: "r1", created_at: "not-a-date", was_submitted: true }, 201);

      await expect(saveQuestionnaireResponse(ctx, "nps-2026", {}, false)).rejects.toMatchObject({
        reason: "server_error",
      });
    });
  });

  describe("dismissQuestionnaires", () => {
    it("posts the bundle and user and returns the dismissal date", async () => {
      respond({ dismissed_at: "2026-09-04T11:00:00.000Z" });

      const dismissedAt = await dismissQuestionnaires(ctx);

      expect(dismissedAt).toEqual(new Date("2026-09-04T11:00:00.000Z"));
      const [url, init] = lastCall();
      expect(url).toBe("https://pulse.example.com/v1/questionnaires/dismiss");
      expect(JSON.parse(init.body as string)).toEqual({
        bundle_id: "com.example.web",
        user_id: "user-1",
      });
    });

    it("throws when the server rejects the dismissal", async () => {
      respond({ error: "user_id is required to dismiss questionnaires" }, 400);

      await expect(dismissQuestionnaires(ctx)).rejects.toBeInstanceOf(PulseQuestionnaireError);
    });
  });
});
