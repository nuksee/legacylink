# Hackathon findings

Last updated Oct 29, 2026, when Kaveh pasted the Official Rules from the participant portal. Earlier notes come from the public event pages and search results.

## Status

- Application **approved** (Oct 20, 2026). Entering the **Indie** track, solo.
- Official Rules: published to participants. Section 4 ("Hackathon Rules") is quoted below.

## Official rules (section 4, verbatim)

> - Open source: Repositories must be public.
> - Team size: A maximum of four participants per team. Solo participants are allowed.
> - Demo requirements: Your demo must only highlight the specific features, code, and functionality that you built during the Hackathon. Judges must be able to clearly identify what was created during the Hackathon. Failure to clearly identify your original contributions will result in immediate disqualification at Judges sole discretion.
> - New work only: What you present at this Hackathon must have been built during the event. This should be clear in your submissions. Startups may build on existing products or codebases, but you must clearly identify what was newly developed during the Hackathon.
> - Banned projects: Projects will be disqualified if they: violate legal, ethical, or platform policies, use code, data, or assets you do not have the rights to.

The rules also list "anti-projects" to avoid: AI medical advice, basic RAG apps, simple image analyzers, simple "AI for Education" chatbots, AI job application screeners, AI nutrition coaches, personality analyzers, sports analyzers or coaches, and anything political or involving war. LegacyLink isn't in any of these categories.

## Deadline

- Event page: **"Nov 4: Project submissions due by 9:00 PM ET"**. The page header says "submissions due Nov 5, 2026 UTC".
- US clocks change on Nov 1, so Nov 4 is EST (UTC-5). 9:00 PM ET is therefore **02:00 UTC on Nov 5**, or 05:30 Tehran time on Nov 5.
- No grace period is stated. Our plan: **submit by the end of Nov 4, local time.**
- Judging runs Nov 4–8. Winners are announced at the Nov 9 closing ceremony.

## What was built when

Git history is the evidence. The build window opened Oct 26.

**Before the window (Oct 20):** none of this is presented as hackathon work.

