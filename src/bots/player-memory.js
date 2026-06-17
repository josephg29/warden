import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import { config } from '../config.js';
import { settingsStore } from '../settings-store.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const SCHEMA_VERSION       = 1;
const PERSIST_DEBOUNCE_MS  = 2000;
const COMPRESS_THRESHOLD   = 15;
const COMPRESS_TARGET      = 10;
const COMPRESS_TIMEOUT_MS  = 8000;

// Local LLM swap — mirrors USE_LOCAL_LLM in brain.js so memory compression
// routes to the same endpoint as the decision loop. Without this, compression
// keeps calling Cerebras even on local runs (observed: 473 consecutive 402s).
const USE_LOCAL_LLM      = process.env.USE_LOCAL_LLM === '1';
const LOCAL_LLM_BASE_URL = process.env.LOCAL_LLM_BASE_URL ?? 'http://localhost:11434/v1';
const LOCAL_LLM_MODEL    = process.env.LOCAL_LLM_MODEL    ?? 'qwen2.5:7b';
const CEREBRAS_MODEL     = 'qwen-3-235b-a22b-instruct-2507';
const RECENT_EVENT_TTL_MS  = 6 * 60 * 1000;   // drop events older than ~6 min from render
const REPLY_ATTRIBUTION_MS = 60 * 1000;       // bot say attributed to person if they spoke within 60s
const MAX_EXCHANGES        = 6;
// Bug 13 + Phase D (Step 2.5+, 2026-05-12): raised 24 → 60. Per the
// /AI/drafts/2026-05-12-memory-rot-analysis.md survey, the 24-cap fills in
// 9–14 minutes at the brain's ~5s decision cadence with frequent failures,
// turning failed_attempts into a sliding 10-minute window rather than a
// memory. 60 widens the window to ~30 minutes (one full crafting attempt
// cycle), so restart N can see what restart N-1 actually tried.
const MAX_FAILED           = 60;
const MAX_LEARNED          = 30;
const MAX_ANCHORS          = 24;
const MAX_COMMITMENTS      = 8;
const RENDER_RECENT        = 8;
const RENDER_EXCHANGES     = 2;
const RENDER_ANCHORS       = 8;
const RENDER_LEARNED       = 8;
const RENDER_FAILED        = 20;       // Bug 13: was hard-coded to 4 — show recent failures so the LLM sees its full failure window, not just the last handful
const RENDER_COMMITMENTS   = 4;
const SAY_EXCERPT          = 80;
// Bug 9: filter facts written more than this far from current position when
// rendering the context block. Recipe-style facts (no spatial dependence) are
// preserved by the regex below; movement/dig-style facts get filtered.
const STALE_FACT_DISTANCE  = 24;
// Recipe / inventory / item-knowledge facts are position-independent — never
// filter them by distance. Pattern uses substring matching (no \b) because
// "_" is a word char in JS regex, so "crafting_table" or "planks" wouldn't
// match boundary-anchored alternatives like \bplank\b.
const POSITION_INDEPENDENT_FACT_RE = /(?:recipe|craft|smelt|fuel|ingredient|plank|stick|pickaxe|sword|shovel|hoe|furnace|table|edible|food|eat|cook|tool|item|inventory|chest|bow|arrow|bucket|fish_rod|fishing|seed|sapling|planted|growth|farmland|wheat|carrot|potato|melon|pumpkin|sugar_cane|kelp|honey|beetroot|chorus|enchant|potion|brew|lapis|redstone|emerald|diamond|gold|iron|copper|coal|stone_pickaxe|wooden_pickaxe|iron_pickaxe)/i;

const COMPRESS_SYSTEM = `You compress a Minecraft player's recent memory.
Given a list of timestamped events, return a SINGLE short sentence in first person, present-or-past tense, that preserves: what was done, key locations or coords, key encounters with other players or mobs, what was learned. Omit filler. No quotes, no list, just one sentence under 220 characters.`;

// F5: dedup proximity-style events that arrive every 2s for the same mob+coord.
// Within this window, the prior matching event's `ts` and `count` are bumped
// rather than pushing a duplicate row.
const EVENT_DEDUPE_WINDOW_MS = 30_000;

// F4: after this many consecutive compression-LLM failures, stop appending
// the placeholder string to earlier_session_summary — set it to a single
// short marker once and drop oldest events without summarising. Reset on
// the first successful summary.
const COMPRESSION_FAILURE_LIMIT = 3;
const COMPRESSION_OFFLINE_MARKER = '[memory compression unavailable]';

