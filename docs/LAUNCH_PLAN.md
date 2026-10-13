# EnergySwap — Launch Research and Planning

**Status:** Research and planning only. Nothing has been published. No platform was posted to, no account was created, no person or community was contacted, no money was spent, and no commits were pushed.

**Date of research:** 13 October 2026

**Author:** Marketing/Sales specialist

---

## 0. Bottom line first

**EnergySwap is not ready to be announced as a product.** Three of the four blockers below would be discovered within minutes by any technically literate viewer, and two of them would directly contradict the project's strongest claim.

It *is* ready to be announced as **an honest, documented engineering artifact seeking contributors** — but only after five specific gates clear (§3). Until then, the correct marketing action is no marketing action.

There is one item that is a live risk *today* and does not wait for the gates:

> **The public GitHub repository still shows the code from before the security work.** If EnergySwap is named anywhere publicly while that is true, the "the platform holds no keys" claim and the public code will contradict each other. Any reviewer who opens the repo will find it. This is the highest-damage single fact in this document, because the no-keys property is the *entire* positioning.

**Correction — what the published code actually contains.** This was verified directly against `origin/main` (tip `2f6a0e6`) rather than taken on trust, and the earlier draft of this section was wrong in a way that mattered.

It claimed the published version had "an operator-controlled price". It does not:

- `server.js` on `origin/main` takes `hbarPerKWh` **from the client's request body** (`parseFloat(hbarPerKWh)`). There is no operator price anywhere in the published tree, and no symbol matching `operatorPrice` / `OPERATOR_PRICE`.
- The published `server.js` contains **no `setOperator`** and no reference to `operatorKey`.

What the published tree *does* contain is the real contradiction:

- `EnergySwapBackend/execute-trade.js` calls `client.setOperator(operatorId, operatorKey)` and performs the transfer itself — the platform holding a signing key and settling on behalf of the parties.
- `EnergySwapBackend/credit-energy-tokens.js` sits alongside it.

So the accurate statement is: **the published code holds the operator key and performs middleman settlement**, not that it lets an operator set the price. Those are different failures with different fixes, and a reader sent looking for an operator price would find none and could reasonably discount this whole document.

Both files are already moved to `legacy-operator/` on the local branch, with a README explaining why they were archived. Publishing the four local commits resolves this. The rest of this document's reasoning is unaffected.

---

## 1. Platform research

Every platform below was visited during this task. Where a platform could not be reached, that is stated plainly rather than filled in from memory. **A guessed platform is worse than an omission here, because a guessed platform gets acted on.**

### 1.1 Hedera-specific ecosystem

