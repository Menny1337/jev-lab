import { choice, noul, score } from "@typesafe-ai/sdk";

export const STATE =
  "My payouts have failed for 3 days. I am losing sales and getting frustrated. "
  + "Please fix this as soon as possible.";

export const singleQuestions = {
  urgency: noul("Does this message express urgency or time-sensitivity?"),
};

export const batchQuestions = {
  ...singleQuestions,
  department: choice("Which team should handle this support request?", {
    billing: "Payment, payout or subscription issues",
    technical: "Bugs or integration problems",
    sales: "Pricing or account questions",
  }),
  frustration: score("How frustrated does the customer appear?", [
    "Calm, just stating facts",
    "Frustrated but civil",
    "Very angry, strong language",
  ]),
};