// F15: keep only the last N successful summaries instead of an unbounded
// concat capped by truncate(600). Render is `;` joined.
const SUMMARY_SEGMENT_KEEP = 5;

// paraphrase detection — Jaccard threshold above which two strings are treated as duplicates.
// Split into LEARNED / FAILED tracks per the 2026-05-12 fleet run observation
// that a shared 0.40 ate legitimate distinct learned facts down to 0-1 entries
// on two of eight bots while still leaving failed_attempts denser. Keep LEARNED
// at the prior 0.55 (strict — only fold true paraphrases) and use the tighter
// 0.40 only for FAILED, where near-duplicate failure wordings ("place_block
// crafting_table no_valid_surface" vs "couldn't place crafting_table, no
// surface") share many salient tokens and we want them collapsed. Goal stays
// at 0.6 — goal stickiness vs churn is a separate tradeoff.
const GOAL_PARAPHRASE_THRESHOLD = 0.6;
const FACT_PARAPHRASE_THRESHOLD = 0.55;
const FAILED_PARAPHRASE_THRESHOLD = 0.40;

export function memoryTokens(text) {
  if (!text) return new Set();
  const out = new Set();
  for (const t of String(text).toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length < 3) continue;
    out.add(t);
    // crude singular-stem so "logs" and "log" count as the same token
    if (t.length > 3 && t.endsWith('s')) out.add(t.slice(0, -1));
  }
  return out;
}