| Platform | URL visited | Active? | How submission works | Self-promotion policy | Engagement (observed) | Verdict |
|---|---|---|---|---|---|---|
| **Hedera Discord** | `discord.com/invite/hederahashgraph` (linked from hedera.com/community) | Yes | No formal submissions. Forum channels exist — hedera.com/community explicitly says event proposals go to the `#community-discussion` forum with an "Events & Activities" tag. Token-gated channels exist for Builder NFT holders. | **Could not verify.** Requires joining to read the rules; Discord content is not indexable and the invite was not followed (joining = account creation, which is out of scope). Treat channel rules as unknown. | Hedera states **11,000+ members** on its own community page | **Highest-value target — but for participation, not promotion.** Genuine technical answers in dev channels. Do not drop a project link unprompted. |
| **r/Hedera** | `hedera.com/community` (links here); `reddit.com/r/Hedera/about/rules` — **fetch returned 403 Forbidden; also blocked at the network level from this environment** | **Unverified** | Unverified | **Unverified.** Reddit's *site-wide* rule was retrieved and quoted in §1.5, but per-subreddit rules could not be read. | Hedera states **92,000+ members** — but see the composition warning in §2 | **Avoid for now.** Two reasons: rules unverified, and the membership is overwhelmingly not developers (§2). |
| **Hello Future Apex Hackathon** | `hackathon.stackup.dev/web/events/hedera-hello-future-apex-hackathon-2026` | **Closed** | Virtual, teams of 1–5, 5 weeks, requires public GitHub repo + live demo link + ≤5-min demo video + pitch deck. Judged on 7 weighted criteria. | N/A — not a promotion surface, it's a competition | **1,197 participants, $250,000 prize pool**, hosted by AngelHack + Hashgraph. Main tracks $40K each: AI & Agents, DeFi & Tokenization, **Sustainability**, Open Track, Legacy Builders. Plus 6 partner bounties ($8K each). | **Best structural fit — target the next edition.** The Sustainability track is a direct match. Note: EnergySwap missed this one; it closed 23 March 2026. No later edition found. |
| **Hedera dApp Directory** | `hedera.com/dapp-directory/` | Yes | A "Get Listed" web form (First name, Last name, Email, Company, Industry, Job Title, project description). Industry options include Corporate, Financial Services, Government, Software, Academic, Other. | **This is a curated official directory, not an open submission feed.** Requires submitting real identity and contact details. | Categories are substantial. The **Sustainability** category already contains Blockchain for Energy (B4E), Evercity, DOVU, Verra, KrypC, Civic Ledger and others | **Later-stage only, gated hard.** Listing an alpha with zero completed trades would misrepresent it to official users. Requires contacting Hedera staff — out of scope for this task. |
| **Hedera Council** | `hederacouncil.org` | Yes | Not a submission surface. Governing body; has Strategic Partner and Community Partner programmes with "Apply" flows. | N/A | Council members include **Blockchain for Energy (B4E)** and **Repsol** — see §2.3, this is the most interesting finding in the whole research | **Not an audience. But highly relevant context** — energy is already a live Hedera Council thread. |
| **Hedera Foundation / funding** | `hedera.foundation` | Yes | "Submit a proposal" form. | N/A | States funding "supports **DeFi and enterprise** projects that drive Hedera network adoption, while delivering positive social and global impact." Listed focus areas: RWA tokenization, AI, DeFi, DePIN | **Poor fit right now.** An individual portfolio project in an unfunded category is not what this programme funds. Do not spend effort. |
| **Hedera Builder NFT programme** | `hedera.com/builders-program/` | Yes | NFTs earned by **event attendance (QR scan at official meetups), partner distributions, or completing courses/workshops/bootcamps** | — | Gives token-gated Discord access, VIP voice chats, private AMAs | **Genuine-contribution route.** The NFT is earned by showing up, not by asking. Useful for legitimately accessing gated developer spaces later. |
| **Hedera events / ETHGlobal** | `hedera.com/events/?...hackathon` and `hedera.com/community` | Yes | Sponsorship/booth presence, not an audience surface you submit to | N/A | Upcoming: **ETHGlobal Mumbai, 6–8 Nov 2026** — Hedera sponsoring "with a booth and a bounty". Also Singapore Fintech Festival 18–20 Nov 2026, Money20/20 USA 18–21 Oct 2026 | **Out of budget.** These are in-person and would likely require registration/travel. Flagged as awareness only. |
| **`hashgraph/awesome-hedera`** | Found via `github.com/search?q=awesome+hedera&type=repositories` | Yes | Pull request | N/A — it's a curated list; PR is the mechanism | **325 stars**, last updated **10 Feb 2025** — stale by ~20 months. Four other forks exist with 0–3 stars | **Low value, low cost.** It curates *tools and resources*, not dApps, so an application project is arguably off-scope. A PR is a genuine contribution, but expect little return. |

### 1.2 General developer platforms

| Platform | URL visited | Active? | How submission works | Self-promotion policy (verbatim where possible) | Engagement | Verdict |
|---|---|---|---|---|---|---|
| **Hacker News** | `news.ycombinator.com/newsguidelines.html` | Yes | Direct URL submission via account | **Explicit and restrictive.** Verified quotes: *"Please don't use HN primarily for promotion. It's ok to post your own stuff part of the time, but the primary use of the site should be for curiosity."* · *"Please don't post on HN to ask or tell us something. Send it to hn@ycombinator.com."* · *"Please submit the original source."* · *"Don't solicit upvotes, comments, or submissions."* · *"Please don't post generated text in HN posts."* | Very large, very hostile to marketing | **Do not post a launch.** If ever used, the compliant form is a *technical artifact* (e.g. a post-mortem on the money-path defect) submitted as the original source, with no request for feedback. Note the AI-text prohibition — this plan must be rewritten by hand before any HN use. |
| **Lobsters** | `lobste.rs/about` | Yes | Tag-required submission | **Explicit, quantified.** *"It's great to have authors participate in the community, but not to exploit it as a write-only tool for product announcements... As a rule of thumb, self-promo should be **less than a quarter** of one's stories and comments."* Also: invitation tree for registration; **new users (first 70 days) cannot submit links to domains not previously submitted**, and cannot use the `announce` tag; "Spam" flag = "content designed to promote a commercial service **or created without meaningful human authorship**" | Small (~"large enough to be worth asking questions about and small enough the answers make sense") | **Not viable cold.** Three independent barriers: invitation tree, new-domain submission block, and the 70-day newcomer window during which `announce` is unusable. Revisit only after sustained genuine participation over months. |
| **DEV Community (dev.to)** | `dev.to/community` | Yes | Self-publishing, any account. Tags + welcome thread | **No explicit self-promotion rule found on the page visited.** The community page invites newcomers: *"Welcome to DEV Community! Start by introducing yourself to the community"* and links a Welcome Thread. I did **not** locate a formal self-promo policy and am **not asserting one either way**. | Large. Observed tag sizes: webdev 449,080 · programming 308,248 · javascript 260,376 · ai 435,768 · opensource 105,624 · security 88,521 | **Good technical-writing surface, with a caveat.** Best suited to a deep engineering write-up, not a launch. Because the self-promo stance is unverified, publish something genuinely instructive rather than anything that reads as an announcement. |
| **Hashnode** | `hashnode.com` | Yes | Self-publishing blog, plus `/hackathons` | **Could not verify a self-promotion policy.** Homepage is a search shell; policy pages not reached. | Not verified | **Low priority / unverified.** Do not rely on it. |
| **Product Hunt** | `producthunt.com/launch` | Yes | Submit product URL; makers encouraged to hunt their own products | Verified: free to use; **company accounts are prohibited**; *"The only real rule here is that you cannot ask people directly to upvote your product. Instead, ask them to visit and comment."* Community guidelines exist at help.producthunt.com. Refuses spam accounts. | Very large, launch-day leaderboard competition | **Recommend against — see §5.** It rewards launch-day traffic and a polished demo. EnergySwap has neither. |

