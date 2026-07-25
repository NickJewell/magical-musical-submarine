/**
 * OpenRouter LLM client — Propose, Directions, and Narrate stages.
 * Propose uses JSON schema structured output.
 * Narrate uses plain text — system prompt forbids asserting unverified facts.
 */

import { logger } from "./logger";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const PROPOSE_MODEL = process.env.OPENROUTER_PROPOSE_MODEL ?? "moonshotai/kimi-k2";
const NARRATE_MODEL = process.env.OPENROUTER_NARRATE_MODEL ?? "meta-llama/llama-3.3-70b-instruct";
// The taste portrait is the marquee piece of prose in the product — it needs a
// critic's ear, not a summarizer's. Route it to Kimi K2 (same model as Propose),
// which writes with more voice and compression than the default Narrate model.
const PORTRAIT_MODEL = process.env.OPENROUTER_PORTRAIT_MODEL ?? "moonshotai/kimi-k2";
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
  eloTop?: string[];
  count?: number;
  broader?: boolean;
}): Promise<Candidate[]> {
  const { portraitText, recap, directionLabel, directionRationale, similarArtists, eloTop = [], count = 5, broader = false } = opts;

  const eloBlock = eloTop.length > 0
    ? `\n\nThe user's highest-ranked tracks by head-to-head comparison (their taste's center of gravity — lean toward this sensibility and quality bar, but do NOT re-suggest these exact tracks):\n${eloTop.map((t) => `- ${t}`).join("\n")}`
    : "";

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
Direction rationale: ${directionRationale}${eloBlock}

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
  eloTop?: string[];
  focus?: { kind: string; label: string; artist?: string | null } | null;
}): Promise<DirectionsResult> {
  const { portraitText, recap, seeds, similarArtists, eloTop = [], focus } = opts;
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
    const eloLine = eloTop.length > 0
      ? `\n\nHighest-ranked by head-to-head comparison (the center of their taste — the strongest paths should honor this gravity, the contrastive ones should knowingly pull against it):\n${eloTop.map((t) => `- ${t}`).join("\n")}`
      : "";
    userPrompt = `User seeds: ${seedList}

Taste portrait:
${portraitText}

Recap:
${recap || "(no prior dives)"}

Well-trodden reference (top Last.fm similar): ${wellTroddenTop}${eloLine}

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
  eloTop?: Array<{ title: string; artist: string; rating: number }>;
  eloBottom?: Array<{ title: string; artist: string; rating: number }>;
  priorPortrait?: string | null;
}): Promise<string> {
  const { seeds, pairChoices, recentRatings, eloTop, eloBottom, priorPortrait } = opts;

  const seedList = seeds
    .map((s) => `- "${s.title}" by ${s.artist}${s.year ? ` (${s.year})` : ""}${s.prompt ? ` [seeded from: "${s.prompt}"]` : ""}`)
    .join("\n");

  const pairList = pairChoices.length > 0
    ? pairChoices.map((p) => `- Preferred "${p.winner}" over "${p.loser}" (strength: ${p.strength}/2)`).join("\n")
    : "(no pairwise data yet)";

  const systemPrompt = `You are a music critic writing a taste portrait — the kind someone screenshots because it finally names something they felt but couldn't say. Robert Christgau's compression, a close listener's ear, and zero patience for the language of algorithms. Profile the *person*, not their playlist.

Do the thinking silently, then write. Weight the signal honestly: a head-to-head ranking or a note they wrote in their own words is hard evidence; a lone unrated seed is a guess. Find the through-line that connects songs sharing no style or era, and find the axis where their choices pull against each other — resolve it or name it. Work out what specific thing they reach for inside each genre, what they avoid, and what music seems to *do* for them. Infer only from musical evidence; never invent biography, a life event, or a feeling they didn't give you.

Then write it — 200–400 words, second person, present tense, three paragraphs that breathe:

1. OPEN ON SOMETHING CONCRETE. The first sentence lands on a real, specific observation about this listener — a craving, a contradiction, the shape of their taste — sharp enough that it couldn't describe anyone else. No warm-up, no "You are drawn to," no throat-clear. If your opening line could head a different person's portrait, delete it and start again.

2. EARN EVERY CLAIM. Prefer the risky, precise read over the safe, universal one — each characterization should be specific enough that it could plausibly be wrong. Back the analysis with the evidence, then say what it *feels* like to have this taste. Where the evidence is thin, be evocative, not factual.

3. NAME GENRES — BUT NEVER AS A LIST. Naming scenes and traditions precisely is the job, but no roll-call, no "from jazz to techno," no eras strung together with commas. Every genre arrives with an insight about *why* it's theirs: not "you like indie" but "you like indie when the guitars are brittle and the singing sounds embarrassed." Reach for a specific track or a line from their own notes only when it's the proof of a claim — a couple of well-placed specifics, never an inventory.

4. LAND THE ENDING. Close on a line worth quoting — the honest open question their taste leaves you with, the thing the next recommendation could test. Not a disclaimer, not a summary.

If a prior portrait is provided, treat the user's edits as authoritative and evolve it — don't start over.

Banned on sight: "sonic," "soundscape," "sonic tapestry," "eclectic," "genre-defying," "musical journey," "auditory," "at its core," "a masterclass in," "whether it's X or Y," "diverse range," "eras and genres," "a little bit of everything," "you're in for a treat" — and any sentence generic enough to describe a different person.`;

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

  const eloBlock = eloTop && eloTop.length > 0
    ? "\n\nHead-to-head ELO ranking (the distilled result of their direct comparisons — the SHARPEST preference signal; weight the extremes heavily). The top is the pole their taste gravitates toward, the bottom is what it pushes against:\n" +
      "Highest-ranked:\n" +
      eloTop.map((t) => `- "${t.title}" by ${t.artist} (${Math.round(t.rating)})`).join("\n") +
      (eloBottom && eloBottom.length > 0
        ? "\nLowest-ranked:\n" + eloBottom.map((t) => `- "${t.title}" by ${t.artist} (${Math.round(t.rating)})`).join("\n")
        : "")
    : "";

  const priorBlock = priorPortrait
    ? `\n\nPrior portrait (evolve this, do not discard):\n${priorPortrait}`
    : "";

  const userPrompt = `Seeds:\n${seedList}\n\nPairwise preferences:\n${pairList}${ratingsBlock}${eloBlock}${priorBlock}`;

  const portrait = await chat(PORTRAIT_MODEL, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);

  return portrait.trim();
}

// ---- Tasting note (per dive leg) ----

/**
 * A critic's paragraph on one leg of a dive — "what we tasted here." Given the
 * direction explored and the tracks the listener heard + rated on this leg,
 * write a compact reflection on what it revealed about their taste. Uses the
 * music-appreciation house style (see .claude/skills/music-appreciation).
 */
export async function generateTastingNote(opts: {
  diveName: string;
  directionLabel: string;
  hypothesis?: string | null;
  tracks: Array<{ title: string; artist: string; listenState: string | null; score: number | null; reviewText?: string | null }>;
}): Promise<string> {
  const { diveName, directionLabel, hypothesis, tracks } = opts;

  const trackList = tracks.map((t) => {
    const scoreLabel = t.score === 1 ? " — 1/3, wanted less of this"
      : t.score === 2 ? " — 2/3, middle ground"
      : t.score === 3 ? " — 3/3, wanted more of this"
      : "";
    const state = t.listenState ? ` (${t.listenState})` : "";
    const note = t.reviewText ? ` — their note: "${t.reviewText}"` : "";
    return `- "${t.title}" by ${t.artist}${state}${scoreLabel}${note}`;
  }).join("\n");

  const systemPrompt = `You are a music critic writing the tasting note for one leg of a listening journey — a wine-note for a stretch of songs. The reader followed a thread ("${directionLabel}") and rated what they heard. Say what this leg *revealed* about their taste, in the voice of someone with an ear and a point of view.

Write ONE tight paragraph, 55–100 words, second person, present tense. Not a recap, not a track-by-track — a read on what this leg taught you about them.

Craft:
- OPEN ON SOMETHING CONCRETE. The first sentence lands on the real result of this leg — what landed, what got rejected, the specific shape of the reaction. No warm-up, no "On this leg you explored…," no throat-clear.
- EARN IT FROM THE EVIDENCE. The ratings and their own notes are the signal — what they scored 3/3 versus what they skipped tells you where the thread hit and where it missed. Prefer the sharp, falsifiable read over the safe one. Weight their written notes hardest.
- NAME THE GENRE MOVE WITH AN INSIGHT, never as a list — what specific thing inside "${directionLabel}" did they reach for or push away? If the leg is unrated or thin, be evocative about the thread itself, not factual; never invent a reaction they didn't give.
- LAND IT. Close on a line worth quoting — what this leg sets up, the question it leaves, or the direction it points next.

Banned on sight: "sonic," "soundscape," "sonic tapestry," "eclectic," "genre-defying," "musical journey," "auditory," "at its core," "a masterclass in," "whether it's X or Y," "you're in for a treat," "on this leg," "this section" — and any sentence generic enough to describe a different stretch of songs. Output the paragraph only: no heading, no title, no quotes around it.`;

  const userPrompt = `Dive: "${diveName}"
Thread explored: "${directionLabel}"${hypothesis ? `\nThe hunch behind it: ${hypothesis}` : ""}

What they heard and how they rated it:
${trackList}

Write the tasting note for this leg — what it revealed about their taste.`;

  const note = await chat(PORTRAIT_MODEL, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);

  return note.trim();
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