| Repo | What | Commits |
|---|---|---|
| legacylink | First README (since rewritten), `docs/plan.md`, early `docs/hackathon.md` | `2f15433`, `e181f10`, `bc8f1d6` |
| legacylink | `docs/architecture.md`: the design and format spec. It contains no runnable code. | `2ded9c9` |
| legacylink | `.claude/`: Claude Code settings plus two skills copied from [anthropics/skills](https://github.com/anthropics/skills) (Apache 2.0, licence kept). These are dev tooling, not product. | `5447f7b` |
| contoso-order-entry | The whole sample app and its static build. It's the **target** the agent works on, not the entry. | `594bd65` to `acc313c` |

**During the window (Oct 26 onward):** this is the entry.

- legacylink: everything under `src/`, `test/`, `prompts/` and `examples/`; the CLI; the explorer, learner, compiler, runner, MCP server, approval console, healer and the scripted demo; CI; and every doc except the ones listed above.
- contoso-order-entry: `vercel.json` only (Oct 26).

## Compliance checklist

- [ ] Make both repos public before submitting. Neither repo's history has secrets: a scan on Oct 29 found only env-var names, and no `.env` file has ever been committed. Note that commit metadata includes a personal email address, which becomes public.
- [ ] Add a licence file. None exists yet. The rules only require public repos, but "open source" reads better with a licence, for example MIT.
- [ ] Keep the README section "Built during the hackathon" and link to it from the submission.
- [ ] In the demo video, say out loud that Contoso was prepared on Oct 20 as a test target. Show only LegacyLink features.
- [ ] Rights: npm dependencies are all MIT, ISC, Apache-2.0 or BSD (checked Oct 29). The anthropics/skills copies keep their Apache 2.0 licence. Contoso's CSS and markup were written from scratch to look like 2009 WebForms, and copy no Microsoft files. "Contoso" is Microsoft's standard fictional sample company.
- [ ] Use no customer data. Contoso's data is invented in `lib/data.js`.
- [ ] On the form, choose the problem statement **Push the Frontier** and the **Indie** track.
- [ ] Claim the Meta API credits before Nov 4, 9 PM ET.
- [ ] Post the demo on X, for the Most Viral bonus and the Community Vote.
- [ ] Confirm eligibility: participants located in sanctioned countries (see Eligibility) are excluded, and Meta Model API has its own country list.

## Deliverables

- Submit through the Cerebral Valley portal. Each project enters exactly one track. Late submissions are not considered.
- The rules require public repos and a submission that clearly marks what was built during the event.
- A **3-minute demo video** is the main thing judges look at, alongside the code and the live product.
- Pre-submit checklist (from the details page, secondhand): the repo is public, the video link works, and every contributor is listed.
- The form's fields and the video hosting format are still unknown. Prepare the public repo links, the README, the 3-minute video (1080p) and a short description that names what was built during the event.
- **Claim the API credits by Nov 4, 9 PM ET.** That's the same moment as the submission deadline.

## Judging

Kaveh shared the [event details page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details) on Oct 29. It renders only in a signed-in browser, and the build container can't reach it. The items below come from another participant's notes on that page ([meta-ai-hackathon/meta-hack](https://github.com/meta-ai-hackathon/meta-hack/tree/main/info)). They match the weights reported earlier, but **confirm them against the page**.

**Pass/fail gates, applied before scoring.** Failing either one disqualifies the project.
1. The project fits one problem statement:
   - **Build for Your World**: bring Meta's models into a domain you know firsthand.
   - **Push the Frontier**: give a machine a new capability in software, robotics, manufacturing, energy, materials or science.

   LegacyLink fits **Push the Frontier (software)**: agents gain the ability to operate API-less apps. Pick that one on the form.
2. The project genuinely uses Meta's models: the Model API (Muse Spark series, Muse Wonder, Muse Image, Muse Voice Transcribe, SAM 3.1) and/or the open weights (Muse Glimmer, Muse Spark Open). LegacyLink's explorer, learner and healer run on Muse Spark, so this is met. Show those calls in the demo.

**Scored rubric** (each part scored 0–10):

| Criterion | Weight | What it means |
|---|---|---|
| Impact | 30% | Real-world potential, who benefits, whether people could actually use it |
| Meta AI tooling | 25% | Creative use beyond a basic integration |
| Demo | 25% | Working, impressive, holds up live, plus the quality of the 3-minute video |
| Technical depth | 20% | Sound engineering and thoughtful refinement |

The top 5 in each track go to a live final, judged on the same rubric. The event page sums up the Indie track as "creativity, technical ambition, and whether it works".

**Bonus prizes ($50K in total):**
- Most Viral Project, $20K: the most X engagement on the demo post through Nov 8.
- Best Build on Open Weight Models, $10K: Muse Glimmer or Muse Spark Open, self-hosted or on partner inference.
- Community Vote, $10K: the public gallery.
- **Best Agentic Use-Case, $5K**: the strongest agent autonomy or multi-step workflows. This is the best fit for LegacyLink.
- Best Creative Build, $5K: Muse Image or Muse Wonder.

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

- Official Rules, section 4 (participant portal; pasted Oct 29)
- [Event details page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details) (needs sign-in), summarized secondhand in [meta-ai-hackathon/meta-hack](https://github.com/meta-ai-hackathon/meta-hack/tree/main/info)
- [Cerebral Valley event page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) ([markdown version](https://cerebralvalley.ai/e/meta-ai-developer-hackathon.md))
- [dev.meta.ai event page](https://dev.meta.ai/events/global-hackathon)
- [ReconScribe guide (Oct 17)](https://reconscribe.com/meta-global-ai-developer-hackathon-2026/)
- [Vibecoderslife (Oct 22): $150 credits from the approval email](https://vibecoderslife.com/post/meta-ai-developer-hackathon-2026)
- [Superpower Daily (Oct 22)](https://superpowerdaily.com/posts/meta-sets-october-26-start-for-1-million-ai-hackathon-capped-at-20-000-builders)
- [Internshala listing](https://internshala.com/competitions/meta-global-ai-developer-hackathon-2026/)
- [Resourify: Meta API credits](https://resourify.com/resources/meta-api)
- [Let's Data Science: Muse Spark 1.1 API](https://letsdatascience.com/news/meta-opens-muse-spark-11-to-developers-via-model-api-f9b336cb)