### 1.3 Open-source and portfolio surfaces

| Surface | URL visited | Finding |
|---|---|---|
| **GitHub topic `hedera`** | `github.com/topics/hedera` | **376 public repositories** matching the topic. The JS SDK EnergySwap depends on is `hiero-ledger/hiero-sdk-js` (331 stars), now maintained under the Linux Foundation's Hiero project rather than `hashgraph/`. Note this rename — documentation and README links should reference the current SDK org. Top repos are almost entirely SDKs, infrastructure and tooling, **not applications**. |
| **GitHub topics generally** | `github.com/topics` (linked) | Adding topics to a repo is self-service and free. Zero cost, zero risk, no gate. Do this as part of Gate G3. |
| **Awesome lists** | GitHub repo search for "awesome hedera" | Only **5 results total**, one of substance (`hashgraph/awesome-hedera`, 325 stars, stale). The awesome-list route is not a meaningful discovery channel at Hedera's scale. |

### 1.4 Energy and solar industry communities

This is where a naive launch goes badly wrong, so the finding is worth stating plainly.

| Surface | What I verified | Verdict |
|---|---|---|
| **r/solar, r/solarDIY, r/energy** | **Could not be verified.** All Reddit endpoints returned 403 from this environment (both `www.` and `old.`, HTML and `.json`). I will not characterise their rules from memory. | **Do not approach until someone reads the rules manually.** |
| **Academic / research literature** | Substantial and verified via search results: peer-reviewed work on blockchain-based P2P energy trading in *Sustainability* (Chiarini 2022, cited 38×; Shan 2023 case study of eight P2P trials, cited 26×), CIRED Working Group reports on Blockchain/Transactive Energy, an EU Blockchain Observatory paper on P2P energy markets, and an IRENA innovation landscape brief. | **Real, receptive, non-marketing audience** — but slow, and see §2.3 for why it is a *long-term* play only. |
| **Commercial incumbents** | **Powerledger** (powerledger.io) — builds P2P energy trading for **utilities and communities**, now running on **Solana**. **Piclo** (piclo.com) — *pitched* a consumer P2P marketplace, then **pivoted** to a B2B "Marketplace for Energy Flexibility", raising funding led by EDP Ventures in Aug 2024. Piclo's own head has publicly argued a centralised trading platform is *"absolutely the wrong approach"* for distributed energy markets. | **Critical context, not a channel.** See §4.3 — this is the single most important thing to understand before writing any copy. |

