/**
 * OpenRouter LLM client — Propose, Directions, and Narrate stages.
 * Propose uses JSON schema structured output.
 * Narrate uses plain text — system prompt forbids asserting unverified facts.
 */

import { logger } from "./logger";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const PROPOSE_MODEL = process.env.OPENROUTER_PROPOSE_MODEL ?? "deepseek/deepseek-chat";
const NARRATE_MODEL = process.env.OPENROUTER_NARRATE_MODEL ?? "meta-llama/llama-3.3-70b-instruct";
const BASE_URL = "https://openrouter.ai/api/v1/chat/completions";

if (!OPENROUTER_KEY) {
  logger.warn("OPENROUTER_API_KEY is not set — LLM features will fail at runtime");
}

interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenRouterResponse {
  choices: Array<{
    message: { content: string };
  }>;
}

async function chat(
  model: string,
  messages: OpenRouterMessage[],
  responseFormat?: { type: "json_schema"; json_schema: { name: string; schema: unknown; strict: boolean } }
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.8,
  };

  if (responseFormat) {
    body.response_format = responseFormat;
  }

  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_BASE_URL ?? "http://localhost",
      "X-Title": "Trails",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as OpenRouterResponse;
  return data.choices[0]?.message.content ?? "";
}

// ---- Types ----

export interface Candidate {
  artist: string;
  title: string;
  type: "track" | "album";
  year_guess?: number;
  rationale: string;
  likely_known: "low" | "medium" | "high";
}

export interface Direction {
  label: string;
  rationale: string;
  isWellTrodden: boolean;
}

export interface DirectionsResult {
  hypothesis: string;
  directions: Direction[];
  wellTroddenDirection: Direction;
}

// ---- Propose ----

export async function propose(opts: {
  portraitText: string;
  recap: string;
  directionLabel: string;
  directionRationale: string;
  similarArtists: string[];
  count?: number;
}): Promise<Candidate[]> {
  const { portraitText, recap, directionLabel, directionRationale, similarArtists, count = 5 } = opts;

  const wellTroddenList = similarArtists.slice(0, 10).join(", ");

  const systemPrompt = `You are a music recommendation assistant. Generate track candidates that fit the user's taste and the chosen direction.

CRITICAL RULES:
- Output ONLY valid JSON matching the schema. No prose, no markdown.
- The well-trodden artists are: ${wellTroddenList || "none identified"}. Steer AWAY from these for the main direction.
- Include likely_known: "low" for genuinely obscure picks, "medium" for moderately known, "high" for widely known.
- Generate ${count} candidates (we will validate and may need extras).`;

  const userPrompt = `User taste portrait:
${portraitText}

Recent dive recap:
${recap || "(first dive — no recap yet)"}

Chosen direction: "${directionLabel}"
Direction rationale: ${directionRationale}

Generate ${count} track/album candidates that fit this direction and this user's taste. Steer away from the well-trodden artists.`;

  const schema = {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            artist: { type: "string" },
            title: { type: "string" },
            type: { type: "string", enum: ["track", "album"] },
            year_guess: { type: "number" },
            rationale: { type: "string" },
            likely_known: { type: "string", enum: ["low", "medium", "high"] },
          },
          required: ["artist", "title", "type", "rationale", "likely_known"],
        },
      },
    },
    required: ["candidates"],
  };

  const raw = await chat(PROPOSE_MODEL, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ], {
    type: "json_schema",
    json_schema: { name: "candidates", schema, strict: true },
  });

  try {
    const parsed = JSON.parse(raw) as { candidates: Candidate[] };
    return parsed.candidates ?? [];
  } catch (err) {
    logger.error({ err, raw }, "Failed to parse Propose response");
    return [];
  }
}

// ---- Directions ----

