/**
 * OpenRouter LLM client — Propose, Directions, and Narrate stages.
 * Propose uses JSON schema structured output.
 * Narrate uses plain text — system prompt forbids asserting unverified facts.
 */

import { logger } from "./logger";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const PROPOSE_MODEL = process.env.OPENROUTER_PROPOSE_MODEL ?? "moonshotai/kimi-k2";
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

  const data = (await res.json()) as OpenRouterResponse & { error?: { message?: string; code?: number } };

  // OpenRouter occasionally returns HTTP 200 with an error body and no choices
  // (e.g. context-length exceeded, provider overload). Treat this as a hard error.
  if (!data.choices?.length) {
    const detail = data.error?.message ?? JSON.stringify(data).slice(0, 300);
    throw new Error(`OpenRouter returned no choices: ${detail}`);
  }

  return data.choices[0].message.content ?? "";
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
  broader?: boolean;
}): Promise<Candidate[]> {
  const { portraitText, recap, directionLabel, directionRationale, similarArtists, count = 5, broader = false } = opts;

  const wellTroddenList = similarArtists.slice(0, 10).join(", ");

  const broaderHint = broader
    ? "\n- IMPORTANT: A previous attempt with obscure picks failed verification. Suggest LESS OBSCURE artists — prefer moderately well-known to widely known acts that are more likely to exist in music databases."
    : "";

  const systemPrompt = `You are a music recommendation assistant. Generate individual track candidates that fit the user's taste and the chosen direction.

CRITICAL RULES:
- Output ONLY valid JSON matching the schema. No prose, no markdown.
- Every candidate MUST be a specific individual track (song), never an album or EP title.
- If you want to highlight an artist's album, pick the single best track from it instead.
- The well-trodden artists are: ${wellTroddenList || "none identified"}. Steer AWAY from these for the main direction.
- Include likely_known: "low" for genuinely obscure picks, "medium" for moderately known, "high" for widely known.
- Generate ${count} candidates (we will validate and may need extras).${broaderHint}`;

  const userPrompt = `User taste portrait:
${portraitText}

Recent dive recap:
${recap || "(first dive — no recap yet)"}

Chosen direction: "${directionLabel}"
Direction rationale: ${directionRationale}

Generate ${count} individual track candidates that fit this direction and this user's taste. Each must be a specific song, not an album title. Steer away from the well-trodden artists.`;

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
            type: { type: "string", enum: ["track"] },
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
  focus?: { kind: string; label: string; artist?: string | null } | null;
}): Promise<DirectionsResult> {
  const { portraitText, recap, seeds, similarArtists, focus } = opts;
  const wellTroddenList = similarArtists.slice(0, 10).join(", ");
  const wellTroddenTop = similarArtists[0] ?? "a popular similar artist";

  // Two modes:
  // - Focused dive: analyze the chosen selection ALONE and radiate three
  //   targeted paths from it (portrait deliberately ignored for novelty).
  // - Taste dive: the original portrait-driven exploration.
  let systemPrompt: string;
  let userPrompt: string;

  if (focus) {
    const focusDesc =
      focus.kind === "genre" || focus.kind === "subgenre"
        ? `the ${focus.kind} "${focus.label}"`
        : focus.kind === "artist"
          ? `the artist ${focus.label}`
          : `"${focus.label}"${focus.artist ? ` by ${focus.artist}` : ""} (a ${focus.kind})`;

    systemPrompt = `You are a music taste analyst and a deep genre cartographer. The user has picked a single starting point and wants to explore OUTWARD from it. Analyze that starting point on its own terms — its lineage, its scenes, its adjacent traditions, the tensions inside it — and chart three distinct paths into music they probably haven't heard.

CRITICAL RULES:
- Output ONLY valid JSON matching the schema.
- Anchor everything on the chosen starting point. Do NOT rely on any prior profile of the user — treat this as a fresh expedition from this one selection.
- The 3 directions must be genuinely CONTRASTIVE with each other: e.g. one deeper into the roots/lineage, one into a sideways-adjacent scene, one into a bolder reinterpretation or descendant. Cover real ground — reward curiosity, not the obvious.
- Each direction needs a vivid, evocative label (3-5 words) and a 1-sentence rationale that names what connects it to the starting point AND how it diverges.
- The hypothesis should be a sharp, specific read on what makes this starting point tick and where the interesting exits are.
- The well_trodden direction is the conventional pick from here — just name the obvious closely-associated artist.`;

    userPrompt = `Starting point: ${focusDesc}

Closely associated artists (from Last.fm — the well-trodden neighborhood to push past): ${wellTroddenList || "(none found)"}
Well-trodden reference (nearest obvious pick): ${wellTroddenTop}

Analyze this starting point and generate 3 named, contrastive themed directions that radiate outward from it, plus the well-trodden direction. Ignore any prior taste profile — explore from this selection alone.`;
  } else {
    systemPrompt = `You are a music taste analyst. Given a user's taste profile, generate 3 distinct exploration directions — each a named, themed path into new music.

CRITICAL RULES:
- Output ONLY valid JSON matching the schema.
- The 3 directions must be CONTRASTIVE — steer them AWAY from: ${wellTroddenList || "none"}.
- Each direction needs a vivid, evocative label (3-5 words) and a 1-sentence rationale.
- The well_trodden direction is the conventional pick — just name the obvious similar artist.`;

    const seedList = seeds.map((s) => `"${s.title}" by ${s.artist}`).join(", ");
    userPrompt = `User seeds: ${seedList}

Taste portrait:
${portraitText}

Recap:
${recap || "(no prior dives)"}

Well-trodden reference (top Last.fm similar): ${wellTroddenTop}

Generate 3 named themed directions (contrastive) and the well-trodden direction.`;
  }

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
  recentRatings?: Array<{ title: string; artist: string; listenState: string; score: number | null; reviewText?: string | null }>;
  priorPortrait?: string | null;
}): Promise<string> {
  const { seeds, pairChoices, recentRatings, priorPortrait } = opts;

  const seedList = seeds
    .map((s) => `- "${s.title}" by ${s.artist}${s.year ? ` (${s.year})` : ""}${s.prompt ? ` [seeded from: "${s.prompt}"]` : ""}`)
    .join("\n");

  const pairList = pairChoices.length > 0
    ? pairChoices.map((p) => `- Preferred "${p.winner}" over "${p.loser}" (strength: ${p.strength}/2)`).join("\n")
    : "(no pairwise data yet)";

  const systemPrompt = `You write the kind of taste portrait someone screenshots because it finally puts words to something they felt but couldn't name. You are equal parts music critic and close observer: you can hear the connective tissue between songs that share no style, era, or scene, AND you can say something true and specific about the genres someone actually lives in. You have opinions, an ear, and no patience for the language of algorithms.

Write a taste portrait of this person: 200–450 words, second person, present tense ("You are drawn to…"). Shape it as 3–4 organic paragraphs separated by blank lines, each turning to a distinct facet of their taste — never one dense block. Let the paragraphs breathe and flow into each other rather than reading as sections.

Think silently before writing (do not show this reasoning):

- Read all the signal, weighting by strength: relative preferences (pairwise/duels) and high ratings on songs they already knew are strong evidence; the notes they wrote in their own words are the sharpest signal of all; a single seed or an unrated pick is weak. Each seed's prompt-tag (the mood/memory it answered) reveals their relationship to music — mine it.
- Do the genre analysis for real. Which styles, scenes, or traditions do they actually gravitate to, and — more interesting — what SPECIFIC thing within each one are they reaching for? (Not "you like indie" but "you like indie when the guitars are brittle and the singing sounds embarrassed.") Notice when the same craving shows up across genres that look unrelated on paper. Name the texture, the tempo, the emotional register, the production choices they keep choosing.
- Hold the analytical and the subjective together: back the characterization with the evidence, then say what it FEELS like to have this taste — what it says about how they move through the world.
- Form 2–3 competing hypotheses about the core of their taste. Identify the single strongest through-line and the axis of tension where their choices pull against each other. Resolve it, or name it honestly.
- Separate core taste from biographical attachment — a song tied to a memory is not necessarily a song they'd choose for itself.
- Infer the psychological function music serves them (mood regulation, identity, nostalgia, sensation, meaning, belonging, escape) and their likely listening contexts.
- Define the edges: what they seem to avoid, skip, or rate low. Negative space is as defining as love.
- Calibrate confidence. Say what you're sure of plainly; where evidence is thin, be evocative, not factual. Never invent biography, life events, or feelings they did not give you — infer only from musical evidence, and hedge when you must.
- If a prior portrait is provided, treat any user edits as authoritative and evolve the portrait — don't start over.

Output rules:
- Name genres, scenes, and traditions freely and precisely when they illuminate the point — that is the job. But never reduce a person to a list: no "from jazz to techno," no genre roll-call, no set of eras strung together with commas. Every genre you name must come with an insight about WHY it's theirs.
- Reach for a specific track, artist, or a line from their own notes ONLY when it earns its place — as the proof of a claim or the hinge of an insight, dropped in where it lands hardest. Do not recap their library or name-check everything back to them. A couple of well-placed specifics beat a full inventory.
- Prefer specific, falsifiable characterizations over safe, universal ones. Every claim should be earned from the evidence and could plausibly be wrong.
- End with one sentence naming what you're still unsure about — an open question the next recommendations could test.
- Banned phrases/moves (cut on sight): "sonic tapestry," "soundscape," "sonic," "eclectic," "genre-defying," "musical journey," "at its core," "whether it's X or Y," "auditory," "diverse range," "eras and genres," "a little bit of everything," and any sentence that could describe anyone.`;

  const ratingsBlock = recentRatings && recentRatings.length > 0
    ? "\n\nRecent track ratings and notes (strongest signal — weight heavily; the notes in their own words are the sharpest evidence of what they actually respond to):\n" +
      recentRatings.map((r) => {
        const scoreLabel = r.score === 1 ? " (1/3 — wants less of this)"
          : r.score === 2 ? " (2/3 — middle ground)"
          : r.score === 3 ? " (3/3 — wants more of this)" : "";
        const note = r.reviewText ? ` — their note: "${r.reviewText}"` : "";
        return `- "${r.title}" by ${r.artist}: ${r.listenState}${scoreLabel}${note}`;
      }).join("\n")
    : "";

  const priorBlock = priorPortrait
    ? `\n\nPrior portrait (evolve this, do not discard):\n${priorPortrait}`
    : "";

  const userPrompt = `Seeds:\n${seedList}\n\nPairwise preferences:\n${pairList}${ratingsBlock}${priorBlock}`;

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
  priorRatings: Array<{ title: string; artist: string; listenState: string; score: number | null; reviewText?: string | null }>;
}): Promise<string> {
  // Note: `priorRatings` is intentionally NOT used here. The taste connection
  // comes from the portrait (which is itself built from ratings + notes), so we
  // don't feed the raw rated-song list into this prompt — that's what produced
  // the "like that X you loved" callbacks the review should avoid.
  const { portraitText, rec, directionLabel } = opts;

  const relationships = JSON.stringify(rec.relationships ?? {}, null, 2).slice(0, 500);

  const systemPrompt = `You write the one review that convinces someone to press play — a persuasive, specific case for why THIS track and THIS artist are worth their time, told through the lens of what this particular listener loves. Think of the best writer at a record shop who gets this person's taste and is genuinely excited to hand them something great.

Write 140–200 words, second person. Break it into 2–3 short, organic paragraphs separated by a blank line — let it breathe rather than land as one dense block. No headers, no bullets, no title.

What to cover:
- Why the TRACK is great: open on what the song actually does — a texture, a move, a moment, the feel of the first thirty seconds — and name what's distinctive about it. Give them something to listen FOR: where to enter, what to wait for, what rewards a second play.
- Why the ARTIST is worth knowing: place them — what they're about, what they do that others don't, why they're a find worth following past this one song.
- Why it fits THEM: connect it to the shape of their taste — the textures, moods, and instincts their portrait reveals — in your own words. Speak to the KIND of thing they respond to.

Hard rules:
- The FIRST sentence must drop straight into a concrete, specific detail of THIS track — a sound, a move, a lyric, a moment. NEVER open with a hype preamble or a verdict about how good it is. Banned openers and any variant of them: "You're in for a treat", "Get ready", "Prepare to", "Prepare yourself", "Buckle up", "You're about to", "You won't be disappointed", "Meet ", "Say hello to", "If you're looking for", "Trust me". Vary your openings — no two reviews should begin the same way.
- Do NOT name-drop the listener's own liked, seeded, or previously rated songs, and do NOT compare this track to them ("like that X you loved", "scratches the same itch as Y"). That callback game reads as cringe. Reference their taste as a sensibility, never as a list of past picks. The portrait is your guide to their taste — use it, don't quote it or itemize it.
- Only assert facts present in the verified metadata below. Do NOT invent release dates, labels, personnel, collaborations, chart history, or backstory. When MusicBrainz relationships support a specific claim ("produced by X", "same label as Y"), you may make it — but only then. When metadata is thin, spend the words on the sound, the artist, and the fit, never on invented facts.
- You may point to another track from the same album as a natural next step, but the pick itself is always this single track.
- Write like a person with taste and a pulse. Banned on sight: "you're in for a treat," "sonic," "soundscape," "sonic tapestry," "eclectic," "genre-defying," "musical journey," "auditory," "a masterclass in," "at its core," "if you love X you'll love Y," "perfect blend," and any sentence generic enough to sell a different song.`;

  const userPrompt = `The listener's taste portrait (their sensibility — use it as a guide, don't quote or itemize it):
${portraitText}

Direction being explored: "${directionLabel}"

The track you're selling:
Title: ${rec.title}
Artist: ${rec.artist}
Year: ${rec.year ?? "unknown"}
Verified MusicBrainz relationships (the ONLY facts you may assert):
${relationships}

Write the review that makes them press play — why this track is great, why this artist is worth knowing, and why it suits their taste.`;

  const narrative = await chat(NARRATE_MODEL, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);

  return narrative.trim();
}

