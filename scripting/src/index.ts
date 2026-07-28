import OpenAI from "openai";
import "dotenv/config";

async function main() {
  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  if (!client.apiKey) {
    throw new Error("OPENAI_API_KEY is missing. Check your .env file.");
  }

  const response = await client.responses.create({
    model: "gpt-4o",
    input: `Find groups of four items that share something in common.

Category Examples
FISH: Bass, Flounder, Salmon, Trout
FIRE ___: Ant, Drill, Island, Opal

Categories will always be more specific than
"5-LETTER-WORDS," "NAMES" or "VERBS."

Each puzzle has exactly one solution. Every item fits in
exactly one category.

Watch out for words that seem to belong to multiple categories!

Order your answers in terms of your confidence level, high confidence first.

Here are the items:

Captain, Clarks, Ottoman, Empire, Annapolis, Bobsled, Camper, Direct
Everest, Fuji, Gala, Head, Converse, Lead, Honeycrisp, Crocs

Return your guess as ONLY JSON like this:

{"groups":
[
{"items": ["item1a", "item2a", "item3a", "item4a"],
"reason": "…"},
{"items": ["item2a", "item2b", "item3b", "item4b"],
"reason": "…"},
]}
No other text.`,
  });

  console.log("Model output:", response.output_text);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
