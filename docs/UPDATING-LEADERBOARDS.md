# Updating the leaderboard highlight lists

The config wizard highlights "best as of `<date>`" models by matching the models a
gateway's API returns against three curated top-10 lists stored in
`data/leaderboards/`:

| File | Source page |
|------|-------------|
| `data/leaderboards/text-to-image.json`  | <https://artificialanalysis.ai/image/leaderboard/text-to-image> |
| `data/leaderboards/image-to-video.json` | <https://artificialanalysis.ai/video/leaderboard/image-to-video> |
| `data/leaderboards/text-to-video.json`  | <https://artificialanalysis.ai/video/leaderboard/text-to-video> |

These lists were last captured **2026-10-04**.

## When to update

Artificial Analysis updates the Arena Elo rankings frequently (new models appear
"in the last month" on each page). Refresh these files whenever you want the
wizard's "Nth best as of `<date>`" hints to reflect the current state of the art —
a quarterly refresh is usually plenty.

## How to update

1. **Open the three leaderboard pages** (links above). The pages are
   JavaScript-rendered, so read them in a real browser (or via a browser-control
   tool) rather than a plain `curl`/fetch, which returns an empty shell.

2. For each page, note the default view:
   - Image: the single ranked table.
   - Video: the **"With Audio"** tab is the default we capture. (There is also a
     "No Audio" view whose ordering differs — keep using "With Audio" unless you
     deliberately change the convention, and update the `metric` field if so.)

3. **Take the top 10 rows.** For each, record:
   - `rank` (1–10)
   - `name` — exactly as shown (e.g. `"GPT Image 2 (high)"`)
   - `creator` — the "Creator" column (e.g. `"OpenAI"`)
   - `elo` — the Elo column as an integer
   - `released` — the "Released" column as `YYYY-MM`
   - `openWeights: true` — only if the row is tagged "Open Weights"
   - `aliases` — lowercase strings the matcher should compare against gateway
     model ids/names. Include the slugified name and any common short forms.
     **This is the most important field for good matching.** Matching is
     **suffix-anchored** (see "How matching works" below), so:
     - You do **not** need to list every vendor-prefixed form — a provider
       prefix (`bytedance/…`) is ignored automatically. Listing the bare slug is
       enough; add a prefixed form only as an extra convenience.
     - Each alias must be **variant-specific**. A base alias like
       `"seedance-2.0"` will **not** match a sibling variant such as
       `seedance-2.0-fast`/`-lite`/`-pro` (that's deliberate — variants have
       different Elo). Give every ranked variant its own entry with its own
       full-variant aliases; never rely on a base alias to cover a variant.
     - A gateway's model **id can differ entirely from the marketing name** — on
       OpenRouter "GPT Image 2" is `openai/gpt-5.4-image-2`. The marketing-name
       slug alone won't match that, so check the live gateway list and add the
       actual id slug as an alias (here: `"gpt-5.4-image-2"`). If a clearly-top
       model shows in the wizard's "not offered" note but you know the gateway
       has it, this id-vs-name mismatch is the usual cause.

4. **Update the file header**:
   - `captured` → today's date (`YYYY-MM-DD`)
   - `note` → change the date in `"<rank> best as of <date>"`

5. Bump the date everywhere it is hard-coded:
   - the `captured` field in each JSON file (above)
   - this document's "last captured" line
   - the wizard reads the date from the JSON `captured` field, so you do **not**
     need to touch the wizard source — just the JSON.

## How matching works (so you write good aliases)

At wizard time, for each model the gateway API returns we lowercase its id and
name and normalise away separators (`-_/ .`). An alias matches when the
candidate **equals it or ends with it** (suffix-anchored). A match prints, e.g.:

```
google/gemini-3.1-flash-image   ⭐ 6th best text-to-image as of 2026-10-04 (Nano Banana 2 (Gemini 3.1 Flash Image))
```

Why suffix-anchored: a provider/namespace **prefix** (`bytedance/…`) is always
at the *front*, so anchoring to the end ignores it and the same model matches
across gateways. A quality **variant** (`-fast`/`-lite`/`-pro`/`-standard`) is
always at the *end*, so a base alias like `seedance-2.0` does **not** absorb
`seedance-2.0-fast` — each variant keeps its own rank. (The old substring
matcher collapsed every variant of a generation onto the highest-ranked one.)

Consequences when writing aliases:
- A terser candidate than your alias won't match (no reverse scan), so list the
  bare slug too — e.g. both `veo-3.1` **and** `veo-3.1-fast` as separate entries.
- If a clearly-top model is **not** lighting up, add a fuller/closer alias here
  — that is the intended maintenance action. The matcher errs toward **no hint**
  rather than a wrong one, so under-matching is safe; over-matching is the bug we
  avoid.

## Schema reference

```jsonc
{
  "leaderboard": "text-to-image",            // stable key
  "title": "Text to Image",
  "source": "https://artificialanalysis.ai/...",
  "metric": "…Elo (with-audio view, …)",
  "captured": "2026-10-04",                  // YYYY-MM-DD — drives the wizard hint date
  "note": "…",
  "models": [
    {
      "rank": 1,
      "name": "GPT Image 2 (high)",
      "creator": "OpenAI",
      "elo": 1341,
      "released": "2026-04",
      "openWeights": false,                  // optional, omit if false
      "aliases": ["gpt-image-2", "gpt image 2", "openai/gpt-image-2"]
    }
  ]
}
```