// ---- Canon candidate generation (§17.3.1) ----

export interface CanonCandidate {
  title: string;
  artist: string;
  year?: number | null;
  genre?: string | null;
  region?: string | null;
}

export async function generateCanonCandidates(
  genre: string,
  era: string,
  count: number,
  region?: string,
): Promise<CanonCandidate[]> {
  const regionClause = region ? ` from ${region}` : "";
  const userPrompt =
    `Generate a list of ${count} widely-acclaimed, must-hear ${genre} tracks${regionClause} from the ${era} period.` +
    ` Prioritize breadth: cover sub-genres, regions, genders, and cultural backgrounds within ${genre}.` +
    ` Include obscure gems alongside widely-known classics — the goal is a representative canon, not a chart list.` +
    ` Return ONLY the JSON array. No commentary.`;

  const schema = {
    type: "object",
    properties: {
      tracks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title:  { type: "string" },
            artist: { type: "string" },
            year:   { type: ["integer", "null"] },
            genre:  { type: ["string", "null"] },
            region: { type: ["string", "null"] },
          },
          required: ["title", "artist"],
          additionalProperties: false,
        },
      },
    },
    required: ["tracks"],
    additionalProperties: false,
  };

  const raw = await chat(
    PROPOSE_MODEL,
    [
      {
        role: "system",
        content:
          "You are a music historian compiling canonical must-hear tracks." +
          " Output only the requested JSON. Never hallucinate MBIDs — just title, artist, year, genre, region.",
      },
      { role: "user", content: userPrompt },
    ],
    { type: "json_schema", json_schema: { name: "canon_candidates", schema, strict: true } },
  );

  try {
    const parsed = JSON.parse(raw) as { tracks: CanonCandidate[] };
    return parsed.tracks ?? [];
  } catch {
    logger.warn({ raw }, "generateCanonCandidates: JSON parse failed");
    return [];
  }
}