export async function directions(opts: {
  portraitText: string;
  recap: string;
  seeds: Array<{ title: string; artist: string }>;
  similarArtists: string[];
}): Promise<DirectionsResult> {
  const { portraitText, recap, seeds, similarArtists } = opts;
  const wellTroddenList = similarArtists.slice(0, 10).join(", ");
  const wellTroddenTop = similarArtists[0] ?? "a popular similar artist";

  const systemPrompt = `You are a music taste analyst. Given a user's taste profile, generate 3 distinct exploration directions — each a named, themed path into new music.

CRITICAL RULES:
- Output ONLY valid JSON matching the schema.
- The 3 directions must be CONTRASTIVE — steer them AWAY from: ${wellTroddenList || "none"}.
- Each direction needs a vivid, evocative label (3-5 words) and a 1-sentence rationale.
- The well_trodden direction is the conventional pick — just name the obvious similar artist.`;

  const seedList = seeds.map((s) => `"${s.title}" by ${s.artist}`).join(", ");
  const userPrompt = `User seeds: ${seedList}

Taste portrait:
${portraitText}

Recap:
${recap || "(no prior dives)"}

Well-trodden reference (top Last.fm similar): ${wellTroddenTop}

Generate 3 named themed directions (contrastive) and the well-trodden direction.`;

  const schema = {
    type: "object",
    properties: {
      hypothesis: { type: "string" },
      directions: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            rationale: { type: "string" },
          },
          required: ["label", "rationale"],
        },
      },
      well_trodden_label: { type: "string" },
      well_trodden_rationale: { type: "string" },
    },
    required: ["hypothesis", "directions", "well_trodden_label", "well_trodden_rationale"],
  };

  const raw = await chat(PROPOSE_MODEL, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ], {
    type: "json_schema",
    json_schema: { name: "directions", schema, strict: true },
  });

  try {
    const parsed = JSON.parse(raw) as {
      hypothesis: string;
      directions: Array<{ label: string; rationale: string }>;
      well_trodden_label: string;
      well_trodden_rationale: string;
    };

    return {
      hypothesis: parsed.hypothesis,
      directions: parsed.directions.map((d) => ({
        label: d.label,
        rationale: d.rationale,
        isWellTrodden: false,
      })),
      wellTroddenDirection: {
        label: parsed.well_trodden_label,
        rationale: parsed.well_trodden_rationale,
        isWellTrodden: true,
      },
    };
  } catch (err) {
    logger.error({ err, raw }, "Failed to parse Directions response");
    throw new Error("Failed to generate directions");
  }
}

// ---- Generate portrait ----

export async function generatePortrait(opts: {
  seeds: Array<{ title: string; artist: string; year: number | null; prompt: string | null }>;
  pairChoices: Array<{ winner: string; loser: string; strength: number }>;
}): Promise<string> {
  const { seeds, pairChoices } = opts;

  const seedList = seeds
    .map((s) => `- "${s.title}" by ${s.artist}${s.year ? ` (${s.year})` : ""}${s.prompt ? ` [seeded from: "${s.prompt}"]` : ""}`)
    .join("\n");

  const pairList = pairChoices.length > 0
    ? pairChoices.map((p) => `- Preferred "${p.winner}" over "${p.loser}" (strength: ${p.strength}/2)`).join("\n")
    : "(no pairwise data yet)";

  const systemPrompt = `You are a music taste analyst. Write a vivid, personal taste portrait (150-300 words) in second person ("You are drawn to..."). 
  
Focus on:
- The emotional and sonic textures the user gravitates toward
- What the seeds reveal about their relationship with music (escapism, nostalgia, energy, texture, etc.)
- Specific qualities they seem to value (production, lyricism, mood, era)
- A sense of their listening context

Do NOT list the songs back. Do NOT use music review clichés. Write as if you know this person.`;

  const userPrompt = `Seeds:\n${seedList}\n\nPairwise preferences:\n${pairList}`;

  const portrait = await chat(NARRATE_MODEL, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);

  return portrait.trim();
}

// ---- Narrate ----

export async function narrate(opts: {
  portraitText: string;
  rec: {
    title: string;
    artist: string;
    year: number | null;
    relationships: unknown;
  };
  directionLabel: string;
  priorRatings: Array<{ title: string; artist: string; listenState: string; score: number | null }>;
}): Promise<string> {
  const { portraitText, rec, directionLabel, priorRatings } = opts;

  const ratingContext = priorRatings.length > 0
    ? priorRatings
        .slice(-5)
        .map(
          (r) =>
            `- "${r.title}" by ${r.artist}: ${r.listenState}${r.score ? ` (${r.score}/5)` : ""}`
        )
        .join("\n")
    : "(no prior ratings)";

  const relationships = JSON.stringify(rec.relationships ?? {}, null, 2).slice(0, 500);

  const systemPrompt = `You are writing a personalized recommendation narrative. Write 150-220 words in second person.

STRICT RULES:
- Only assert facts present in the verified metadata supplied below. Do NOT invent release dates, label names, personnel, or collaborations not listed.
- When MusicBrainz relationships support a specific claim ("produced by X", "same label as Y"), make it — but only then.
- Spend the words on: why this fits THIS user (cite their portrait and recent ratings), what to listen for / where to enter the track, emotional and craft texture.
- If metadata is sparse, spend extra words on taste-connection and listening guidance instead of invented facts.
- Write one continuous piece — no headers, no bullets.`;

  const userPrompt = `User taste portrait:
${portraitText}

Recent ratings:
${ratingContext}

Direction being explored: "${directionLabel}"

Track to narrate:
Title: ${rec.title}
Artist: ${rec.artist}
Year: ${rec.year ?? "unknown"}
MusicBrainz relationships (verified only):
${relationships}

Write a 150-220 word personalized narrative for this recommendation.`;

  const narrative = await chat(NARRATE_MODEL, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);

  return narrative.trim();
}
