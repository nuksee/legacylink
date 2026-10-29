# Hackathon findings

Last updated Oct 29, 2026, from the official **Participant Guide**: the event details page, which Kaveh saved as a PDF from the participant portal. Section numbers below follow the guide.

## Status

- Application **approved** (Oct 20, 2026). Entering the **Indie** track, solo.
- The Official Rules and Participant Guide are published to participants. Section 4 ("Hackathon Rules") is quoted below.

## Official rules (section 4, verbatim)

> - Open source: Repositories must be public.
> - Team size: A maximum of four participants per team. Solo participants are allowed.
> - Demo requirements: Your demo must only highlight the specific features, code, and functionality that you built during the Hackathon. Judges must be able to clearly identify what was created during the Hackathon. Failure to clearly identify your original contributions will result in immediate disqualification at Judges sole discretion.
> - New work only: What you present at this Hackathon must have been built during the event. This should be clear in your submissions. Startups may build on existing products or codebases, but you must clearly identify what was newly developed during the Hackathon.
> - Banned projects: Projects will be disqualified if they: violate legal, ethical, or platform policies, use code, data, or assets you do not have the rights to.

The rules also list "anti-projects" to avoid: AI medical advice, basic RAG apps, simple image analyzers, simple "AI for Education" chatbots, AI job application screeners, AI nutrition coaches, personality analyzers, sports analyzers or coaches, and anything political or involving war. LegacyLink isn't in any of these categories.

## Schedule and deadline (guide §3, all times ET)

- **Kickoff:** Mon Oct 26, 12:00 PM ET (16:00 UTC). The guide gives the "building period" as Oct 27 – Nov 4.
- **Live sessions:**
  - Agents 101: Oct 27
  - Agents 102 (verifiable agents): Oct 28
  - Fireworks and Muse open models: Oct 30, 12:00 PM
- **Office hours:** Discord `#office-hours`, 10–11 AM ET on weekdays.
- **Tue Nov 3:** the last full day for submission questions and technical troubleshooting.
- **Deadline: Wed Nov 4, 9:00 PM EST = 02:00 UTC Thu Nov 5.** Submit on the CV platform. "Late submissions won't be considered." Our plan is to submit by the end of Nov 4, local time.
- **Judging:** Thu Nov 5 – Sun Nov 8.
- **Mon Nov 9, 12:00 PM ET:** closing ceremony. The top 10 (5 per track) are announced, judged live in a final round, and winners revealed. Community voting opens the same day.
- **Mon Nov 16:** community vote winner announced.

## What was built when

Git history is the evidence. The event opened at kickoff, Oct 26 12:00 PM ET (16:00 UTC). The first agent commit (`f7e7b37`, the explorer) is from Oct 26 20:47 UTC, after kickoff. The guide calls Oct 27 – Nov 4 the "building period", so the work from the evening of Oct 26 sits between kickoff and that date. Say so openly in the submission.

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
- [ ] Keep the demo video to 3 minutes. Say out loud that Contoso was prepared on Oct 20 as a test target. Show only LegacyLink features.
- [ ] Rights: npm dependencies are all MIT, ISC, Apache-2.0 or BSD (checked Oct 29). The anthropics/skills copies keep their Apache 2.0 licence. Contoso's CSS and markup were written from scratch to look like 2009 WebForms, and copy no Microsoft files. "Contoso" is Microsoft's standard fictional sample company.
- [ ] Use no customer data. Contoso's data is invented in `lib/data.js`.
- [ ] On the form, choose the problem statement **Push the Frontier** and the **Indie** track.
- [ ] Claim the $150 Meta API credits through the guide's Google form; this needs a card on the Billing page. Deadline: Nov 4, 9 PM ET.
- [ ] Post the demo on X, for the Most Viral bonus and the Community Vote.
- [ ] Confirm eligibility: participants located in sanctioned countries (see Eligibility) are excluded, and Meta Model API has its own country list.

## Submission (guide §7)

- Submit on the CV platform by **Nov 4, 9:00 PM EST**. Teams submit one project. A solo entrant is their own team's "Representative".
- Required: a **three-minute demo video** "highlighting the specific features, code, and functionality you built during the Hackathon". Judges use it as a primary artifact, along with the code and the live product.
- Before submitting, check that the repo is publicly accessible, the video link works, and everyone who worked on the project is listed.
- The guide doesn't list the form's fields. Prepare the public repo links, the README, the 3-minute video (1080p, hosted at a public link) and a short description that names what was built during the event.

## Judging (guide §1, §8, §9)

