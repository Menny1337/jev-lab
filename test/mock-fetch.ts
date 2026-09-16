import assert from "node:assert/strict";

// Imported only by subprocess tests; no network call is possible through this transport.
globalThis.fetch = async (_input, init) => {
  if (process.env.JEV_LAB_TEST_FAIL === "yes") {
    return Response.json({ error: "fixture-only" }, { status: 503 });
  }
  assert.equal(typeof init?.body, "string");
  const request: unknown = JSON.parse(String(init?.body));
  assert.ok(request && typeof request === "object" && "questions" in request);
  assert.ok(request.questions && typeof request.questions === "object");
  const answers = Object.fromEntries(Object.keys(request.questions).map(name => {
    if (name === "urgency") return [name, { type: "noul", noul: 0.5 }];
    if (name === "department") return [name, {
      type: "choice", choice: "billing", confidence: 0.5,
      probabilities: { billing: 0.6, technical: 0.3, sales: 0.1 },
    }];
    return [name, {
      type: "score", score: 1, confidence: 0.5,
      legend: { 0: "Calm", 1: "Frustrated", 2: "Angry" },
      probabilities: { 0: 0.2, 1: 0.6, 2: 0.2 },
    }];
  }));
  return Response.json({
    model: "mock-model", answers, usage: { input_tokens: 1, output_tokens: 1 },
  });
};