*(Correction worth recording: I initially expected the P2P energy pilot graveyard to be worse than it is. Enera's status could not be verified — searches returned an unrelated German wind manufacturer, "eno energy". I am making **no claim** about Enera. Piclo and Powerledger are both verified and both pivoted rather than died.)*

### 1.5 Reddit site-wide policy (the one Reddit rule I could verify)

From `redditinc.com/policies/reddit-rules`, retrieved verbatim:

> "Abide by community rules. Participate authentically in communities where you have a personal interest, and do not spam or engage in disruptive behaviors (including content manipulation) that interfere with Reddit communities."

This is the *site-wide* floor. Per-subreddit rules override it and were unreadable for r/Hedera and the solar subreddits.

---

## 2. Audience analysis

### 2.1 Hedera / Web3 developers — **primary audience, small**

**Size reality check, which matters more than anything else in this document:**

- Hedera Discord: **11,000+** (Hedera's own figure)
- @hedera_devs on X: **4,500+** (Hedera's own figure)
- r/Hedera: **92,000+** — but this is a **token-price community**, not a developer community. It is overwhelmingly retail HBAR holders watching price. Posting a developer project there reaches people who cannot evaluate it and will not use it.
- GitHub topic `hedera`: **376 repositories total** — that is the entire open-source corpus, not a growing subset.

**So the realistic reachable developer audience is in the low thousands, and the subset that would care about P2P energy settlement is a small fraction of that.** Any plan that promises meaningful "reach" or "traction" here is fiction. EnergySwap should target *individuals who will read the code*, not a *number of eyeballs*.

**What they care about:** how you used HCS and the mirror node; whether you understood the difference between a consensus message and a proof; whether your key handling is defensible; test quality. Hedera developers are unusually well-informed on exactly the subject matter of this project's main design decision.

**The claim that lands:** "The API opens zero Hedera clients when accepting a reading — and there is a test that asserts it." That is checkable in thirty seconds and it is unusual.

**What reads as noise:** anything that leads with the word "revolutionises", any mention of HBAR price, any implication of partnership with Hedera, any request for engagement.

### 2.2 Decentralisation / P2P-marketplace people — **secondary, mostly theory**

**What they care about:** whether the trust model actually removes the operator. This community has been sold "decentralised energy trading" repeatedly and is appropriately sceptical.

**The claim that lands:** the no-keys argument stated as an architectural consequence, not a slogan — plus an honest account of what removing the operator does *not* solve. This group rewards the caveat more than the claim.

**What reads as noise:** claiming that removing the middleman solves the market-design problem. It does not. See §4.3.

### 2.3 Energy / solar researchers — **genuinely relevant, wrong order**

This audience is where P2P energy is a *real subject*, not a novelty. Two verified facts make it more relevant than it looks:

1. **Blockchain for Energy (B4E) is a Hedera Council member** — a non-profit consortium of energy companies, joined June 2025 to drive emissions-reporting standards. **Repsol** is also a Council member, specifically on energy-sector Web3 and digital identity.
2. The academic literature is deep and long-running (CIRED working groups since 2018; peer-reviewed case studies; EU and IRENA policy work).

**However:** these audiences care about market design, grid physics, metering accuracy, regulatory compliance and settlement certainty. EnergySwap currently has **zero completed trades**, a **browser-trust model instead of chain reconciliation**, and a **known unauthenticated offer-posting gap**. Approaching the energy research community *before* gates G1 and G2 would be the most damaging possible error, because the one question they will ask first — "what evidence do you have that this actually trades?" — currently has the answer "none."

**Sequencing:** this audience is reachable only *after* the security model is complete and demonstrable. It is a year-plus play, not a launch play.

### 2.4 Hiring / portfolio reviewers — **secondary, but they are the ones who will actually read**

**What they care about:** judgement. Specifically: did you find a real problem, understand it, find and fix a real defect, and know what you don't know. A documented money-path defect that was found by independent review, fixed, and covered by a test against a real database is *more* impressive to this reader than a green demo — because most portfolios have never had anyone find a bug in them.

**The claim that lands:** the honest version, including the gaps.

**What reads as noise:** volume metrics, growth claims, "users", anything implying a team or traction that does not exist.

### 2.5 Audiences that do not exist for this project

- **Consumers / households.** There is no energy to buy. HBAR on testnet has no monetary value and accounts need funding. Any consumer-facing framing is false.
- **Solar DIY hobbyists.** Different problem, different economics, and a blockchain marketplace would read as a joke to them.
- **Institutional energy buyers.** Nothing here is deployable by them, and they would need metering, SLAs and regulatory posture that do not exist.

---

## 3. Sequencing tied to readiness

Effort is expressed in **focused working days**, not calendar dates. Calendar dates would be dishonest given that G1 has an unknown tail and G2 is unstarted feature work.

### Gate summary

| Gate | Must be true | Effort | Blocks |
|---|---|---|---|
| **G0** | Public repo no longer contradicts the positioning | 0.25 day | **Everything** |
| **G3** | Post-security code published | 0.25 day | **Everything** |
| **G4** | Production API boots; a stranger can load the demo | 0.5–1 day | **Everything** |
| **G1** | Funded testnet accounts + **one trade completed end to end** | 3–10 days, high variance | **Stages 3 and 4** |
| **G2** | Offer posting authenticated | 3–5 days | **Public exposure of write endpoints**; credibility of the security claim |
| **G5** | README + architecture + threat model + known-gaps doc | 1.5–3 days | Quality of every announcement |

### Stage 0 — Close the blockers (no audience work at all)

**No marketing of any kind in this stage.** Not even "soft" signalling.

1. **G0 — Audit what the public repo exposes.** *(0.25 day)* Determine exactly which commits are visible on the public remote. If the pre-security code with the operator-controlled price is publicly reachable, treat this as an incident, not a chore.
2. **G3 — Publish the post-security code.** *(0.25 day)* Push the security work. Push this **first**, before any public mention anywhere.
3. **G4 — Redeploy and verify the API boots.** *(0.5–1 day)* The undeclared-dependency fix needs to actually reach Render and be confirmed live from outside. Add a cheap external uptime check so this cannot silently regress again.
4. **G1 — Complete one real trade, end to end.** *(3–10 days — this is the honest unknown)* Fund two testnet Hedera accounts, stand up the gateway, and run one offer → accept → signed transfer → recorded trade, capturing the transaction ID. Do not skip this. **This gate is what converts the project from a claim into a demonstration.**
5. **G2 — Authenticate offer posting.** *(3–5 days)* Implement wallet signing on the frontend (does not exist today), verify server-side, bind each offer to a provable account. Until this lands, the write endpoints must not be reachable by strangers, because the impersonation gap is a *live vulnerability*, not a cosmetic one.

### Stage 1 — Build the artifacts, still no distribution

6. **G5 — Write the documentation.** *(1.5–3 days)* Architecture diagram; the security model including the mirror-node `payer_account_id` anchor; a threat model that names the impersonation gap and the browser-trust model as *known and accepted*; a maturity section; a contribution guide; setup instructions that assume a reader has never seen the project. **This is the highest-leverage item in the plan** — it is what converts a reader into a contributor, and it is what every later platform link points at.

### Stage 2 — Participate before promoting

7. **Join the Hedera Discord and participate genuinely.** *(Ongoing, weeks)* Answer technical questions in developer channels. Ask real questions. Do not mention EnergySwap unless someone asks what you're building. The Builders NFT route (event attendance, courses) is the legitimate way into token-gated spaces.
8. **Establish a public technical footprint.** *(Ongoing)* Contribute to the ecosystem on things that are not this project. The point is to have a reason to be there.

### Stage 3 — The announcement, once, narrowly

9. **Publish one deep technical write-up.** DEV Community is the best-verified fit for this (§1.2). Subject matter: the no-custody design and why the platform cannot become a settlement operator. Written as engineering, not announcement.
10. **Then, and only then, one Show-and-tell / build-log post** to the Hedera community channels, framed as "here is what I built and what I got wrong." Not "I built a marketplace."

### Stage 4 — The hackathon

11. **Enter the next Hello Future Apex Hackathon, Sustainability track.** Verify each edition genuinely requires: public repo, live demo link, ≤5-minute demo video, pitch deck. The 2026 edition required all four — **which is precisely why G1 and G4 are blocking.** A project that cannot complete a trade cannot produce the required demo.

### Timeline in effort

| Stage | Effort | Blocking |
|---|---|---|
| Stage 0 — blockers | **~7–19 focused days** | G0/G3/G4 block *everything*; G1 blocks Stages 3–4; G2 blocks public exposure |
| Stage 1 — artifacts | ~1.5–3 days | G5 blocks announcement quality |
| Stage 2 — participation | Weeks of background time | Nothing, but nothing works without it |
| Stage 3 — announcement | ~2 days writing, after Stage 2 | Blocked on Stage 0 + Stage 1 |
| Stage 4 — hackathon | ~5 days + edition timeline | Blocked on G1, G4 |

**The variance is almost entirely in G1.** If the completed trade reveals further defects in the money path — and a path that has never run once is exactly where you find them — Stage 0 expands. Plan for that rather than being surprised by it.

---

## 4. Positioning and honest messaging

### 4.1 Core positioning

> **EnergySwap is a peer-to-peer energy marketplace built on Hedera where the platform never holds a key or a coin.**
>
> Households with rooftop solar sell kilowatt-hours directly to their neighbours. The energy goes one way; the money goes the other, directly between the two people, signed by them and paid for by them. There is no escrow, no custodian, no settlement operator, and nobody in the middle who sets the price.
>
> That last part is unusual. Nearly every previous attempt at peer-to-peer energy trading needed a trusted operator to run the market — a company or utility holding the money and setting the tariff. This one is built so that it does not need one, and a test asserts it: the API opens zero Hedera clients when accepting a reading.

**The one idea worth a stranger's attention:** *the marketplace holds nothing.* Everything else follows from it.

### 4.2 Honest maturity statement — and an assessment of whether it is credible

**It is credible. It is also the only version that survives contact with a reader.**

The temptation is to soften "zero completed trades" into "working prototype" or "early alpha". Don't. Evaluate it honestly against the two audiences that matter:

- **Security-minded developers** — a candid statement *raises* credibility. Anyone in this audience who reads "no trade has completed end to end" and then checks will respect the admission enormously, and will distrust a softer claim.
- **Hiring reviewers** — this audience reads self-assessment accuracy as a direct proxy for engineering judgement. A candid maturity section is one of the strongest signals available.

Everyone else — the large, price-driven, non-technical majority — is irrelevant to this project. **The honesty costs nothing with the audience that matters and is the entire strategy with the audience that does.**

**Draft announcement text:**

> **EnergySwap — testnet alpha, and it hasn't traded yet.**
>
> I'm building a peer-to-peer energy marketplace on Hedera: households with rooftop solar sell kilowatt-hours directly to consumers, and both the energy and the money move peer-to-peer with no middleman.
>
> **Where it actually is:** testnet only. Mainnet is deliberately disabled in configuration. The platform holds no keys and no funds — that's enforced by a test — but **no trade has completed end to end yet**. The money path had a defect that made recording impossible; it's fixed and unit-tested against a real database, but no HBAR has moved through the full flow. Offer posting is currently unauthenticated, so anyone can post an offer claiming any account as the producer; that's a known gap with a specified fix, not a design choice. The production API may not currently boot.
>
> **What works:** the architecture, the security model, and the tests — 124 backend, 17 frontend. The identity design is the part I'm most confident in: you sign in with any EVM wallet that should hold nothing, and the binding between that wallet and your Hedera trading account is proven on-chain, so a forged producer claim gets rejected.
>
> **Why I'm sharing it now, before it works:** because the parts that are hard are the parts I'd like help with — authenticated offer posting, and reconciling from the chain rather than trusting the browser.
>
> Testnet. No real money, no real energy. Looking for contributors, not users.

### 4.3 The anti-claims

Each of these is a fair thing for a knowledgeable person to say. Answer each directly.

**"It isn't a working marketplace."**
*True.* Say so in the first paragraph, not the fifth. Then say precisely which step is unproven.

**"Peer-to-peer energy trading has failed commercially."**
*Substantially true, and this is the sharpest critique available.* The verified record: Piclo pitched a consumer P2P marketplace and **pivoted to a B2B flexibility marketplace**, raising EDP-led funding in Aug 2024; Powerledger now runs on **Solana** and sells to **utilities**. The honest reading is that consumer P2P energy found the willingness-to-pay and the grid economics hard, not that the technology failed. EnergySwap has not solved this and should not imply it has. If pressed, the real question isn't "why blockchain" — it's "why would anyone pay a neighbour more than the grid does."

**"Does this actually need a blockchain?"**
*The strongest fair critique, and the one most likely to be asked by a good engineer.* Hedera is doing real work here — micro-fee transfers between parties with no intermediary, and `payer_account_id` as a non-spoofable security anchor. But a conventional server *could* implement much of this, and EnergySwap has not demonstrated the chain is necessary. **Do not dismiss this.** Answer: "you're right that a lot of this doesn't strictly need one. What it buys is non-repudiation of settlement and a payer that can't be spoofed. Whether that's worth it is a fair question and I haven't proven the trade-off."

**"Anyone can post an offer as any producer."**
*True, and currently exploitable.* Say it, name the fix, and do not ship the write endpoints publicly until it's closed. Disclosing a known, understood vulnerability with a fix in progress reads as competence; being found with it reads as negligence.

**"The platform trusts the browser."**
*True.* Trades are recorded as the browser reports them, not reconciled from the chain. Name this as a known limitation with a stated remediation.

**"You're borrowing Hedera's credibility."**
*Fair.* Hedera publishes a brand book (linked from its site footer as "brand book"). Make no claim of partnership, sponsorship, affiliation or endorsement. Say "built on Hedera" — a factual statement about the network — and nothing more.

**"It's a portfolio project, not a company."**
*True.* Say so in the first sentence. It removes any ambiguity about what is being asked of a reader.

### 4.4 The strength, stated as a strength

The no-custody design is a genuine and unusual engineering property and should be stated as one, without hedging:

> EnergySwap holds no keys and no funds. Consumers and prosumers sign their own HBAR transfers and pay their own network fees. There is no escrow and no settlement operator. Producers set their own price; there is no operator-controlled pricing anywhere in the system. This is not an aspiration — `test/gateway.test.js` asserts that the API opens zero Hedera clients when accepting a reading, so the property is enforced by the test suite rather than merely claimed in a document.

### 4.5 The brand line

Shortest true version:

> **The marketplace holds nothing. That's the whole design.**

---

## 5. What NOT to do

| Tactic | Why not |
|---|---|
| **Product Hunt launch** | It optimises for launch-day traffic against a leaderboard. EnergySwap cannot complete a trade, so there is no demo, and the resulting spike would be traffic that arrives, finds nothing, and leaves. Product Hunt also **prohibits company accounts** — and this is explicitly a portfolio project. A launch-day result here would be a small, visible credibility loss. |
| **Show HN / "Ask HN: feedback wanted"** | HN's guidelines explicitly forbid posting *to ask or tell*: *"Please don't post on HN to ask or tell us something. Send it to hn@ycombinator.com."* Also: *"don't use HN primarily for promotion."* A launch post from an account with no history is the canonical HN spam pattern. If ever used, it must be a technical artifact submitted as the original source. |
| **"Ask HN: has anyone built X on Hedera?"** | This is promotion wearing a question's clothes, and it is the specific pattern HN guidelines exist to suppress. |
| **Posting to r/Hedera** | 92,000+ members who are overwhelmingly not developers; per-subreddit rules **could not be verified**. A developer post that reaches nobody, plus an unverifiable rules risk, is a bad trade. Revisit only after someone reads the rules by hand. |
| **r/solar, r/solarDIY, r/energy** | Rules unverified. More importantly, the audience fit is poor — these are practical, hardware-focused communities where a blockchain marketplace reads as a novelty. |
| **Cold-submitting to Lobsters** | Three independent structural barriers: invitation tree required, new users cannot submit unseen domains, and the `announce` tag is unavailable to users in their first 70 days. |
| **Any spend** | Product Hunt paid promotion, event tickets, ETHGlobal Mumbai registration/travel (6–8 Nov 2026, three weeks out) are all out of budget. ETHGlobal Mumbai is noted as awareness only. |
| **Leveraging Hedera's brand** | No implication of partnership, sponsorship, affiliation or endorsement. No use of Hedera marks. Hedera publishes a brand book, which implies brand rules exist. |
| **Framing testnet trading as live energy trading** | HBAR has no monetary value on testnet and accounts require funding. Any framing that implies real energy or real money is false. |
| **Any implication of mainnet readiness** | Mainnet is deliberately disabled in `config.js`. This is a design decision to be respected, not a limitation to be hinted around. |
| **Pitching as a product with users** | There are no users. There are no completed trades. Any "users", "trades" or "traction" figure would be fabricated. |
| **Asking for stars, forks, followers or upvotes** | Product Hunt explicitly prohibits asking for upvotes; HN explicitly prohibits soliciting votes. More broadly, it reads as noise to every audience in §2. |
| **Publishing AI-generated text to HN** | HN guidelines now state: *"Please don't post generated text in HN posts... Write your text yourself — HN is for sharing between humans."* This document is fine as an internal planning artefact; anything derived from it must be rewritten by hand before HN use. |
| **A hero video, landing page polish, or brand refresh** | Nothing here matters until G1 and G2. Presentation cannot substitute for a working trade. |
| **Listing in the Hedera dApp Directory now** | An official directory listing implies a working application. The Sustainability category already contains real, funded, operating projects (B4E, Evercity, DOVU, Verra). Listing next to them with zero completed trades would misrepresent the project's maturity to the users who actually build here. |

---

## 6. Sources

Every URL below was fetched during this research task on 13 October 2026.

**Fetched successfully:**

| URL | What it established |
|---|---|
| `https://hedera.com/community` | Hedera's own community figures: Discord 11,000+ · r/Hedera 92,000+ · X 460,000+ · @hedera_devs 4,500+ · LinkedIn 60,000+ · YouTube 42,000+ · Instagram 33,000+ · TikTok 3,000+ · Spanish X 3,800+. Discord forum + "Events & Activities" tag mechanism. Links to Hackathons, Ambassador/Builder/Moderator programs, dApp Directory, Hiero. |
| `https://github.com/hashgraph` | Official Hedera org: 957 followers, 91 repositories. |
| `https://hedera.com/dapp-directory/` | Directory categories incl. **Sustainability** (already holds B4E, Evercity, DOVU, Verra, Civic Ledger). "Get Listed" form requires name, email, company, industry, job title. |
| `https://hedera.com/events/?e-filter-24790d4-event-type=hackathon` | Upcoming: ETHGlobal Mumbai 6–8 Nov 2026 (booth + bounty); SFF 18–20 Nov 2026; Money20/20 USA 18–21 Oct 2026. Past Hello Future hackathon AMA recordings. |
| `https://hederacouncil.org/` | Council member list. **Blockchain for Energy (B4E)** joined June 2025. **Repsol** joined on energy-sector Web3 + digital identity. Node operators are permissioned Council members. |
| `https://hedera.foundation/` | Funding scope is **DeFi and enterprise**; focus areas RWA, AI, DeFi, DePIN. Not aimed at individual portfolio projects. |
| `https://hedera.com/builders-program/` | Builder NFTs earned via **event attendance / partner distribution / courses**, not by asking. Token-gated Discord access. Links to the 2026 Apex hackathon. |
| `https://hackathon.stackup.dev/web/events/hedera-hello-future-apex-hackathon-2026` | **Closed.** 17 Feb–23 Mar 2026. 1,197 participants. $250,000 pool. Sustainability track $40K. Submission requirements: public GitHub repo, live demo link, ≤5-min demo video, pitch PDF. 7 weighted judging criteria. 6 partner bounties. |
| `https://hbar.guide/` | Run by Hashgraph DeFi Alliance. Sections are Wallets/HBAR/Bridges/Staking/DEXs/Lending/Memecoins/NFTs — **no energy category**. Listing requests via Google Form. Low fit. |
| `https://news.ycombinator.com/newsguidelines.html` | HN self-promotion and "don't ask/tell on HN" rules, quoted in §1.2 and §5. |
| `https://lobste.rs/about` | Lobsters self-promo rule (<25%), invitation tree, 70-day newcomer restrictions, spam flag definition. |
| `https://dev.to/community` | DEV tag sizes and welcome-thread invitation. No explicit self-promo rule located. |
| `https://hashnode.com` | Active. No policy located. |
| `https://www.producthunt.com/launch` | Free; company accounts prohibited; no asking for upvotes; maker self-hunt encouraged. |
| `https://redditinc.com/policies/reddit-rules` | Site-wide rule, quoted verbatim in §1.5. |
| `https://github.com/topics/hedera` | **376 public repositories.** `hiero-ledger/hiero-sdk-js` at 331 stars (SDK now under Hiero/Linux Foundation). |
| `https://github.com/search?q=awesome+hedera&type=repositories` | 5 results. `hashgraph/awesome-hedera` 325 stars, **last updated 10 Feb 2025**. |
| `https://powerledger.io/` | Now on **Solana**; sells to utilities and communities in 10+ countries. |
| `https://www.piclo.com/` | Pivoted to B2B "Marketplace for Energy Flexibility". |

**Could not be reached — and therefore make no claims about:**

| URL / target | Outcome |
|---|---|
| `https://hederacommunity.org/` | Transport error — no response. Its current status is unknown to me. |
| `https://www.reddit.com/r/Hedera/about/rules` | HTTP 403 |
| `https://old.reddit.com/r/Hedera/about/rules` | HTTP 403 |
| `https://www.reddit.com/r/{solar,solarDIY,energy}/about.json` | HTTP 403 (all) |
| `https://www.reddit.com/r/Hedera/` and `/r/solar/` | HTTP 403 / blocked at network level |
| Browser-based Reddit access | Unavailable — no desktop browser connected to this session |
| `discord.com/invite/hederahashgraph` | Invite not followed. Channel rules unverified. Following would require account creation, which was out of scope. |
| `https://brand.hedera.com/` | Linked from hedera.com footer as "brand book"; not visited. Existence of brand rules inferred from the link only. |
| `help.producthunt.com/en/articles/3615694-community-guidelines` | Referenced from PH's launch guide; not fetched. |
| Enera (German energy trading platform) | **No verified information.** Searches returned an unrelated company ("eno energy"). No claim is made about Enera in this document. |

**Market context from search (secondary — used only for the §4.3 anti-claims, not as a factual foundation):**

- MDPI *Sustainability* 14(23):16305 — Chiarini et al., "Blockchain, Data Protection and P2P Energy Trading" (2022), cited 38×
- MDPI *Sustainability* 15(23):16284 — Shan et al. (2023), case study of eight P2P trading trials incl. Piclo, Vandebron, Powerpeers, cited 26×
- CIRED Working Group — "Blockchain, Transactive Energy and P2P Trading" report
- EU Blockchain Observatory — "Towards a Peer-to-Peer Energy Market: an Overview"
- IRENA — "Peer-to-peer electricity trading: Innovation Landscape Brief" (2020)
- UK Tech News / Open Utility — Piclo funding led by EDP Ventures, Aug 2024
- Utility Week — "Piclo opposes distributed energy supermarket model"

---

## 7. Recommendation

**Do not announce EnergySwap yet.** The blockers are not presentational; they are the substance of the project. Specifically:

1. **Publish the security work to the public repo before the project is named anywhere.** This is independent of everything else and is the one item with live downside today.
2. **Complete one trade end to end.** Until then, "energy marketplace" is a description of intent.
3. **Close the unauthenticated offer-posting gap** before any stranger can reach the write endpoints.
4. **Confirm the deployed API boots**, or don't share a link.

Once those clear, the announcement is straightforward and, unusually, the honest version *is* the strong version. The no-custody design is a real and defensible piece of engineering. The maturity gap is explainable. What is not defensible is letting a viewer discover the gaps — especially the impersonation one — before being told.