export function jaccardSimilarity(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function isParaphraseOfAny(text, list, threshold) {
  const toks = memoryTokens(text);
  for (const entry of list) {
    const existing = typeof entry === 'string' ? entry : entry?.text;
    if (!existing) continue;
    if (existing === text) return true;
    if (jaccardSimilarity(toks, memoryTokens(existing)) >= threshold) return true;
  }
  return false;
}

// Stop words that should NOT count as topic-defining tokens — common English
// fillers, verbs, adjectives, and the polarity words used by the contradiction
// detector itself. Kept short so domain nouns (item/skill names, materials)
// pass through.
const SALIENT_STOPWORDS = new Set([
  'this', 'that', 'with', 'using', 'have', 'when', 'from', 'plenty', 'enable',
  'enables', 'inventory', 'place', 'places', 'placed', 'placement', 'craft',
  'crafted', 'crafting', 'failed', 'fails', 'works', 'work', 'working',
  'reliable', 'cannot', 'valid', 'invalid', 'need', 'needs', 'needed',
  'requires', 'required', 'missing', 'broken', 'safe', 'unsafe', 'wrong',
  'cant', 'wont', 'doesnt', 'isnt', 'inside', 'into', 'onto', 'upon',
  'before', 'after', 'above', 'below', 'their', 'there', 'these', 'those',
  'they', 'them', 'than', 'then', 'because', 'while', 'still', 'also',
  'just', 'only', 'some', 'most', 'much', 'like', 'will', 'would', 'should',
  'could', 'might', 'must', 'about', 'every', 'each', 'here', 'where',
  'something', 'anything', 'nothing', 'enough', 'around', 'first', 'still',
]);

function salientTokens(text) {
  if (!text) return new Set();
  const out = new Set();
  // Split on chars OTHER than letters/digits/underscore so compound IDs like
  // "crafting_table" stay together as a single token (the LLM and Minecraft
  // both treat these as atomic identifiers).
  for (const t of String(text).toLowerCase().split(/[^a-z0-9_]+/)) {
    if (t.length < 4) continue;
    if (SALIENT_STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// PlayerMemory
// ---------------------------------------------------------------------------
export class PlayerMemory {
  constructor(botId, opts = {}) {
    this._botId      = botId;
    this._persona    = opts.persona ?? `${botId}, a curious survivor on a fresh Minecraft server`;
    this._dataDir    = opts.dataDir ?? config.dataDir;
    this._filePath   = path.join(this._dataDir, 'memory', `${botId}.json`);
    this._client     = opts.llmClient ?? null;   // lazy-init on first compression
    this._log        = opts.log ?? ((msg) => console.log(`[memory:${botId}] ${msg}`));

    this._state          = freshState(this._persona);
    this._persistTimer   = null;
    this._compressing    = false;
    this._stopped        = false;
    // F4: count consecutive compression-LLM failures
    this._compressionFailures = 0;
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------
  async load() {
    try {
      const raw = await fsp.readFile(this._filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this._state = mergeState(this._state, parsed);
        // session_started_at marks current run, not lifetime
        this._state.session_started_at = Date.now();
        this._log(`loaded memory: ${this._state.anchors.length} anchors, ${this._state.learned.length} facts, ${Object.keys(this._state.people).length} people`);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this._log(`load failed (${err.message}), starting fresh`);
      }
      this._state.session_started_at = Date.now();
    }
  }

  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    // synchronous flush so a process exit after stop() never loses the latest state
    try {
      this._writeSync();
    } catch (err) {
      this._log(`stop flush failed: ${err.message}`);
    }
  }

  setPersona(text) {
    if (!text || text === this._state.persona) return;
    this._state.persona = String(text);
    this._schedulePersist();
  }

  // -------------------------------------------------------------------------
  // event subscription — fed by the brain-event EventEmitter
  // -------------------------------------------------------------------------
  handleEvent(evt) {
    if (!evt || !evt.type) return;
    const ts       = evt.ts ?? Date.now();
    const location = evt.location ?? null;

    switch (evt.type) {
      case 'chat_in':         return this._onChatIn(evt.data ?? {}, ts, location);
      case 'decision':        return this._onDecision(evt.data ?? {}, ts, location);
      case 'skill_done':      return this._onSkillDone(evt.data ?? {}, ts, location);
      case 'skill_cancelled': return this._onSkillCancelled(evt.data ?? {}, ts);
      case 'damage':          return this._onDamage(evt.data ?? {}, ts, location);
      case 'death':           return this._onDeath(evt.data ?? {}, ts, location);
      case 'hostile_near':    return this._onHostile(evt.data ?? {}, ts, location);
      default:                return;
    }
  }

  _onChatIn({ from, text }, ts, location) {
    if (!from || !text) return;
    const person = this._person(from);
    person.last_seen = ts;
    pushBounded(person.exchanges, { from: 'them', text: String(text), ts }, MAX_EXCHANGES);
    this._pushEvent({
      type: 'chat',
      summary: `${from}: "${excerpt(text)}"`,
      ts,
      location,
    });
  }

  _onDecision({ say, action, reason }, ts, _location) {
    if (say) {
      // attribute to most-recent chatter within REPLY_ATTRIBUTION_MS
      const partner = this._recentChatter(ts);
      if (partner) {
        const person = this._person(partner);
        pushBounded(person.exchanges, { from: 'me', text: String(say), ts }, MAX_EXCHANGES);
      }
    }
    if (action?.type) {
      this._pushEvent({
        type: 'decide',
        summary: `decided ${action.type}${action.args ? `(${compactArgs(action.args)})` : ''}${reason ? ` [${reason}]` : ''}`,
        ts,
      });
    }
  }

  _onSkillDone({ skill, args, outcome, durationMs }, ts, location) {
    const dur = durationMs ? `${Math.round(durationMs/1000)}s` : '';
    // F8 (Test7): error was truncated to 60 chars, so the brain saw
    // "failed: no oak_planks in inventory — craft wooden_pickaxe first (3 pla…"
    // and missed the actionable suffix. 240 chars fits the longest skill error
    // we emit (the craft "server reported success but item never landed..." line).
    const tail = outcome?.ok
      ? `ok${outcome.collected != null ? ` (${outcome.collected})` : ''}${outcome.crafted ? ` (${outcome.crafted})` : ''}${outcome.killed ? ' killed' : ''}${outcome.ate ? ` ate ${outcome.ate}` : ''}`
      : `failed: ${truncate(outcome?.error ?? 'unknown', 240)}`;
    this._pushEvent({
      type: outcome?.ok ? 'did' : 'tried',
      summary: `${skill}${args ? `(${compactArgs(args)})` : ''} → ${tail}${dur ? ` after ${dur}` : ''}`,
      ts,
      location,
    });
  }

  _onSkillCancelled({ skill, reason }, ts) {
    this._pushEvent({
      type: 'cancel',
      summary: `cancelled ${skill}${reason ? ` (${reason})` : ''}`,
      ts,
    });
  }

  _onDamage({ hp }, ts, location) {
    this._pushEvent({
      type: 'hurt',
      summary: `took damage, hp=${hp ?? '?'}`,
      ts,
      location,
    });
  }

  _onDeath(_data, ts, location) {
    this._pushEvent({
      type: 'died',
      summary: 'died',
      ts,
      location,
    });
  }

  _onHostile({ entity, distance }, ts, location) {
    this._pushEvent({
      type: 'spotted',
      summary: `${entity} ~${distance}m`,
      ts,
      location,
    });
  }

  // -------------------------------------------------------------------------
  // LLM-issued mutations — called from brain after parsing the JSON response
  // -------------------------------------------------------------------------
  applyUpdate(update, ctx = {}) {
    if (!update || typeof update !== 'object') return;
    let touched = false;

    if (typeof update.set_goal === 'string' && update.set_goal.trim()) {
      const next = update.set_goal.trim();
      if (next !== this._state.current_goal) {
        // reject paraphrases of the current goal — keep stickiness so the bot
        // doesn't churn the goal on every turn while pursuing the same objective
        const cur = this._state.current_goal;
        const sim = cur ? jaccardSimilarity(memoryTokens(cur), memoryTokens(next)) : 0;
        if (!cur || sim < GOAL_PARAPHRASE_THRESHOLD) {
          if (cur) this._state.parent_goal = cur;
          this._state.current_goal = next;
          touched = true;
        }
      }
    }

    if (typeof update.set_parent_goal === 'string' && update.set_parent_goal.trim()) {
      const next = update.set_parent_goal.trim();
      if (next !== this._state.parent_goal) {
        this._state.parent_goal = next;
        touched = true;
      }
    }

    if (update.add_anchor && typeof update.add_anchor === 'object') {
      const a = update.add_anchor;
      const pos = ctx.position;
      if (a.name && pos && Number.isFinite(pos.x) && Number.isFinite(pos.z)) {
        const anchor = {
          name: String(a.name).slice(0, 40),
          note: String(a.note ?? '').slice(0, 120),
          x: Math.round(pos.x),
          y: Math.round(pos.y ?? 64),
          z: Math.round(pos.z),
          ts: Date.now(),
        };
        const idx = this._state.anchors.findIndex((x) => x.name === anchor.name);
        if (idx >= 0) this._state.anchors[idx] = anchor;
        else           this._state.anchors.push(anchor);
        if (this._state.anchors.length > MAX_ANCHORS) {
          this._state.anchors.splice(0, this._state.anchors.length - MAX_ANCHORS);
        }
        touched = true;
      }
    }

    if (typeof update.add_learned === 'string' && update.add_learned.trim()) {
      const text = update.add_learned.trim().slice(0, 200);
      if (!isParaphraseOfAny(text, this._state.learned, FACT_PARAPHRASE_THRESHOLD)) {
        // Bug 9: tag every learned fact with the position where it was
        // written. Stale spatial facts can then be filtered when rendering
        // context far from where they were discovered.
        const pos = ctx.position;
        const fact = { text, ts: Date.now() };
        if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.z)) {
          fact.x = Math.round(pos.x);
          fact.y = Math.round(pos.y ?? 64);
          fact.z = Math.round(pos.z);
        }
        // Bug 5: contradiction detection — if the new fact records a
        // failure or "cannot do X", scan existing learned facts for the
        // inverse claim and prune them. Prevents recipe hallucinations
        // from persisting after the LLM itself has discovered they fail.
        this._pruneContradictoryLearned(text);
        this._state.learned.push(fact);
        if (this._state.learned.length > MAX_LEARNED) {
          this._state.learned.splice(0, this._state.learned.length - MAX_LEARNED);
        }
        touched = true;
      }
    }

    if (typeof update.add_failed === 'string' && update.add_failed.trim()) {
      const text = update.add_failed.trim().slice(0, 200);
      const recent = this._state.failed_attempts.slice(-MAX_FAILED);
      if (!isParaphraseOfAny(text, recent, FAILED_PARAPHRASE_THRESHOLD)) {
        const pos = ctx.position;
        const fail = { text, ts: Date.now() };
        if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.z)) {
          fail.x = Math.round(pos.x);
          fail.y = Math.round(pos.y ?? 64);
          fail.z = Math.round(pos.z);
        }
        // Bug 5: when a failure is recorded, scan learned facts for
        // contradicting beliefs and remove them. Specifically catches
        // "X works using Y" / "Y can do X" patterns when we just logged
        // "X failed because Y is wrong".
        this._pruneContradictoryLearned(text);
        this._state.failed_attempts.push(fail);
        if (this._state.failed_attempts.length > MAX_FAILED) {
          this._state.failed_attempts.splice(0, this._state.failed_attempts.length - MAX_FAILED);
        }
        touched = true;
      }
    }

    if (update.add_commitment && typeof update.add_commitment === 'object') {
      const { person: who, text } = update.add_commitment;
      if (who && text && typeof who === 'string' && typeof text === 'string') {
        const person = this._person(who);
        const cText = text.trim().slice(0, 160);
        if (!person.commitments.some((c) => c.text === cText && !c.fulfilled)) {
          person.commitments.push({ text: cText, ts: Date.now(), fulfilled: false });
          if (person.commitments.length > MAX_COMMITMENTS) {
            person.commitments.splice(0, person.commitments.length - MAX_COMMITMENTS);
          }
          touched = true;
        }
      }
    }

    if (touched) this._schedulePersist();
  }

  // -------------------------------------------------------------------------
  // context block — prepended to every LLM observation
  // -------------------------------------------------------------------------
  contextBlock() {
    const s = this._state;
    const now = Date.now();
    const lines = [];

    lines.push(`WHO I AM: ${s.persona}`);

    if (s.current_goal) {
      const because = s.parent_goal ? ` (because: ${s.parent_goal})` : '';
      lines.push(`WHAT I'M TRYING TO DO: ${s.current_goal}${because}`);
    } else {
      lines.push(`WHAT I'M TRYING TO DO: (not decided yet — set this with memory_update.set_goal)`);
    }

    const events = renderEvents(s, now);
    if (events.length) {
      lines.push('RECENT MEMORY:');
      for (const e of events) lines.push(`  - ${e}`);
    }

    if (s.anchors.length) {
      lines.push('PLACES I KNOW:');
      const anchors = s.anchors.slice(-RENDER_ANCHORS);
      for (const a of anchors) {
        const note = a.note ? ` "${a.note}"` : '';
        lines.push(`  - ${a.name}: (${a.x}, ${a.y}, ${a.z})${note}`);
      }
    }

    const peopleLines = renderPeople(s, now);
    if (peopleLines.length) {
      lines.push("PEOPLE I'VE MET:");
      for (const p of peopleLines) lines.push(`  - ${p}`);
    }

    // Bug 6: render failed_attempts BEFORE learned facts so failure history
    // anchors the LLM's reading of context. Previous order let wrong "learned"
    // beliefs (e.g. "crafting_table from cobblestone") override correct
    // failure diagnoses that were pushed off the visible window.
    if (s.failed_attempts.length) {
      lines.push("WHAT I'VE TRIED THAT DIDN'T WORK (read this first — don't repeat these):");
      const fails = s.failed_attempts.slice(-RENDER_FAILED);
      for (const f of fails) lines.push(`  - ${f.text}`);
    }

    if (s.learned.length) {
      // Bug 9: filter spatial facts whose origin is far from current position.
      // Position-independent facts (recipes, item knowledge) are preserved.
      const here = this._lastRenderPosition;
      const isStale = (f) => {
        if (!here || !f || f.x == null || f.y == null || f.z == null) return false;
        if (POSITION_INDEPENDENT_FACT_RE.test(f.text)) return false;
        const dx = f.x - here.x, dy = f.y - here.y, dz = f.z - here.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz) > STALE_FACT_DISTANCE;
      };
      const learnedFiltered = s.learned.filter((f) => !isStale(f)).slice(-RENDER_LEARNED);
      if (learnedFiltered.length) {
        lines.push("THINGS I'VE LEARNED:");
        for (const f of learnedFiltered) lines.push(`  - ${f.text}`);
      }
    }

    const lastDid = lastSkillEvent(s);
    if (lastDid) {
      lines.push(`WHAT I JUST DID: ${lastDid.summary}`);
    }

    return lines.join('\n');
  }

  // Bug 9: brain calls this with the current bot position right before
  // building each context block, so spatial filtering can use up-to-date
  // coordinates without changing the public contextBlock() signature.
  setRenderPosition(pos) {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) {
      this._lastRenderPosition = null;
      return;
    }
    this._lastRenderPosition = { x: pos.x, y: pos.y ?? 64, z: pos.z };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  // Bug 5: prune learned facts that contradict a newly observed failure or
  // negative fact. The big real-world case (Test5 obs-04) was the LLM writing
  // "Can craft a crafting_table using 4 cobblestone" while simultaneously
  // logging the failure "craft crafting_table missing 4× any plank". After
  // this prune fires, the wrong belief is removed and won't re-poison
  // future context blocks.
  //
  // Heuristic: opposite polarity (positive vs negative verbs) + at least 2
  // shared "salient" tokens (item-like words: 4+ chars, not in stoplist).
  // Compound IDs like "crafting_table" survive as a single token because we
  // split on chars OTHER than [a-z0-9_].
  //
  // OVN-011: require N=2 contradictions before pruning. The prior single-
  // contradiction policy was throwing away useful heuristics like
  // "jump_loop can be broken by switching to goto_item or pillar_up" the
  // first time the LLM logged a related failure. Two contradictions is the
  // sweet spot — bounded keep-around for wrong beliefs (~10 minutes of
  // activity) but enough resilience for legitimate rules-of-thumb.
  _pruneContradictoryLearned(newText) {
    if (!newText || !this._state.learned.length) return;
    const POSITIVE = /\b(?:can|works|reliable|use|using|place|placed|plenty|enables?|substitute|substitut\w*)\b/i;
    const NEGATIVE = /\b(?:cannot|can'?t|won'?t|fail|failed|fails|impossible|missing|need(?:s|ed)?|requires?|invalid|wrong|not\s+a\s+valid|isn'?t|doesn'?t|broken|unsafe)\b/i;
    const newIsNegative = NEGATIVE.test(newText);
    const newIsPositive = POSITIVE.test(newText) && !newIsNegative;
    if (!newIsNegative && !newIsPositive) return;
    const newSalient = salientTokens(newText);
    if (newSalient.size < 1) return;

    const PRUNE_AFTER_CONTRADICTIONS = 2;
    const survivors = [];
    let pruned = 0;
    for (const fact of this._state.learned) {
      const factText = fact?.text;
      if (!factText) { survivors.push(fact); continue; }
      const factIsNegative = NEGATIVE.test(factText);
      const factIsPositive = POSITIVE.test(factText) && !factIsNegative;
      const oppositePolarity = (newIsNegative && factIsPositive) || (newIsPositive && factIsNegative);
      if (!oppositePolarity) { survivors.push(fact); continue; }
      const factSalient = salientTokens(factText);
      let shared = 0;
      for (const t of newSalient) if (factSalient.has(t)) shared++;
      // 2+ shared salient nouns is a strong "same topic" signal — bump the
      // contradiction counter. Prune only when the counter crosses the
      // threshold; otherwise keep the fact and remember the contradiction.
      if (shared >= 2) {
        const prior = fact.contradictionCount ?? 0;
        const next = prior + 1;
        if (next >= PRUNE_AFTER_CONTRADICTIONS) {
          pruned++;
          this._log(`pruned contradictory learned fact: "${factText}" (shared salient: ${shared}, contradictions: ${next})`);
          continue;
        }
        // Keep the fact but stamp the strike against it so the next
        // contradiction prunes for real.
        survivors.push({ ...fact, contradictionCount: next });
        continue;
      }
      survivors.push(fact);
    }
    if (pruned > 0 || survivors.some((f, i) => f !== this._state.learned[i])) {
      this._state.learned = survivors;
    }
  }

  _person(name) {
    const key = String(name);
    if (!this._state.people[key]) {
      this._state.people[key] = { last_seen: 0, exchanges: [], commitments: [] };
    }
    return this._state.people[key];
  }

  // returns the most recent thing this person said TO the bot, or null
  latestIncomingChat(name) {
    const p = this._state.people?.[name];
    if (!p) return null;
    for (let i = p.exchanges.length - 1; i >= 0; i--) {
      if (p.exchanges[i].from === 'them') return p.exchanges[i];
    }
    return null;
  }

  _recentChatter(now) {
    let best = null, bestTs = 0;
    for (const [name, p] of Object.entries(this._state.people)) {
      if (p.last_seen > bestTs && (now - p.last_seen) <= REPLY_ATTRIBUTION_MS) {
        bestTs = p.last_seen;
        best = name;
      }
    }
    return best;
  }

  _pushEvent(evt) {
    // F14: TTL sweep — drop events older than RECENT_EVENT_TTL_MS on every push.
    // The render-time filter already hides them but they still cost disk +
    // count toward COMPRESS_THRESHOLD. Sweeping here keeps the buffer tight.
    const ttlCutoff = Date.now() - RECENT_EVENT_TTL_MS;
    if (this._state.recent_events.length > 0 && this._state.recent_events[0].ts < ttlCutoff) {
      this._state.recent_events = this._state.recent_events.filter((e) => e.ts >= ttlCutoff);
    }

    // F5: coalesce identical proximity-style events. If the most recent event
    // matches type + summary + (rounded) location and is within the dedupe
    // window, just bump the existing entry's ts + count.
    const last = this._state.recent_events[this._state.recent_events.length - 1];
    if (last && eventsCoalesce(last, evt)) {
      last.ts = evt.ts;
      last.count = (last.count ?? 1) + 1;
      this._schedulePersist();
      return;
    }

    this._state.recent_events.push(evt);
    this._schedulePersist();
    if (this._state.recent_events.length > COMPRESS_THRESHOLD) {
      this._compressOldEvents();   // fire-and-forget
    }
  }

  _schedulePersist() {
    if (this._stopped) return;
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._writeAsync().catch((err) => this._log(`persist failed: ${err.message}`));
    }, PERSIST_DEBOUNCE_MS);
    this._persistTimer.unref?.();
  }

  async _writeAsync() {
    await fsp.mkdir(path.dirname(this._filePath), { recursive: true });
    const tmp = `${this._filePath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this._state, null, 2), 'utf-8');
    await fsp.rename(tmp, this._filePath);
  }

  _writeSync() {
    fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
    const tmp = `${this._filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this._state, null, 2), 'utf-8');
    fs.renameSync(tmp, this._filePath);
  }

  async _compressOldEvents() {
    if (this._compressing) return;
    if (this._state.recent_events.length <= COMPRESS_THRESHOLD) return;
    this._compressing = true;
    const oldest = this._state.recent_events.slice(0, COMPRESS_TARGET);
    try {
      const summary = await this._summarize(oldest);
      // F4: success — clear failure streak and append a real segment.
      this._compressionFailures = 0;
      // F15: bound the summary to the last N segments instead of one big string.
      this._state.earlier_session_summary = appendSummarySegment(this._state.earlier_session_summary, summary);
      this._state.recent_events.splice(0, COMPRESS_TARGET);
      this._schedulePersist();
    } catch (err) {
      this._compressionFailures += 1;
      this._log(`compression failed (${this._compressionFailures} in a row): ${err.message}`);
      // F4: stop appending the placeholder string after a few failures.
      // First few failures: drop the events silently; preserve the last
      // genuine summary instead of poisoning it. After the limit, set the
      // single offline marker (only if not already set) and continue dropping.
      if (this._compressionFailures >= COMPRESSION_FAILURE_LIMIT) {
        const cur = this._state.earlier_session_summary;
        if (!cur || !String(cur).includes(COMPRESSION_OFFLINE_MARKER)) {
          this._state.earlier_session_summary = COMPRESSION_OFFLINE_MARKER;
        }
      }
      this._state.recent_events.splice(0, COMPRESS_TARGET);
      this._schedulePersist();
    } finally {
      this._compressing = false;
    }
  }

  async _summarize(events) {
    const client = this._ensureClient();
    if (!client) throw new Error('no Cerebras key — cannot compress');
    const lines = events.map((e) => {
      const loc = e.location ? ` @ (${e.location.x},${e.location.z})` : '';
      const ago = relTime(Date.now() - e.ts);
      return `[${ago}] ${e.type}: ${e.summary}${loc}`;
    }).join('\n');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), COMPRESS_TIMEOUT_MS);
    try {
      const res = await client.chat.completions.create({
        model:       USE_LOCAL_LLM ? LOCAL_LLM_MODEL : CEREBRAS_MODEL,
        messages:    [
          { role: 'system', content: COMPRESS_SYSTEM },
          { role: 'user',   content: `Events:\n${lines}\n\nOne-sentence summary:` },
        ],
        max_tokens:  120,
        temperature: 0.4,
        top_p:       0.8,
      }, { signal: ctrl.signal });
      const out = res.choices[0]?.message?.content?.trim() ?? '';
      return truncate(out.replace(/\s+/g, ' '), 220) || `${events.length} earlier events`;
    } finally {
      clearTimeout(timer);
    }
  }

  _ensureClient() {
    if (this._client) return this._client;
    if (USE_LOCAL_LLM) {
      this._client = new OpenAI({ apiKey: 'ollama', baseURL: LOCAL_LLM_BASE_URL });
      return this._client;
    }
    const apiKey = config.cerebrasApiKey || settingsStore.get('cerebrasApiKey');
    if (!apiKey) return null;
    this._client = new OpenAI({ apiKey, baseURL: 'https://api.cerebras.ai/v1' });
    return this._client;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function freshState(persona) {
  return {
    schemaVersion:           SCHEMA_VERSION,
    persona,
    current_goal:            null,
    parent_goal:             null,
    anchors:                 [],
    learned:                 [],
    failed_attempts:         [],
    people:                  {},
    recent_events:           [],
    earlier_session_summary: null,
    session_started_at:      Date.now(),
  };
}

function mergeState(base, loaded) {
  const out = { ...base };
  for (const k of Object.keys(base)) {
    if (loaded[k] !== undefined) out[k] = loaded[k];
  }
  // defensive: ensure expected shapes
  if (!Array.isArray(out.anchors))         out.anchors = [];
  if (!Array.isArray(out.learned))         out.learned = [];
  if (!Array.isArray(out.failed_attempts)) out.failed_attempts = [];
  if (!Array.isArray(out.recent_events))   out.recent_events = [];
  if (!out.people || typeof out.people !== 'object') out.people = {};
  return out;
}

function pushBounded(arr, item, max) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

// F5: do two events represent the same observation that arrived twice?
// Match on type + summary + rounded location, within EVENT_DEDUPE_WINDOW_MS.
function eventsCoalesce(prev, next) {
  if (!prev || !next) return false;
  if (prev.type !== next.type) return false;
  if (prev.summary !== next.summary) return false;
  if ((next.ts ?? 0) - (prev.ts ?? 0) > EVENT_DEDUPE_WINDOW_MS) return false;
  const a = prev.location, b = next.location;
  if (!a && !b) return true;
  if (!a || !b) return false;
  // round to 1 block — proximity events sample positions slightly differently
  return Math.round(a.x) === Math.round(b.x)
      && Math.round(a.z) === Math.round(b.z);
}

// F15: bounded summary segments — split on `;` so the renderer always shows
// at most SUMMARY_SEGMENT_KEEP recent compressions, joined by `; `.
function appendSummarySegment(prev, segment) {
  const cleaned = String(segment || '').trim();
  if (!cleaned) return prev || null;
  // strip the offline marker if present once we have a real segment
  const baseRaw = prev && prev !== COMPRESSION_OFFLINE_MARKER ? String(prev) : '';
  const base = baseRaw
    .split(/\s*;\s*/)
    .filter((s) => s && s !== COMPRESSION_OFFLINE_MARKER);
  base.push(cleaned);
  while (base.length > SUMMARY_SEGMENT_KEEP) base.shift();
  return base.join('; ');
}

function excerpt(text) {
  return truncate(String(text).replace(/\s+/g, ' '), SAY_EXCERPT);
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function compactArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    if (v == null) continue;
    parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
    if (parts.length >= 3) break;
  }
  return parts.join(',');
}

