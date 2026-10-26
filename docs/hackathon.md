# Hackathon findings

Last checked Oct 26, 2026 (first day of the build window). The Cerebral Valley page can't be opened from the build container, so this comes from fetching the public pages plus search results.

## Status

- Application **approved** (Oct 20, 2026).
- **Official Rules: still not public.** As of Oct 26, both the [Cerebral Valley page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) and [dev.meta.ai](https://dev.meta.ai/events/global-hackathon) still say they "will be published before the Hackathon begins on October 26, 2026 and must be accepted by the selected participants". No public copy is indexed anywhere. They will most likely appear in the participant portal or a kickoff email, so check there and update this file.
- The only linked legal document is the [Application Overview and Event Waiver](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver). Its body doesn't render outside a browser.

## Deadline

- Event page: **"Nov 4: Project submissions due by 9:00 PM ET"**. The page header says "submissions due Nov 5, 2026 UTC".
- US clocks change on Nov 1, so Nov 4 is EST (UTC-5). 9:00 PM ET is therefore **02:00 UTC on Nov 5**, or 05:30 Tehran time on Nov 5. Both sources agree once the time zone is worked out.
- Internshala's "6:30 AM IST" (01:00 UTC) uses daylight time and is one hour early. Using it as our hard stop costs nothing.
- No grace period is stated. Our plan: **submit by the end of Nov 4, local time.**
- Judging runs Nov 4–8. Winners are announced at the Nov 9 closing ceremony.

## Code written before the build window

- **Not addressed** by any public source. ReconScribe's guide only says entries must be work you own, and open-source components are fine if you follow their licences.
- Our exposure: `contoso-order-entry` (the target app) and the docs in this repo were written Oct 20. The LegacyLink agent itself has no code from before Oct 26.
- Until the rules say otherwise:
  - treat the sample app as a test fixture, not the entry;
  - say plainly in the submission that it was prepared before the window;
  - keep all agent code in commits dated Oct 26 or later.
- Re-check this as soon as the rules are out. If they ban prior code, rewrite or regenerate the sample app inside the window; it's small.

## Deliverables

- Submit through the Cerebral Valley portal. Each project enters exactly one track. We're entering **Indie**, solo.
- Reported, but not on the official page: a working demo and a demo video. The submission form wasn't public as of Oct 17.
- Unknown until the rules are out: whether a repo link, a public demo URL, a written description or a video length limit is required. Prepare all four anyway: a public repo or a judge invite, a README, a 2–3 minute video, and a short description.

## Judging

- Event page, Indie track: "Judged on creativity, technical ambition, and whether it works."
- Event page, Startup track: "Judged on technical execution and whether it holds up in production."
- Reported weights from third-party guides, not confirmed by the event page: impact 30%, creative use of Meta tooling 25%, demo 25%, technical depth 20%.

## Meta models and credits

- **Muse Spark is not mandatory** on either official page. The page says participants can "use the Muse Spark series, Muse Wonder, Muse Image and SAM 3.1 through Meta Model API, run Meta open weights models, and code faster with Muse Code". The waiver reportedly says participants "build with Meta AI products including Muse Spark". Because Meta tooling is reportedly 25% of the score, use Muse Spark for the explorer and compiler steps anyway.
- **Meta Model API credits:** $150 per selected participant. This comes from Meta's approval email, not from the public page, and is outside the $1M prize pool. Check the dashboard to confirm it has landed.
- **Partner credits** (selected participants, for Meta open-weights models): Baseten $100 with 2M TPM, Modal $100 through Endpoints, Fireworks $25 plus a workshop.
- Model API country restrictions apply. Model API is blocked in some countries the hackathon itself allows.
- Pricing after credits: $1.25 per million input tokens and $4.25 per million output tokens for Muse Spark 1.1.

## Eligibility

- Open worldwide except where prohibited. This excludes sanctioned parties and people located in Belarus, China, Russia, Ukraine, Syria, Cuba, North Korea and Iran.
- Also excluded: Meta and Cerebral Valley employees, contractors and interns, government-affiliated people, and their families or households.
- The cap is 20,000 selected participants. $1,000,000 in total prizes; no per-track breakdown has been published.

## Sources

- [Cerebral Valley event page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) ([markdown version](https://cerebralvalley.ai/e/meta-ai-developer-hackathon.md))
- [dev.meta.ai event page](https://dev.meta.ai/events/global-hackathon)
- [ReconScribe guide (Oct 17)](https://reconscribe.com/meta-global-ai-developer-hackathon-2026/)
- [Vibecoderslife (Oct 22): $150 credits from the approval email](https://vibecoderslife.com/post/meta-ai-developer-hackathon-2026)
- [Superpower Daily (Oct 22)](https://superpowerdaily.com/posts/meta-sets-october-26-start-for-1-million-ai-hackathon-capped-at-20-000-builders)
- [Internshala listing](https://internshala.com/competitions/meta-global-ai-developer-hackathon-2026/)
- [Resourify: Meta API credits](https://resourify.com/resources/meta-api)
- [Let's Data Science: Muse Spark 1.1 API](https://letsdatascience.com/news/meta-opens-muse-spark-11-to-developers-via-model-api-f9b336cb)