**Stage one (pass/fail):** the project "reasonably fits the theme and reasonably used Meta Model API and/or Meta's open-weight models". The two problem statements are:
- **Build for Your World**: bring Meta's models into your domain.
- **Push the Frontier**: use Meta's models on challenges in "software, robotics, manufacturing, energy, materials and beyond". "Give a machine a new capability…"

LegacyLink fits **Push the Frontier (software)**: it gives agents a new capability, operating apps that have no API. It meets the model requirement because the explorer, learner and healer call Muse Spark through the Model API. The demo should show those calls.

**Stage two:** each criterion is scored 0–10.

| Criterion | Weight | Guide's question (abridged) |
|---|---|---|
| Impact | 30% | Real-world potential, who benefits, could people actually use it, does it fit a problem statement |
| Use of Meta AI tooling | 25% | Creative use beyond a basic integration |
| Technical depth & execution | 20% | Sound, thoughtfully refined engineering |
| Demo | 25% | Working and impressive, holds up live, a video that's genuinely cool to watch |

**Stage three:** the top 5 per track go to a final round. The final-round judges watch the video demos live and rank them with the same rubric.

**Prizes:** $1,000,000 in total.
- Indie track ($400K): 1st $150K, 2nd $100K, 3rd $75K, 4th $50K, 5th $25K.
- Startups track: $550K.
- Bonus prizes from Meta ($50K):
  - Most Viral Project, $20K: the highest engagement on X for the demo post after the event.
  - Best Build on Meta Open Weight Models, $10K: Muse Glimmer or Muse Spark Open, on your own hardware or partner inference.
  - Community Vote, $10K: votes in the public gallery; the winner is announced Nov 16.
  - **Best Agentic Use-Case, $5K**: "strongest use of AI agents to complete meaningful tasks, make decisions, or coordinate multi-step workflows". This is the best fit for LegacyLink.
  - Best Creative Build, $5K: Muse Image or Muse Wonder.

## Meta models and credits (guide §1, §5, §6)

- **Required:** "Your project must incorporate Meta's models."
  - Through the Model API: the Muse Spark series, Muse Wonder, Muse Image, Muse Voice Transcribe and SAM 3.1.
  - As open weights: Muse Glimmer and Muse Spark Open.
  - For coding: the Muse Code agent.
- **$150 in Meta Model API credits per accepted participant.** These aren't automatic.
  - Apply through the Google form linked in the guide. Credits arrive in batches; check the Billing page.
  - A credit card must be on the account before any API call. It gets a temporary pre-authorization charge, released within a few days.
  - Set a "Spend Limit" notification on the Billing page to avoid going past $150.
  - **Claim by Wed Nov 4, 9:00 PM ET.** Each participant claims their own credits.
- Partner credits are not guaranteed:
  - Baseten: $100 plus a 2M TPM limit, for up to 2,000 participants, reviewed by use case. For the hackathon, use the model id `meta-models/muse-spark-open-1026`.
  - Modal: $100, for the first 1,000 participants.
  - Fireworks: $25, for shortlisted teams only.
- Pricing after credits: $1.25 per million input tokens and $4.25 per million output tokens for Muse Spark 1.1.

## Eligibility

- Open worldwide except where prohibited. This excludes sanctioned parties and people located in Belarus, China, Russia, Ukraine, Syria, Cuba, North Korea and Iran.
- Also excluded: Meta and Cerebral Valley employees, contractors and interns, government-affiliated people, and their families or households.
- The cap is 20,000 selected participants. $1,000,000 in total prizes; no per-track breakdown has been published.

## Sources

- Official Rules, section 4 (participant portal; pasted Oct 29)
- [Participant Guide / event details page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details) (needs sign-in; PDF saved by Kaveh Oct 29)
- [Cerebral Valley event page](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) ([markdown version](https://cerebralvalley.ai/e/meta-ai-developer-hackathon.md))
- [dev.meta.ai event page](https://dev.meta.ai/events/global-hackathon)
- [ReconScribe guide (Oct 17)](https://reconscribe.com/meta-global-ai-developer-hackathon-2026/)
- [Vibecoderslife (Oct 22): $150 credits from the approval email](https://vibecoderslife.com/post/meta-ai-developer-hackathon-2026)
- [Superpower Daily (Oct 22)](https://superpowerdaily.com/posts/meta-sets-october-26-start-for-1-million-ai-hackathon-capped-at-20-000-builders)
- [Internshala listing](https://internshala.com/competitions/meta-global-ai-developer-hackathon-2026/)
- [Resourify: Meta API credits](https://resourify.com/resources/meta-api)
- [Let's Data Science: Muse Spark 1.1 API](https://letsdatascience.com/news/meta-opens-muse-spark-11-to-developers-via-model-api-f9b336cb)