function relTime(deltaMs) {
  if (deltaMs < 1000) return 'just now';
  const s = Math.round(deltaMs / 1000);
  if (s < 60)   return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60)   return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function renderEvents(state, now) {
  const out = [];
  if (state.earlier_session_summary) {
    out.push(`earlier this session: ${state.earlier_session_summary}`);
  }
  const recent = state.recent_events
    .filter((e) => (now - e.ts) <= RECENT_EVENT_TTL_MS)
    .slice(-RENDER_RECENT);
  for (const e of recent) {
    const loc = e.location ? ` @ (${e.location.x},${e.location.z})` : '';
    // F5: surface the dedup count so the LLM sees "spotted creeper × 8" as
    // one line rather than the count getting lost in the coalesce.
    const count = (e.count && e.count > 1) ? ` × ${e.count}` : '';
    out.push(`${relTime(now - e.ts)} — ${e.summary}${count}${loc}`);
  }
  return out;
}

function renderPeople(state, now) {
  const lines = [];
  const sorted = Object.entries(state.people)
    .sort((a, b) => (b[1].last_seen ?? 0) - (a[1].last_seen ?? 0))
    .slice(0, 5);
  for (const [name, p] of sorted) {
    const ex = p.exchanges.slice(-RENDER_EXCHANGES);
    const exStr = ex.map((m) => `${m.from === 'me' ? 'I said' : 'they said'} "${excerpt(m.text)}"`).join('; ');
    const seen = p.last_seen ? `last seen ${relTime(now - p.last_seen)}` : 'never spoken';
    const open = p.commitments.filter((c) => !c.fulfilled).slice(-RENDER_COMMITMENTS);
    const promises = open.length ? `; I owe them: ${open.map((c) => c.text).join('; ')}` : '';
    lines.push(`${name} (${seen})${exStr ? ` — ${exStr}` : ''}${promises}`);
  }
  return lines;
}

function lastSkillEvent(state) {
  for (let i = state.recent_events.length - 1; i >= 0; i--) {
    const e = state.recent_events[i];
    if (e.type === 'did' || e.type === 'tried' || e.type === 'cancel') return e;
  }
  return null;
}
