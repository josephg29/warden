import OpenAI from 'openai';
import pathfinderPkg from 'mineflayer-pathfinder';
import minecraftData from 'minecraft-data';
import vec3Pkg from 'vec3';
import { config } from '../config.js';
import { settingsStore } from '../settings-store.js';
import { safeError } from '../safe-error.js';
import { brainDebug } from '../logger.js';

const { pathfinder, Movements, goals } = pathfinderPkg;
// vec3 is a CJS module exporting a factory function; .Vec3 is the class.
// We need this so coords created locally have .floored() etc. that
// mineflayer-pathfinder calls internally (otherwise GoalLookAtBlock crashes).
const Vec3 = vec3Pkg.Vec3 ?? vec3Pkg.default?.Vec3 ?? vec3Pkg;

function resolveCerebrasKey() {
  return config.cerebrasApiKey || settingsStore.get('cerebrasApiKey') || null;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const MIN_THINK_GAP_MS = 1500;   // floor between LLM calls — protects rate limit
const IDLE_RETHINK_MS  = 20000;  // safety: re-think if nothing else triggers it
const HOSTILE_RADIUS   = 10;
const HOSTILE_POLL_MS  = 2000;
const HOSTILE_TYPES = new Set([
  'zombie','skeleton','creeper','spider','witch','enderman',
  'husk','drowned','phantom','pillager','vindicator','zombie_villager',
]);

// no-op skills don't trigger immediate re-think on completion — we let the idle
// timer pace the next decision, otherwise the brain spam-thinks every 1.5s
const NO_OP_SKILLS = new Set(['wait', 'chat_only', 'stop']);

// while one of these is running, hostile_near should NOT re-trigger a think —
// the bot is already moving (presumably toward safety) and re-thinking just
// cancels the path mid-flight, leaving it stuck in place near the threat
const MOVEMENT_OR_DEFENSE = new Set([
  'attack_nearest', 'flee',
  'goto_coord', 'goto_block', 'goto_item', 'follow_player',
]);

// per-skill failure cooldown — if a (skill+args) combo failed N+ times in
// the last window, the next attempt is auto-converted to a wait so the LLM
// is forced to re-strategise before retrying the same broken plan
const SKILL_FAIL_WINDOW_MS = 60000;
const SKILL_FAIL_THRESHOLD = 2;  // 2 prior fails ⇒ block 3rd attempt
// OVN-005/009: when the failure is fully deterministic (e.g. "no crafting_table
// in inventory" or "no oak_log within 32m"), the next attempt will fail for
// exactly the same reason. Block on the first failure rather than waiting for
// the threshold-2 confirmation — there's nothing transient about a missing item.
const SKILL_FAIL_THRESHOLD_EARLY = 1;

// OVN-018 (overnight Fix #1, 2026-05-09): _cancelCurrentSkill reasons that
// count toward _isBlockedSkill's failure cooldown. Without this, a skill that
// gets cancelled by jump_loop or death never increments the per-skill failure
// counter — so after 5 consecutive cancellations of collect_block(oak_log,32),
// _isBlockedSkill still returns null and the LLM re-picks the same broken
// combo every ~25s. 'superseded' / 'stop' are normal flow and excluded.
const SKILL_CANCEL_FAILURE_REASONS = new Set(['jump_loop', 'death']);

// OVN-006: when the same skill+args is picked rapidly enough to be debounced
// repeatedly inside this longer window, escalate to a failure-log entry so the
// next LLM prompt sees "DO NOT RETRY". Without this, the LLM keeps picking the
// same broken action turn after turn while debouncing absorbs each pick.
const DEBOUNCE_ESCALATION_WINDOW_MS = 60000;
const DEBOUNCE_ESCALATION_THRESHOLD = 3;

// throttle hostile-proximity rethinks — _checkHostiles polls every 2s, but
// re-thinking every 2s while the bot is fleeing/pathing creates a 30/min
// decision spam where the LLM repicks the same flee target each time
const HOSTILE_RETHINK_GAP_MS = 8000;

// if the LLM picks the same skill+args twice within this window, the second
// pick is converted to a wait — defends against rapid re-trigger loops where
// the same context produces the same decision before progress can land
const REPEAT_DECISION_WINDOW_MS = 4000;

// hard upper bound on a single skill — if it runs longer than this without
// resolving (e.g. pathfinder gets stuck), abort and re-think. Without this
// the brain can hang forever when a long-running skill never finishes.
const SKILL_WATCHDOG_MS = 45000;

// hard upper bound on a single LLM call — Test5 obs-07 (Bug 7) showed the
// brain freezing permanently when a Cerebras request never returned. With a
// timeout we abort and fall back to a wait so the loop can recover next tick.
const LLM_CALL_TIMEOUT_MS = 30000;

// Retry-with-jitter for transient LLM failures (timeout/abort, 429, 5xx,
// network). DeepSeek's direct API stalled past the 30s abort under sustained
// 5-bot load (forage C1 pilot, 2026-06-10); a single jittered retry catches a
// transient slow response before the brain falls back to `wait`. Worst-case
// stall is ATTEMPTS * timeout + backoff, kept under BRAIN_NO_DECISION_TIMEOUT_MS.
const LLM_RETRY_ATTEMPTS  = 2;    // total tries per decision (1 retry)
const LLM_RETRY_BASE_MS   = 400;  // backoff base, doubled each retry
const LLM_RETRY_JITTER_MS = 350;  // random 0..this added to each backoff

// brain-loop watchdog — if no _think cycle completes within this window the
// brain is wedged (LLM hang, never-resolving skill, etc). The watchdog clears
// in-flight state and re-enters the loop. Tuned generously so a slow chain of
// long skills doesn't trip it.
const BRAIN_WATCHDOG_MS = 120000;

// no-decision watchdog (Session B follow-up): when nothing fresh has been
// recorded in `lastDecision` for this long AND no future think is scheduled
// (no idle timer, no current skill, no pending think), force a recovery —
// regardless of `_thinking`. Catches cases where the LLM call hangs but the
// existing wedge timer hasn't tripped yet, and where _thinking is true but the
// in-flight think has stalled silently. Distinct from BRAIN_WATCHDOG_MS so the
// two thresholds tune independently.
const BRAIN_NO_DECISION_TIMEOUT_MS = 180_000;
// don't trip the no-decision watchdog within the first N ms after start —
// the very first think may legitimately take longer than this on a cold LLM
// connection, and there's no decision to compare against yet.
const BRAIN_COLD_START_GRACE_MS    = 60_000;

// LLM exponential backoff (F8) — when the API is unavailable, doubling waits
// avoid burning quota at MIN_THINK_GAP_MS pace. Reset to 0 on first success.
// Step 2.6 (2026-05-26): backoff gated to LLM_OFFLINE_CHAT_AFTER consecutive
// errors (transient single failures shouldn't sleep the brain) and curve
// re-stretched to 30s → 60s → 120s → 240s → 300s (cap). With the watchdog's
// brainStatus:'llm_backoff' guard, the longer cap no longer trips false
// stall recycles, and when the provider is truly down (e.g. Cerebras 402) the
// bot stops burning a 30s timeout every minute.
const LLM_BACKOFF_INITIAL_MS = 30_000;
const LLM_BACKOFF_MAX_MS     = 300_000;

// Local LLM swap. Set USE_LOCAL_LLM=1 to route both the OpenAI client + the
// model name to a local Ollama (or any OpenAI-compatible) endpoint instead of
// Cerebras. Default is OFF so existing flows are unchanged; flip via env var
// for fleet testing against a local 7B (slower decisions, no API quota).
const USE_LOCAL_LLM      = process.env.USE_LOCAL_LLM === '1';
const LOCAL_LLM_BASE_URL = process.env.LOCAL_LLM_BASE_URL ?? 'http://localhost:11434/v1';
const LOCAL_LLM_MODEL    = process.env.LOCAL_LLM_MODEL    ?? 'qwen2.5:7b';
const CEREBRAS_MODEL     = 'qwen-3-235b-a22b-instruct-2507';
const USE_OPENAI         = process.env.USE_OPENAI === '1';
const OPENAI_BASE_URL    = process.env.OPENAI_BASE_URL    ?? 'https://api.openai.com/v1';
const OPENAI_MODEL       = process.env.OPENAI_MODEL       ?? 'gpt-5-nano';
const USE_OPENROUTER     = process.env.USE_OPENROUTER === '1';
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
const OPENROUTER_MODEL   = process.env.OPENROUTER_MODEL   ?? 'qwen/qwen3-235b-a22b-2507';

// BUG-CEREBRAS-429: fleet-wide token bucket shared across all Brain instances
// in the same process. Caps aggregate Cerebras calls/s before per-bot backoff.
// Step 2.5 / Phase B (2026-05-11): raised 2 → 4 req/s.
// Step 2.6 (2026-05-16): raised 4 → 6 req/s. The 30h Step 2.5 overnight kept
// 8 productive bots and saturated the 4 r/s cap, cascading into per-bot
// exponential backoff that hit the (now-lowered) 60s cap. Telemetry will
// show whether 6 r/s holds; the bucket-wait>500ms log + post-bucket 429 log
// in _callLLM together distinguish bucket throttling from API rate-limit.
const FLEET_LLM_RATE     = 6;   // tokens per second (shared across all bots)
const FLEET_LLM_CAPACITY = 6;   // bucket depth — max burst before throttle engages
const _fleetBucket = {
  rate:       FLEET_LLM_RATE,
  capacity:   FLEET_LLM_CAPACITY,
  tokens:     FLEET_LLM_CAPACITY,
  lastRefill: Date.now(),
  _refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.lastRefill) * (this.rate / 1000));
    this.lastRefill = now;
  },
  async consume() {
    for (;;) {
      this._refill();
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      const waitMs = Math.ceil((1 - this.tokens) * (1000 / this.rate));
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  },
  _reset() { this.tokens = this.capacity; this.lastRefill = Date.now(); },
};

// after this many consecutive LLM errors, broadcast a single chat message so a
// human watching can see the bot is offline. Paraphrase-suppressed afterward.
const LLM_OFFLINE_CHAT_AFTER = 3;

// post-respawn (F6) — NaN-position is normal for a few seconds after a respawn
// while mineflayer waits for the entity packet. Don't trigger _onReconnect
// during this grace.
const POST_RESPAWN_GRACE_MS  = 5000;

// pending-think priority (F11) — higher number wins when multiple reasons are
// queued while _thinking is true. Reasons not in this map default to 0.
const REASON_PRIORITY = {
  damage:                 100,
  hostile:                 90,
  death:                   80,
  spawn_reflex:            70,
  chat:                    60,
  jump_loop_escaped:       50,
  brain_watchdog:          40,
  brain_watchdog_idle:     40,
  startup:                 30,
  skill_done:              20,
  idle:                    10,
};
function priorityOf(reason) {
  if (!reason) return 0;
  // reasons may be `${kind}:${detail}` (e.g. "hostile:zombie") — match prefix
  const colon = reason.indexOf(':');
  const head  = colon >= 0 ? reason.slice(0, colon) : reason;
  return REASON_PRIORITY[head] ?? REASON_PRIORITY[reason] ?? 0;
}

// spawn-kill-box reflex (F12) — within this many ms of a fresh spawn, if the
// bot has no inventory and ≥2 hostiles within this radius, force a hardcoded
// flee before any LLM turn is spent.
const SPAWN_REFLEX_WINDOW_MS = 5000;
const SPAWN_REFLEX_RADIUS    = 5;
const SPAWN_REFLEX_HOSTILES  = 2;

// safety reflex (F8) — if HP drops below this and no LLM is reachable, run a
// hardcoded flee (move 12 blocks away from the closest hostile) without the
// LLM. Doesn't fire if the LLM is healthy — the LLM should handle low-HP.
const LOW_HP_REFLEX_HP       = 10;
const LOW_HP_FLEE_DISTANCE   = 12;

// "haven't moved" detection — if the bot's position drifts less than this
// over the surface-window time below, surface a STATIONARY hint to the LLM
// so it stops re-picking the same dead-end action
const STATIONARY_RADIUS = 2;
const STATIONARY_WINDOW_MS = 90000;

// jump-in-place detection: count complete jump cycles (land→jump→land) where
// horizontal displacement is near zero. After the threshold, trigger escape.
const JUMP_LOOP_THRESHOLD = 6;
const JUMP_LOOP_VELOCITY_THRESHOLD = 0.08;

// BUG-001/003/012 hard-block layer (Session B, 2026-05-09).
// Soft anti-loop (failure log + paralysis override) repeatedly fails to break
// LLM fixation — the LLM sees the warning text and ignores it (Test31 obs).
// The hardblock layer escalates from "ask politely via prompt text" to
// "deterministically refuse the action and force a goal-pop."
const SIG_HARDBLOCK_THRESHOLD   = 3;             // fails before sig enters _blockedSigs
const SIG_HARDBLOCK_TTL_MS      = 5 * 60_000;    // sig stays banned for 5 min
// Step 2.6 anti-fixation (2026-05-16): after N hard-block events on the same
// sig within a 5-min window, push a STUCK FIXATION nudge into memory so the
// LLM is told (in plain text inside its next prompt) that the current goal is
// unreachable from here and to pick a fundamentally different objective.
const ANTI_FIXATION_THRESHOLD   = 5;
const ANTI_FIXATION_WINDOW_MS   = 5 * 60_000;

// BUG-023 (Path 2, 2026-05-18): goal-aging. When current_goal stays
// unchanged for GOAL_AGING_THRESHOLD think-ticks AND inventory size and
// position haven't moved, the brain pushes an add_failed annotation
// saying the goal is stalled. Path 2 compatible: info only, no override.
const GOAL_AGING_THRESHOLD     = 10;          // think-ticks
const GOAL_AGING_POS_THRESHOLD = 2;           // blocks of position drift before resetting
const GOAL_AGING_COOLDOWN      = 6;           // turns between repeat firings

// BUG-025 (Path 2, 2026-05-18): stash advisor. Fire the "place a chest"
// annotation at most every STASH_ADVISOR_COOLDOWN think ticks while
// progression-tier items remain unstashed. 20 = roughly once every ~3
// minutes of active thinking, frequent enough to remind but not spam.
const STASH_ADVISOR_COOLDOWN   = 20;
const COMPLETION_BLIND_THRESHOLD = 5;            // identical successes before BUG-003 trips
const GOAL_STALE_MS             = 5 * 60_000;    // current_goal age before BUG-003 fires
const OSCILLATION_MIN_LEN       = 4;             // last N decisions must form A-B-A-B
const HARDBLOCK_ENABLED         = true;          // kill switch: set false to short-circuit

// Step 2 (2026-05-10): brain-level stuck-loop EARLY break — interrupts the
// cycle BEFORE the supervisor-level stuck_loop detector (≥10 identical in 20)
// trips a slot recycle. The supervisor still runs as the backstop. Tuned
// lower so the brain has 4-5 turns to break the cycle in-memory before the
// supervisor pulls the plug at 10. Fires AFTER hardblock + oscillation +
// completion-blindness so those layers get first crack at the same data;
// composes with failure-cooldown by skipping when the latest ring entry has
// already been substituted to wait/look_around (so the two never overwrite
// each other).
const STUCK_LOOP_EARLY_THRESHOLD = 4;
const STUCK_LOOP_EARLY_WINDOW    = 8;

// Step 2: collect_block × jump_loop interaction. Per the 2026-05-10 fleet
// report (section 7), 21 jump_loops + 20 collect_block_failed dominated the
// failure log. After 2 jump_loop cancels of the same collect_block(X) within
// 60s, substitute a deterministic recovery skill (stand-still + look + nudge
// to current pos) instead of letting the LLM re-pick the same broken target.
// Composes with the OVN-018 SKILL_CANCEL_FAILURE_REASONS path: that path
// records the cancel as a generic failure (which the failure-cooldown sees);
// this layer adds a target-specific recovery on top.
const COLLECT_JUMP_RECOVER_THRESHOLD = 2;
const COLLECT_JUMP_RECOVER_WINDOW_MS = 60_000;

// Phase A4 (Step 2.5+, 2026-05-12): when a skill failure carries an explicit
// { recovery: { skill, args } } hint — currently emitted by use_block on the
// out_of_range path — the brain runs the recovery skill directly instead of
// surfacing the hint as text and letting the LLM decide. Capped at one
// consecutive auto-recovery (`_autoRecovering` flag) so a failing recovery
// hands control back to the LLM with both failures visible in memory rather
// than chaining into a recovery loop.
const AUTO_RECOVERY_ENABLED = true;          // kill switch: set false to short-circuit

// F2 (Test7) — entities that win against unarmed players: ranged shooters and
// the creeper (which one-shots unarmed players via explosion). attack_nearest
// refuses these without a sword/axe held; the brain is told to flee instead.
const UNARMED_DEATH_RISK = new Set([
  'skeleton', 'stray', 'wither_skeleton', 'witch',
  'creeper', 'ghast', 'pillager', 'evoker', 'phantom',
  'blaze', 'piglin', 'piglin_brute',
]);
const MELEE_WEAPON_RE = /_(?:sword|axe)$/;

// MC vanilla per-message limit is 256 chars; leave ~16 for the "<Test5> " prefix
// the server prepends. Anything longer is split mid-word into a second message.
const SAY_MAX_CHARS = 240;
// Suppress an outgoing chat message if the same wording (or a near-paraphrase)
// was sent within this window — the bot would otherwise spam identical lines
// during STATIONARY/loop states (Bug 10, Test5 obs-04).
const SAY_DEDUPE_WINDOW_MS = 60_000;
// Above this Jaccard token-overlap, two consecutive narrations are treated
// as duplicates even if not literal string matches.
const SAY_DEDUPE_PARAPHRASE = 0.55;

export const SYSTEM_PROMPT = `You are a player in a Minecraft survival world, playing alone on a fresh server.
Talk in chat the way a person would mutter to themselves while playing — short, first person, present tense.
Pick ONE skill at a time. The skill runs to completion (or until something changes) before you decide again.
Do not micromanage motor controls — pick a high-level skill and trust it.

You have memory between turns. The block at the top of each user message ("WHO I AM", "WHAT I'M TRYING TO DO", "RECENT MEMORY", "PLACES I KNOW", "PEOPLE I'VE MET", "THINGS I'VE LEARNED", "WHAT I'VE TRIED THAT DIDN'T WORK", "WHAT I JUST DID") is your continuity. Read it. Don't repeat what you already tried that failed. Don't re-introduce yourself to people you've already met.

Available skills (use exactly these names):

MOVEMENT
- goto_block       { "block": "<name>", "range": 32 }                                — pathfind to nearest matching block
- goto_coord       { "x": <int>, "z": <int>, "y": <int?> }                            — pathfind to coordinates
- goto_item        { "range": 32 }                                                    — walk to nearest dropped item entity (e.g. gear from a death) so it auto-picks up. Use this NOT goto_block/collect_block for items lying on the ground.
- follow_player    { "player": "<name>", "distance": 3, "duration": 30 }              — keep following a player at distance for N seconds
- jump             {}                                                                  — single jump (step up obstacle). Does NOT gain height — for climbing, use pillar_up.
- pillar_up        { "block": "<name>", "count": 1 }                                  — gain height by jumping and placing a block beneath you mid-air, repeated count times. Use this (NOT jump+place_block in sequence) to climb up cliffs or build a tower. Block must be in inventory; needs open headroom and a solid block beneath your current feet.
- look_around      { "turns": 4 }                                                     — slow rotate to scan surroundings
- stop             {}                                                                  — cancel current pathing/controls and idle
- mount            { "entity_type": "<name>", "range": 8 }                            — mount a boat/horse/minecart/donkey/etc.
- dismount         {}                                                                  — leave whatever I'm riding

MINING / BLOCKS
- collect_block    { "block": "<name>", "count": 1, "range": 32 }                     — find, walk to, mine; repeat until count
- dig_block        { "x": <int>, "y": <int>, "z": <int> }                              — mine a specific block at coords
- dig_down         { "depth": 1 }                                                     — mine straight down N blocks (void-safe, refuses lava/water/bedrock)
- place_block      { "block": "<name>" }                                              — place a block from inventory in any open adjacent spot (auto-finds spot)
- place_block_at   { "block": "<name>", "x": <int>, "y": <int>, "z": <int> }          — place a block at exact coords (auto-picks reference face)
- use_block        { "block": "<name>"?, "x": <int>?, "y": <int>?, "z": <int>?, "range": 16 } — right-click a block (open door, button, lever, chest UI)

CRAFTING / SURVIVAL
- craft            { "item": "<name>", "count": 1 }                                   — craft; auto-uses 2x2 inventory or pathfinds to a crafting_table
- smelt            { "input": "<name>", "fuel": "<name>"?, "count": 1 }               — pathfind to a furnace and smelt; fuel defaults to coal/charcoal/log/planks
- equip_item       { "item": "<name>", "destination": "hand|head|torso|legs|feet|off-hand" } — equip tool/weapon/armor
- use_item         { "offhand": false, "hold_ms": 0 }                                 — right-click held item (drink potion, throw ender pearl, light flint, charge bow)
- shoot_bow        { "entity_type": "<name>", "range": 32, "charge_ms": 1100 }        — equip bow, charge, release at target
- eat              { "food": "<name>" }                                               — equip food and eat. ONLY real foods work: bread, apple, cooked_beef, cooked_porkchop, cooked_chicken, cooked_mutton, cooked_cod, cooked_salmon, baked_potato, carrot, golden_carrot, sweet_berries, glow_berries, melon_slice, cookie, mushroom_stew, dried_kelp. Seeds, raw_potato, raw_chicken, wheat (the crop), bamboo etc. are NOT food and will fail.
- sleep            {}                                                                  — find and use a bed (only at night)
- wake_up          {}                                                                  — wake up from bed

INVENTORY / STORAGE
- drop             { "item": "<name>", "count": 1 }                                   — toss an item to the ground
- give_to          { "player": "<name>", "item": "<name>", "count": 1 }               — walk near a player and toss them an item
- deposit_chest    { "item": "<name>", "count": 1 }                                   — find nearest chest, deposit
- withdraw_chest   { "item": "<name>", "count": 1 }                                   — find nearest chest, withdraw

FLUIDS
- fill_bucket      { "liquid": "water|lava" }                                         — use empty bucket on nearby liquid
- empty_bucket     {}                                                                  — pour current bucket out where I'm looking

FARMING / FISHING
- fish             {}                                                                  — equip fishing_rod, walk to water, cast and reel a catch
- till_soil        {}                                                                  — use hoe on dirt/grass to make farmland
- plant_crop       { "seed": "<name>" }                                               — place a seed item on farmland (e.g. wheat_seeds, carrot, potato)
- use_bonemeal     { "block": "<name>"?, "x": <int>?, "y": <int>?, "z": <int>?, "range": 16 } — apply bone_meal to a block
- shear_animal     { "entity_type": "sheep", "range": 12 }                            — pathfind and shear with shears

ENTITIES
- attack_nearest   { "entity_type": "<name>", "range": 16 }                           — close in and attack
- use_entity       { "entity_type": "<name>", "range": 8 }                            — right-click entity (breed by feeding, dye sheep, lead, name tag, etc.)
- flee             { "from": "<entity_type>" }                                        — sprint away from nearest of that type

META
- wait             { "seconds": 2 }                                                   — short pause, lets the world tick
- chat_only        {}                                                                  — LAST RESORT: only talk this turn, take no action. Never pick chat_only twice in a row.

Block names are Minecraft IDs: oak_log, birch_log, dirt, grass_block, stone, cobblestone, sand, water, oak_planks, crafting_table, furnace, chest, bed, etc.
Item names are Minecraft IDs: oak_planks, stick, crafting_table, wooden_pickaxe, stone_pickaxe, iron_ingot, bread, etc.
Entity names are Minecraft IDs: zombie, skeleton, cow, sheep, pig, chicken, etc.

Survival cheatsheet (act on these, don't just narrate them):
- To get planks from logs: match the plank type to your log type — spruce_log → craft(spruce_planks), oak_log → craft(oak_planks), birch_log → craft(birch_planks), etc. Uses inventory 2x2, no table needed.
- To get sticks: { "type": "craft", "args": { "item": "stick", "count": 4 } } — uses 2 planks of any type.
- To craft tools (pickaxe, axe, sword, shovel): use craft(wooden_pickaxe) etc. at a crafting_table — the skill auto-crafts planks and sticks from your logs if needed. Just have logs and stand near a table.
- To get a crafting_table: craft 4 planks then craft crafting_table; place it; then craft tools.
- To smelt iron: need furnace + iron_ore + fuel; { "type": "smelt", "args": { "input": "raw_iron", "fuel": "coal", "count": 1 } }.
- To sleep through night: have a bed in inventory → place_block "white_bed" (or any bed) → sleep.

PICKAXE TIER RULES (Minecraft 1.21 — strict; the brain will hardblock attempts to mine above tier):
- Wooden pickaxe mines: stone, cobblestone, coal_ore, andesite, diorite, granite, dripstone. CANNOT mine copper, iron, gold, redstone, lapis, diamond, or any deepslate_*_ore.
- Stone pickaxe mines: ALL of the above PLUS copper_ore, iron_ore, lapis_ore, deepslate_coal_ore, deepslate_copper_ore, deepslate_iron_ore. CANNOT mine gold, redstone, diamond, emerald, or deepslate variants of those.
- Iron pickaxe mines: ALL of the above PLUS gold_ore, redstone_ore, diamond_ore, emerald_ore, and ALL deepslate_*_ore variants except ancient_debris.
- Recipe tier order: wooden_pickaxe (3 planks + 2 sticks) → stone_pickaxe (3 cobblestone + 2 sticks) → iron_pickaxe (3 iron_ingot + 2 sticks).
- "Mining by hand" never drops anything for stone-tier or deeper blocks. If you don't have the correct pickaxe IN INVENTORY, do not pick dig_block or collect_block on that target — craft/upgrade the pickaxe first.
- Where iron is: iron_ore spawns y=-30 to y=64 in stone, plus deepslate_iron_ore below y=0. Dig DOWN from the surface in stone caves to find it. Strip-mine at y=8 to y=16 for highest yield.

Death, recovery, and protecting your progress (read this BEFORE you mine deep or fight tough mobs — losing iron because you died is the project's #1 progress-killer):
- When you die, EVERY item in your inventory drops at the death coordinates. Items despawn 5 minutes after the death. You respawn at world spawn (or your bed if one is set) — usually far from where you died.
- After a death, the brain will write an entry into WHAT I'VE TRIED THAT DIDN'T WORK naming the death coords AND the item list you dropped. To recover the drops you must goto_coord to those coords AND use goto_item within the 5-minute despawn window. Past 5 minutes, the items are gone.
- A bed sets your respawn point. Recipe: 3 planks (same species) + 3 wool, crafted at a crafting_table. To set spawn: place_block(<species>_bed) then sleep at night. After that, any death respawns you at the bed, NOT at world spawn.
- A chest holds 27 stacks of items, safe from deaths and mobs. Recipe: 8 planks (same species), crafted at a crafting_table. To store: place_block(chest), then deposit_chest(item=<name>, count=<n>). To take items back: withdraw_chest(item=<name>, count=<n>). Naming a chest location via add_anchor (e.g. name="home_stash") lets you path back to it later by name.
- The progression-protector pattern a real player uses: as soon as you have your first stone-tier or iron-tier item, place a chest near your work area, deposit_chest your valuables (raw_iron, iron_ingot, stone_pickaxe, raw_copper, copper_ingot, coal — anything you'd hate to re-grind), add_anchor name="home_stash", then go mine more. If you die, you respawn at your bed, walk back to your chest, withdraw your stash, and only the few items mined since the last deposit are at risk.
- Iron armor reduces incoming damage by ~60%. Once you have 24 iron_ingot, craft a full set (iron_helmet, iron_chestplate, iron_leggings, iron_boots) and equip_item to head/torso/legs/feet. This is the single biggest survival upgrade in the early game.
- Low health (HP shown in LIVE STATE): if HP drops below 8, retreat. Flee from hostiles, eat food to regenerate, place_block to wall off attackers. The brain WILL NOT auto-retreat for you — that's your decision. If the LLM is offline (rate-limit backoff), a hardcoded low-HP flee fires as a last-resort safety, but during normal operation you must choose to retreat yourself.

HARD RULES — these are enforced by the skills and the brain:
- INVENTORY IS THE LIVE STATE. The "Inventory:" line in --- LIVE STATE --- is authoritative — it is read directly from the bot just before this decision. If an item is not listed, you do NOT have it. NEVER narrate having an item that's not on the Inventory line. NEVER plan around a "bow", "sword", "pickaxe", or any other tool unless it appears on that line.
- COMBAT WITH NO WEAPON IS A LOSS. attack_nearest will refuse if you target skeleton, stray, witch, creeper, ghast, pillager, evoker, phantom, blaze, piglin, piglin_brute, or wither_skeleton without a sword/axe in hand. Use flee instead, or craft a wooden_sword first (2 planks + 1 stick at a crafting_table).
- CRAFT CAN FAIL TO DELIVER. If craft returned ok:false saying "server reported success but item never landed in inventory", the output dropped on the ground because your inventory was full. Do NOT retry the same craft — drop an unused item with drop(<name>) first, then craft again. If the dropped output is still nearby (within 5 minutes), goto_item will pick it up.
- USE QUOTED ERRORS. When a skill returns an error, the WHAT I JUST DID line shows it verbatim. Read the literal error message — do not paraphrase or invent a different cause.

Respond ONLY with valid JSON in exactly this format — no prose, no code fences:
{
  "say": "your narration (1-2 short sentences) or empty string",
  "action": { "type": "<skill_name>", "args": { ... } },
  "memory_update": { ... }
}

The "memory_update" field is OPTIONAL. Use it when something is worth remembering across turns. All sub-fields are optional — include only what changed:
- "set_goal":        "<short string, IMMEDIATE step>"              — the SHORT-HORIZON action I'm doing right NOW (e.g. "place crafting_table here", "mine 4 oak_logs"). On a goal switch, the previous current_goal automatically becomes parent_goal — set_parent_goal is only needed to set a brand-new bigger objective.
- "set_parent_goal": "<short string, BIG objective>"               — the LONGER-HORIZON objective behind the current step (e.g. "build a shelter before night", "smelt iron"). parent_goal is BIGGER and slower-changing than current_goal. If current_goal is "mine 4 oak_logs", parent_goal might be "craft wooden tools".
- "add_anchor":      { "name": "<short>", "note": "<why>" }       — name a place at my current position so I can refer to it later (e.g. "home_base", "first_trees")
- "add_learned":     "<short fact about this world>"               — something true I shouldn't relearn
- "add_failed":      "<what I tried and why it didn't work>"       — to avoid looping on the same broken plan
- "add_commitment":  { "person": "<name>", "text": "<promise>" }   — record a promise I made to someone in chat

Use memory_update sparingly but use it. A goal you don't write down evaporates next turn. A place you don't name has no coordinates next turn. A failure you don't record will be tried again.

GOAL STICKINESS: only call set_goal when the actual objective changes (e.g. "get wood" → "build a shelter"). Re-stating the SAME objective in different words is ignored — current_goal stays put. Don't waste a memory_update slot rephrasing the goal you already have.

REPEAT-FAILURE GUARD: when the same skill+args fails twice within a minute, the third attempt is auto-blocked (substituted with a wait) and a "skill X failed Nx" entry is added to WHAT I'VE TRIED THAT DIDN'T WORK. Deterministic errors ("no <X> in inventory", "no <X> within Nm", "no recipe available") block on the FIRST failure — they will not change on retry. If you see such an entry, do NOT pick that skill+args again — try a DIFFERENT skill or DIFFERENT args. Examples:
- craft(oak_planks) failed missing oak_log? → collect_block(oak_log) first.
- craft(wooden_pickaxe) failed needs crafting_table? → place_block(crafting_table) first, then craft.
- place_block(crafting_table) failed "no crafting_table in inventory"? → craft(crafting_table) first (4 planks).
- goto_block(crafting_table) failed "no crafting_table within 32m"? → place one if you have it, otherwise craft one.
- goto_block(oak_log) returned no oak_log nearby? → pick a DIFFERENT direction with goto_coord, or goto_block on a different resource.

If you have no useful action, use { "type": "wait", "args": { "seconds": 2 } }.
Do not repeat your last message. If health or food is low, prioritise food / shelter.`;

// BUG-001 Path A (2026-05-13): the BLOCKED banner in the observation has been
// ignored — the LLM keeps re-picking blocked sigs because the candidate set
// in the system message doesn't acknowledge them. This builder annotates each
// blocked sig directly under its skill's line in the SKILLS enumeration, so
// the constraint lives where the LLM picks from.
export function buildSystemPrompt(blockedSigs, basePrompt) {
  const base = basePrompt ?? SYSTEM_PROMPT;
  if (!blockedSigs || blockedSigs.size === 0) return base;
  const now = Date.now();
  const bySkill = new Map();
  for (const [sig, entry] of blockedSigs) {
    if (!entry || entry.until <= now) continue;
    const colonIdx = sig.indexOf(':');
    const skill = colonIdx >= 0 ? sig.slice(0, colonIdx) : sig;
    if (!bySkill.has(skill)) bySkill.set(skill, []);
    bySkill.get(skill).push(entry);
  }
  if (bySkill.size === 0) return base;
  let prompt = base;
  for (const [skill, entries] of bySkill) {
    const blockedLines = entries.map((e) => {
      const tail = e.lastError ? ` — ${e.lastError}` : '';
      return `    ${e.label}${tail}`;
    });
    const annotation = '\n' + [
      '  [BLOCKED this turn — DO NOT pick:',
      ...blockedLines,
      '  ]',
      '  Use a DIFFERENT args value (try the prereq instead).',
    ].join('\n');
    const skillLineRe = new RegExp(`(\\n- ${skill}\\s[^\\n]+)`);
    prompt = prompt.replace(skillLineRe, (match) => match + annotation);
  }
  return prompt;
}

// ---------------------------------------------------------------------------
// Pure helpers (Session B follow-up): brain watchdog + _think exit invariant.
// Extracted so we can drive the threshold logic from tests without spinning up
// timers, mineflayer, or the LLM.
// ---------------------------------------------------------------------------

// Returns null when no recovery is needed, otherwise an object describing the
// trip:  { kind, reason, ageMs }. Caller is expected to clear in-flight state
// and call _scheduleThink(reason).
//
// Three trip conditions, in priority order:
//   1. wedged_thinking  — _thinking has been true longer than thinkWatchdogMs
//   2. no_decision      — lastDecision is older than noDecisionMs AND no future
//                          think is scheduled (idleTimer/currentSkill/pendingThink
//                          are all empty). Fires regardless of _thinking — the
//                          original watchdog only caught wedged-thinking and a
//                          narrow no-skill idle case, missing the in-flight
//                          stalled-think pattern observed in Test5 obs-07.
//   3. idle_stall       — !_thinking && !currentSkill && _lastTickOkAt is older
//                          than thinkWatchdogMs. Pre-existing.
//
// `coldStartMs` is a grace window after `brainStartedAt` during which no trip
// fires — the very first think can legitimately take longer than the
// no_decision threshold, and there's no decision to compare against yet.
export function watchdogDecision({
  now,
  running,
  thinking,
  thinkStartedAt,
  lastTickOkAt,
  lastDecisionTs,
  brainStartedAt,
  currentSkill,
  idleTimer,
  pendingThink,
  thinkWatchdogMs,
  noDecisionMs,
  coldStartMs,
}) {
  if (!running) return null;
  if (brainStartedAt > 0 && (now - brainStartedAt) < coldStartMs) return null;

  const wedgedThinking = thinking
    && thinkStartedAt > 0
    && (now - thinkStartedAt) > thinkWatchdogMs;

  const idleStall = !thinking
    && !currentSkill
    && (now - lastTickOkAt) > thinkWatchdogMs;

  const hasScheduledThink = idleTimer != null
    || currentSkill != null
    || pendingThink != null;

  const lastDecisionAge = lastDecisionTs > 0 ? (now - lastDecisionTs) : -1;
  const noDecisionStall = lastDecisionTs > 0
    && lastDecisionAge > noDecisionMs
    && !hasScheduledThink;

  // no_decision is checked BEFORE wedgedThinking and idle_stall so it pre-empts
  // them when both fire — its message names the actual symptom (the brain
  // hasn't recorded a decision in a long time) rather than the secondary state.
  if (noDecisionStall) {
    return { kind: 'no_decision', reason: 'brain_watchdog_no_decision', ageMs: lastDecisionAge };
  }
  if (wedgedThinking) {
    return { kind: 'wedged_thinking', reason: 'brain_watchdog', ageMs: now - thinkStartedAt };
  }
  if (idleStall) {
    return { kind: 'idle_stall', reason: 'brain_watchdog_idle', ageMs: now - lastTickOkAt };
  }
  return null;
}

// Invariant for every _think() exit: either some next-think mechanism is
// scheduled (idle timer / current skill / pending think) OR brainStatus is
// non-active and a reason string is populated. A silent exit (neither holds)
// means no future _think will fire and the brain is wedged.
export function thinkExitInvariantHolds({
  idleTimer,
  currentSkill,
  pendingThink,
  brainStatus,
  reason,
}) {
  const scheduled = idleTimer != null
    || currentSkill != null
    || pendingThink != null;
  const inactiveWithReason = brainStatus != null
    && brainStatus !== 'active'
    && typeof reason === 'string'
    && reason.length > 0;
  return scheduled || inactiveWithReason;
}

// Dev-mode assertion is opt-out via NODE_ENV=production; explicit BRAIN_DEV_ASSERT=0
// also disables it. Production runs avoid the cost of the check entirely.
function isBrainDevAssertEnabled() {
  if (process.env.BRAIN_DEV_ASSERT === '0') return false;
  return process.env.NODE_ENV !== 'production';
}

// ---------------------------------------------------------------------------
// Brain
// ---------------------------------------------------------------------------
export class Brain {
  constructor(mfBot, {
    onDecision   = null,
    onError      = null,
    onReconnect  = null,
    onEvent      = null,  // hook for history layer (fix #5): { type, data, ts }
    memory       = null,  // PlayerMemory instance — provides contextBlock() + applyUpdate()
    systemPromptOverride = null,  // experiment hook: replaces SYSTEM_PROMPT base
    chatRethinkGapMs = 0, // coalesce chat-triggered re-thinks (0 = off, current behaviour)
    idleRethinkMs = IDLE_RETHINK_MS, // idle-timer re-think gap; lower = thinks more often
    rethinkTickMs = 0, // forced periodic re-think (0 = off). Silent mirror of C2's chat-poke cadence — the think-rate control.
    ignoreLiveChat = false, // placebo: ignore real in-world peer chat; only chat via injectChat() is processed
  } = {}) {
    this._bot         = mfBot;
    this._client      = USE_OPENROUTER
      ? new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: OPENROUTER_BASE_URL })
      : USE_OPENAI
        ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY, baseURL: OPENAI_BASE_URL })
        : USE_LOCAL_LLM
          ? new OpenAI({ apiKey: 'ollama', baseURL: LOCAL_LLM_BASE_URL })
          : new OpenAI({ apiKey: resolveCerebrasKey(), baseURL: 'https://api.cerebras.ai/v1' });
    this._onDecision  = onDecision;
    this._onError     = onError;
    this._onReconnect = onReconnect;
    this._onEvent     = onEvent;
    this._memory      = memory;
    this._systemPromptOverride = systemPromptOverride;
    this._chatRethinkGapMs = chatRethinkGapMs;
    this._lastChatThinkAt  = 0;   // governor: last chat-triggered re-think (ms)
    this._idleRethinkMs    = idleRethinkMs;   // per-instance idle re-think gap (think-rate control)
    this._rethinkTickMs    = rethinkTickMs;   // forced periodic re-think cadence (0 = off)
    this._tickTimer        = null;
    this._ignoreLiveChat   = ignoreLiveChat;  // placebo: deaf to live peer chat (uses injectChat instead)

    this._running       = false;
    this._thinking      = false;
    // F11: priority queue of pending reasons while _thinking is true. Highest
    // priority wins on dequeue (damage > hostile > death > … > idle). Stored
    // as a single { reason, priority } slot — newer same-priority overwrites.
    this._pendingThink  = null;             // { reason, priority } | null
    this._lastThinkAt   = 0;
    this._idleTimer     = null;
    this._proximityT    = null;

    this._lastSaid      = '';
    this._recentSays    = [];               // [{ts, text}] — for paraphrase-dedupe (Bug 10)
    this._currentSkill  = null;             // { name, args, abort, startedAt }
    this._lastErrMsg    = null;
    this._chatOnlyStreak = 0;               // anti-loop: consecutive chat_only picks
    this._failureLog    = new Map();        // key=`${skill}:${argsKey}` → [{ts, error}]
    this._debounceLog   = new Map();        // key=`${skill}:${argsKey}` → [ts] — OVN-006 escalation
    this._recentDecisions = [];             // [{ts, type, key}] — short ring for repeat-debounce
    this._lastHostileThinkAt = 0;           // throttle for hostile_near rethinks
    this._lastHostileEntity = null;
    this._lastReconnectAt = 0;              // debounce NaN-position reconnect storm
    this._stuckCount = 0;                  // escalating stuck counter — resets on movement
    this._regroupBreakCount = 0;           // BUG-001: times breakRegroupWait fired on the current regroup goal
    this._watchdogTimer = null;             // aborts a skill that won't resolve
    this._brainWatchdogTimer = null;        // detects wedged brain (thinking too long)
    this._thinkStartedAt = 0;               // when current _think started (0 = idle)
    this._lastTickOkAt   = Date.now();      // last successful _think completion
    this._lastJumpLoopHint = 0;             // suppress jump-loop hint after handled
    this._positionHistory = [];             // [{ts, x, y, z}] — for stationary detection
    this._lastChatFrom  = null;             // username of the most recent incoming chat
    this._wasOnGround      = true;          // jump-loop: previous onGround state
    this._jumpCycleCount   = 0;             // jump-loop: consecutive stationary jumps
    this._jumpLoopHandling = false;         // jump-loop: prevent re-entrant escape
    this._physTick         = null;          // bound physicTick handler for removal
    this._mcData        = null;
    this._movements     = null;

    // BUG-001/003/012 hard-block state
    this._blockedSigs    = new Map();        // sig → { until, lastError }
    this._goalChangedAt  = Date.now();       // last time current_goal actually changed
    this._lastKnownGoal  = null;             // tracked to detect real goal changes
    this._lastBlockedHint = 0;               // suppress repeat of the "you ignored the block" log

    // BUG-023 (Path 2, 2026-05-18): goal-aging tracker. Counts consecutive
    // turns where current_goal is unchanged, inventory size is unchanged,
    // and position has drifted less than GOAL_AGING_POS_THRESHOLD blocks.
    // When the count exceeds GOAL_AGING_THRESHOLD, the brain emits an
    // add_failed annotation saying the goal looks stalled. Path 2: info
    // only, the LLM picks the next move.
    this._goalAgingTurns       = 0;
    this._goalAgingLastInvSize = 0;
    this._goalAgingLastPos     = null;
    this._goalAgingLastFiredAt = 0;          // tick-counter, not wall time

    // BUG-025 (Path 2, 2026-05-18): death-resilience tracking. Snapshot
    // inventory every think tick so a death can report what the bot
    // actually dropped + when those items despawn (5 min after death).
    // Also tracks stash-advisor cadence (don't re-fire every tick).
    this._lastKnownInventory   = [];
    this._stashAdvisorLastFire = 0;

    // Step 2 (2026-05-10): per-(skill,argsKey) jump_loop cancel log used by
    // the collect_block × jump_loop recovery substitution. Populated from
    // _cancelCurrentSkill('jump_loop') so the recovery layer can ask "did
    // collect_block(birch_log) cause ≥2 jump_loops in the last 60s?"
    // without scanning the broader _failureLog.
    this._jumpLoopCancelLog = new Map();     // key=`${skill}:${argsKey}` → [{ts}]

    // Phase A4 (Step 2.5+, 2026-05-12): set to true while the brain is running
    // a skill it auto-substituted from a previous skill's `recovery` hint.
    // Used by _onSkillDone to refuse to chain a second consecutive
    // auto-recovery — a failing recovery hands control back to the LLM.
    this._autoRecovering = false;

    // F8: LLM availability tracking
    this._consecutiveLLMErrors = 0;
    this._llmBackoffMs   = 0;            // current backoff window (0 = no backoff)
    this._llmBackoffUntil = 0;           // wall-clock at which next LLM call is permitted
    this._llmOfflineNoticeSent = false;  // sent the one-time chat warning?
    this._lastLLMErrorSnapshot = null;   // OVN-013: surfaced in the recovery log

    // F6: post-respawn grace — NaN-position is normal briefly after respawn
    this._lastRespawnAt = 0;

    // F12: first-tick spawn-reflex — fired once per Brain instance
    this._brainStartedAt = 0;
    this._spawnReflexFired = false;

    // F13: aggregated error reporting — same msg gets counted, re-emitted every 60s
    this._errAgg = null;                 // { msg, count, firstAt, lastAt, lastEmittedAt }

    // F1/F3: typed last error for dashboard exposure
    this.lastError = null;               // { ts, status, message } | null

    // _think exit invariant tracking. _brainStatus defaults to 'active'; paths
    // that exit _think without scheduling a next think MUST set this to a
    // non-active value with a populated reason. Dev-mode assertion in _think
    // finally surfaces silent exits.
    this._brainStatus       = 'active';   // 'active' | 'stopped' | 'stalled' | 'error'
    this._brainStatusReason = null;       // human-readable string when non-active
    this._lastInvariantViolation = null;  // dev-only — last silent-exit detected

    // exposed for the history layer to consume
    this.lastDecision   = null;
    this.lastSkillResult = null;
  }

  start() {
    if (this._running) return;
    // F7: don't flip _running=true until install succeeds. If pathfinder or
    // event-wire throws, the brain is NOT running — and stop() can't accidentally
    // try to clean up half-installed state.
    try {
      this._installPathfinder();
      this._wireEvents();
    } catch (err) {
      this._reportError(err, 'pathfinder install');
      return;
    }
    this._running = true;
    this._brainStartedAt = Date.now();
    this._lastTickOkAt = Date.now();
    this._brainStatus       = 'active';
    this._brainStatusReason = null;
    this._startBrainWatchdog();
    this._scheduleThink('startup');
  }

  stop() {
    this._running = false;
    // _think's early `if (!this._running) return;` exit bypasses the try/finally
    // and would otherwise leave brainStatus='active' with no scheduled think —
    // the invariant assertion would fire. Mark stopped+reason here so a final
    // _think after stop() lands in the inactive-with-reason branch cleanly.
    this._brainStatus       = 'stopped';
    this._brainStatusReason = 'brain stopped via stop()';
    this._cancelCurrentSkill('stop');
    if (this._idleTimer)        { clearTimeout(this._idleTimer);        this._idleTimer = null; }
    if (this._watchdogTimer)    { clearTimeout(this._watchdogTimer);    this._watchdogTimer = null; }
    if (this._brainWatchdogTimer){ clearInterval(this._brainWatchdogTimer); this._brainWatchdogTimer = null; }
    if (this._proximityT)       { clearInterval(this._proximityT);      this._proximityT = null; }
    if (this._tickTimer)        { clearInterval(this._tickTimer);       this._tickTimer = null; }
    if (this._physTick) {
      try { this._bot.removeListener('physicTick', this._physTick); } catch { /* noop */ }
      this._physTick = null;
    }
    this._jumpLoopHandling = false;
    this._jumpCycleCount   = 0;
    try { this._bot.pathfinder?.setGoal(null); } catch { /* noop */ }
    this._clearControls();
  }

  // -------------------------------------------------------------------------
  // brain watchdog — recovery from a wedged loop
  // -------------------------------------------------------------------------
  _tickWatchdog() {
    const decision = watchdogDecision({
      now:             Date.now(),
      running:         this._running,
      thinking:        this._thinking,
      thinkStartedAt:  this._thinkStartedAt,
      lastTickOkAt:    this._lastTickOkAt,
      lastDecisionTs:  this.lastDecision?.ts ?? 0,
      brainStartedAt:  this._brainStartedAt,
      currentSkill:    this._currentSkill,
      idleTimer:       this._idleTimer,
      pendingThink:    this._pendingThink,
      thinkWatchdogMs: BRAIN_WATCHDOG_MS,
      noDecisionMs:    BRAIN_NO_DECISION_TIMEOUT_MS,
      coldStartMs:     BRAIN_COLD_START_GRACE_MS,
    });
    if (!decision) return;
    const ageS = Math.round(decision.ageMs / 1000);
    console.warn(`[brain:${this._bot.username}] BRAIN WATCHDOG (${decision.kind}) — ${ageS}s; forcing reset`);
    this.lastError = { ts: Date.now(), status: 'watchdog', message: `watchdog:${decision.reason}` };
    this._thinking       = false;
    this._thinkStartedAt = 0;
    this._lastTickOkAt   = Date.now();
    this._scheduleThink(decision.reason);
  }

  _startBrainWatchdog() {
    if (this._brainWatchdogTimer) clearInterval(this._brainWatchdogTimer);
    // Check every 30s. The pure `watchdogDecision` helper picks one of
    // wedged_thinking / no_decision / idle_stall and we react accordingly. The
    // no_decision arm is the new ungated trip — fires whenever lastDecision is
    // older than BRAIN_NO_DECISION_TIMEOUT_MS AND no future think is scheduled,
    // regardless of `_thinking`. The cold-start grace prevents false-fires on
    // boot before the first decision lands.
    this._brainWatchdogTimer = setInterval(() => this._tickWatchdog(), 30000);
    this._brainWatchdogTimer.unref?.();
  }

  // -------------------------------------------------------------------------
  // setup
  // -------------------------------------------------------------------------
  _installPathfinder() {
    if (!this._bot.pathfinder) this._bot.loadPlugin(pathfinder);
    this._mcData = minecraftData(this._bot.version);
    this._movements = new Movements(this._bot, this._mcData);
    this._movements.allowSprinting = true;
    this._movements.allowParkour = true;
    this._movements.canDig = true;
    this._bot.pathfinder.setMovements(this._movements);
  }

  _wireEvents() {
    const bot = this._bot;

    bot.on('entityHurt', (entity) => {
      if (entity === bot.entity) {
        this._emit('damage', { hp: bot.health });
        this._scheduleThink('damage');
      }
    });

    bot.on('death', () => {
      // F6: a death is followed by a respawn during which bot.entity.position
      // is NaN for ~1-3s. Mark the moment so _think's NaN-handler skips
      // _onReconnect during the grace window — otherwise every death triggers
      // a disconnect+reconnect storm that loses brain state.
      this._lastRespawnAt = Date.now();
      this._emit('death', {});
      this._recordDeathLocation(bot.entity?.position);
      this._cancelCurrentSkill('death');
      this._scheduleThink('death');
    });

    bot.on('respawn', () => {
      this._lastRespawnAt = Date.now();
    });

    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      if (this._ignoreLiveChat) return;  // placebo: deaf to live peer chat; only injectChat() is heard
      this._emit('chat_in', { from: username, text: message });
      // Governor: cap how often inbound chat forces a re-think, so a room of
      // talking agents can't storm the shared LLM budget (mirrors
      // HOSTILE_RETHINK_GAP_MS). The message is still recorded above; only the
      // urgent re-think is throttled. Off (0) by default — current behaviour.
      const now = Date.now();
      if (this._chatRethinkGapMs > 0 && (now - this._lastChatThinkAt) < this._chatRethinkGapMs) return;
      this._lastChatThinkAt = now;
      this._scheduleThink(`chat:${username}`);
    });

    this._proximityT = setInterval(() => this._checkHostiles(), HOSTILE_POLL_MS);

    // Think-rate control: a silent, content-free re-think every rethinkTickMs,
    // mirroring how constant chat forces re-thinks in C2. Off by default.
    if (this._rethinkTickMs > 0) {
      this._tickTimer = setInterval(() => this._scheduleThink('tick'), this._rethinkTickMs);
    }

    this._physTick = () => this._checkJumpLoop();
    bot.on('physicTick', this._physTick);
  }

  _checkHostiles() {
    if (!this._running) return;
    // F6: skip during the post-respawn grace — position is briefly invalid and
    // we don't want stale entity ghosts firing _scheduleThink storms.
    if ((Date.now() - this._lastRespawnAt) < POST_RESPAWN_GRACE_MS) return;
    const bot = this._bot;
    const me  = bot.entity?.position;
    if (!me || isNaN(me.x)) return;
    let closest = null, closestD = Infinity;
    for (const e of Object.values(bot.entities ?? {})) {
      if (e === bot.entity) continue;
      // OVN-010: dropped the e.mobType fallback. mineflayer+prismarine-entity
      // populate e.name on hostile mobs spawned via the protocol; touching
      // e.mobType triggers a per-call deprecation trace that previously
      // starved the dashboard event loop (BUG-OVN-010 / 2026-05-05).
      const name = (e.name ?? '').toLowerCase();
      if (!HOSTILE_TYPES.has(name)) continue;
      if (!e.position || isNaN(e.position.x)) continue;
      const dx = e.position.x - me.x, dz = e.position.z - me.z;
      const d = Math.sqrt(dx*dx + dz*dz);
      if (d < closestD) { closestD = d; closest = e; }
    }
    if (closest && closestD <= HOSTILE_RADIUS) {
      const cur = this._currentSkill?.name;
      // any movement skill is already a defensive response — let it run.
      // Re-firing every 8s while the bot is mid-flee just supersedes the
      // pathfind and the bot ends up cycling without making any escape.
      if (MOVEMENT_OR_DEFENSE.has(cur)) return;
      const now = Date.now();
      const sameEntity = closest.name === this._lastHostileEntity;
      if (sameEntity && (now - this._lastHostileThinkAt) < HOSTILE_RETHINK_GAP_MS) return;
      this._lastHostileEntity = closest.name;
      this._lastHostileThinkAt = now;
      this._emit('hostile_near', { entity: closest.name, distance: Math.round(closestD) });
      this._scheduleThink(`hostile:${closest.name}`);
    }
  }

  // -------------------------------------------------------------------------
  // scheduling
  // -------------------------------------------------------------------------
  // Placebo hook: deliver a message to this brain as if heard, without it being
  // live in-world chat. Mirrors the bot.on('chat') path (record + governed
  // re-think) so a replayed donor stream is indistinguishable from real hearing.
  injectChat(from, text) {
    if (!this._running) return;
    this._emit('chat_in', { from, text });
    const now = Date.now();
    if (this._chatRethinkGapMs > 0 && (now - this._lastChatThinkAt) < this._chatRethinkGapMs) return;
    this._lastChatThinkAt = now;
    this._scheduleThink(`chat:${from}`);
  }

  _scheduleThink(reason) {
    if (!this._running) return;
    if (this._thinking) {
      // F11: priority-aware queue — keep the highest-priority queued reason
      // so that an `idle` arriving after `hostile:zombie` doesn't displace it.
      const newPri = priorityOf(reason);
      const curPri = this._pendingThink ? this._pendingThink.priority : -1;
      if (newPri >= curPri) {
        this._pendingThink = { reason, priority: newPri };
      }
      return;
    }
    const wait = Math.max(0, MIN_THINK_GAP_MS - (Date.now() - this._lastThinkAt));
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    // Track the pending think in `_idleTimer` so the invariant assertion and
    // the watchdog can see that a future _think is scheduled. Previously this
    // was an untracked setTimeout — invisible to `watchdogDecision`'s
    // hasScheduledThink check, which would falsely trip the no_decision arm.
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      this._think(reason);
    }, wait);
  }

  async _think(reason) {
    if (!this._running) return;
    this._thinking = true;
    this._pendingThink = null;
    this._lastThinkAt = Date.now();
    this._thinkStartedAt = this._lastThinkAt;

    try {
      if (!this._positionValid()) {
        // give the world a beat to provide a real position; reconnect if it persists
        await sleep(500);
        if (!this._positionValid()) {
          const now = Date.now();
          // F6: if we just respawned, NaN-position is normal — skip reconnect
          // entirely until the grace window passes. The proximity timer is
          // also paused effectively (positionValid() is false) so we don't
          // burn cycles either.
          if ((now - this._lastRespawnAt) < POST_RESPAWN_GRACE_MS) {
            this._scheduleIdleTimer();
            return;
          }
          // debounce reconnect storms — if we triggered a reconnect <30s ago,
          // skip and let the previous reconnect cycle settle.
          if ((now - this._lastReconnectAt) > 30000 && this._onReconnect) {
            this._lastReconnectAt = now;
            this._onReconnect();
          }
          return;
        }
      }

      // F12: first-tick spawn-kill-box reflex — if we're within the spawn
      // window, have empty inventory, and are surrounded by hostiles, fire a
      // hardcoded flee BEFORE spending an LLM turn. The LLM round-trip is too
      // slow when a creeper is at 2m.
      if (!this._spawnReflexFired && this._brainStartedAt > 0) {
        const sinceStart = Date.now() - this._brainStartedAt;
        if (sinceStart < SPAWN_REFLEX_WINDOW_MS && this._spawnKillBoxDetected()) {
          this._spawnReflexFired = true;
          const action = { type: 'flee', args: { from: this._closestHostileType() ?? 'zombie' } };
          this._recordDecision({ reason: 'spawn_reflex', observation: 'spawn-kill-box reflex (hardcoded, no LLM)', say: '', action, memoryUpdate: null });
          this._startSkill(action);
          return;
        }
      }

      // F8: if HP is low AND the LLM is currently in backoff (i.e. unreachable),
      // run a hardcoded flee. We can't ask the LLM for help if it isn't there.
      if (this._llmInBackoff() && (this._bot.health ?? 20) <= LOW_HP_REFLEX_HP) {
        const hostile = this._closestHostileType();
        if (hostile) {
          const action = { type: 'flee', args: { from: hostile } };
          this._recordDecision({ reason: 'low_hp_reflex', observation: `low-HP reflex hp=${this._bot.health} llm=offline`, say: '', action, memoryUpdate: null });
          this._startSkill(action);
          return;
        }
      }

      // F8: if we're in LLM backoff, don't waste a turn calling the API. Record
      // a wait decision so the dashboard shows the brain IS running — just
      // throttled — and reschedule for the next allowed slot.
      if (this._llmInBackoff()) {
        const waitMs = Math.max(0, this._llmBackoffUntil - Date.now());
        const action = { type: 'wait', args: { seconds: Math.min(6, Math.ceil(waitMs / 1000) || 2) } };
        this._recordDecision({
          reason,
          observation: `LLM in backoff for ${Math.round(waitMs/1000)}s (consecutive errors: ${this._consecutiveLLMErrors})`,
          say: '',
          action,
          memoryUpdate: null,
        });
        this._startSkill(action);
        return;
      }

      // BUG-023 (Path 2, 2026-05-18): goal-aging signal. If the current_goal
      // has been the same AND inventory unchanged AND position barely moved
      // for GOAL_AGING_THRESHOLD ticks, push an add_failed annotation so the
      // LLM sees "your goal has been current for N turns with zero progress."
      // Path 2: information only — the LLM owns the decision to abandon.
      this._checkGoalAging();

      // BUG-025 (Path 2, 2026-05-18): inventory snapshot for death-resilience.
      // Mineflayer's death event fires AFTER inventory has been cleared, so
      // we snapshot here at the start of each think tick. _recordDeathLocation
      // uses the most recent snapshot to name what was dropped.
      try {
        const items = this._bot?.inventory?.items?.() ?? [];
        this._lastKnownInventory = items.map((i) => ({ name: i.name, count: i.count }));
      } catch { /* noop */ }

      // BUG-025: stash advisor. If the bot is holding progression-tier items
      // (stone-tier+, iron-tier+) AND has no chest/stash anchor named, push
      // a one-shot annotation reminding the LLM that a player would stash
      // these before mining further. Path 2: info only.
      this._checkStashAdvisor();

      const obs = this._observe(reason);
      const result = await this._callLLM(obs);

      // F8: track LLM health. _callLLM returns _llm_error string on the
      // fallback path; absence of that field implies a successful call.
      if (result._llm_error) {
        this._noteLLMError(result._llm_error_status, result._llm_error);
      } else {
        this._noteLLMSuccess();
      }

      if (result.memory_update && this._memory) {
        try {
          this._memory.applyUpdate(result.memory_update, { position: this._bot.entity?.position ?? null });
          // BUG-003 support: track when current_goal genuinely changes so the
          // completion-blindness detector knows the LLM has been stuck on the
          // same objective for too long.
          const newGoal = result.memory_update.set_goal;
          if (newGoal && newGoal !== this._lastKnownGoal) {
            this._goalChangedAt = Date.now();
            this._lastKnownGoal = newGoal;
          }
        } catch (err) {
          console.warn(`[brain:${this._bot.username}] memory_update apply failed: ${err.message}`);
        }
      }

      // Step 2.6 (2026-05-16): _recordDecision moved DOWN — see the call site
      // just before _startSkill. The original early-recording was the root
      // cause of the dominant Step 2.5 stuck-loop signature: when the LLM
      // picked a blocked sig and the post-pick refusal converted it to
      // look_around, lastDecision.action stayed pinned to the original pick.
      // The watchdog read that and tallied 10 identical "decisions" while
      // the bot was actually look_around-ing. Recording AFTER the conversion
      // ladder fixes the dashboard / watchdog view of reality.

      if (result.say) {
        const out = this._prepareSay(result.say);
        if (out) {
          try { this._bot.chat(out); } catch { /* noop */ }
          this._lastSaid = out;
          this._recentSays.push({ ts: Date.now(), text: out });
          // keep the dedupe window short — five entries is plenty
          if (this._recentSays.length > 8) this._recentSays.shift();
        }
      }

      if (result.action) {
        // Step 2 (2026-05-10): collect_block × jump_loop recovery. Runs BEFORE
        // the per-skill failure cooldown so the deterministic recovery
        // sequence (collect_jump_recover skill) substitutes for the bare
        // wait(5) the cooldown would otherwise produce. Composes with the
        // OVN-018 cancel-as-failure path: that path still records the cancel
        // in _failureLog for cooldown purposes, but the action mutation here
        // takes precedence for THIS turn. After substitution we do NOT fall
        // through into the failure-cooldown / hardblock checks for this turn.
        const recoverySubstituted = this._applyCollectJumpRecovery(result);

        // anti-loop: per-skill failure cooldown — if the LLM tries the same
        // skill+args after recent failures, force a wait so it has a turn to
        // re-strategise with the failure entry visible in memory. Threshold
        // drops to 1 for deterministic errors (OVN-005/009): missing items and
        // missing nearby blocks won't fix themselves on retry.
        if (!recoverySubstituted && result.action.type) {
          const blocked = this._isBlockedSkill(result.action.type, result.action.args);
          if (blocked) {
            const brief = argsBrief(result.action.args);
            // OVN-015: blocking fires hundreds of times per night when the LLM
            // fixates on an unreachable target. The memory write below is the
            // real signal; this log line is a frequency-noise breadcrumb.
            brainDebug(`[brain:${this._bot.username}] blocking ${result.action.type}(${brief}) — ${blocked.fails.length} fails in last ${Math.round(SKILL_FAIL_WINDOW_MS/1000)}s${blocked.earlyTrip ? ' (deterministic error)' : ''}`);
            if (this._memory) {
              try {
                this._memory.applyUpdate({
                  add_failed: `${result.action.type}(${brief}) failed ${blocked.fails.length}x in 60s — last: ${blocked.lastError}. Try a different skill or args.`,
                }, { position: this._bot.entity?.position ?? null });
              } catch { /* noop */ }
            }
            // BUG-001: when fail count crosses the hard-block threshold, also
            // park the sig in _blockedSigs so the next prompt's BLOCKED banner
            // names it loudly and the post-pick refusal will fire if the LLM
            // tries it anyway.
            //
            // 2026-05-13 follow-up to the rerun report: promote to hardblock
            // immediately on early-trip (deterministic) failures, not at fail
            // count 3. The rerun showed two bots looping craft:wooden_pickaxe
            // x10 each despite the early-trip cooldown banner firing — the
            // soft banner alone wasn't enough to break LLM fixation. Hardblock
            // adds the post-pick look_around + goal clear which the LLM
            // can't ignore. earlyTrip means the failure is deterministic
            // (won't fix on retry without state change), so locking the sig
            // for SIG_HARDBLOCK_TTL_MS (5min) is the correct treatment —
            // it forces the bot onto a different objective long enough to
            // either gather the missing prereq or move on.
            if (HARDBLOCK_ENABLED && (blocked.earlyTrip || blocked.fails.length >= SIG_HARDBLOCK_THRESHOLD)) {
              this._addBlockedSig(result.action.type, result.action.args, blocked.lastError, blocked.lastErrorCode);
            }
            result.action = { type: 'wait', args: { seconds: 5 } };
          } else if (HARDBLOCK_ENABLED && this._isSigBlocked(result.action.type, result.action.args)) {
            // BUG-001 enforcement: the LLM picked a sig that's currently in the
            // hard-block list (banner showed it, LLM ignored it). Don't ask
            // again — force look_around AND clear the goal so memory genuinely
            // changes for the next turn.
            const brief = argsBrief(result.action.args);
            const label = `${result.action.type}(${brief})`;
            console.warn(`[brain:${this._bot.username}] BLOCKED-SIG IGNORED — LLM picked ${label} despite banner; forcing look_around + goal clear`);

            // BUG-022 (Step 2.6 / Path 2, 2026-05-18): per-skill-class
            // anti-fixation. The previous per-sig keying never tripped (0
            // STUCK FIXATION firings in 56,636 IGNORED events over a 7-hour
            // run) because the LLM's fixation pattern is per-skill-class
            // (dig_block at many different coords, place_block of many
            // different blocks) — not per-exact-sig. Counting hits by skill
            // name captures the actual behavior.
            const skillClass = result.action.type;
            this._antiFixationHits ??= new Map();
            const cutoff = Date.now() - ANTI_FIXATION_WINDOW_MS;
            const hits = (this._antiFixationHits.get(skillClass) || []).filter((t) => t >= cutoff);
            hits.push(Date.now());
            this._antiFixationHits.set(skillClass, hits);
            if (hits.length >= ANTI_FIXATION_THRESHOLD && this._memory) {
              try {
                this._memory.applyUpdate({
                  add_failed: `STUCK FIXATION: ${skillClass}(*) has been picked-then-blocked ${hits.length}x in the last ${Math.round(ANTI_FIXATION_WINDOW_MS/60000)}min despite the banner — different args each time, but the same skill class. Wiki: this pattern means the underlying approach (using ${skillClass}) is not working from here. Pick a FUNDAMENTALLY different skill class — if you've been ${skillClass}-ing, try the OPPOSITE category (if dig, try place/craft/goto_coord; if collect, try dig or goto somewhere new).`,
                }, { position: this._bot?.entity?.position ?? null });
              } catch { /* noop */ }
              this._antiFixationHits.set(skillClass, []);
            }
            // BUG-018 (2026-05-11): instead of the generic "pick a different
            // objective" hint, look up the prereq chain for the blocked sig
            // and inject a concrete next-step. The overnight run showed
            // bots drifting off-strategy after each generic clear; this
            // points them at the missing resource explicitly.
            const blockedEntry = this._blockedSigs.get(this._canonicalSig(result.action.type, result.action.args));
            const goalHint = deriveBlockedGoalHint(
              result.action.type,
              result.action.args,
              this._bot,
              blockedEntry?.lastError,
            );
            this._forceLookAround(result, {
              setGoal:   goalHint,
              addFailed: `LLM picked ${label} despite BLOCKED banner — brain forced look_around. Hint: ${goalHint.replace(/^BLOCKED: [^—]+— /, '')}`,
            });
          }
        }

        // anti-paralysis: if stationary for the full window AND fixated on one
        // skill class, escalate — look_around x2, then force goal abandonment.
        if (this._isStationary()) {
          if (result.action.type) {
            const recentSameType = this._recentDecisions
              .filter((d) => d.type === result.action.type)
              .length;
            if (recentSameType >= 5) {
              this._stuckCount += 1;
              if (this._stuckCount >= 3) {
                const stuckGoal = this._memory?._state?.current_goal ?? 'current goal';
                console.warn(`[brain:${this._bot.username}] stuck escalation (${this._stuckCount}x) — abandoning goal "${stuckGoal}"`);
                if (this._memory) {
                  try {
                    this._memory.applyUpdate({
                      add_failed: `goal "${stuckGoal}" abandoned — stuck in same ${STATIONARY_RADIUS}m radius for ${Math.round(STATIONARY_WINDOW_MS * this._stuckCount / 1000)}s picking ${result.action.type} repeatedly. Pick a completely different objective.`,
                      set_goal: 'stuck — regroup and pick a new objective unrelated to the previous one',
                    }, { position: this._bot.entity?.position ?? null });
                  } catch { /* noop */ }
                }
                result.action = { type: 'wait', args: { seconds: 30 } };
              } else {
                console.warn(`[brain:${this._bot.username}] paralysis override (${this._stuckCount}/3) — stationary + ${recentSameType}x ${result.action.type} → look_around`);
                if (this._memory) {
                  try {
                    this._memory.applyUpdate({
                      add_failed: `picked ${result.action.type} ${recentSameType}x while stuck in same spot — brain forced look_around. Pick a DIFFERENT skill class next (dig_down, place_block, collect_block, craft).`,
                    }, { position: this._bot.entity?.position ?? null });
                  } catch { /* noop */ }
                }
                result.action = { type: 'look_around', args: { turns: 4 } };
              }
            }
          }
        } else {
          this._stuckCount = 0;
        }

        // anti-loop: same skill+args picked seconds apart — typically caused
        // by a re-trigger storm (hostile, damage, chat) where the same context
        // produces the same answer before the previous skill made progress
        if (result.action.type) {
          const now = Date.now();
          const key = argsKey(result.action.args);
          const recentSame = this._recentDecisions.find((d) =>
            d.type === result.action.type && d.key === key && (now - d.ts) < REPEAT_DECISION_WINDOW_MS,
          );
          if (recentSame) {
            // OVN-015: routine frequency-noise — gate at LOG_LEVEL=debug.
            brainDebug(`[brain:${this._bot.username}] debouncing ${result.action.type}(${argsBrief(result.action.args)}) — picked again ${now - recentSame.ts}ms after last`);
            // OVN-006: escalate persistent re-picks to a failure-log entry so
            // the next prompt's RECENTLY-FAILED banner steers the LLM away.
            const { count } = this._recordDebounce(result.action.type, result.action.args);
            if (count >= DEBOUNCE_ESCALATION_THRESHOLD) {
              const brief = argsBrief(result.action.args);
              this._recordFailure(
                result.action.type,
                result.action.args,
                `debounced ${count}x in 60s — pick a different skill or args`,
              );
              if (this._memory) {
                try {
                  this._memory.applyUpdate({
                    add_failed: `${result.action.type}(${brief}) re-picked and debounced ${count}x in 60s — pick a DIFFERENT skill or different args.`,
                  }, { position: this._bot.entity?.position ?? null });
                } catch { /* noop */ }
              }
            }
            result.action = { type: 'wait', args: { seconds: 3 } };
          } else {
            this._recentDecisions.push({
              ts: now,
              type: result.action.type,
              args: result.action.args,
              key,
              sig: this._canonicalSig(result.action.type, result.action.args),
              ok:  null,                      // mutated in _onSkillDone
            });
            if (this._recentDecisions.length > 12) this._recentDecisions.shift();
          }
        }

        // BUG-012 enforcement: A-B-A-B oscillation with ≥1 fail ⇒ ban both sigs
        // simultaneously and force a goal pop. Runs after _recentDecisions push
        // so the just-picked decision is included in the window.
        if (HARDBLOCK_ENABLED && result.action.type && result.action.type !== 'look_around') {
          const osc = this._detectOscillation();
          if (osc) {
            console.warn(`[brain:${this._bot.username}] BUG-012 oscillation detected — banning ${osc[0].label} <-> ${osc[1].label}`);
            for (const o of osc) {
              const lastErr = this._recentDecisions.findLast?.((d) => d.sig === o.sig && d.ok === false)?.error
                ?? 'oscillation pair';
              const skillName = o.sig.split(':')[0];
              const matched = this._recentDecisions.findLast?.((d) => d.sig === o.sig);
              this._addBlockedSig(skillName, matched?.args ?? {}, lastErr);
            }
            this._forceLookAround(result, {
              setGoal:   `BLOCKED: oscillating between ${osc[0].label} and ${osc[1].label} — pick a different objective`,
              addFailed: `oscillation A-B-A-B between ${osc[0].label} and ${osc[1].label} — both hard-blocked`,
            });
          }
        }

        // BUG-003 enforcement: same sig succeeded N times on a stale goal ⇒
        // pop the goal so the LLM has a chance to recognize completion.
        if (HARDBLOCK_ENABLED && result.action.type && result.action.type !== 'look_around') {
          const sig = this._canonicalSig(result.action.type, result.action.args);
          const blindLabel = this._detectCompletionBlindness(sig);
          if (blindLabel) {
            console.warn(`[brain:${this._bot.username}] BUG-003 completion-blindness — ${blindLabel} succeeded ${COMPLETION_BLIND_THRESHOLD}× on stale goal; forcing goal pop`);
            this._forceLookAround(result, {
              setGoal:   `COMPLETED: ${blindLabel} succeeded repeatedly — pick the next objective`,
              addFailed: `re-picked ${blindLabel} after it already succeeded ${COMPLETION_BLIND_THRESHOLD}× on the same goal — goal popped`,
            });
          }
        }

        // Step 2 (2026-05-10): brain-level stuck-loop EARLY break. Runs AFTER
        // the existing oscillation + completion-blindness checks so they get
        // first crack at the same data — those handle structured patterns
        // (A-B-A-B alternation, all-ok on stale goal); this catches FLAT
        // repetition that neither pattern matches. Composes with the
        // failure-cooldown (which already converted to wait if it tripped) by
        // skipping when the latest ring entry is already wait/look_around.
        if (HARDBLOCK_ENABLED) {
          this._applyStuckLoopEarlyBreak(result);
        }

        // Phase C / C2 (Step 2.5, 2026-05-11): wait-spiral hint. Slot 7's
        // 35-of-40 wait pattern from the 8-bot observation is "learned
        // helplessness" — LLM picks wait while a goal is set because the
        // path is blocked but no other approach has occurred to it. Inject
        // a directional hint into memory so the next prompt cycle sees it
        // and either picks a different approach or pops the goal. The hint
        // does NOT mutate result.action — the action this turn stands; the
        // hint shapes the NEXT turn.
        const currentGoal = this._memory?._state?.current_goal ?? null;
        const waitSpiral = detectWaitSpiral(this._recentDecisions, currentGoal);
        if (waitSpiral.spiral && this._memory) {
          if (this._bot?.username) {
            console.warn(`[brain:${this._bot.username}] wait-spiral — ${waitSpiral.waitCount}/${WAIT_SPIRAL_WINDOW} waits while goal="${currentGoal}"; injecting directional hint`);
          }
          try {
            this._memory.applyUpdate({
              add_failed: `WAIT-SPIRAL: picked wait ${waitSpiral.waitCount} of last ${WAIT_SPIRAL_WINDOW} turns while goal "${currentGoal}" stayed unfulfilled. The current approach is blocked. Either (a) try a fundamentally DIFFERENT skill class (collect_block, dig_block, goto_coord to a new area, place_block) — never wait again next turn — OR (b) abandon this goal via set_goal to something achievable from the current position.`,
            }, { position: this._bot?.entity?.position ?? null });
          } catch { /* noop */ }

          // Step 2.6 hotfix (2026-05-17): if the goal text has an actionable
          // Next-step (collect_block, craft, place_block, drop, ...) AND the
          // LLM picked wait or look_around, deterministically substitute the
          // action with the extracted next-step. The 30-min observation
          // showed 47 wait-spirals on one bot — the hint alone wasn't
          // enough; the LLM kept picking wait. Forcing the action breaks
          // the loop and lets real progress happen.
          const isPassivePick = result.action?.type === 'wait' || result.action?.type === 'look_around';
          if (isPassivePick) {
            const nextStep = extractGoalNextStep(currentGoal);
            if (nextStep) {
              const brief = argsBrief(nextStep.args);
              console.warn(`[brain:${this._bot.username}] wait-spiral substitution — forcing ${nextStep.type}(${brief}) from goal Next-step`);
              try {
                this._memory.applyUpdate({
                  add_failed: `wait-spiral substitution: brain force-ran ${nextStep.type}(${brief}) from the goal's Next-step. The hint had been ignored ${waitSpiral.waitCount} turns — deterministic execution to break the loop.`,
                }, { position: this._bot?.entity?.position ?? null });
              } catch { /* noop */ }
              result.action = nextStep;
            }
          }
        }

        // BUG-001: when the goal is "stuck — regroup ..." (set by the
        // paralysis override above) the LLM frequently still picks wait(30).
        // Force look_around so the bot actually re-perceives its
        // surroundings and has a chance to pick a real next skill.
        {
          const isRegroupGoal = typeof currentGoal === 'string'
            && /^\s*stuck\s*[—-]\s*regroup/i.test(currentGoal);
          if (!isRegroupGoal) {
            this._regroupBreakCount = 0;
          }
          const broken = breakRegroupWait(currentGoal, result.action);
          if (broken !== result.action) {
            this._regroupBreakCount += 1;
            console.warn(`[brain:${this._bot.username}] regroup-wait broken (${this._regroupBreakCount}x) — forcing look_around`);
            result.action = broken;

            // BUG-001 strong break: after repeated regroup-wait overrides the
            // LLM is fixated on the same blocked skill. Pop the bot to a
            // random ±20 horizontal offset and clear failure-log entries for
            // the dominant recent skill so the cognitive lock releases too.
            if (this._regroupBreakCount >= 6) {
              const pos = this._bot?.entity?.position ?? null;
              if (pos) {
                const sign = () => (Math.random() < 0.5 ? -1 : 1);
                const dx = sign() * (10 + Math.floor(Math.random() * 11)); // ±10..±20
                const dz = sign() * (10 + Math.floor(Math.random() * 11));
                const tx = Math.round(pos.x) + dx;
                const tz = Math.round(pos.z) + dz;
                const ty = Math.round(pos.y);

                // Find the dominant non-passive skill in the recent ring and
                // clear its failure-log entries to break the cognitive lock.
                const counts = new Map();
                for (const d of this._recentDecisions) {
                  if (!d?.type || d.type === 'wait' || d.type === 'look_around') continue;
                  counts.set(d.type, (counts.get(d.type) || 0) + 1);
                }
                let dominant = null;
                let max = 0;
                for (const [t, c] of counts) {
                  if (c > max) { max = c; dominant = t; }
                }
                let cleared = 0;
                if (dominant) {
                  const prefix = `${dominant}:`;
                  for (const key of [...this._failureLog.keys()]) {
                    if (key.startsWith(prefix)) {
                      this._failureLog.delete(key);
                      cleared += 1;
                    }
                  }
                }

                console.warn(`[brain:${this._bot.username}] regroup strong-break — goto_coord(${tx},${ty},${tz}); cleared ${cleared} failure entries for "${dominant || 'n/a'}"`);
                result.action = { type: 'goto_coord', args: { x: tx, y: ty, z: tz } };
                if (this._memory) {
                  try {
                    this._memory.applyUpdate({
                      add_failed: `regroup strong-break: ${this._regroupBreakCount} overrides on the same regroup goal — brain force-ran goto_coord(${tx},${ty},${tz}) (±20 offset) and cleared the failure log for ${dominant || 'recent skill'}. Pick a NEW objective from the new position; do NOT return to the previous one.`,
                    }, { position: pos });
                  } catch { /* noop */ }
                }
                this._regroupBreakCount = 0;
              }
            }
          }
        }

        // anti-loop: if the LLM keeps picking chat_only without acting, override to wait
        if (result.action.type === 'chat_only') {
          this._chatOnlyStreak += 1;
          if (this._chatOnlyStreak >= 3) {
            console.warn(`[brain:${this._bot.username}] chat_only x${this._chatOnlyStreak} — substituting wait(4s)`);
            result.action = { type: 'wait', args: { seconds: 4 } };
            // record as a failed attempt so the LLM sees it next turn
            if (this._memory) {
              try { this._memory.applyUpdate({ add_failed: 'looped on chat_only without acting; brain forced a wait' }, { position: this._bot.entity?.position ?? null }); } catch { /* noop */ }
            }
          }
        } else {
          this._chatOnlyStreak = 0;
        }

        // Step 2.6 (2026-05-16): late _recordDecision — captures the FINAL
        // converted action (look_around / wait / etc.) instead of the LLM's
        // pre-conversion pick. The dashboard and watchdog read lastDecision
        // and now see the action that actually runs. Also fires after F1's
        // wait-fallback path because that block already records its own
        // decision and returns early.
        this._recordDecision({
          reason,
          observation: obs,
          say:         result.say,
          action:      result.action,
          memoryUpdate: result.memory_update ?? null,
        });
        this._startSkill(result.action);
      }
    } catch (err) {
      this._reportError(err, 'think');
      // F1: record the failure as a decision so the dashboard knows the brain
      // is alive but errored — otherwise lastDecision stays null indefinitely.
      try {
        this._recordDecision({
          reason,
          observation: `_think threw: ${err?.message || err}`,
          say: '',
          action: { type: 'wait', args: { seconds: 4 } },
          memoryUpdate: null,
          error: err?.message || String(err),
        });
      } catch { /* noop */ }
    } finally {
      this._thinking = false;
      this._thinkStartedAt = 0;
      this._lastTickOkAt = Date.now();
      // Only arm the idle timer when no skill is in flight — _onSkillDone
      // re-arms it (or schedules a real think) when the running skill
      // completes. Without this guard, idle fires mid-skill and supersedes it.
      if (!this._currentSkill) {
        this._scheduleIdleTimer();
      }
      // F11: dequeue the highest-priority pending reason
      if (this._pendingThink && this._running) {
        const next = this._pendingThink.reason;
        this._pendingThink = null;
        this._scheduleThink(next);
      }
      // dev-mode: detect silent exits where neither (a) a future think is
      // scheduled nor (b) brainStatus is non-active with a populated reason.
      // No-op in production.
      if (isBrainDevAssertEnabled()) {
        this._checkThinkExitInvariant(reason);
      }
    }
  }

  _checkThinkExitInvariant(thinkReason) {
    const ok = thinkExitInvariantHolds({
      idleTimer:    this._idleTimer,
      currentSkill: this._currentSkill,
      pendingThink: this._pendingThink,
      brainStatus:  this._brainStatus,
      reason:       this._brainStatusReason,
    });
    if (ok) {
      this._lastInvariantViolation = null;
      return;
    }
    const msg = '_think exited without scheduling next think and brainStatus is "active" with no reason — silent exit detected';
    this._lastInvariantViolation = {
      ts: Date.now(),
      thinkReason,
      msg,
    };
    const username = this._bot?.username ?? '?';
    console.error(`[brain:${username}] DEV ASSERT (_think exit invariant): ${msg}; thinkReason=${thinkReason}`);
  }

  _scheduleIdleTimer() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => this._scheduleThink('idle'), this._idleRethinkMs);
  }

  // -------------------------------------------------------------------------
  // skills
  // -------------------------------------------------------------------------
  _startSkill(action) {
    this._cancelCurrentSkill('superseded');
    // While a skill is running, the idle re-think timer must NOT fire — it
    // would supersede the skill mid-pathfind and the bot would never finish
    // a long flee or pathfind. _onSkillDone re-arms the next think.
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    if (this._watchdogTimer) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    const ac = new AbortController();
    const skill = {
      name: action.type,
      args: action.args ?? {},
      abort: () => ac.abort(),
      startedAt: Date.now(),
    };
    this._currentSkill = skill;

    // hard timeout — pathfinder occasionally hangs when no path can be found
    // and the skill never resolves. Watchdog aborts and forces a re-think.
    this._watchdogTimer = setTimeout(() => {
      if (this._currentSkill === skill) {
        console.warn(`[brain:${this._bot.username}] watchdog firing — ${skill.name}(${argsBrief(skill.args)}) ran ${Math.round((Date.now()-skill.startedAt)/1000)}s without resolving`);
        // OVN-008: record failure synchronously so the LLM's next prompt sees
        // it without waiting for the abort race to resolve via _onSkillDone.
        try {
          this._recordFailure(
            skill.name,
            skill.args,
            `skill ran ${Math.round(SKILL_WATCHDOG_MS / 1000)}s without resolving — target likely unreachable`,
          );
        } catch { /* noop */ }
        try { skill.abort(); } catch { /* noop */ }
        try { this._bot.pathfinder?.setGoal(null); } catch { /* noop */ }
      }
    }, SKILL_WATCHDOG_MS);

    const fn = SKILLS[action.type] ?? SKILLS.wait;
    const ctx = { bot: this._bot, signal: ac.signal, mcData: this._mcData };

    Promise.resolve()
      .then(() => fn(ctx, skill.args))
      .catch((err) => ({ ok: false, error: err?.message || String(err) }))
      .then((outcome) => this._onSkillDone(skill, outcome ?? { ok: true }));
  }

  _cancelCurrentSkill(reason) {
    if (!this._currentSkill) return;
    const skill = this._currentSkill;
    this._currentSkill = null;
    try { skill.abort(); } catch { /* noop */ }
    try { this._bot.pathfinder?.setGoal(null); } catch { /* noop */ }
    this._clearControls();
    if (SKILL_CANCEL_FAILURE_REASONS.has(reason)) {
      this._recordFailure(skill.name, skill.args, `cancelled (${reason})`);
    }
    // Step 2: record jump_loop cancels into a per-(skill,argsKey) log so the
    // collect_block × jump_loop recovery layer can detect target-specific
    // geographic stuck-spots. Distinct from _failureLog which aggregates by
    // skill+args generically — this log is jump-loop-only and 60s-windowed.
    if (reason === 'jump_loop') {
      this._recordJumpLoopCancel(skill.name, skill.args);
    }
    this._emit('skill_cancelled', { skill: skill.name, reason });
  }

  _onSkillDone(skill, outcome) {
    // Step 2.6 (2026-05-16): split-path recording. Early-trip (deterministic)
    // failures are recorded synchronously BEFORE the cancelled-skill early-
    // return so the cooldown ring sees them even when _cancelCurrentSkill
    // ran ahead. Non-early-trip outcomes (transient errors, "aborted") are
    // recorded AFTER the early-return — that path already records cancels
    // via _cancelCurrentSkill, so double-recording here would trip the
    // SKILL_FAIL_THRESHOLD=2 cooldown one step too early.
    const isEarly = outcome && outcome.ok === false
      && isEarlyTripError(outcome.error, outcome.error_code);
    if (isEarly) {
      this._recordFailure(skill.name, skill.args, outcome.error, outcome.error_code);
    }
    if (this._currentSkill !== skill) return; // already cancelled
    this._currentSkill = null;
    if (this._watchdogTimer) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    if (outcome && outcome.ok === false && !isEarly) {
      this._recordFailure(skill.name, skill.args, outcome.error, outcome.error_code);
    }
    // BUG-003/012: record skill success/failure on the matching recent decision
    // so the oscillation + completion-blindness detectors have outcome data.
    const sig = this._canonicalSig(skill.name, skill.args);
    for (let i = this._recentDecisions.length - 1; i >= 0; i--) {
      if (this._recentDecisions[i].sig === sig && this._recentDecisions[i].ok === null) {
        this._recentDecisions[i].ok = outcome ? outcome.ok !== false : true;
        if (outcome?.error) this._recentDecisions[i].error = outcome.error;
        break;
      }
    }
    this.lastSkillResult = {
      skill:      skill.name,
      args:       skill.args,
      outcome,
      durationMs: Date.now() - skill.startedAt,
      ts:         Date.now(),
    };
    this._emit('skill_done', this.lastSkillResult);

    // Phase A4 (Step 2.5+, 2026-05-12): auto-execute recovery hint. When a
    // failed skill returns { recovery: { skill, args } } (use_block out_of_range
    // emits goto_coord, see SKILLS.use_block), run the recovery directly
    // instead of waiting for the LLM to translate the error text. Skipped when
    // already auto-recovering, so a failing recovery falls through into the
    // normal re-think path with both failures recorded in memory.
    const rec = outcome?.recovery;
    if (
      AUTO_RECOVERY_ENABLED &&
      outcome && outcome.ok === false &&
      rec && typeof rec === 'object' &&
      typeof rec.skill === 'string' &&
      SKILLS[rec.skill] &&
      !this._autoRecovering
    ) {
      const recArgsBrief = argsBrief(rec.args ?? {});
      const tag = outcome.error_code || 'recovery_hint';
      console.warn(`[brain:${this._bot.username}] auto-recovery — ${skill.name}(${argsBrief(skill.args)}) → ${tag}; running ${rec.skill}(${recArgsBrief})`);
      if (this._memory) {
        try {
          this._memory.applyUpdate({
            add_failed: `${skill.name}(${argsBrief(skill.args)}) → ${tag}; brain auto-ran ${rec.skill}(${recArgsBrief}).`,
          }, { position: this._bot.entity?.position ?? null });
        } catch { /* noop */ }
      }
      this._autoRecovering = true;
      this._startSkill({ type: rec.skill, args: rec.args ?? {} });
      return;
    }
    // Clear the auto-recovery flag — either this _onSkillDone is the recovery
    // skill itself finishing (success or fail) or no recovery was in play.
    this._autoRecovering = false;

    // Step 2.6 (2026-05-16): post-craft stick nudge. The 30h Step 2.5
    // overnight produced 69 plank crafts but only 1 stick craft — the LLM
    // jumped straight from "I have planks" to "craft wooden_pickaxe". When a
    // plank craft succeeds and the bot has no sticks (and no current_goal
    // already pointing at sticks), inject an explicit "craft sticks next"
    // goal so the next _think turn sees it. derivePostCraftNudge is pure
    // and exported for test coverage.
    if (this._memory && outcome && outcome.ok === true && skill.name === 'craft') {
      const currentGoal = this._memory?._state?.current_goal ?? '';
      const nudge = derivePostCraftNudge(skill.name, skill.args, outcome, this._bot, currentGoal);
      if (nudge) {
        try {
          this._memory.applyUpdate(nudge, { position: this._bot.entity?.position ?? null });
          if (nudge.set_goal) {
            this._goalChangedAt = Date.now();
            this._lastKnownGoal = nudge.set_goal;
          }
        } catch { /* noop */ }
      }
    }

    // no-op skills (wait/chat_only/stop) finish near-instantly — re-thinking
    // immediately just burns API calls. Let the idle timer handle them.
    if (!NO_OP_SKILLS.has(skill.name)) {
      this._scheduleThink(`skill_done:${skill.name}`);
    } else {
      this._scheduleIdleTimer();
    }
  }

  // -------------------------------------------------------------------------
  // observation
  // -------------------------------------------------------------------------
  _observe(reason) {
    const bot = this._bot;
    const pos = bot.entity.position;
    const time = bot.time?.timeOfDay ?? 0;
    const isDay = time < 13000 || time > 23000;

    // record position for stationary detection
    const now = Date.now();
    this._positionHistory.push({ ts: now, x: pos.x, y: pos.y, z: pos.z });
    // keep only entries inside the stationary window
    const cutoff = now - STATIONARY_WINDOW_MS;
    while (this._positionHistory.length > 0 && this._positionHistory[0].ts < cutoff) {
      this._positionHistory.shift();
    }

    const nearbyEnts = Object.values(bot.entities ?? {})
      .filter(e => e !== bot.entity && e.position && !isNaN(e.position.x))
      .map(e => {
        const dx = e.position.x - pos.x, dz = e.position.z - pos.z;
        return { name: e.name ?? e.type, d: Math.round(Math.sqrt(dx*dx + dz*dz)) };
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, 6)
      .map(e => `${e.name} ~${e.d}m`)
      .join(', ') || 'nothing nearby';

    // Phase C / C1 (Step 2.5, 2026-05-11): structured surroundings replaces
    // the prior "first hit per block-name" list. Lists 5 closest tree-bearing
    // logs + 5 closest mineable ores + the bot's compass facing, with full
    // (x,y,z) coords so the LLM can goto_coord directly instead of
    // re-discovering by goto_block / collect_block + range guesses.
    const surroundings = summarizeSurroundings(bot, this._mcData);

    const invMap = new Map();
    for (const slot of Object.values(bot.inventory?.slots ?? {})) {
      if (!slot) continue;
      invMap.set(slot.name, (invMap.get(slot.name) ?? 0) + slot.count);
    }
    const inv = invMap.size
      ? [...invMap.entries()].map(([n, c]) => `${c}x ${n}`).join(', ')
      : 'empty';

    const stateLines = [
      `Trigger: ${reason}`,
      `Position: ${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}  (${isDay ? 'day' : 'night'})`,
      `Health: ${Math.round(bot.health ?? 20)}/20  Food: ${Math.round(bot.food ?? 20)}/20`,
      `Nearby entities: ${nearbyEnts}`,
      `Surroundings: ${surroundings.toString()}`,
      `Inventory: ${inv}`,
      `Last thing I said: "${this._lastSaid || 'nothing yet'}"`,
    ];

    if (this._chatOnlyStreak >= 2) {
      stateLines.unshift(`WARNING: chat_only ${this._chatOnlyStreak}x in a row without acting. Pick a real skill (craft / collect_block / goto_block / wait) — DO NOT chat_only again.`);
    }

    // STATIONARY hint — if the bot's barely moved over the window, the LLM
    // is presumably picking the same dead-end action and we should call it out
    if (this._positionHistory.length >= 3) {
      const oldest = this._positionHistory[0];
      const ageMs = now - oldest.ts;
      if (ageMs >= STATIONARY_WINDOW_MS - 5000) {
        const dx = pos.x - oldest.x, dy = pos.y - oldest.y, dz = pos.z - oldest.z;
        const drift = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (drift <= STATIONARY_RADIUS) {
          // Bug 3: don't suggest skills that are already blocked. Build a
          // dynamic suggestion list excluding the ones currently failing.
          const blockedNames = new Set();
          for (const [key, arr] of this._failureLog) {
            if (arr.length >= SKILL_FAIL_THRESHOLD) {
              blockedNames.add(key.split(':')[0]);
            }
          }
          const allOptions = [
            { skill: 'look_around', hint: 'look_around to scan surroundings' },
            { skill: 'pillar_up', hint: 'pillar_up to climb out if you have any blocks (dirt, cobblestone, anything)' },
            { skill: 'goto_coord', hint: 'goto_coord to a HORIZONTAL spot you have never tried (pick |dx|+|dz| > 8, keep y within 3 of current)' },
            { skill: 'collect_block', hint: 'collect_block on something visible to make ANY forward progress' },
            { skill: 'dig_block', hint: 'dig_block at a specific coord adjacent to you to break out' },
            { skill: 'dig_down', hint: 'dig_down to descend (only if footing is solid)' },
            { skill: 'place_block', hint: 'place_block to wall yourself in for safety' },
          ];
          const usable = allOptions.filter((o) => !blockedNames.has(o.skill));
          const pool = usable.length >= 3 ? usable : allOptions;
          const suggestions = pool.slice(0, 3).map((o) => o.hint).join(' OR ');
          stateLines.unshift(`STATIONARY: position has barely changed (${drift.toFixed(1)}m drift) for ${Math.round(ageMs/1000)}s. Whatever you've been picking is NOT working. Pick a SKILL CLASS you have NOT tried in the last minute. Suggested: ${suggestions}. Whatever you do — DO NOT pick the same skill+args you've already failed twice.`);
        }
      }
    }

    // put blocked actions at the TOP — they are the most important constraint
    // for the LLM's next pick, otherwise they get buried under inventory data
    const blocked = this._blockedActionsSummary();
    if (blocked.length) {
      stateLines.unshift(`RECENTLY FAILED — DO NOT RETRY: ${blocked.join(' | ')}. Pick a DIFFERENT skill or args.`);
    }

    // BUG-001 hard-block — sits ABOVE the soft RECENTLY FAILED hint. These sigs
    // crossed the failure threshold and are deterministically refused for 5 min.
    if (HARDBLOCK_ENABLED) {
      const hardBlock = this._blockedSigsBlock();
      if (hardBlock) stateLines.unshift(hardBlock);
    }

    // Bug 8: if we just handled a jump-loop within the last 30s, surface that
    // explicitly so the LLM doesn't reschedule the same upward goto_coord.
    if (this._lastJumpLoopHint && (now - this._lastJumpLoopHint) < 30000) {
      stateLines.unshift(`JUMP-LOOP RECOVERY: just escaped a jump loop. DO NOT pick goto_coord with y above current+5, and do NOT pick jump alone for height. Use pillar_up to climb, or pick a horizontal-only objective for the next few turns.`);
    }

    // surface the most recent player message prominently when a chat triggered the think
    if (reason && reason.startsWith('chat:') && this._memory) {
      const who = reason.slice(5);
      const last = this._memory.latestIncomingChat?.(who);
      if (last) {
        stateLines.unshift(`PLAYER JUST SAID — ${who}: "${String(last.text).slice(0, 200)}" — acknowledge it directly.`);
      }
    }

    if (this._memory) {
      // Bug 9: hand current position to memory so spatial filtering of
      // learned facts uses up-to-date coords this tick.
      this._memory.setRenderPosition?.({ x: pos.x, y: pos.y, z: pos.z });
    }
    const ctx = this._memory ? this._memory.contextBlock() : null;
    return ctx ? `${ctx}\n\n--- LIVE STATE ---\n${stateLines.join('\n')}` : stateLines.join('\n');
  }

  // -------------------------------------------------------------------------
  // LLM
  // -------------------------------------------------------------------------
  async _callLLM(observation) {
    // Fleet-wide rate gate — runs before the per-bot hard timeout below so
    // the bucket wait does not consume the abort timer's budget.
    const _bucketT0 = Date.now();
    await _fleetBucket.consume();
    const _bucketWaitMs = Date.now() - _bucketT0;
    if (_bucketWaitMs > 500) console.info(`fleet-bucket-wait: ${_bucketWaitMs}ms (bot=${this._bot.username})`);

    const params = {
      model:    USE_OPENROUTER ? OPENROUTER_MODEL
              : USE_OPENAI    ? OPENAI_MODEL
              : USE_LOCAL_LLM ? LOCAL_LLM_MODEL
              : CEREBRAS_MODEL,
      messages: [
        { role: 'system', content: buildSystemPrompt(this._blockedSigs, this._systemPromptOverride ?? undefined) },
        { role: 'user',   content: `Current state:\n${observation}\n\nWhat skill do you run next?` },
      ],
    };
    if (USE_OPENAI) {
      // gpt-5-nano is a reasoning model: uses max_completion_tokens, rejects
      // custom temperature/top_p (only default=1 allowed). reasoning_effort
      // 'low' keeps per-tick decisions snappy.
      params.max_completion_tokens = 1500;
      params.reasoning_effort      = 'low';
    } else {
      // OpenRouter (DeepSeek-V3), local (Ollama), and Cerebras all use the
      // standard chat-completions param shape.
      params.max_tokens  = 1500;
      params.temperature = 0.7;
      params.top_p       = 0.8;
    }
    if (USE_OPENROUTER) {
      // OpenRouter provider routing: prefer fastest-throughput backends and
      // fall through to another provider if one is slow/down. This is what
      // kills the timeout-storm failure mode that DeepSeek's single direct
      // endpoint produced under 5-bot load. To pin one backend for stricter
      // reproducibility, replace `sort` with e.g. `order: ['fireworks']`.
      params.provider = { sort: 'throughput', allow_fallbacks: true };
      // DeepSeek V4/V3.x are hybrid reasoning models: if thinking is on they
      // emit a long chain-of-thought before the JSON, which blows the 30s
      // abort and re-creates the very timeouts we're fixing. This is a fast
      // real-time decision loop, not a reasoning task — keep thinking OFF.
      params.reasoning = { enabled: false };
    }

    // Hard timeout via AbortController (per attempt) — without this a single
    // hung request freezes the brain loop forever (Test5 obs-07 / Bug 7).
    // Wrapped in a jittered retry so a transient slow response or 429/5xx is
    // retried once before falling back to `wait`.
    let res, lastErr, lastAborted = false;
    for (let attempt = 1; attempt <= LLM_RETRY_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LLM_CALL_TIMEOUT_MS);
      try {
        res = await this._client.chat.completions.create(params, { signal: controller.signal });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        lastAborted = err?.name === 'AbortError' || controller.signal.aborted;
        const status = err?.status ?? null;
        // Retry transient failures only: timeout/abort, rate-limit (429),
        // server errors (5xx), or a network error with no HTTP status.
        const retryable = lastAborted || status === 429 || status >= 500 || status == null;
        if (attempt < LLM_RETRY_ATTEMPTS && retryable) {
          const backoff = LLM_RETRY_BASE_MS * Math.pow(2, attempt - 1);
          const jitter  = Math.floor(Math.random() * LLM_RETRY_JITTER_MS);
          console.warn(`llm-retry ${attempt}/${LLM_RETRY_ATTEMPTS - 1}: ${lastAborted ? 'timeout' : (status ?? 'network')} (bot=${this._bot.username}, in ${backoff + jitter}ms)`);
          await new Promise((r) => setTimeout(r, backoff + jitter));
          continue;
        }
        break;
      } finally {
        clearTimeout(timer);
      }
    }
    if (lastErr) {
      const err = lastErr;
      const reason = lastAborted ? `LLM call exceeded ${LLM_CALL_TIMEOUT_MS}ms — aborted` : `LLM call: ${err?.message || err}`;
      this._reportError(err, 'callLLM');
      // Phase B / B1 (Step 2.5, 2026-05-11): when the API itself returns 429
      // AFTER the fleet bucket admitted the request, the bucket cap is too
      // high — the API is now the bottleneck, not us. Distinct from the
      // "fleet-bucket-wait" log which fires when the bucket throttled. If
      // this fires repeatedly at 6 req/s (Step 2.6's raised cap), drop the
      // cap back toward 5 (or the API quota was lowered).
      if (err?.status === 429) {
        console.warn(`llm-429: post-bucket after ${LLM_RETRY_ATTEMPTS} tries — cap may be too high (bot=${this._bot.username}, bucket-wait=${_bucketWaitMs}ms)`);
      }
      // Fall back to a short wait so the loop can pick up next tick rather
      // than crashing the whole think cycle. Status is attached so the caller
      // can drive the backoff path (F8) and dashboard surface (F3).
      return {
        say: '',
        action: { type: 'wait', args: { seconds: 2 } },
        _llm_error: reason,
        _llm_error_status: err?.status ?? null,
      };
    }
    const raw = res.choices[0]?.message?.content?.trim() ?? '{}';
    try {
      const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      const parsed = JSON.parse(cleaned);
      if (parsed.action && !parsed.action.args) parsed.action.args = {};
      return parsed;
    } catch {
      return { say: raw.slice(0, 200), action: { type: 'wait', args: { seconds: 2 } } };
    }
  }

  // -------------------------------------------------------------------------
  // F1: single point of decision recording — guarantees lastDecision and the
  // emit/onDecision side-effects always run together, even on the error path.
  // -------------------------------------------------------------------------
  _recordDecision({ reason, observation, say, action, memoryUpdate, error = null }) {
    this.lastDecision = {
      reason,
      observation,
      say:           say ?? null,
      action:        action ?? null,
      memory_update: memoryUpdate ?? null,
      error:         error,
      ts:            Date.now(),
    };
    // a fresh decision means the brain is alive — return to 'active' so the
    // _think exit invariant does not require an explicit reason on this path.
    if (this._running) {
      this._brainStatus       = 'active';
      this._brainStatusReason = null;
    }
    this._emit('decision', this.lastDecision);
    if (this._onDecision) {
      try {
        this._onDecision({
          mcDay:       this._bot.time?.day       ?? 0,
          mcTick:      this._bot.time?.timeOfDay ?? 0,
          observation,
          say:         say    ?? null,
          action:      action ?? null,
        });
      } catch { /* noop */ }
    }
  }

  // -------------------------------------------------------------------------
  // F8: LLM availability bookkeeping
  // -------------------------------------------------------------------------
  _llmInBackoff() {
    return this._llmBackoffUntil > Date.now();
  }

  _noteLLMError(status, message) {
    this._consecutiveLLMErrors += 1;
    // exponential backoff: 5s, 10s, 20s, 40s, 60s (capped — Step 2.6 lowered
    // the ceiling from 300s). Pure doubling logic lives in computeBackoffNext
    // so the test suite can exercise the schedule without touching brain state.
    this._llmBackoffMs    = computeBackoffNext(this._llmBackoffMs);
    this._llmBackoffUntil = Date.now() + this._llmBackoffMs;
    const truncMsg = String(message || 'unknown').slice(0, 200);
    this.lastError = { ts: Date.now(), status: status ?? null, message: truncMsg };
    // OVN-013: keep the most recent error around so _noteLLMSuccess can name
    // it in the recovery log. Lets us tell rate-limit (429) from network
    // (ECONNRESET) from server (5xx) without scraping bot stderr.
    this._lastLLMErrorSnapshot = { status: status ?? null, message: truncMsg.slice(0, 80), at: Date.now() };
    // one-shot user-visible chat after a few errors so a watcher knows the bot
    // isn't dead — just offline. Best-effort; if chat throws (disconnected,
    // reconnecting), we just swallow it.
    if (!this._llmOfflineNoticeSent && this._consecutiveLLMErrors >= LLM_OFFLINE_CHAT_AFTER) {
      this._llmOfflineNoticeSent = true;
      try { this._bot.chat('brain offline — LLM unavailable, waiting for it to recover'); } catch { /* noop */ }
    }
  }

  _noteLLMSuccess() {
    if (this._consecutiveLLMErrors > 0) {
      // OVN-013: surface the last error so cluster patterns (e.g. 5 bots
      // recovering from 429 simultaneously) are debuggable from one log.
      const snap = this._lastLLMErrorSnapshot;
      const tail = snap ? ` (last: ${snap.status ?? '?'} ${snap.message || 'unknown'})` : '';
      console.log(`[brain:${this._bot.username}] LLM recovered after ${this._consecutiveLLMErrors} consecutive errors${tail}`);
    }
    this._consecutiveLLMErrors = 0;
    this._llmBackoffMs = 0;
    this._llmBackoffUntil = 0;
    this._llmOfflineNoticeSent = false;
    this._lastLLMErrorSnapshot = null;
    this.lastError = null;
  }

  // -------------------------------------------------------------------------
  // F12 / F8 helpers — distinguish "panic" reflex inputs without LLM
  // -------------------------------------------------------------------------
  _spawnKillBoxDetected() {
    const bot = this._bot;
    const me  = bot.entity?.position;
    if (!me) return false;
    if ((bot.inventory?.items?.() ?? []).length > 0) return false; // not naked
    let count = 0;
    for (const e of Object.values(bot.entities ?? {})) {
      if (e === bot.entity) continue;
      // OVN-010: drop e.mobType — see comment on _checkHostiles for context.
      const name = (e.name ?? '').toLowerCase();
      if (!HOSTILE_TYPES.has(name)) continue;
      if (!e.position || isNaN(e.position.x)) continue;
      const dx = e.position.x - me.x, dz = e.position.z - me.z;
      if (Math.sqrt(dx*dx + dz*dz) <= SPAWN_REFLEX_RADIUS) count += 1;
      if (count >= SPAWN_REFLEX_HOSTILES) return true;
    }
    return false;
  }

  _closestHostileType() {
    const bot = this._bot;
    const me  = bot.entity?.position;
    if (!me) return null;
    let bestName = null, bestD = Infinity;
    for (const e of Object.values(bot.entities ?? {})) {
      if (e === bot.entity) continue;
      // OVN-010: drop e.mobType — see comment on _checkHostiles for context.
      const name = (e.name ?? '').toLowerCase();
      if (!HOSTILE_TYPES.has(name)) continue;
      if (!e.position || isNaN(e.position.x)) continue;
      const dx = e.position.x - me.x, dz = e.position.z - me.z;
      const d = Math.sqrt(dx*dx + dz*dz);
      if (d < bestD) { bestD = d; bestName = name; }
    }
    return bestName;
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------
  _positionValid() {
    const p = this._bot.entity?.position;
    return p != null && !isNaN(p.x) && !isNaN(p.z);
  }

  _clearControls() {
    for (const ctrl of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
      try { this._bot.setControlState(ctrl, false); } catch { /* noop */ }
    }
  }

  _emit(type, data) {
    if (this._onEvent) {
      try { this._onEvent({ type, data, ts: Date.now() }); } catch { /* noop */ }
    }
  }

  // OVN-019 (overnight Fix #2, 2026-05-09): write a memory entry on death
  // naming the death location so the next prompt's RECENTLY-FAILED block
  // explicitly warns the LLM off that spot. Without this, the brain re-decides
  // with only the "[death]" reason tag and frequently picks a goto_coord
  // straight back to the danger (Test53 example: died at y=38 → next decision
  // goto_coord(y=-37), 75 blocks straight down into the deathfall).
  _recordDeathLocation(pos) {
    if (!this._memory) return;
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return;
    const x = Math.round(pos.x), y = Math.round(pos.y), z = Math.round(pos.z);
    // BUG-025 (Path 2, 2026-05-18): name the dropped items + give a
    // recovery deadline. Mineflayer's death event fires AFTER the bot's
    // inventory is already cleared, so use the snapshot taken at the
    // start of the most recent think tick. Items despawn 5 min after
    // they hit the ground.
    const snapshot = (this._lastKnownInventory ?? [])
      .filter((it) => it && it.count > 0)
      .map((it) => `${it.count}x ${it.name}`);
    const dropList = snapshot.length ? snapshot.slice(0, 12).join(', ') : '(inventory snapshot empty — bot may have spawned in)';
    const more = snapshot.length > 12 ? ` +${snapshot.length - 12} more` : '';
    const despawnAtMs = Date.now() + 5 * 60_000;
    const despawnIso = new Date(despawnAtMs).toISOString().slice(11, 19) + 'Z';
    const anchorName = `death_${Date.now().toString(36).slice(-6)}`;
    try {
      this._memory.applyUpdate({
        add_failed: `DIED at (${x},${y},${z}). DROPPED: ${dropList}${more}. Items DESPAWN at ~${despawnIso} (5 min from death). Wiki: to recover, set_goal "recover death drops at (${x},${y},${z})" then goto_coord(x=${x},z=${z},y=${y}) and goto_item(range=32). After despawn the items are gone. WARNING: you respawn at world spawn or your bed — usually far from this point. Walking back through hostile terrain may take longer than 5 min; weigh the tradeoff vs. just re-grinding.`,
        add_anchor: { name: anchorName, note: `death at (${x},${y},${z}) — drops despawn ${despawnIso}` },
      }, { position: { x, y, z } });
    } catch { /* noop */ }
  }

  // ---- per-skill failure cooldown -----------------------------------------
  // BUG-023 (Path 2, 2026-05-18): goal-aging signal. Tracks consecutive
  // think-ticks where current_goal, inventory size, and bot position have
  // ALL been unchanged. After GOAL_AGING_THRESHOLD ticks, pushes an
  // add_failed annotation describing the stall — pure information, no
  // goal override. The LLM owns the decision to set_goal to something
  // else (or to keep trying).
  _checkGoalAging() {
    if (!this._memory) return;
    const currentGoal = this._memory?._state?.current_goal ?? null;
    if (!currentGoal) {
      this._goalAgingTurns = 0;
      this._goalAgingLastFiredAt = 0;
      return;
    }
    const invItems = this._bot?.inventory?.items?.() ?? [];
    const invSize  = invItems.reduce((s, i) => s + (i.count | 0), 0);
    const pos      = this._bot?.entity?.position;
    const prevPos  = this._goalAgingLastPos;
    let posDelta = Infinity;
    if (pos && prevPos) {
      const dx = (pos.x | 0) - prevPos.x;
      const dy = (pos.y | 0) - prevPos.y;
      const dz = (pos.z | 0) - prevPos.z;
      posDelta = Math.sqrt(dx*dx + dy*dy + dz*dz);
    }
    const goalChanged = currentGoal !== this._goalAgingLastGoal;
    const invChanged  = invSize !== this._goalAgingLastInvSize;
    const posMoved    = posDelta >= GOAL_AGING_POS_THRESHOLD;
    if (goalChanged || invChanged || posMoved) {
      this._goalAgingTurns = 0;
      this._goalAgingLastFiredAt = 0;
    } else {
      this._goalAgingTurns += 1;
    }
    this._goalAgingLastGoal    = currentGoal;
    this._goalAgingLastInvSize = invSize;
    if (pos) this._goalAgingLastPos = { x: pos.x | 0, y: pos.y | 0, z: pos.z | 0 };
    if (this._goalAgingTurns >= GOAL_AGING_THRESHOLD &&
        (this._goalAgingTurns - this._goalAgingLastFiredAt) >= GOAL_AGING_COOLDOWN) {
      try {
        this._memory.applyUpdate({
          add_failed: `GOAL STALLED: current_goal "${currentGoal}" has been your goal for ${this._goalAgingTurns} consecutive think-ticks with ZERO observable progress — no inventory change, no position change (drift <${GOAL_AGING_POS_THRESHOLD} blocks). The wiki strongly suggests this goal is not reachable from your current location. Either set_goal to a smaller intermediate sub-task that you CAN observe progress on (move N blocks, place a single block, collect 1 item) OR abandon this goal entirely via set_goal to something completely different. The brain is not going to choose for you.`,
        }, { position: pos ?? null });
      } catch { /* noop */ }
      this._goalAgingLastFiredAt = this._goalAgingTurns;
      if (this._bot?.username) {
        console.warn(`[brain:${this._bot.username}] goal-aging — "${currentGoal}" stalled for ${this._goalAgingTurns} turns; logging annotation`);
      }
    }
  }

  // BUG-025 (Path 2, 2026-05-18): stash advisor. When the bot holds
  // progression-tier items in main inventory AND no anchor named with
  // 'chest'/'stash'/'home'/'base' is known, push a one-shot annotation:
  // "Wiki: place a chest and deposit these before mining further — death
  // drops everything." Fires at most once every STASH_ADVISOR_COOLDOWN
  // think ticks to avoid spam. Path 2: info only.
  _checkStashAdvisor() {
    if (!this._memory) return;
    const turnsSinceFired = this._goalAgingTurns - (this._stashAdvisorLastFire || 0);
    if (this._stashAdvisorLastFire > 0 && turnsSinceFired < STASH_ADVISOR_COOLDOWN) return;
    const items = this._lastKnownInventory ?? [];
    const valuableNames = [
      'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe',
      'iron_ingot', 'gold_ingot', 'diamond', 'emerald', 'netherite_ingot',
      'raw_iron', 'raw_gold', 'ancient_debris',
      'iron_axe', 'iron_sword', 'iron_shovel', 'iron_hoe',
      'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots',
      'diamond_axe', 'diamond_sword', 'diamond_shovel', 'diamond_hoe',
      'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots',
      'totem_of_undying', 'enchanted_book', 'enchanted_golden_apple',
    ];
    const valuable = items.filter((i) => valuableNames.includes(i.name) && i.count > 0);
    if (valuable.length === 0) return;
    const anchors = this._memory?._state?.anchors ?? [];
    const hasStashAnchor = anchors.some((a) =>
      /chest|stash|home|base|storage/i.test(a?.name ?? ''),
    );
    if (hasStashAnchor) return;
    const list = valuable.slice(0, 6).map((i) => `${i.count}x ${i.name}`).join(', ');
    const more = valuable.length > 6 ? ` +${valuable.length - 6} more` : '';
    try {
      this._memory.applyUpdate({
        add_failed: `STASH ADVISORY: you are holding progression-tier items (${list}${more}) in your main inventory with no chest/stash/home anchor known. Wiki: a player would place_block(chest), deposit_chest these items, then add_anchor name="home_stash" before continuing to mine. If you die now, ALL of these drop at the death point and despawn in 5 min. This annotation will not repeat until you act on it (or for several more turns). The brain is not setting your goal; you decide.`,
      }, { position: this._bot?.entity?.position ?? null });
    } catch { /* noop */ }
    this._stashAdvisorLastFire = this._goalAgingTurns;
    if (this._bot?.username) {
      console.warn(`[brain:${this._bot.username}] stash-advisor — ${valuable.length} valuable items in main inventory, no stash anchor; logging advisory`);
    }
  }

  // errorCode (optional) is the skill's structured failure tag — see EARLY_TRIP_CODES.
  // Passing it through lets isEarlyTripError fire at threshold 1 without depending on
  // a regex match against the human-readable error string.
  _recordFailure(skill, args, error, errorCode = null) {
    const key = `${skill}:${argsKey(args)}`;
    const cutoff = Date.now() - SKILL_FAIL_WINDOW_MS;
    const arr = (this._failureLog.get(key) || []).filter((e) => e.ts >= cutoff);
    arr.push({
      ts: Date.now(),
      error: String(error || 'unknown').slice(0, 120),
      errorCode: errorCode || null,
    });
    this._failureLog.set(key, arr);
  }

  _pruneFailureLog() {
    const cutoff = Date.now() - SKILL_FAIL_WINDOW_MS;
    for (const [key, arr] of this._failureLog) {
      const recent = arr.filter((e) => e.ts >= cutoff);
      if (recent.length === 0) this._failureLog.delete(key);
      else if (recent.length !== arr.length) this._failureLog.set(key, recent);
    }
  }

  _recentFailures(skill, args) {
    const key = `${skill}:${argsKey(args)}`;
    const cutoff = Date.now() - SKILL_FAIL_WINDOW_MS;
    return (this._failureLog.get(key) || []).filter((e) => e.ts >= cutoff);
  }

  // OVN-005/009: returns truthy when the (skill, args) combo should be auto-
  // blocked (substituted with a wait + add_failed entry). Threshold drops to
  // SKILL_FAIL_THRESHOLD_EARLY for deterministic errors that can't get better
  // on retry (e.g. "no crafting_table in inventory").
  _isBlockedSkill(skill, args) {
    const fails = this._recentFailures(skill, args);
    if (fails.length === 0) return null;
    const last = fails[fails.length - 1];
    const earlyTrip = isEarlyTripError(last.error, last.errorCode);
    const threshold = earlyTrip ? SKILL_FAIL_THRESHOLD_EARLY : SKILL_FAIL_THRESHOLD;
    if (fails.length >= threshold) return { fails, lastError: last.error, lastErrorCode: last.errorCode, earlyTrip };
    return null;
  }

  _blockedActionsSummary() {
    this._pruneFailureLog();
    return summarizeBlockedActions(this._failureLog);
  }

  // -------------------------------------------------------------------------
  // BUG-001/003/012 hard-block layer
  // -------------------------------------------------------------------------
  // Canonical signature for a (skill, args) pair — uses the same ARGS_IGNORE
  // canonicalization as the failure log, so volume knobs (count, range, etc.)
  // collide on one sig.
  _canonicalSig(skill, args) {
    return `${skill}:${argsKey(args)}`;
  }

  _addBlockedSig(skill, args, lastError, errorCode = null) {
    // When the failure is "no X in inventory", strip x/y/z from the sig so the
    // hardblock applies to skill+block regardless of which coord the LLM picked.
    // Without this, place_block_at(crafting_table,x=114,...) and (x=115,...)
    // get separate sigs and the hardblock leaks — the LLM bumps a coord and
    // refails immediately. See log evidence: BUG (Step 2.6 follow-up).
    // Step 2.6 follow-up (pillar_up): strip `block` when the failure is
    // position-bound but block-agnostic (no_headroom / no_floor) so the LLM
    // can't bypass the hardblock by switching block=cobblestone → block=dirt.
    const stripPositional = isInventoryMissingError(lastError);
    const stripBlock = isBlockAgnosticError(lastError, errorCode);
    const sigArgs = (stripPositional || stripBlock)
      ? argsKey(args, { stripPositional, stripBlock })
      : argsKey(args);
    const sig = `${skill}:${sigArgs}`;
    this._blockedSigs.set(sig, {
      until:     Date.now() + SIG_HARDBLOCK_TTL_MS,
      lastError: String(lastError ?? '').slice(0, 240),
      label:     `${skill}(${sigArgs})`,
    });
    if (this._bot?.username) {
      console.warn(`[brain:${this._bot.username}] sig hard-blocked: ${skill}(${sigArgs}) — ${lastError}`);
    }

    // Step 2.6 anti-fixation (2026-05-16): track repeat hard-blocks on the
    // same sig within ANTI_FIXATION_WINDOW_MS. After ANTI_FIXATION_THRESHOLD
    // hits, surface a STUCK FIXATION nudge via memory so the LLM's next
    // prompt sees that its current_goal is unreachable from here and should
    // be abandoned. The 17,183 BLOCKED-SIG IGNORED events from the Step 2.5
    // overnight show the LLM doesn't internalize blocks within a session —
    // this is the meta-level reminder.
    this._antiFixationHits ??= new Map();
    const cutoff = Date.now() - ANTI_FIXATION_WINDOW_MS;
    const hits   = (this._antiFixationHits.get(sig) || []).filter((t) => t >= cutoff);
    hits.push(Date.now());
    this._antiFixationHits.set(sig, hits);
    if (hits.length >= ANTI_FIXATION_THRESHOLD && this._memory) {
      const label = `${skill}(${argsKey(args)})`;
      try {
        this._memory.applyUpdate({
          add_failed: `STUCK FIXATION: ${label} has been hard-blocked ${hits.length}x in the last ${Math.round(ANTI_FIXATION_WINDOW_MS/60000)}min. The current_goal is not achievable from here — pick a FUNDAMENTALLY different objective (different skill class, different area, or set_goal to something simpler).`,
        }, { position: this._bot?.entity?.position ?? null });
      } catch { /* noop */ }
      // reset the counter so the nudge doesn't spam every turn — wait
      // another window of repeats before re-firing
      this._antiFixationHits.set(sig, []);
    }
  }

  _isSigBlocked(skill, args) {
    // Check both the regular sig AND the positional-stripped sig — _addBlockedSig
    // stores the stripped form for inventory-missing failures, so a freshly picked
    // place_block_at(...,x=115,...) must still match a block recorded at x=114.
    const sigs = [
      `${skill}:${argsKey(args)}`,
      `${skill}:${argsKey(args, { stripPositional: true })}`,
      `${skill}:${argsKey(args, { stripBlock: true })}`,
      `${skill}:${argsKey(args, { stripPositional: true, stripBlock: true })}`,
    ];
    for (const sig of sigs) {
      const entry = this._blockedSigs.get(sig);
      if (!entry) continue;
      if (entry.until <= Date.now()) {
        this._blockedSigs.delete(sig);
        continue;
      }
      return true;
    }
    return false;
  }

  // Prompt banner — sits at the top of stateLines so the LLM sees it before
  // anything else. Returns '' if no sigs are currently blocked.
  _blockedSigsBlock() {
    const now = Date.now();
    const lines = [];
    for (const [sig, entry] of this._blockedSigs) {
      if (entry.until <= now) {
        this._blockedSigs.delete(sig);
        continue;
      }
      const tail = entry.lastError ? ` — last error: ${entry.lastError}` : '';
      lines.push(`- ${entry.label}${tail}`);
    }
    if (lines.length === 0) return '';
    return [
      '## BLOCKED THIS TURN — DO NOT PICK',
      ...lines,
      '',
      'If you pick any of these, the brain will force look_around and clear your goal. Pick a DIFFERENT skill class.',
    ].join('\n');
  }

  // Replace whatever action the LLM picked with a forced look_around, and apply
  // a memory_update so the LLM's next turn sees a real goal change rather than
  // re-picking the same blocked sig.
  _forceLookAround(result, { setGoal = null, addFailed = null } = {}) {
    result.action = { type: 'look_around', args: { turns: 4 } };
    if (this._memory && (setGoal || addFailed)) {
      const update = {};
      if (setGoal)    update.set_goal   = setGoal;
      if (addFailed)  update.add_failed = addFailed;
      try {
        this._memory.applyUpdate(update, { position: this._bot.entity?.position ?? null });
        if (setGoal) {
          this._goalChangedAt = Date.now();
          this._lastKnownGoal = setGoal;
        }
      } catch { /* noop */ }
    }
  }

  // BUG-012: detect strict A-B-A-B oscillation in the last N decisions, with at
  // least one failed entry (otherwise the bot may legitimately be alternating
  // between two productive targets). Returns null or [{label, sig}, {label, sig}].
  _detectOscillation() {
    const ring = this._recentDecisions;
    if (ring.length < OSCILLATION_MIN_LEN) return null;
    const tail = ring.slice(-OSCILLATION_MIN_LEN);
    const sigA = tail[0].sig;
    const sigB = tail[1].sig;
    if (!sigA || !sigB || sigA === sigB) return null;
    for (let i = 0; i < tail.length; i++) {
      const expected = i % 2 === 0 ? sigA : sigB;
      if (tail[i].sig !== expected) return null;
    }
    const anyFail = tail.some((d) => d.ok === false);
    if (!anyFail) return null;
    return [
      { sig: sigA, label: `${tail[0].type}(${tail[0].key})` },
      { sig: sigB, label: `${tail[1].type}(${tail[1].key})` },
    ];
  }

  // BUG-003: same sig succeeded ≥ COMPLETION_BLIND_THRESHOLD times AND the
  // current_goal hasn't changed in GOAL_STALE_MS — the LLM has lost track that
  // the underlying objective is satisfied. Returns the label or null.
  _detectCompletionBlindness(sig) {
    if (!sig) return null;
    if ((Date.now() - this._goalChangedAt) < GOAL_STALE_MS) return null;
    const matches = this._recentDecisions.filter((d) => d.sig === sig);
    if (matches.length < COMPLETION_BLIND_THRESHOLD) return null;
    if (!matches.every((d) => d.ok === true)) return null;
    const last = matches[matches.length - 1];
    return `${last.type}(${last.key})`;
  }

  // Step 2 (2026-05-10): brain-level stuck-loop early-break detector. Returns
  // null when no sig in the last STUCK_LOOP_EARLY_WINDOW ring entries appears
  // ≥STUCK_LOOP_EARLY_THRESHOLD times. Otherwise returns the offending sig's
  // count + label + type + args so the caller can substitute the action and
  // write a memory entry. Composed with the existing oscillation /
  // completion-blindness checks: this fires ONLY when neither of those
  // patterns matched — a flat repetition of the same sig that doesn't
  // alternate (excluded by oscillation) and isn't all-ok on a stale goal
  // (excluded by completion-blindness).
  _detectStuckLoopEarly() {
    const ring = this._recentDecisions;
    if (ring.length < STUCK_LOOP_EARLY_THRESHOLD) return null;
    const tail = ring.slice(-STUCK_LOOP_EARLY_WINDOW);
    const counts = new Map();
    for (const d of tail) {
      if (!d.sig) continue;
      counts.set(d.sig, (counts.get(d.sig) ?? 0) + 1);
    }
    let bestSig = null, bestCount = 0;
    for (const [sig, c] of counts) {
      if (c > bestCount) { bestSig = sig; bestCount = c; }
    }
    if (bestCount < STUCK_LOOP_EARLY_THRESHOLD) return null;
    const latest = ring.findLast
      ? ring.findLast((d) => d.sig === bestSig)
      : [...ring].reverse().find((d) => d.sig === bestSig);
    if (!latest) return null;
    return {
      sig:   bestSig,
      count: bestCount,
      label: `${latest.type}(${latest.key})`,
      type:  latest.type,
      args:  latest.args,
    };
  }

  // Step 2: substitute result.action with look_around when the stuck-loop
  // early-break tripped. Returns true if substituted, false otherwise. The
  // memory injection is craft/place_block-specific so the LLM gets concrete
  // guidance on what to verify next instead of "you're stuck."
  // Skips when the latest ring entry's type is wait/look_around — that means
  // an upstream layer (failure-cooldown, hardblock, oscillation,
  // completion-blindness) already substituted, so this layer must not
  // overwrite.
  _applyStuckLoopEarlyBreak(result) {
    if (!result?.action?.type) return false;
    const ring = this._recentDecisions;
    if (ring.length === 0) return false;
    const latest = ring[ring.length - 1];
    if (latest.type === 'look_around' || latest.type === 'wait') return false;
    const stuck = this._detectStuckLoopEarly();
    if (!stuck) return false;
    const currentSig = this._canonicalSig(result.action.type, result.action.args);
    if (stuck.sig !== currentSig) return false;
    const { type, count, label } = stuck;
    let guidance;
    if (type === 'craft') {
      guidance = `${label} has cycled ${count} times in the last ${STUCK_LOOP_EARLY_WINDOW} decisions — the recipe inputs may be missing or the placement may be blocked — verify inventory and surroundings, then try a DIFFERENT skill or args.`;
    } else if (type === 'place_block') {
      guidance = `${label} has cycled ${count} times in the last ${STUCK_LOOP_EARLY_WINDOW} decisions — the recipe inputs may be missing or the placement may be blocked — verify inventory and surroundings, then try a DIFFERENT skill or args.`;
    } else {
      guidance = `${label} has cycled ${count} times in the last ${STUCK_LOOP_EARLY_WINDOW} decisions — try a different approach (different block target, different range, dig the obstacle, or move to a new area).`;
    }
    if (this._bot?.username) {
      console.warn(`[brain:${this._bot.username}] stuck_loop early-break — ${label} ×${count}/${STUCK_LOOP_EARLY_WINDOW}; forcing look_around`);
    }
    this._forceLookAround(result, { addFailed: guidance });
    return true;
  }

  // Step 2: per-(skill,argsKey) jump_loop cancel log helpers used by the
  // collect_block × jump_loop recovery layer.
  _recordJumpLoopCancel(skill, args) {
    const key = `${skill}:${argsKey(args)}`;
    const cutoff = Date.now() - COLLECT_JUMP_RECOVER_WINDOW_MS;
    const arr = (this._jumpLoopCancelLog.get(key) || []).filter((e) => e.ts >= cutoff);
    arr.push({ ts: Date.now() });
    this._jumpLoopCancelLog.set(key, arr);
  }

  _recentJumpLoopCancels(skill, args) {
    const key = `${skill}:${argsKey(args)}`;
    const cutoff = Date.now() - COLLECT_JUMP_RECOVER_WINDOW_MS;
    return (this._jumpLoopCancelLog.get(key) || []).filter((e) => e.ts >= cutoff);
  }

  // Step 2: substitute collect_block(X) with the deterministic recovery skill
  // collect_jump_recover when X has caused ≥COLLECT_JUMP_RECOVER_THRESHOLD
  // jump_loop cancels in the last COLLECT_JUMP_RECOVER_WINDOW_MS. Clears the
  // log on substitution so the next turn's identical pick does not re-fire
  // the recovery (a fresh jump_loop must occur first). Returns true if
  // substituted. Composes with failure-cooldown by running BEFORE it in
  // _think — if recovery substitutes, failure-cooldown is skipped for the
  // turn so the recovery runs instead of a bare wait(5).
  _applyCollectJumpRecovery(result) {
    if (!result?.action?.type) return false;
    if (result.action.type !== 'collect_block') return false;
    const cancels = this._recentJumpLoopCancels(result.action.type, result.action.args);
    if (cancels.length < COLLECT_JUMP_RECOVER_THRESHOLD) return false;
    const brief = argsBrief(result.action.args);
    const pos = this._bot?.entity?.position;
    const posStr = pos && Number.isFinite(pos.x)
      ? `(${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)})`
      : 'current spot';
    if (this._bot?.username) {
      console.warn(`[brain:${this._bot.username}] collect_jump recovery — collect_block(${brief}) caused ${cancels.length} jump_loops in 60s at ${posStr}; substituting stand-still + look_around + goto-current`);
    }
    if (this._memory) {
      try {
        this._memory.applyUpdate({
          add_failed: `collect_block(${brief}) caused ${cancels.length} jump_loops in 60s while geographically stuck at ${posStr}. Brain ran a stand-still + look + goto-current recovery. DO NOT repeat collect_block(${brief}) — pick a DIFFERENT block target, a DIFFERENT skill class (dig_block, dig_down, place_block, pillar_up), or goto_coord to a position |dx|+|dz|>10 from here first.`,
        }, { position: pos ?? null });
      } catch { /* noop */ }
    }
    // Clear the log so the same target does not re-trigger recovery on the
    // next turn — a fresh jump_loop must happen for a new substitution.
    this._jumpLoopCancelLog.delete(`${result.action.type}:${argsKey(result.action.args)}`);
    result.action = { type: 'collect_jump_recover', args: {} };
    return true;
  }

  // OVN-006: track per-(skill,key) debounce frequency. When the LLM has been
  // re-picking the same broken action repeatedly, returns the count inside the
  // escalation window so the caller can promote to a failure-log entry.
  _recordDebounce(skill, args) {
    const key = `${skill}:${argsKey(args)}`;
    const cutoff = Date.now() - DEBOUNCE_ESCALATION_WINDOW_MS;
    const arr = (this._debounceLog.get(key) || []).filter((ts) => ts >= cutoff);
    arr.push(Date.now());
    this._debounceLog.set(key, arr);
    return { count: arr.length, key };
  }

  _isStationary() {
    if (this._positionHistory.length < 3) return false;
    const oldest = this._positionHistory[0];
    const now = Date.now();
    if ((now - oldest.ts) < (STATIONARY_WINDOW_MS - 5000)) return false;
    const pos = this._bot.entity?.position;
    if (!pos) return false;
    const dx = pos.x - oldest.x, dy = pos.y - oldest.y, dz = pos.z - oldest.z;
    return Math.sqrt(dx*dx + dy*dy + dz*dz) <= STATIONARY_RADIUS;
  }

  // Bugs 10 & 11: prepare an outgoing chat message — truncate to MC's 240-char
  // soft limit so it doesn't get split mid-word, and suppress if a recent
  // message had the same content or a high token-overlap paraphrase.
  _prepareSay(rawSay) {
    const text = String(rawSay).replace(/\s+/g, ' ').trim();
    if (!text) return null;
    const truncated = truncateAtBoundary(text, SAY_MAX_CHARS);
    const now = Date.now();
    const cutoff = now - SAY_DEDUPE_WINDOW_MS;
    while (this._recentSays.length > 0 && this._recentSays[0].ts < cutoff) {
      this._recentSays.shift();
    }
    const newToks = sayTokens(truncated);
    for (const prev of this._recentSays) {
      if (prev.text === truncated) return null;
      const overlap = jaccardOf(newToks, sayTokens(prev.text));
      if (overlap >= SAY_DEDUPE_PARAPHRASE) return null;
    }
    return truncated;
  }

  // ---- jump-loop detection & escape ----------------------------------------
  _checkJumpLoop() {
    if (!this._running || this._jumpLoopHandling) return;
    const bot = this._bot;
    const onGround = bot.entity?.onGround ?? true;
    const vel = bot.entity?.velocity;
    const horizontal = vel ? Math.abs(vel.x) + Math.abs(vel.z) : 1;

    // A complete jump cycle = air→ground transition with no horizontal movement
    if (!this._wasOnGround && onGround) {
      if (horizontal < JUMP_LOOP_VELOCITY_THRESHOLD) {
        this._jumpCycleCount++;
        if (this._jumpCycleCount >= JUMP_LOOP_THRESHOLD) {
          this._jumpCycleCount = 0;
          this._handleJumpLoop().catch((err) =>
            console.warn(`[brain:${bot.username}] jump-loop escape error:`, err?.message)
          );
        }
      } else {
        this._jumpCycleCount = 0;
      }
    }
    this._wasOnGround = onGround;
  }

  async _handleJumpLoop() {
    const bot = this._bot;
    this._jumpLoopHandling = true;
    // OVN-015: jump-loop detection fires hundreds of times per night while a
    // bot is stuck. The memory entry below is the real signal — gate the log.
    brainDebug(`[brain:${bot.username}] jump-loop detected — attempting escape`);
    this._cancelCurrentSkill('jump_loop');
    // Bug 8: previously the jump_loop escape only cancelled the in-flight
    // skill — the next decision tick would pick the *same* goto_coord and
    // immediately re-trigger the loop. Record the misbehaviour as a failed
    // attempt and a fresh goal so the next LLM call sees explicit guidance
    // to switch skill class.
    const stuckSkill = this._currentSkill?.name ?? 'previous skill';
    const stuckArgs  = this._currentSkill?.args ?? null;
    if (this._memory) {
      try {
        const brief = stuckArgs ? argsBrief(stuckArgs) : '';
        this._memory.applyUpdate({
          add_failed: `${stuckSkill}${brief ? `(${brief})` : ''} caused jump-loop (bot jumping in place 6+ times) — DO NOT pick goto_coord with y above current+5, OR jump alone for height. Use pillar_up (atomic jump+place) to gain height, or pick a horizontal-only skill like collect_block / goto_block / dig_block to make progress.`,
        }, { position: bot.entity?.position ?? null });
      } catch { /* noop */ }
    }
    this._lastJumpLoopHint = Date.now();
    // OVN-007: instrument the escape so we can tell whether _tryDigOut
    // actually broke a block, _tryNudgeEscape pathfound away, or both
    // failed — currently 346 jump-loops/4h trigger this path but the bot
    // appears to re-trap immediately, and we have no signal to distinguish
    // the failure modes.
    const beforePos = bot.entity?.position
      ? { x: Math.round(bot.entity.position.x), y: Math.round(bot.entity.position.y), z: Math.round(bot.entity.position.z) }
      : null;
    const adjacent = this._adjacentBlockSummary(beforePos);
    let dugOut = false;
    let nudgedOut = false;
    try {
      dugOut = await this._tryDigOut();
      if (!dugOut) {
        await this._tryNudgeEscape();
        // _tryNudgeEscape doesn't return — infer success by horizontal
        // displacement. Anything > 1.5m means the pathfind made progress.
        const after = bot.entity?.position;
        if (after && beforePos) {
          const dx = after.x - beforePos.x, dz = after.z - beforePos.z;
          nudgedOut = Math.sqrt(dx * dx + dz * dz) > 1.5;
        }
      }
    } catch (err) {
      console.warn(`[brain:${bot.username}] jump-loop escape failed:`, err?.message);
    }
    this._emit('jump_loop_attempt', {
      before:    beforePos,
      adjacent,
      dugOut,
      nudgedOut,
      escaped:   dugOut || nudgedOut,
      stuckSkill,
    });
    this._jumpLoopHandling = false;
    this._scheduleThink('jump_loop_escaped');
  }

  // OVN-007: snapshot the 4 cardinal-adjacent blocks so we can later see
  // whether jump-loops cluster on a particular terrain pattern (slabs,
  // stairs, single-block gaps, fences, etc.). Returns null if the bot's
  // position isn't valid yet.
  _adjacentBlockSummary(pos) {
    if (!pos) return null;
    const bot = this._bot;
    const offsets = [
      { dir: 'north', dx: 0, dz: -1 },
      { dir: 'south', dx: 0, dz: 1 },
      { dir: 'east',  dx: 1, dz: 0 },
      { dir: 'west',  dx: -1, dz: 0 },
    ];
    const out = {};
    for (const o of offsets) {
      try {
        const b = bot.blockAt(new Vec3(pos.x + o.dx, pos.y, pos.z + o.dz));
        out[o.dir] = b?.name ?? null;
      } catch { out[o.dir] = null; }
    }
    return out;
  }

  async _tryDigOut() {
    const bot = this._bot;
    const pos = bot.entity.position.floored();
    const offsets = [
      { x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 },
    ];
    for (const off of offsets) {
      for (const dy of [0, 1]) {
        const block = bot.blockAt(pos.offset(off.x, dy, off.z));
        if (!block || block.name === 'air') continue;
        if (!bot.canDigBlock(block)) continue;
        try {
          await bot.dig(block);
          return true;
        } catch { continue; }
      }
    }
    return false;
  }

  async _tryNudgeEscape() {
    const bot = this._bot;
    const pos = bot.entity.position;
    const angle = Math.random() * Math.PI * 2;
    const goal = new goals.GoalNear(
      pos.x + Math.cos(angle) * 3,
      pos.y,
      pos.z + Math.sin(angle) * 3,
      1,
    );
    await Promise.race([
      bot.pathfinder.goto(goal).catch(() => {}),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
  }

  _reportError(err, where) {
    // Label the error with the provider actually in use, not a hardcoded one.
    const prov = USE_OPENROUTER ? 'OpenRouter' : USE_OPENAI ? 'OpenAI' : USE_LOCAL_LLM ? 'local LLM' : 'Cerebras';
    const msg = err.status === 401 ? `${prov} rejected the key (401).`
              : err.status === 402 ? `${prov} returned 402 (Payment Required — out of credits).`
              : err.status === 429 ? `${prov} rate-limited (429). Slow down.`
              : `${where}: ${err?.message || err}`;
    // F13: aggregate identical errors. Re-emit every 60s with × N suffix so a
    // 402 storm doesn't go silent after the first occurrence.
    const now = Date.now();
    if (this._errAgg && this._errAgg.msg === msg) {
      this._errAgg.count += 1;
      this._errAgg.lastAt = now;
      if (now - this._errAgg.lastEmittedAt >= 60_000) {
        const since = Math.round((now - this._errAgg.firstAt) / 1000);
        // BUG-014: route through safeError so a fleet-wide stderr storm
        // from a 402 cascade can't starve the shared event loop.
        safeError(this._bot.username, `${msg} × ${this._errAgg.count} in ${since}s`);
        this._errAgg.lastEmittedAt = now;
      }
    } else {
      // first occurrence (or different message replaces the aggregator)
      safeError(this._bot.username, msg);
      this._errAgg = { msg, count: 1, firstAt: now, lastAt: now, lastEmittedAt: now };
    }
    this._lastErrMsg = msg;
    if (this._onError) this._onError({ botId: this._bot.username, message: msg, status: err?.status ?? null });
  }
}

// ---------------------------------------------------------------------------
// Skills — each returns a Promise<{ ok: boolean, ... }>
// All are abortable via ctx.signal.
// ---------------------------------------------------------------------------
const SKILLS = {
  wait: async ({ signal }, { seconds = 2 }) => {
    const ms = Math.min(Math.max(seconds * 1000, 200), 6000);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve({ ok: true }), ms);
      signal.addEventListener('abort', () => { clearTimeout(t); resolve({ ok: false, error: 'aborted' }); });
    });
  },

  chat_only: async () => ({ ok: true }),

  jump: async ({ bot, signal }) => {
    if (signal.aborted) return { ok: false, error: 'aborted' };
    bot.setControlState('jump', true);
    await sleep(350);
    bot.setControlState('jump', false);
    return { ok: true };
  },

  // Bug 4: atomic pillar-up. jump + place_block in two LLM cycles is physically
  // impossible — by the time the LLM picks place_block, the bot has already
  // landed. This skill jumps and places at the bot's *previous* feet position
  // (now exposed below the bot mid-air) in a single async function.
  pillar_up: async ({ bot, signal }, { block, count = 1 }) => {
    if (!block) return { ok: false, error: 'missing block' };
    const want = Math.min(Math.max(count | 0, 1), 16);
    let placed = 0;
    for (let i = 0; i < want; i++) {
      if (signal.aborted) return { ok: placed > 0, error: 'aborted', placed };
      const item = bot.inventory.items().find((it) => it.name === block);
      if (!item) return { ok: placed > 0, error_code: 'no_block_in_inventory', error: `no ${block} in inventory`, placed };
      try { await bot.equip(item, 'hand'); }
      catch (e) { return { ok: placed > 0, error: `equip: ${e.message}`, placed }; }
      // Capture the floor position the bot is standing on; this is the block
      // we'll be standing ON top of after the jump+place lands.
      const start = bot.entity.position.floored();
      // BUG-024 (Path 2, 2026-05-18): structured no_headroom error_code so
      // the failure-cooldown trips on turn 1 and the LLM sees a concrete
      // wiki annotation. Without this, slots 6 and 8 spent the entire 6h57m
      // run picking pillar_up while a ceiling block sat 2 above their head.
      const ceiling = bot.blockAt(new Vec3(start.x, start.y + 2, start.z));
      if (ceiling && ceiling.name !== 'air' && !/^(?:water|lava|flowing_water|flowing_lava)$/.test(ceiling.name)) {
        return {
          ok: placed > 0,
          error_code: 'no_headroom',
          error: `pillar_up ${block}: headroom blocked above by ${ceiling.name} at (${start.x},${start.y+2},${start.z}). Need 2 blocks of air directly above your head.`,
          placed,
        };
      }
      // Reference block: the block beneath current feet provides the place face.
      const refBlock = bot.blockAt(new Vec3(start.x, start.y - 1, start.z));
      if (!refBlock || refBlock.name === 'air') {
        return {
          ok: placed > 0,
          error_code: 'no_floor',
          error: `pillar_up ${block}: no solid block beneath feet to anchor placement (you're in mid-air or over a hole).`,
          placed,
        };
      }
      bot.setControlState('jump', true);
      // Wait for the bot to clear the block at start.y (jump apex is ~250ms in)
      await sleep(220);
      bot.setControlState('jump', false);
      // Look down so the place targets the top face of refBlock from above
      try { await bot.lookAt(new Vec3(start.x + 0.5, start.y - 0.5, start.z + 0.5), true); } catch { /* noop */ }
      try {
        await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
        placed++;
      } catch (e) {
        // Wait for the bot to land before reporting so the next decision sees
        // a stable position rather than mid-air state.
        await sleep(400);
        return { ok: placed > 0, error: `place: ${e.message}`, placed };
      }
      // Settle: let the bot land on the new block before the next iteration
      await sleep(450);
    }
    return { ok: true, placed };
  },

  look_around: async ({ bot, mcData, signal }, { turns = 4 }) => {
    const n = Math.min(Math.max(turns | 0, 1), 8);
    for (let i = 0; i < n; i++) {
      if (signal.aborted) return { ok: false, error: 'aborted' };
      await bot.look((i / n) * 2 * Math.PI, 0, true);
      await sleep(300);
    }
    // Phase C / C1 (Step 2.5, 2026-05-11): include the structured
    // surroundings summary in the result so the brain can render it back to
    // the LLM (and so callers / tests can introspect what was seen).
    const surroundings = summarizeSurroundings(bot, mcData);
    return { ok: true, surroundings };
  },

  // Step 2 (2026-05-10): deterministic recovery substituted in by the brain
  // when collect_block(X) has caused ≥2 jump_loops in 60s. NOT exposed in
  // SYSTEM_PROMPT — the LLM never picks this directly. Sequence:
  //   1. Clear movement controls + flush pathfinder goal so the bot stops
  //      thrashing in place (the jump-loop's geographic anchor).
  //   2. Stand still 5s — let physics settle, gravity drop the bot to ground
  //      if airborne, and the watchdog clear in-flight aborts.
  //   3. look_around 4 turns — scan surroundings so the next think has a
  //      complete view of the immediate area.
  //   4. goto_coord to the bot's current reported position — a no-op
  //      pathfind that flushes any stale pathfinder state and resolves
  //      immediately. Bounded with a 2s race so a wedged pathfinder never
  //      pins this skill open longer than the look + wait already took.
  collect_jump_recover: async ({ bot, signal }) => {
    for (const ctrl of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
      try { bot.setControlState(ctrl, false); } catch { /* noop */ }
    }
    try { bot.pathfinder?.setGoal(null); } catch { /* noop */ }
    await sleep(5000);
    if (signal.aborted) return { ok: false, error: 'aborted' };
    for (let i = 0; i < 4; i++) {
      if (signal.aborted) return { ok: false, error: 'aborted' };
      try { await bot.look((i / 4) * 2 * Math.PI, 0, true); } catch { /* noop */ }
      await sleep(300);
    }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    const pos = bot.entity?.position;
    if (!pos || isNaN(pos.x)) return { ok: true, recovered: true };
    try {
      const goal = new goals.GoalNear(Math.round(pos.x), Math.round(pos.y), Math.round(pos.z), 1);
      await Promise.race([
        bot.pathfinder.goto(goal).catch(() => {}),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    } catch { /* noop */ }
    return { ok: true, recovered: true };
  },

  goto_coord: async ({ bot, signal }, { x, z, y }) => {
    if (x == null || z == null) return { ok: false, error: 'missing x/z' };
    const goal = (y != null) ? new goals.GoalBlock(x | 0, y | 0, z | 0) : new goals.GoalNearXZ(x | 0, z | 0, 1);
    return runPathfinder(bot, goal, signal);
  },

  goto_block: async ({ bot, signal, mcData }, { block, range = 32 }) => {
    if (!block) return { ok: false, error: 'missing block' };
    const id = mcData.blocksByName[block]?.id;
    if (id == null) return { ok: false, error: `unknown block: ${block}` };
    const target = bot.findBlock({ matching: id, maxDistance: range });
    if (!target) return { ok: false, error: `no ${block} within ${range}m` };
    const goal = new goals.GoalGetToBlock(target.position.x, target.position.y, target.position.z);
    return runPathfinder(bot, goal, signal);
  },

  collect_block: async ({ bot, signal, mcData }, { block, count = 1, range = 32 }) => {
    if (!block) return { ok: false, error: 'missing block' };
    const id = mcData.blocksByName[block]?.id;
    if (id == null) return { ok: false, error: `unknown block: ${block}` };
    if (blockNeedsPickaxe(mcData, block)) {
      const equipped = await equipBestPickaxe(bot);
      if (!equipped.ok) return equipped;
      // Step 2.6 hotfix (2026-05-17): tier check after equipping.
      const tier = pickaxeTierForBlock(mcData, bot, block);
      if (!tier.ok) {
        return {
          ok: false,
          error_code: 'pickaxe_tier_too_low',
          error: `collect_block ${block}: your pickaxe is too weak — needs ${tier.needs} (or better). Mining without the right tier breaks the block with no drop. Next step: craft(item=${tier.needs}) first.`,
        };
      }
    }
    let collected = 0;
    while (collected < count && !signal.aborted) {
      const target = bot.findBlock({ matching: id, maxDistance: range });
      if (!target) return { ok: collected > 0, error: `no more ${block} within ${range}m`, collected };
      try {
        const r = await runPathfinder(bot, new goals.GoalLookAtBlock(target.position, bot.world), signal);
        if (!r.ok) return { ok: collected > 0, error: `pathfind: ${r.error}`, collected };
      } catch (e) {
        return { ok: collected > 0, error: `pathfind: ${e.message}`, collected };
      }
      if (signal.aborted) return { ok: collected > 0, error: 'aborted', collected };
      try {
        await bot.dig(target);
        collected++;
      } catch (e) {
        return { ok: collected > 0, error: `dig: ${e.message}`, collected };
      }
    }
    return { ok: collected >= count, collected };
  },

  place_block: async ({ bot, signal }, { block }) => {
    if (!block) return { ok: false, error: 'missing block' };
    const item = bot.inventory.items().find(i => i.name === block);
    if (!item) return { ok: false, error_code: 'no_block_in_inventory', error: `no ${block} in inventory` };
    // Phase A — A3 (Step 2.5, 2026-05-11): preflight surface check. The
    // ring tryPlaceNearby walks needs at least one (air slot) sitting on a
    // (solid block) — without one, mineflayer's bot.placeBlock loops through
    // every candidate and throws "must reference a face that is on a solid
    // block." The stuck-loop logs from 2026-05-10 show place_block
    // (crafting_table) repeating that failure 10+ times. Bail out early
    // with a typed error so the failure-cooldown trips on turn 1 instead
    // of after the LLM has wasted a full ring iteration.
    const surface = previewPlacementSurface(bot);
    if (!surface.ok) {
      // Step 2.6 hotfix (2026-05-17): when adjacent terrain blocks the
      // placement, try a dirt-pad fallback BEFORE failing. If the bot has
      // dirt or cobblestone in inventory, place that as a base block (those
      // skill types are more permissive about adjacent geometry than
      // furnace/crafting_table); on success the bot now stands next to a
      // freshly-flat slot and the original placement can retry next turn.
      const padCandidate = bot.inventory.items().find((i) =>
        i.name !== block && (i.name === 'dirt' || i.name === 'cobblestone'),
      );
      if (padCandidate) {
        try {
          await bot.equip(padCandidate, 'hand');
          const padRes = await tryPlaceNearby(bot, signal, padCandidate.name);
          if (padRes.ok) {
            // recovery hint instructs the brain to re-run the original
            // place_block on the next turn now that there's flat ground.
            return {
              ok: false,
              error_code: 'no_valid_surface',
              error: `place_block ${block}: no flat surface — placed ${padCandidate.name} as a pad. Retry place_block(${block}) next turn.`,
              recovery: { skill: 'place_block', args: { block } },
            };
          }
        } catch { /* fall through to the original error */ }
      }
      return {
        ok: false,
        error_code: 'no_valid_surface',
        error: `place_block ${block}: no solid surface in adjacent ring (${surface.reason}). Next step: dig_down() to flatten, then place_block(${block}) again.`,
        recovery: { skill: 'dig_down', args: {} },
      };
    }
    try { await bot.equip(item, 'hand'); } catch (e) { return { ok: false, error_code: 'equip_failed', error: `equip: ${e.message}` }; }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    return tryPlaceNearby(bot, signal, block);
  },

  attack_nearest: async ({ bot, signal }, { entity_type, range = 16 }) => {
    if (!entity_type) return { ok: false, error: 'missing entity_type' };
    const target_lc = entity_type.toLowerCase();

    // F2 (Test7): refuse unarmed combat against ranged/lethal mobs. A bare-
    // handed swing does ~1HP, a skeleton's bow does 4 — Test7 logged 21 hits
    // over 15s without a kill, taking arrows the whole time.
    if (UNARMED_DEATH_RISK.has(target_lc)) {
      const held = bot.heldItem;
      const hasMeleeWeapon = held && MELEE_WEAPON_RE.test(held.name);
      if (!hasMeleeWeapon) {
        const hint = target_lc === 'creeper'
          ? 'flee (creeper explodes within 3 blocks — no melee strategy works without armor)'
          : 'flee, or craft a wooden_sword first (2 planks + 1 stick at a crafting_table)';
        return { ok: false, error: `cannot attack ${target_lc} unarmed — ${hint}` };
      }
    }

    const me = bot.entity.position;
    let target = null, best = Infinity;
    for (const e of Object.values(bot.entities ?? {})) {
      if (e === bot.entity || !e.position) continue;
      if ((e.name ?? '').toLowerCase() !== target_lc) continue;
      const dx = e.position.x - me.x, dz = e.position.z - me.z;
      const d = Math.sqrt(dx*dx + dz*dz);
      if (d < best && d <= range) { best = d; target = e; }
    }
    if (!target) return { ok: false, error: `no ${entity_type} within ${range}m` };
    const goal = new goals.GoalFollow(target, 2);
    bot.pathfinder.setGoal(goal, true);
    const deadline = Date.now() + 15000;
    let hits = 0;
    while (!signal.aborted && target.isValid && Date.now() < deadline) {
      const dx = target.position.x - bot.entity.position.x;
      const dz = target.position.z - bot.entity.position.z;
      if (Math.sqrt(dx*dx + dz*dz) <= 3.5) {
        try { bot.attack(target); hits++; } catch { /* noop */ }
        await sleep(600);
      } else {
        await sleep(200);
      }
    }
    try { bot.pathfinder.setGoal(null); } catch { /* noop */ }
    // F2 (Test7): "killed=true with 0 hits" was misleading — target.isValid can
    // flip false because the entity despawned, was killed by another mob, or
    // moved out of range. Only claim a kill when we actually landed hits.
    const targetGone = !target.isValid;
    if (targetGone && hits === 0) {
      return { ok: false, hits, killed: false, error: 'target despawned or moved out of view before any hit landed' };
    }
    return { ok: targetGone, hits, killed: targetGone };
  },

  eat: async ({ bot, signal }, { food }) => {
    // mineflayer's bot.consume() hangs for the full 3s timeout if the held
    // item isn't actually a food, so we gate on a real-food regex first
    if (food && !EDIBLE_NAME_RE.test(food)) {
      return { ok: false, error: `${food} is not edible — try sweet_berries, bread, apple, cooked beef/chicken/porkchop/mutton, baked_potato, cookie, melon_slice, or mushroom_stew` };
    }
    const item = food
      ? bot.inventory.items().find(i => i.name === food)
      : bot.inventory.items().find(i => EDIBLE_NAME_RE.test(i.name));
    if (!item) return { ok: false, error: `no edible ${food ?? 'food'} in inventory` };
    if (!EDIBLE_NAME_RE.test(item.name)) {
      return { ok: false, error: `${item.name} is not edible — pick a real food (bread, cooked meat, apple, berries, ...)` };
    }
    try { await bot.equip(item, 'hand'); } catch (e) { return { ok: false, error: `equip: ${e.message}` }; }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    try { await bot.consume(); return { ok: true, ate: item.name }; }
    catch (e) { return { ok: false, error: `consume: ${e.message}` }; }
  },

  craft: async ({ bot, mcData, signal }, { item, count = 1 }) => {
    if (!item) return { ok: false, error: 'missing item' };

    // OVN-012: don't craft a tool the bot already has a working copy of.
    // Test21 ended the night with 5+ wooden_pickaxes because the LLM kept
    // crafting fresh tools instead of equipping the existing one. Surface a
    // clear "EQUIP-NOT-CRAFT" error so the failure log steers it.
    const existing = alreadyHasWorkingTool(bot, item);
    if (existing) {
      return {
        ok: false,
        error_code: 'already_have_tool',
        error: `EQUIP-NOT-CRAFT: already have ${existing.count}x ${item} in inventory (durability ${Math.round(existing.ratio * 100)}%) — equip_item(item="${item}", destination="hand") instead of crafting another`,
      };
    }

    // Phase A — A1 (Step 2.5, 2026-05-11): static prereqs gate. Runs BEFORE
    // mineflayer's recipesFor / pathfind-to-table. Composes with the existing
    // failure-cooldown layer (the "no recipe available" tail trips the
    // EARLY_TRIP_PATTERNS regex, so the cooldown threshold drops to 1) and
    // with the Step 2 stuck-loop early-break (this gate's deterministic
    // failure means the LLM sees a structured RECENTLY-FAILED entry on turn
    // 1 instead of after 4 wasted turns).
    const inventoryItems = bot.inventory?.items?.() ?? [];
    let prereqCheck = checkRecipePrereqs(item, inventoryItems);

    // Step 2.6 (2026-05-16): if the failure is purely a same-species shortfall
    // and the bot has cross-species potential, auto-consolidate logs into
    // planks of the chosen species before reporting the missing-prereqs error.
    // This was the dominant Step 2.5 wall — bots had mixed-species planks and
    // their crafting_table craft kept failing.
    if (!prereqCheck.ok) {
      const sameSpeciesMissing = prereqCheck.missing.filter((m) => m.sameSpecies);
      const otherMissing       = prereqCheck.missing.filter((m) => !m.sameSpecies);
      if (sameSpeciesMissing.length === 1 && otherMissing.length === 0) {
        const req  = sameSpeciesMissing[0];
        const plan = consolidateToSingleSpecies(inventoryItems, req.count);
        if (plan && plan.needCraft) {
          const plankName = plan.species;
          const plankDef  = mcData.itemsByName[plankName] ?? mcData.blocksByName[plankName];
          if (plankDef) {
            const pr = bot.recipesFor(plankDef.id, null, 1, null);
            if (pr && pr.length > 0) {
              try { await bot.craft(pr[0], plan.needCraft.logs, null); } catch { /* continue */ }
            }
          }
          if (signal.aborted) return { ok: false, error: 'aborted' };
          // Re-evaluate prereqs after the consolidation attempt.
          prereqCheck = checkRecipePrereqs(item, bot.inventory?.items?.() ?? []);
        }
      }
    }
    if (!prereqCheck.ok) {
      const summary = describePrereqsMissing(prereqCheck.missing);
      return {
        ok: false,
        error_code: 'missing_prereqs',
        missing: prereqCheck.missing,
        error: `craft ${item}: no recipe available — missing prereqs: ${summary}. Resource chain: collect_block(<log>) → craft(<planks>) → craft(stick) → craft(${item}).`,
      };
    }

    // Redirect oak_planks/spruce_planks/etc. to the wood type the bot actually has.
    // Prevents the LLM from looping when it guesses the wrong wood variant.
    const resolvedItem = resolveWoodVariant(item, bot);

    const itemDef = mcData.itemsByName[resolvedItem] ?? mcData.blocksByName[resolvedItem];
    if (!itemDef) return { ok: false, error: `unknown item: ${item}` };
    const wantCount = Math.max(1, count | 0);

    // try inventory 2x2 first (no table needed)
    let recipes = bot.recipesFor(itemDef.id, null, 1, null);
    let table = null;

    if (!recipes || recipes.length === 0) {
      const diag = diagnoseRecipeGap(bot, mcData, itemDef.id);
      // genuinely missing ingredients — don't even pathfind to a table
      if (diag.error && !diag.needsTable) {
        return { ok: false, error: `craft ${resolvedItem}: ${diag.error}` };
      }
      const tableId = mcData.blocksByName.crafting_table?.id;
      if (tableId == null) return { ok: false, error: 'crafting_table not in mc-data' };
      table = bot.findBlock({ matching: tableId, maxDistance: 32 });
      if (!table) {
        const haveTableItem = bot.inventory.items().some((i) => i.name === 'crafting_table');
        const hint = haveTableItem
          ? 'have a crafting_table in inventory — place_block(crafting_table) first'
          : 'craft a crafting_table first (need 4 planks)';
        return { ok: false, error: `craft ${resolvedItem} needs a crafting_table within 32m: ${hint}` };
      }
      try {
        const r = await runPathfinder(bot, new goals.GoalLookAtBlock(table.position, bot.world), signal);
        if (!r.ok) return { ok: false, error: `craft ${resolvedItem}: pathfind to crafting_table: ${r.error}` };
      } catch (e) {
        return { ok: false, error: `craft ${resolvedItem}: pathfind to crafting_table: ${e.message}` };
      }
      if (signal.aborted) return { ok: false, error: 'aborted' };
      recipes = bot.recipesFor(itemDef.id, null, 1, table);

      // At the table but still no recipe — the LLM is missing planks or sticks.
      // Auto-fill the logs→planks→sticks chain rather than returning an error and
      // forcing the LLM to manage each step as a separate decision turn.
      if (!recipes || recipes.length === 0) {
        await fillWoodChain(bot, mcData);
        if (signal.aborted) return { ok: false, error: 'aborted' };
        recipes = bot.recipesFor(itemDef.id, null, 1, table);
      }

      if (!recipes || recipes.length === 0) {
        const diag2 = diagnoseRecipeGap(bot, mcData, itemDef.id);
        return { ok: false, error: `craft ${resolvedItem}: ${diag2.error ?? 'no recipe available with current inventory'}` };
      }
    }

    // F1 (Test7): mineflayer's bot.craft() can resolve without throwing in
    // cases where the result drops on the ground (no free inventory slot) or
    // the server denies the recipe — leaving the brain to think it crafted
    // something it never actually got. Snapshot the count of resolvedItem
    // before/after and fail hard when the inventory didn't move.
    const beforeCount = countItemInInventory(bot, resolvedItem);
    try {
      await bot.craft(recipes[0], wantCount, table ?? undefined);
      const afterCount = countItemInInventory(bot, resolvedItem);
      const delivered = afterCount - beforeCount;
      if (delivered <= 0) {
        // Phase A — A2 (Step 2.5, 2026-05-11): explicit error_code lets the
        // brain treat UI desync as a distinct failure class from EARLY_TRIP
        // / no-recipe / missing-ingredient. Memory-update consumers can
        // surface a UI-desync warning instead of looping the same craft.
        return {
          ok: false,
          error_code: 'craft_succeeded_but_item_missing',
          error: `craft ${resolvedItem}: server reported success but ${resolvedItem} never landed in inventory (likely no free slot — output dropped on ground and may despawn in 5min). drop something with drop(<unused_item>) and retry, OR goto_item to pick the dropped ${resolvedItem} up.`,
        };
      }
      const note = resolvedItem !== item ? ` (used ${resolvedItem} in place of ${item})` : '';
      return { ok: true, crafted: `${delivered}x ${resolvedItem}${note}`, used_table: !!table };
    } catch (e) {
      return { ok: false, error: `craft ${resolvedItem}: ${e.message}` };
    }
  },

  goto_item: async ({ bot, signal }, { range = 32 } = {}) => {
    const me = bot.entity?.position;
    if (!me) return { ok: false, error: 'no position' };
    let target = null, bestD = Infinity;
    for (const e of Object.values(bot.entities ?? {})) {
      if (e === bot.entity || !e.position || isNaN(e.position.x)) continue;
      // OVN-010 sibling (caught 2026-05-08 08:16Z cascade): every access to
      // e.objectType triggers a console.trace from prismarine-entity:78. With
      // 5 bots polling goto_item the trace flood synchronously starves the
      // dashboard event loop and all 5 bots disconnect together. Drop the
      // deprecated fallbacks. The set of names matches the library's own
      // getDroppedItem() check (prismarine-entity index.js:65).
      const isItem = e.name === 'item' || e.name === 'Item' || e.name === 'item_stack';
      if (!isItem) continue;
      const dx = e.position.x - me.x, dz = e.position.z - me.z;
      const d = Math.sqrt(dx*dx + dz*dz);
      if (d < bestD && d <= range) { bestD = d; target = e; }
    }
    if (!target) return { ok: false, error: `no item entity within ${range}m` };
    const beforeTotal = totalItemCount(bot);
    const goal = new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1);
    let pathR;
    try { pathR = await runPathfinder(bot, goal, signal); }
    catch (e) { return { ok: false, error: `pathfind: ${e.message}` }; }
    if (!pathR.ok) return { ok: false, error: `pathfind: ${pathR.error}` };
    // wait for the pickup tick (auto-pickup radius is ~1.5 blocks)
    await sleep(700);
    const gained = totalItemCount(bot) - beforeTotal;
    if (gained <= 0) {
      // F6 (Test7): the brain kept retrying goto_item on phantom drops. Spell
      // out the despawn timer and steer it toward a different action.
      return {
        ok: false,
        error: 'reached the item position but no pickup happened — item likely despawned (5min lifetime) or fell into unreachable terrain. STOP retrying goto_item; craft or collect_block what you need instead.',
      };
    }
    return { ok: true, picked_up: gained };
  },

  smelt: async ({ bot, mcData, signal }, { input, fuel, count = 1 }) => {
    if (!input) return { ok: false, error: 'missing input' };
    const furnaceId = mcData.blocksByName.furnace?.id;
    const blastId   = mcData.blocksByName.blast_furnace?.id;
    let furnaceBlock = bot.findBlock({ matching: furnaceId, maxDistance: 32 });
    if (!furnaceBlock && blastId != null) furnaceBlock = bot.findBlock({ matching: blastId, maxDistance: 32 });
    if (!furnaceBlock) return { ok: false, error: 'no furnace within 32m' };
    try {
      const r = await runPathfinder(bot, new goals.GoalLookAtBlock(furnaceBlock.position, bot.world), signal);
      if (!r.ok) return { ok: false, error: `pathfind to furnace: ${r.error}` };
    } catch (e) {
      return { ok: false, error: `pathfind to furnace: ${e.message}` };
    }
    if (signal.aborted) return { ok: false, error: 'aborted' };

    const inputItem = bot.inventory.items().find(i => i.name === input);
    if (!inputItem) return { ok: false, error: `no ${input} in inventory` };

    const fuelCandidates = fuel ? [fuel] : ['coal', 'charcoal', 'oak_log', 'oak_planks'];
    const fuelItem = fuelCandidates.map(n => bot.inventory.items().find(i => i.name === n)).find(Boolean);
    if (!fuelItem) return { ok: false, error: 'no fuel (coal/charcoal/log/planks) in inventory' };

    let furnace;
    try { furnace = await bot.openFurnace(furnaceBlock); }
    catch (e) { return { ok: false, error: `open furnace: ${e.message}` }; }

    const wantCount = Math.max(1, count | 0);
    try {
      await furnace.putFuel(fuelItem.type, null, Math.min(fuelItem.count, Math.max(1, Math.ceil(wantCount / 8))));
      await furnace.putInput(inputItem.type, null, Math.min(inputItem.count, wantCount));
      // wait up to 12s per item for output to appear
      const deadline = Date.now() + (10000 + wantCount * 12000);
      let smelted = 0;
      while (smelted < wantCount && Date.now() < deadline && !signal.aborted) {
        await sleep(2000);
        const out = furnace.outputItem();
        if (out && out.count > 0) {
          try { await furnace.takeOutput(); smelted += out.count; } catch { /* keep waiting */ }
        }
      }
      try { furnace.close(); } catch { /* noop */ }
      return { ok: smelted > 0, smelted, target: wantCount };
    } catch (e) {
      try { furnace.close(); } catch { /* noop */ }
      return { ok: false, error: `smelt: ${e.message}` };
    }
  },

  sleep: async ({ bot, mcData, signal }) => {
    const time = bot.time?.timeOfDay ?? 0;
    if (time < 12542) return { ok: false, error: 'too early to sleep (must be night)' };
    const bedNames = Object.keys(mcData.blocksByName).filter(n => n.endsWith('_bed'));
    let bed = null;
    for (const name of bedNames) {
      const id = mcData.blocksByName[name].id;
      const found = bot.findBlock({ matching: id, maxDistance: 32 });
      if (found) { bed = found; break; }
    }
    if (!bed) return { ok: false, error: 'no bed within 32m' };
    try {
      const r = await runPathfinder(bot, new goals.GoalLookAtBlock(bed.position, bot.world), signal);
      if (!r.ok) return { ok: false, error: `pathfind to bed: ${r.error}` };
    } catch (e) {
      return { ok: false, error: `pathfind to bed: ${e.message}` };
    }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    try {
      await bot.sleep(bed);
      return { ok: true, slept: true };
    } catch (e) {
      return { ok: false, error: `sleep: ${e.message}` };
    }
  },

  drop: async ({ bot, signal }, { item, count = 1 }) => {
    if (!item) return { ok: false, error: 'missing item' };
    if (signal.aborted) return { ok: false, error: 'aborted' };
    const have = bot.inventory.items().find(i => i.name === item);
    if (!have) return { ok: false, error: `no ${item} in inventory` };
    const n = Math.min(have.count, Math.max(1, count | 0));
    try { await bot.toss(have.type, null, n); return { ok: true, dropped: `${n}x ${item}` }; }
    catch (e) { return { ok: false, error: `toss: ${e.message}` }; }
  },

  give_to: async ({ bot, signal }, { player, item, count = 1 }) => {
    if (!player) return { ok: false, error: 'missing player' };
    if (!item)   return { ok: false, error: 'missing item' };
    const target = Object.values(bot.entities ?? {}).find(e =>
      (e.type === 'player' || e.username) && (e.username === player || e.name === player)
    );
    if (!target) return { ok: false, error: `${player} not visible` };
    try {
      const r = await runPathfinder(bot, new goals.GoalFollow(target, 2), signal);
      if (!r.ok) return { ok: false, error: `pathfind to ${player}: ${r.error}` };
    } catch (e) { return { ok: false, error: `pathfind: ${e.message}` }; }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    const have = bot.inventory.items().find(i => i.name === item);
    if (!have) return { ok: false, error: `no ${item} in inventory` };
    const n = Math.min(have.count, Math.max(1, count | 0));
    try {
      await bot.lookAt(target.position.offset(0, 1.6, 0), true);
      await bot.toss(have.type, null, n);
      return { ok: true, gave: `${n}x ${item}`, to: player };
    } catch (e) { return { ok: false, error: `toss: ${e.message}` }; }
  },

  deposit_chest: async ({ bot, mcData, signal }, { item, count = 1 }) => {
    if (!item) return { ok: false, error: 'missing item' };
    const chestId = mcData.blocksByName.chest?.id;
    const chestBlock = bot.findBlock({ matching: chestId, maxDistance: 32 });
    if (!chestBlock) return { ok: false, error: 'no chest within 32m' };
    try {
      const r = await runPathfinder(bot, new goals.GoalLookAtBlock(chestBlock.position, bot.world), signal);
      if (!r.ok) return { ok: false, error: `pathfind to chest: ${r.error}` };
    } catch (e) { return { ok: false, error: `pathfind to chest: ${e.message}` }; }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    let chest;
    try { chest = await bot.openContainer(chestBlock); }
    catch (e) { return { ok: false, error: `open chest: ${e.message}` }; }
    try {
      const have = bot.inventory.items().find(i => i.name === item);
      if (!have) { try { chest.close(); } catch {} return { ok: false, error: `no ${item} in inventory` }; }
      const n = Math.min(have.count, Math.max(1, count | 0));
      await chest.deposit(have.type, null, n);
      try { chest.close(); } catch { /* noop */ }
      return { ok: true, deposited: `${n}x ${item}` };
    } catch (e) {
      try { chest.close(); } catch { /* noop */ }
      return { ok: false, error: `deposit: ${e.message}` };
    }
  },

  withdraw_chest: async ({ bot, mcData, signal }, { item, count = 1 }) => {
    if (!item) return { ok: false, error: 'missing item' };
    const itemDef = mcData.itemsByName[item];
    if (!itemDef) return { ok: false, error: `unknown item: ${item}` };
    const chestId = mcData.blocksByName.chest?.id;
    const chestBlock = bot.findBlock({ matching: chestId, maxDistance: 32 });
    if (!chestBlock) return { ok: false, error: 'no chest within 32m' };
    try {
      const r = await runPathfinder(bot, new goals.GoalLookAtBlock(chestBlock.position, bot.world), signal);
      if (!r.ok) return { ok: false, error: `pathfind to chest: ${r.error}` };
    } catch (e) { return { ok: false, error: `pathfind to chest: ${e.message}` }; }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    let chest;
    try { chest = await bot.openContainer(chestBlock); }
    catch (e) { return { ok: false, error: `open chest: ${e.message}` }; }
    try {
      const n = Math.max(1, count | 0);
      await chest.withdraw(itemDef.id, null, n);
      try { chest.close(); } catch { /* noop */ }
      return { ok: true, withdrew: `${n}x ${item}` };
    } catch (e) {
      try { chest.close(); } catch { /* noop */ }
      return { ok: false, error: `withdraw: ${e.message}` };
    }
  },

  equip_item: async ({ bot, signal }, { item, destination = 'hand' }) => {
    if (!item) return { ok: false, error: 'missing item' };
    if (signal.aborted) return { ok: false, error: 'aborted' };
    const have = bot.inventory.items().find(i => i.name === item);
    if (!have) return { ok: false, error: `no ${item} in inventory` };
    try { await bot.equip(have, destination); return { ok: true, equipped: item, slot: destination }; }
    catch (e) { return { ok: false, error: `equip: ${e.message}` }; }
  },

  dig_block: async ({ bot, mcData, signal }, { x, y, z }) => {
    if (x == null || y == null || z == null) return { ok: false, error: 'missing x/y/z' };
    // GoalLookAtBlock calls .floored() on the position internally — pass a real
    // Vec3, not the plain {x,y,z} object that bot.blockAt() returns on its
    // .position field. (See Test5 obs-01 / Bug 1 in the final report.)
    const pos = new Vec3(x | 0, y | 0, z | 0);
    const target = bot.blockAt(pos);
    if (!target || target.name === 'air') return { ok: false, error: 'no block at coord' };
    if (target.name === 'bedrock') return { ok: false, error: 'bedrock — cannot dig' };
    if (blockNeedsPickaxe(mcData, target.name)) {
      const equipped = await equipBestPickaxe(bot);
      if (!equipped.ok) return equipped;
      // Step 2.6 hotfix (2026-05-17): tier check after equipping. If the
      // best owned pickaxe is too weak, the block breaks but nothing drops
      // — bot thinks it succeeded and loops on the same target. Surface
      // as an early-trip error so the cooldown fires on turn 1.
      const tier = pickaxeTierForBlock(mcData, bot, target.name);
      if (!tier.ok) {
        return {
          ok: false,
          error_code: 'pickaxe_tier_too_low',
          error: `dig_block ${target.name}: your pickaxe is too weak — needs ${tier.needs} (or better). Mining by hand would break the block with no drop. Next step: craft(item=${tier.needs}) first.`,
        };
      }
    }
    try {
      const r = await runPathfinder(bot, new goals.GoalLookAtBlock(pos, bot.world), signal);
      if (!r.ok) return { ok: false, error: `pathfind: ${r.error}` };
    } catch (e) { return { ok: false, error: `pathfind: ${e.message}` }; }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    try { await bot.dig(target); return { ok: true, dug: target.name }; }
    catch (e) { return { ok: false, error: `dig: ${e.message}` }; }
  },

  dig_down: async ({ bot, mcData, signal }, { depth = 1 }) => {
    const n = Math.min(Math.max(depth | 0, 1), 16);
    let dug = 0;
    for (let i = 0; i < n; i++) {
      if (signal.aborted) return { ok: dug > 0, error: 'aborted', dug };
      const here = bot.entity.position;
      // void safety: never dig down if y ≤ -60 (kill plane is -64)
      if (here.y <= -60) return { ok: dug > 0, error: 'too close to void, stopping', dug };

      // If the literal y-1 cell is air but the bot is on solid ground, we're
      // standing on a cave edge. Trust onGround as proof of footing and
      // search the y-1 neighborhood for the actual supporting block. This
      // is what was broken in Test5 obs-01 (Bug 2): the bot at y=24 on a
      // stone ledge with cave at y=23 refused dig_down because the literal
      // (x,y-1,z) cell happened to be cave-air.
      let below = bot.blockAt(here.offset(0, -1, 0));
      const fluidLike = (b) => !!b && /^(?:lava|water|flowing_lava|flowing_water)$/.test(b.name ?? '');
      if (fluidLike(below)) {
        return { ok: dug > 0, error: `unsafe block below: ${below.name}`, dug };
      }
      if (!below || below.name === 'air') {
        if (!bot.entity.onGround) {
          return { ok: dug > 0, error: 'not on solid ground (in air/falling) — cannot dig down safely', dug };
        }
        const fx = Math.floor(here.x);
        const fy = Math.floor(here.y);
        const fz = Math.floor(here.z);
        const candidates = [
          [0, -1, 0], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1],
          [1, -1, 1], [1, -1, -1], [-1, -1, 1], [-1, -1, -1],
        ];
        let found = null;
        for (const [dx, dy, dz] of candidates) {
          const cand = bot.blockAt(new Vec3(fx + dx, fy + dy, fz + dz));
          if (!cand || cand.name === 'air') continue;
          if (fluidLike(cand) || cand.name === 'bedrock') continue;
          found = cand;
          break;
        }
        if (!found) {
          return { ok: dug > 0, error: 'no solid block at feet (cave edge or floating); move horizontally first then dig', dug };
        }
        below = found;
      }
      if (below.name === 'bedrock') return { ok: dug > 0, error: 'bedrock', dug };
      if (blockNeedsPickaxe(mcData, below.name)) {
        const equipped = await equipBestPickaxe(bot);
        if (!equipped.ok) return { ok: dug > 0, ...equipped, dug };
      }
      try { await bot.dig(below); dug++; }
      catch (e) { return { ok: dug > 0, error: `dig: ${e.message}`, dug }; }
      await sleep(150);
    }
    return { ok: true, dug };
  },

  place_block_at: async ({ bot, signal }, { block, x, y, z }) => {
    if (!block) return { ok: false, error: 'missing block' };
    if (x == null || y == null || z == null) return { ok: false, error: 'missing x/y/z' };
    const item = bot.inventory.items().find(i => i.name === block);
    if (!item) return { ok: false, error: `no ${block} in inventory` };
    const targetPos = { x: x | 0, y: y | 0, z: z | 0 };
    // pathfind to within 3 blocks but NOT on the target itself
    try {
      const r = await runPathfinder(bot, new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 2), signal);
      if (!r.ok) return { ok: false, error: `pathfind: ${r.error}` };
    } catch (e) { return { ok: false, error: `pathfind: ${e.message}` }; }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    try { await bot.equip(item, 'hand'); } catch (e) { return { ok: false, error: `equip: ${e.message}` }; }
    return tryPlaceAt(bot, targetPos, block);
  },

  use_item: async ({ bot, signal }, { offhand = false, hold_ms = 0 }) => {
    if (signal.aborted) return { ok: false, error: 'aborted' };
    try {
      bot.activateItem(!!offhand);
      if (hold_ms > 0) await sleep(Math.min(hold_ms | 0, 5000));
      bot.deactivateItem();
      return { ok: true };
    } catch (e) { return { ok: false, error: `activate: ${e.message}` }; }
  },

  use_block: async ({ bot, mcData, signal }, { block, x, y, z, range = 16 }) => {
    let target = null;
    if (x != null && y != null && z != null) {
      target = bot.blockAt({ x: x | 0, y: y | 0, z: z | 0 });
    } else if (block) {
      const id = mcData.blocksByName[block]?.id;
      if (id == null) return { ok: false, error_code: 'unknown_block', error: `unknown block: ${block}` };
      target = bot.findBlock({ matching: id, maxDistance: range });
    }
    if (!target) return { ok: false, error_code: 'no_target', error: 'no target block' };
    try {
      const r = await runPathfinder(bot, new goals.GoalLookAtBlock(target.position, bot.world), signal);
      if (!r.ok) return { ok: false, error_code: 'pathfind_failed', error: `pathfind: ${r.error}` };
    } catch (e) { return { ok: false, error_code: 'pathfind_failed', error: `pathfind: ${e.message}` }; }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    // Phase A — A4 (Step 2.5, 2026-05-11): explicit lookAt + range guard.
    // GoalLookAtBlock should park the bot within use range, but the fleet
    // logs (BUG-001 / BUG-003 era) show use_block(crafting_table) repeating
    // its activate-fails after the pathfinder reports ok. Two ways this
    // happens: (a) the pathfinder finishes "close enough" but actually 5+
    // blocks away (e.g. partially blocked by a tree), (b) the bot lands
    // facing the wrong way and the activate ray misses. Force a face-the-
    // table lookAt + verify the bot is within the survival use range
    // (~4.5 blocks) before invoking activateBlock. If we're still out of
    // range, return a structured failure so the brain substitutes a
    // goto_coord recovery instead of looping use_block.
    const USE_RANGE = 4.5;
    const center = target.position.offset
      ? target.position.offset(0.5, 0.5, 0.5)
      : { x: target.position.x + 0.5, y: target.position.y + 0.5, z: target.position.z + 0.5 };
    try { await bot.lookAt(center, true); } catch { /* lookAt fails are non-fatal */ }
    const me = bot.entity?.position;
    if (me && typeof me.distanceTo === 'function') {
      const d = me.distanceTo(target.position);
      if (d > USE_RANGE) {
        const ax = (target.position.x | 0) + 1, ay = target.position.y | 0, az = target.position.z | 0;
        return {
          ok: false,
          error_code: 'out_of_range',
          error: `use_block ${target.name}: out of use-range (${d.toFixed(1)}m > ${USE_RANGE}m). Try goto_coord({x:${ax},y:${ay},z:${az}}) to a known-good adjacent position, then use_block again.`,
          recovery: { skill: 'goto_coord', args: { x: ax, y: ay, z: az } },
        };
      }
    }
    try { await bot.activateBlock(target); return { ok: true, used: target.name }; }
    catch (e) { return { ok: false, error_code: 'activate_failed', error: `activate: ${e.message}` }; }
  },

  use_entity: async ({ bot, signal }, { entity_type, range = 8 }) => {
    if (!entity_type) return { ok: false, error: 'missing entity_type' };
    const target = nearestEntityByName(bot, entity_type, range);
    if (!target) return { ok: false, error: `no ${entity_type} within ${range}m` };
    try {
      const r = await runPathfinder(bot, new goals.GoalFollow(target, 2), signal);
      if (!r.ok) return { ok: false, error: `pathfind: ${r.error}` };
    } catch (e) { return { ok: false, error: `pathfind: ${e.message}` }; }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    try { await bot.lookAt(target.position.offset(0, target.height ?? 1, 0), true); } catch { /* noop */ }
    try { await bot.activateEntity(target); return { ok: true, used_on: entity_type }; }
    catch (e) { return { ok: false, error: `activate: ${e.message}` }; }
  },

  shoot_bow: async ({ bot, signal }, { entity_type, range = 32, charge_ms = 1100 }) => {
    if (!entity_type) return { ok: false, error: 'missing entity_type' };
    const bow = bot.inventory.items().find(i => i.name === 'bow' || i.name === 'crossbow');
    if (!bow) return { ok: false, error: 'no bow/crossbow' };
    const arrow = bot.inventory.items().find(i => /arrow$/.test(i.name));
    if (!arrow) return { ok: false, error: 'no arrows' };
    const target = nearestEntityByName(bot, entity_type, range);
    if (!target) return { ok: false, error: `no ${entity_type} within ${range}m` };
    try { await bot.equip(bow, 'hand'); } catch (e) { return { ok: false, error: `equip: ${e.message}` }; }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    try {
      await bot.lookAt(target.position.offset(0, (target.height ?? 1.6) * 0.9, 0), true);
      bot.activateItem();
      await sleep(Math.min(Math.max(charge_ms | 0, 200), 2000));
      bot.deactivateItem();
      return { ok: true, shot_at: entity_type };
    } catch (e) {
      try { bot.deactivateItem(); } catch { /* noop */ }
      return { ok: false, error: `bow: ${e.message}` };
    }
  },

  mount: async ({ bot, signal }, { entity_type, range = 8 }) => {
    if (!entity_type) return { ok: false, error: 'missing entity_type' };
    const target = nearestEntityByName(bot, entity_type, range);
    if (!target) return { ok: false, error: `no ${entity_type} within ${range}m` };
    try {
      const r = await runPathfinder(bot, new goals.GoalFollow(target, 1), signal);
      if (!r.ok) return { ok: false, error: `pathfind: ${r.error}` };
    } catch (e) { return { ok: false, error: `pathfind: ${e.message}` }; }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    try { bot.mount(target); await sleep(400); return { ok: !!bot.vehicle, mounted: entity_type }; }
    catch (e) { return { ok: false, error: `mount: ${e.message}` }; }
  },

  dismount: async ({ bot }) => {
    if (!bot.vehicle) return { ok: false, error: 'not mounted' };
    try { bot.dismount(); return { ok: true }; }
    catch (e) { return { ok: false, error: `dismount: ${e.message}` }; }
  },

  wake_up: async ({ bot }) => {
    if (!bot.isSleeping) return { ok: false, error: 'not sleeping' };
    try { await bot.wake(); return { ok: true }; }
    catch (e) { return { ok: false, error: `wake: ${e.message}` }; }
  },

  follow_player: async ({ bot, signal }, { player, distance = 3, duration = 30 }) => {
    if (!player) return { ok: false, error: 'missing player' };
    const target = Object.values(bot.entities ?? {}).find(e =>
      (e.type === 'player' || e.username) && (e.username === player || e.name === player)
    );
    if (!target) return { ok: false, error: `${player} not visible` };
    const goal = new goals.GoalFollow(target, Math.max(1, distance | 0));
    bot.pathfinder.setGoal(goal, true);
    const ms = Math.min(Math.max(duration * 1000, 1000), 60000);
    return new Promise((resolve) => {
      const finish = (r) => { try { bot.pathfinder.setGoal(null); } catch {} resolve(r); };
      const t = setTimeout(() => finish({ ok: true, followed: player, seconds: duration }), ms);
      signal.addEventListener('abort', () => { clearTimeout(t); finish({ ok: false, error: 'aborted' }); });
    });
  },

  stop: async ({ bot }) => {
    try { bot.pathfinder?.setGoal(null); } catch { /* noop */ }
    for (const ctrl of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
      try { bot.setControlState(ctrl, false); } catch { /* noop */ }
    }
    return { ok: true };
  },

  fill_bucket: async ({ bot, mcData, signal }, { liquid = 'water' }) => {
    const bucket = bot.inventory.items().find(i => i.name === 'bucket');
    if (!bucket) return { ok: false, error: 'no empty bucket' };
    const id = mcData.blocksByName[liquid]?.id;
    if (id == null) return { ok: false, error: `unknown liquid: ${liquid}` };
    const source = bot.findBlock({ matching: id, maxDistance: 16 });
    if (!source) return { ok: false, error: `no ${liquid} within 16m` };
    try {
      const r = await runPathfinder(bot, new goals.GoalLookAtBlock(source.position, bot.world), signal);
      if (!r.ok) return { ok: false, error: `pathfind: ${r.error}` };
    } catch (e) { return { ok: false, error: `pathfind: ${e.message}` }; }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    try { await bot.equip(bucket, 'hand'); } catch (e) { return { ok: false, error: `equip: ${e.message}` }; }
    try { await bot.lookAt(source.position.offset(0.5, 0.5, 0.5), true); bot.activateItem(); await sleep(200); bot.deactivateItem();
      return { ok: true, filled: liquid }; }
    catch (e) { return { ok: false, error: `fill: ${e.message}` }; }
  },

  empty_bucket: async ({ bot, signal }) => {
    const filled = bot.inventory.items().find(i => /bucket$/.test(i.name) && i.name !== 'bucket' && i.name !== 'milk_bucket');
    if (!filled) return { ok: false, error: 'no filled bucket' };
    if (signal.aborted) return { ok: false, error: 'aborted' };
    try { await bot.equip(filled, 'hand'); } catch (e) { return { ok: false, error: `equip: ${e.message}` }; }
    try {
      const ahead = bot.blockAtCursor(4) ?? bot.blockAt(bot.entity.position.offset(0, -1, 0));
      if (ahead) await bot.lookAt(ahead.position.offset(0.5, 1, 0.5), true);
      bot.activateItem(); await sleep(200); bot.deactivateItem();
      return { ok: true, emptied: filled.name };
    } catch (e) { return { ok: false, error: `empty: ${e.message}` }; }
  },

  till_soil: async ({ bot, mcData, signal }) => {
    const hoe = bot.inventory.items().find(i => /_hoe$/.test(i.name));
    if (!hoe) return { ok: false, error: 'no hoe' };
    const dirtId   = mcData.blocksByName.dirt?.id;
    const grassId  = mcData.blocksByName.grass_block?.id;
    const target = bot.findBlock({ matching: (b) => b && (b.type === dirtId || b.type === grassId), maxDistance: 6 });
    if (!target) return { ok: false, error: 'no tillable dirt/grass within 6m' };
    try {
      const r = await runPathfinder(bot, new goals.GoalLookAtBlock(target.position, bot.world), signal);
      if (!r.ok) return { ok: false, error: `pathfind: ${r.error}` };
    } catch (e) { return { ok: false, error: `pathfind: ${e.message}` }; }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    try { await bot.equip(hoe, 'hand'); } catch (e) { return { ok: false, error: `equip: ${e.message}` }; }
    try { await bot.activateBlock(target); return { ok: true, tilled: target.name }; }
    catch (e) { return { ok: false, error: `till: ${e.message}` }; }
  },

  use_bonemeal: async ({ bot, mcData, signal }, { block, x, y, z, range = 16 }) => {
    const bonemeal = bot.inventory.items().find(i => i.name === 'bone_meal');
    if (!bonemeal) return { ok: false, error: 'no bone_meal' };
    let target = null;
    if (x != null && y != null && z != null) target = bot.blockAt({ x: x | 0, y: y | 0, z: z | 0 });
    else if (block) {
      const id = mcData.blocksByName[block]?.id;
      if (id == null) return { ok: false, error: `unknown block: ${block}` };
      target = bot.findBlock({ matching: id, maxDistance: range });
    }
    if (!target) return { ok: false, error: 'no target block' };
    try {
      const r = await runPathfinder(bot, new goals.GoalLookAtBlock(target.position, bot.world), signal);
      if (!r.ok) return { ok: false, error: `pathfind: ${r.error}` };
    } catch (e) { return { ok: false, error: `pathfind: ${e.message}` }; }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    try { await bot.equip(bonemeal, 'hand'); await bot.activateBlock(target); return { ok: true, used_on: target.name }; }
    catch (e) { return { ok: false, error: `bonemeal: ${e.message}` }; }
  },

  plant_crop: async ({ bot, mcData, signal }, { seed }) => {
    if (!seed) return { ok: false, error: 'missing seed' };
    const seedItem = bot.inventory.items().find(i => i.name === seed);
    if (!seedItem) return { ok: false, error: `no ${seed}` };
    const farmId = mcData.blocksByName.farmland?.id;
    const target = bot.findBlock({ matching: farmId, maxDistance: 8 });
    if (!target) return { ok: false, error: 'no farmland within 8m' };
    try {
      const r = await runPathfinder(bot, new goals.GoalLookAtBlock(target.position, bot.world), signal);
      if (!r.ok) return { ok: false, error: `pathfind: ${r.error}` };
    } catch (e) { return { ok: false, error: `pathfind: ${e.message}` }; }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    try { await bot.equip(seedItem, 'hand'); await bot.placeBlock(target, { x: 0, y: 1, z: 0 }); return { ok: true, planted: seed }; }
    catch (e) { return { ok: false, error: `plant: ${e.message}` }; }
  },

  fish: async ({ bot, mcData, signal }) => {
    const rod = bot.inventory.items().find(i => i.name === 'fishing_rod');
    if (!rod) return { ok: false, error: 'no fishing_rod' };
    const waterId = mcData.blocksByName.water?.id;
    const water = bot.findBlock({ matching: waterId, maxDistance: 16 });
    if (!water) return { ok: false, error: 'no water within 16m' };
    try {
      const r = await runPathfinder(bot, new goals.GoalNear(water.position.x, water.position.y, water.position.z, 3), signal);
      if (!r.ok) return { ok: false, error: `pathfind: ${r.error}` };
    } catch (e) { return { ok: false, error: `pathfind: ${e.message}` }; }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    try { await bot.equip(rod, 'hand'); } catch (e) { return { ok: false, error: `equip: ${e.message}` }; }
    try { await bot.lookAt(water.position.offset(0.5, 0.5, 0.5), true); } catch { /* noop */ }
    try {
      const aborted = new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
      await Promise.race([bot.fish(), aborted]);
      return { ok: true, caught: true };
    } catch (e) { return { ok: false, error: `fish: ${e.message}` }; }
  },

  shear_animal: async ({ bot, signal }, { entity_type = 'sheep', range = 12 }) => {
    const shears = bot.inventory.items().find(i => i.name === 'shears');
    if (!shears) return { ok: false, error: 'no shears' };
    const target = nearestEntityByName(bot, entity_type, range);
    if (!target) return { ok: false, error: `no ${entity_type} within ${range}m` };
    try {
      const r = await runPathfinder(bot, new goals.GoalFollow(target, 1), signal);
      if (!r.ok) return { ok: false, error: `pathfind: ${r.error}` };
    } catch (e) { return { ok: false, error: `pathfind: ${e.message}` }; }
    if (signal.aborted) return { ok: false, error: 'aborted' };
    try { await bot.equip(shears, 'hand'); await bot.lookAt(target.position.offset(0, 1, 0), true); await bot.activateEntity(target);
      return { ok: true, sheared: entity_type }; }
    catch (e) { return { ok: false, error: `shear: ${e.message}` }; }
  },

  flee: async ({ bot, signal }, { from }) => {
    const me = bot.entity.position;
    let target = null, best = Infinity;
    for (const e of Object.values(bot.entities ?? {})) {
      if (e === bot.entity || !e.position) continue;
      if (from && (e.name ?? '').toLowerCase() !== from.toLowerCase()) continue;
      const dx = e.position.x - me.x, dz = e.position.z - me.z;
      const d = Math.sqrt(dx*dx + dz*dz);
      if (d < best) { best = d; target = e; }
    }
    if (!target) return { ok: false, error: `no ${from ?? 'entity'} found to flee from` };
    const dx = me.x - target.position.x, dz = me.z - target.position.z;
    const len = Math.max(Math.sqrt(dx*dx + dz*dz), 0.001);
    const fleeX = Math.round(me.x + (dx / len) * 24);
    const fleeZ = Math.round(me.z + (dz / len) * 24);
    return runPathfinder(bot, new goals.GoalNearXZ(fleeX, fleeZ, 2), signal);
  },
};

function runPathfinder(bot, goal, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    const onAbort = () => {
      try { bot.pathfinder.setGoal(null); } catch { /* noop */ }
      finish({ ok: false, error: 'aborted' });
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort);
    bot.pathfinder.goto(goal)
      .then(() => finish({ ok: true }))
      .catch((err) => finish({ ok: false, error: err?.message || String(err) }));
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Truncate a string to maxLen, breaking on a word boundary when possible.
// Adds an ellipsis when truncation actually happens. Used for the say skill
// to stay under MC's per-message char limit (Bug 11).
function truncateAtBoundary(s, maxLen) {
  if (!s || s.length <= maxLen) return s;
  const slice = s.slice(0, maxLen - 1);
  // try to break at the last whitespace within the slice
  const idx = slice.lastIndexOf(' ');
  const core = idx > maxLen * 0.6 ? slice.slice(0, idx) : slice;
  return `${core.trimEnd()}…`;
}

function sayTokens(text) {
  if (!text) return new Set();
  const out = new Set();
  for (const t of String(text).toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length < 3) continue;
    out.add(t);
    if (t.length > 3 && t.endsWith('s')) out.add(t.slice(0, -1));
  }
  return out;
}

function jaccardOf(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

const PICKAXE_ITEM_NAMES = new Set([
  'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe',
  'golden_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe',
]);

function blockNeedsPickaxe(mcData, blockName) {
  const block = mcData?.blocksByName?.[blockName];
  if (!block?.harvestTools) return false;
  const pickIds = [...PICKAXE_ITEM_NAMES]
    .map(n => mcData.itemsByName?.[n]?.id)
    .filter(id => id != null);
  return Object.keys(block.harvestTools).some(id => pickIds.includes(Number(id)));
}

// Step 2.6 hotfix (2026-05-17): tier-aware pickaxe check. Returns
// { ok: true } when the bot's best owned pickaxe can actually drop the
// target block, otherwise { ok: false, error, needs } where `needs` is
// the lowest tier that works. Without this, bots with only a wooden
// pickaxe "succeed" at digging iron_ore (the block breaks, nothing drops)
// and the brain marks the skill ok=true — they spin forever thinking
// they're making progress. The 30-min observation showed slot 2 doing
// exactly this on copper_ore.
function pickaxeTierForBlock(mcData, bot, blockName) {
  const block = mcData?.blocksByName?.[blockName];
  if (!block?.harvestTools) return { ok: true };
  const TIER_ORDER = ['wooden_pickaxe','stone_pickaxe','iron_pickaxe','diamond_pickaxe','netherite_pickaxe','golden_pickaxe'];
  const tierIds = {};
  for (const n of TIER_ORDER) {
    const id = mcData.itemsByName?.[n]?.id;
    if (id != null) tierIds[id] = n;
  }
  const acceptedNames = Object.keys(block.harvestTools)
    .map((id) => tierIds[Number(id)])
    .filter(Boolean);
  if (acceptedNames.length === 0) return { ok: true }; // not pickaxe-mined at all
  const inv = bot.inventory?.items?.() ?? [];
  const ownsAccepted = acceptedNames.some((n) => inv.some((it) => it.name === n));
  if (ownsAccepted) return { ok: true };
  // pick the lowest-tier accepted name (most common case: stone or iron)
  const lowest = TIER_ORDER.find((n) => acceptedNames.includes(n)) || acceptedNames[0];
  return { ok: false, needs: lowest, accepted: acceptedNames };
}

async function equipBestPickaxe(bot) {
  const ORDER = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'];
  if (bot.heldItem && PICKAXE_ITEM_NAMES.has(bot.heldItem.name)) return { ok: true };
  const have = ORDER.map(n => bot.inventory.items().find(i => i.name === n)).find(Boolean);
  if (!have) return { ok: false, error: 'no pickaxe in inventory — craft wooden_pickaxe first (3 planks + 2 sticks at a crafting_table)' };
  try { await bot.equip(have, 'hand'); return { ok: true }; }
  catch (e) { return { ok: false, error: `equip pickaxe: ${e.message}` }; }
}

// Items mineflayer's bot.consume() actually accepts. Used by the eat skill to
// reject seeds, raw inedible drops, etc. before they hang the consume call.
const EDIBLE_NAME_RE = /^(?:apple|golden_apple|enchanted_golden_apple|bread|cooked_beef|cooked_porkchop|cooked_chicken|cooked_mutton|cooked_rabbit|cooked_cod|cooked_salmon|baked_potato|carrot|golden_carrot|beetroot|sweet_berries|glow_berries|melon_slice|cookie|pumpkin_pie|cake|honey_bottle|mushroom_stew|rabbit_stew|beetroot_soup|suspicious_stew|dried_kelp|tropical_fish|cod|salmon|chorus_fruit)$/;

function totalItemCount(bot) {
  let n = 0;
  for (const it of bot.inventory?.items() ?? []) n += it.count;
  return n;
}

// OVN-012: returns { count, ratio } if the bot already holds at least one
// working copy of the named tool (≥20% durability). Returns null for non-
// tools and for tools that are about to break — in those cases the LLM
// should be allowed to craft a fresh one.
const TOOL_NAME_RE = /_(?:pickaxe|sword|axe|shovel|hoe)$/;
const TOOL_MIN_DURABILITY_RATIO = 0.2;
export function alreadyHasWorkingTool(bot, itemName) {
  if (!itemName || !TOOL_NAME_RE.test(itemName)) return null;
  const items = bot.inventory?.items?.() ?? [];
  let count = 0;
  let bestRatio = 0;
  for (const it of items) {
    if (it.name !== itemName) continue;
    count += it.count;
    // mineflayer items expose durability via `it.maxDurability` and
    // `it.durabilityUsed`. Treat missing fields as "fresh" so we still
    // block when durability can't be inspected — the LLM can drop the
    // questionable tool and retry if it really needs a new one.
    const used = it.durabilityUsed ?? 0;
    const max  = it.maxDurability ?? 0;
    const ratio = max > 0 ? Math.max(0, (max - used) / max) : 1;
    if (ratio > bestRatio) bestRatio = ratio;
  }
  if (count === 0) return null;
  if (bestRatio < TOOL_MIN_DURABILITY_RATIO) return null;
  return { count, ratio: bestRatio };
}

// Count of a specific item by name across all inventory slots. Used by craft
// to verify post-craft delivery, and by goto_item to verify a pickup.
function countItemInInventory(bot, itemName) {
  if (!itemName) return 0;
  let n = 0;
  for (const it of bot.inventory?.items() ?? []) {
    if (it.name === itemName) n += it.count;
  }
  return n;
}

// OVN-005/009: deterministic skill errors that won't change on retry.
// Threshold drops to 1 for these so the RECENTLY-FAILED banner trips on the
// first failure, instead of giving the LLM a free retry to confirm the
// obvious. Patterns are intentionally narrow — only the literal shapes the
// existing skill code emits (see place_block, goto_block, collect_block,
// equip_item, drop, give_to, etc.).
const EARLY_TRIP_PATTERNS = [
  /no\s+\S+\s+in inventory/i,           // place_block, equip_item, drop, etc.
  /no\s+(?:more\s+)?\S+\s+within\s+\d+m/i, // goto_block, collect_block, smelt, etc.
  /no recipe available/i,               // craft when planks/sticks are missing
];
// 2026-05-12 follow-up to the Step 2.5 fleet run: skills now carry an explicit
// `error_code` for the deterministic failure classes the regex list above
// couldn't reliably match. Matching by code is preferred over text — the code
// is structured and won't drift when the error string is reworded. Notable
// addition: `craft_succeeded_but_item_missing` (BUG-007 lookalike, the phantom
// craft loop that hSkBVNDMfU hit 10x in the 2026-05-12 deploy run). `out_of_range`
// is intentionally excluded — A4 already auto-runs the goto_coord recovery for it.
// `equip_failed`, `no_target`, `pathfind_failed`, and `activate_failed` are
// excluded as potentially transient.
const EARLY_TRIP_CODES = new Set([
  'craft_succeeded_but_item_missing',
  'no_valid_surface',
  'already_have_tool',
  'missing_prereqs',
  'unknown_block',
  'no_block_in_inventory',  // also caught by regex; both paths fire safely
  'pickaxe_tier_too_low',   // Step 2.6 hotfix — wrong tier can't drop the block
  'no_headroom',            // BUG-024 — pillar_up with a ceiling above
  'no_floor',               // BUG-024 — pillar_up with no footing
]);
export function isEarlyTripError(error, errorCode = null) {
  if (errorCode && EARLY_TRIP_CODES.has(errorCode)) return true;
  if (!error) return false;
  return EARLY_TRIP_PATTERNS.some((re) => re.test(String(error)));
}

// Pure helper: render the failure-log Map into the RECENTLY-FAILED banner
// strings the prompt surfaces. Threshold is dynamic — deterministic errors
// trip on the first failure, transient ones still need SKILL_FAIL_THRESHOLD.
export function summarizeBlockedActions(failureLog) {
  const out = [];
  for (const [key, arr] of failureLog) {
    if (arr.length === 0) continue;
    const last = arr[arr.length - 1];
    const earlyTrip = isEarlyTripError(last.error, last.errorCode);
    const threshold = earlyTrip ? SKILL_FAIL_THRESHOLD_EARLY : SKILL_FAIL_THRESHOLD;
    if (arr.length < threshold) continue;
    out.push(`${key} → ${arr.length}x failed (last: ${last.error})`);
  }
  return out;
}

// Phase C / C1 (Step 2.5, 2026-05-11): structured surroundings summary.
// Replaces the existing single-line "Nearby blocks: …" hint with a richer
// summary the LLM can act on: closest tree-bearing logs, closest mineable
// ores, and the bot's compass facing. Pure helper — uses bot.findBlocks
// (mineflayer-pathfinder) when available, falls back to repeated findBlock.
//
// Tree-bearing variants follow WOOD_LOG_VARIANTS. Ore set captures every
// vanilla 1.21.4 *_ore (overworld + nether + deepslate). Both lists are
// resolved against mcData at call time so future MC versions pick up new
// blocks automatically.
const ORE_BLOCK_NAMES = [
  'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore',
  'lapis_ore', 'diamond_ore', 'emerald_ore',
  'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_copper_ore',
  'deepslate_gold_ore', 'deepslate_redstone_ore', 'deepslate_lapis_ore',
  'deepslate_diamond_ore', 'deepslate_emerald_ore',
  'nether_quartz_ore', 'nether_gold_ore', 'ancient_debris',
];
const SURROUNDINGS_RANGE = 32;
const SURROUNDINGS_KEEP  = 5;

// Mineflayer yaw convention: 0 = south, π/2 = west, ±π = north, -π/2 = east.
// Round to nearest 8-point compass for human-readable facing direction.
export function facingFromYaw(yaw) {
  if (yaw == null || !Number.isFinite(yaw)) return 'unknown';
  // Normalize yaw into [-π, π], then to a 0-7 octant where 0 = south.
  let y = yaw % (2 * Math.PI);
  if (y > Math.PI)  y -= 2 * Math.PI;
  if (y < -Math.PI) y += 2 * Math.PI;
  const POINTS = ['south', 'south-west', 'west', 'north-west', 'north', 'north-east', 'east', 'south-east'];
  // octant index: 0 at yaw=0, increments counterclockwise
  const idx = Math.round(y / (Math.PI / 4));
  // map idx ∈ {-4..4} to {0..7} (treat -4 same as 4 — both = north)
  const norm = ((idx % 8) + 8) % 8;
  return POINTS[norm];
}

export function summarizeSurroundings(bot, mcData) {
  const me = bot.entity?.position;
  const trees = [];
  const ores  = [];
  const facing = facingFromYaw(bot.entity?.yaw ?? 0);
  if (!me || !mcData) return _surroundings({ trees, ores, facing, message: 'no position / no mcData' });

  function distTo(p) {
    const dx = p.x - me.x, dy = (p.y ?? me.y) - me.y, dz = p.z - me.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function collect(names, sink) {
    const ids = [];
    for (const n of names) {
      const id = mcData.blocksByName?.[n]?.id;
      if (id != null) ids.push(id);
    }
    if (ids.length === 0) return;
    // Prefer the bulk findBlocks API when the pathfinder plugin exposes it
    if (typeof bot.findBlocks === 'function') {
      const points = bot.findBlocks({ matching: ids, maxDistance: SURROUNDINGS_RANGE, count: SURROUNDINGS_KEEP * 4 });
      const idToName = {};
      for (const n of names) {
        const id = mcData.blocksByName?.[n]?.id;
        if (id != null) idToName[id] = n;
      }
      for (const p of (points || [])) {
        const block = bot.blockAt?.(p);
        const name = block?.name ?? idToName[block?.type] ?? 'unknown';
        sink.push({ name, x: p.x | 0, y: p.y | 0, z: p.z | 0, dist: Math.round(distTo(p)) });
      }
    } else {
      // fall back to single nearest per name
      for (const n of names) {
        const id = mcData.blocksByName?.[n]?.id;
        if (id == null) continue;
        const b = bot.findBlock?.({ matching: id, maxDistance: SURROUNDINGS_RANGE });
        if (b) sink.push({ name: n, x: b.position.x | 0, y: b.position.y | 0, z: b.position.z | 0, dist: Math.round(distTo(b.position)) });
      }
    }
    sink.sort((a, b) => a.dist - b.dist);
    sink.length = Math.min(sink.length, SURROUNDINGS_KEEP);
  }

  collect(WOOD_LOG_VARIANTS, trees);
  collect(ORE_BLOCK_NAMES, ores);

  return _surroundings({ trees, ores, facing });
}

// Internal — wraps the structured fields with a toString() that produces a
// compact prompt-ready line. Matches the "Surroundings: …" line the LLM sees
// in _observe(). Kept as a separate helper so tests can introspect both
// shapes without parsing strings.
function _surroundings({ trees, ores, facing, message }) {
  const obj = { trees, ores, facing };
  obj.toString = function () {
    const parts = [`facing ${facing}`];
    if (trees.length === 0) parts.push('no trees within 32m');
    else parts.push(`trees: ${trees.map((t) => `${t.name} @(${t.x},${t.y},${t.z}) ~${t.dist}m`).join(', ')}`);
    if (ores.length === 0) parts.push('no ores within 32m');
    else parts.push(`ores: ${ores.map((o) => `${o.name} @(${o.x},${o.y},${o.z}) ~${o.dist}m`).join(', ')}`);
    if (message) parts.push(message);
    return parts.join(' | ');
  };
  return obj;
}

// Regroup-wait breaker (BUG-001 mitigation): when paralysis override has
// rewritten the goal to "stuck — regroup ..." but the LLM keeps picking
// `wait` anyway, force a look_around instead. extractGoalNextStep can't help
// here — the regroup goal has no parseable Next-step by design. Pure function;
// returns a new action object so callers can detect the override by ref.
export function breakRegroupWait(currentGoal, action) {
  if (!currentGoal || typeof currentGoal !== 'string') return action;
  if (!/^\s*stuck\s*[—-]\s*regroup/i.test(currentGoal))   return action;
  if (action?.type !== 'wait')                            return action;
  return { type: 'look_around', args: { turns: 4 } };
}

// Step 2.6 hotfix (2026-05-17): extractGoalNextStep — pure parser that
// pulls a concrete skill call out of a goal hint's "Next step:" phrase.
// Used by the wait-spiral substitution path (and tested directly) to break
// learned-helplessness loops: when the brain sees the LLM picking wait
// over and over while a perfectly actionable hint is sitting in its goal
// text, the brain force-executes the parsed next step instead of letting
// the LLM continue to ignore it. Returns null when no parseable call is
// found — caller falls back to the prior behavior (hint-only).
export function extractGoalNextStep(currentGoal) {
  if (!currentGoal || typeof currentGoal !== 'string') return null;
  const m = currentGoal.match(/Next step:\s*([a-z_]+)\s*\(([^)]*)\)/i);
  if (!m) return null;
  const skill = m[1];
  const raw = (m[2] || '').trim();

  if (skill === 'collect_block') {
    let block = null;
    if (raw.startsWith('<')) {
      const alts = raw.replace(/[<>]/g, '').split('|').map((s) => s.trim());
      // prefer the first wood-log variant present in the alternatives
      block = alts.find((a) => WOOD_LOG_VARIANTS.includes(a)) || null;
      if (!block) block = alts.find((a) => /^[a-z_]+$/.test(a)) || null;
    } else if (/block\s*=/.test(raw)) {
      block = raw.replace(/.*block\s*=\s*([a-z_]+).*/, '$1');
    } else if (/^[a-z_]+$/.test(raw)) {
      block = raw;
    }
    if (!block) return null;
    return { type: 'collect_block', args: { block, count: 1, range: 64 } };
  }

  if (skill === 'craft') {
    const im = raw.match(/item\s*=\s*([a-z_]+)/);
    if (!im) return null;
    return { type: 'craft', args: { item: im[1], count: 1 } };
  }

  if (skill === 'place_block') {
    let block = null;
    const bm = raw.match(/block\s*=\s*([a-z_]+)/);
    if (bm) block = bm[1];
    else if (/^[a-z_]+$/.test(raw)) block = raw;
    if (!block) return null;
    return { type: 'place_block', args: { block } };
  }

  if (skill === 'look_around') {
    return { type: 'look_around', args: { turns: 4 } };
  }
  if (skill === 'dig_down') {
    return { type: 'dig_down', args: {} };
  }
  if (skill === 'drop') {
    const dm = raw.match(/item\s*=\s*([a-z_]+)/);
    if (!dm) return null;
    return { type: 'drop', args: { item: dm[1], count: 1 } };
  }
  return null;
}

// Phase C / C2 (Step 2.5, 2026-05-11): wait-spiral detector. Slot 7 in the
// 8-bot observation chose `wait` 35 of 40 turns when its goal (wooden_pickaxe)
// was blocked — classic learned-helplessness. After 4 waits in the last 8
// decisions WHILE a goal is set, push a memory hint so the LLM either picks
// a different approach or abandons the goal.
const WAIT_SPIRAL_THRESHOLD = 4;
const WAIT_SPIRAL_WINDOW    = 8;
export function detectWaitSpiral(decisions, currentGoal) {
  if (!currentGoal || !String(currentGoal).trim()) {
    return { spiral: false, reason: 'no_goal', waitCount: 0 };
  }
  const tail = (decisions || []).slice(-WAIT_SPIRAL_WINDOW);
  let waitCount = 0;
  for (const d of tail) {
    if (d?.type === 'wait') waitCount += 1;
  }
  return {
    spiral:    waitCount >= WAIT_SPIRAL_THRESHOLD,
    waitCount,
    reason:    waitCount >= WAIT_SPIRAL_THRESHOLD ? 'wait_spiral' : 'healthy',
  };
}

// Canonical key for (skill, args) so equivalent calls collide in the failure log.
// Drops volume/duration knobs so e.g. craft(oak_planks, count=1) and
// craft(oak_planks, count=4) share a key — they fail for the same reason.
const ARGS_IGNORE = new Set(['count', 'range', 'duration', 'distance', 'seconds', 'turns', 'depth', 'charge_ms', 'hold_ms', 'offhand']);
// Coords are stripped from the hardblock sig when the failure cause is independent
// of position (e.g. "no <X> in inventory" — retrying at a different x/y/z won't help).
const POSITIONAL_ARGS = new Set(['x', 'y', 'z']);
// Block-name args are stripped from the hardblock sig when the failure cause is
// independent of which block was being placed (e.g. pillar_up no_headroom — the
// ceiling above blocks any block name). Without this, the LLM bypasses the
// hardblock by switching block=cobblestone → block=dirt and refails immediately.
const BLOCK_NAME_ARGS = new Set(['block']);
function argsKey(args, { stripPositional = false, stripBlock = false } = {}) {
  if (!args || typeof args !== 'object') return '{}';
  const keys = Object.keys(args).filter((k) => {
    if (ARGS_IGNORE.has(k)) return false;
    if (stripPositional && POSITIONAL_ARGS.has(k)) return false;
    if (stripBlock && BLOCK_NAME_ARGS.has(k)) return false;
    return true;
  }).sort();
  if (keys.length === 0) return '{}';
  return keys.map((k) => {
    const v = args[k];
    return `${k}=${v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : v)}`;
  }).join(',');
}

// "no <X> in inventory" failures are deterministic and position-independent — the
// hardblock sig drops x/y/z so retries at slightly different coords still collide.
function isInventoryMissingError(error) {
  return /no\s+\S+\s+in inventory/i.test(String(error ?? ''));
}

// pillar_up no_headroom/no_floor failures are positional, not block-specific —
// the ceiling/missing-floor blocks any block name. Strip `block` from the sig
// so block=cobblestone → block=dirt doesn't bypass the hardblock. Match on
// structured error_code first, fall back to error text for callers (e.g. the
// oscillation path) that don't surface errorCode.
const BLOCK_AGNOSTIC_ERROR_CODES = new Set(['no_headroom', 'no_floor']);
function isBlockAgnosticError(error, errorCode = null) {
  if (errorCode && BLOCK_AGNOSTIC_ERROR_CODES.has(errorCode)) return true;
  return /headroom blocked above|no solid block beneath feet/i.test(String(error ?? ''));
}

function argsBrief(args) {
  if (!args || typeof args !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    if (v == null) continue;
    parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
    if (parts.length >= 3) break;
  }
  return parts.join(',');
}

// Given an item the LLM wants to craft, look at every known recipe and return
// the human-readable inventory gap so the bot understands WHY the craft failed
// (vs. the generic "no recipe" the mineflayer API gives).
// When several recipes accept different variants of the same ingredient (e.g.
// stick from any plank type), report them as alternatives instead of pinning
// the user to whichever variant happens to be first in the list.
function diagnoseRecipeGap(bot, mcData, itemId) {
  const recipes = mcData.recipes?.[itemId];
  if (!recipes || recipes.length === 0) return { error: 'no known recipe' };

  const have = {};
  for (const it of bot.inventory.items()) {
    have[it.type] = (have[it.type] || 0) + it.count;
  }

  // collect each recipe's missing-ingredient list; if any recipe is satisfied,
  // the bot only lacks a crafting_table within reach
  const candidates = [];
  for (const recipe of recipes) {
    const need = {};
    if (recipe.inShape) {
      for (const row of recipe.inShape) for (const cell of row) addCell(need, cell);
    } else if (Array.isArray(recipe.ingredients)) {
      for (const cell of recipe.ingredients) addCell(need, cell);
    }
    const missing = [];
    for (const [idStr, count] of Object.entries(need)) {
      const id = Number(idStr);
      const got = have[id] || 0;
      if (got < count) {
        const itemName = mcData.items?.[id]?.name || mcData.blocks?.[id]?.name || `item_${id}`;
        missing.push({ name: itemName, have: got, need: count });
      }
    }
    if (missing.length === 0) {
      return { needsTable: true, error: 'have ingredients but recipe needs a crafting_table within reach' };
    }
    candidates.push(missing);
  }

  // group recipes by structural shape: how many distinct items are missing,
  // and what's the multiset of (need-count) values? recipes that match this
  // shape are alternatives of each other (e.g. all 1-ingredient × 2 plank
  // recipes for stick — oak, birch, jungle, ...)
  const groups = new Map();
  for (const cand of candidates) {
    const shape = cand.map(m => m.need).sort((a,b)=>a-b).join(',');
    if (!groups.has(shape)) groups.set(shape, []);
    groups.get(shape).push(cand);
  }

  // pick the most "promising" group: the one whose simplest recipe needs the
  // fewest TOTAL items (in case a 1-ingredient simple recipe exists alongside
  // multi-ingredient variants)
  let bestGroup = null;
  let bestTotal = Infinity;
  for (const group of groups.values()) {
    const totalForGroup = Math.min(...group.map(c => c.reduce((s, m) => s + m.need, 0)));
    if (totalForGroup < bestTotal) { bestTotal = totalForGroup; bestGroup = group; }
  }

  // for each ingredient slot in the chosen group, collect all alternative names
  const slots = bestGroup[0].map(() => ({ alternatives: new Set(), need: 0 }));
  for (const cand of bestGroup) {
    for (let i = 0; i < cand.length; i++) {
      slots[i].alternatives.add(cand[i].name);
      slots[i].need = cand[i].need;
    }
  }

  const parts = slots.map(s => {
    const names = [...s.alternatives];
    if (names.length === 1) return `${s.need}× ${names[0]}`;
    if (names.length <= 4) return `${s.need}× any of (${names.join(', ')})`;
    return `${s.need}× any plank/log/etc — alternatives: ${names.slice(0,4).join(', ')}, ...`;
  });

  return { error: `missing ${parts.join(' AND ')}` };
}

function addCell(need, cell) {
  if (cell == null) return;
  let id;
  if (typeof cell === 'object') id = cell.id ?? cell.type ?? cell;
  else id = cell;
  if (id == null || id === -1 || id < 0) return;
  need[id] = (need[id] || 0) + 1;
}

// Place against any solid neighbor of `targetPos` whose corresponding face is open.
// Bot must already be equipped and within reach of targetPos.
async function tryPlaceAt(bot, targetPos, blockName) {
  const Vec3 = bot.entity.position.constructor;
  const target = bot.blockAt(new Vec3(targetPos.x, targetPos.y, targetPos.z));
  if (target && target.boundingBox === 'block' && target.name !== 'air' && !/water|lava/.test(target.name)) {
    return { ok: false, error: `target ${targetPos.x},${targetPos.y},${targetPos.z} is occupied by ${target.name}` };
  }
  const me = bot.entity.position.floored();
  if (me.x === targetPos.x && me.y === targetPos.y && me.z === targetPos.z) {
    return { ok: false, error: 'standing on the placement target — move first' };
  }
  // faces: dir vector goes FROM ref TO new block; placeBlock takes faceVector pointing away from ref into the new block.
  const faces = [
    { d: [ 0, -1,  0], face: { x: 0, y:  1, z: 0 } },  // ref below → place above
    { d: [ 1,  0,  0], face: { x:-1, y:  0, z: 0 } },  // ref east  → place west of ref
    { d: [-1,  0,  0], face: { x: 1, y:  0, z: 0 } },
    { d: [ 0,  0,  1], face: { x: 0, y:  0, z:-1 } },
    { d: [ 0,  0, -1], face: { x: 0, y:  0, z: 1 } },
    { d: [ 0,  1,  0], face: { x: 0, y: -1, z: 0 } },  // last resort: ref above → place below
  ];
  let lastErr = 'no valid face';
  for (const { d, face } of faces) {
    const refPos = new Vec3(targetPos.x + d[0], targetPos.y + d[1], targetPos.z + d[2]);
    const ref = bot.blockAt(refPos);
    if (!ref) continue;
    if (ref.name === 'air' || /water|lava/.test(ref.name)) continue;
    try {
      await bot.lookAt(new Vec3(targetPos.x + 0.5, targetPos.y + 0.5, targetPos.z + 0.5), true);
      await bot.placeBlock(ref, face);
      return { ok: true, placed: blockName, at: { x: targetPos.x, y: targetPos.y, z: targetPos.z } };
    } catch (e) { lastErr = e?.message || String(e); }
  }
  return { ok: false, error: `place: ${lastErr}` };
}

// Phase A — A3 (Step 2.5, 2026-05-11): preview of the same ring tryPlaceNearby
// will walk. Returns { ok: true } when at least one candidate position is air
// AND has a non-air block beneath it (meaning placeBlock will succeed there).
// When no candidate qualifies, returns { ok: false, reason } for the
// place_block error message. Pure inspection — no network/place attempts.
function previewPlacementSurface(bot) {
  const me = bot.entity?.position?.floored?.();
  if (!me) return { ok: false, reason: 'no bot position' };
  const Vec3 = bot.entity.position.constructor;
  const ring = [
    [ 1, 0,  0], [-1, 0,  0], [0, 0,  1], [0, 0, -1],
    [ 1, 0,  1], [ 1, 0, -1], [-1, 0,  1], [-1, 0, -1],
    [ 2, 0,  0], [-2, 0,  0], [0, 0,  2], [0, 0, -2],
  ];
  let airSlots = 0, withBase = 0;
  for (const [dx, dy, dz] of ring) {
    const tb = bot.blockAt(new Vec3(me.x + dx, me.y + dy, me.z + dz));
    if (!tb || tb.name !== 'air') continue;
    airSlots += 1;
    const beneath = bot.blockAt(new Vec3(me.x + dx, me.y + dy - 1, me.z + dz));
    if (beneath && beneath.name !== 'air') withBase += 1;
  }
  if (withBase > 0) return { ok: true, candidates: withBase };
  if (airSlots === 0) return { ok: false, reason: 'every adjacent slot is blocked' };
  return { ok: false, reason: 'every air slot is over a void/air column — nothing to anchor against' };
}

// Search a ring of horizontal positions around the bot for a placeable air block.
async function tryPlaceNearby(bot, signal, blockName) {
  const me = bot.entity.position.floored();
  // candidates: 4 cardinal + 4 diagonal at feet level, then one block up (if standing in a 1-tall hole)
  const ring = [
    [ 1, 0,  0], [-1, 0,  0], [0, 0,  1], [0, 0, -1],
    [ 1, 0,  1], [ 1, 0, -1], [-1, 0,  1], [-1, 0, -1],
    [ 2, 0,  0], [-2, 0,  0], [0, 0,  2], [0, 0, -2],
  ];
  const Vec3 = bot.entity.position.constructor;
  for (const [dx, dy, dz] of ring) {
    if (signal.aborted) return { ok: false, error: 'aborted' };
    const targetPos = { x: me.x + dx, y: me.y + dy, z: me.z + dz };
    const tb = bot.blockAt(new Vec3(targetPos.x, targetPos.y, targetPos.z));
    if (!tb || tb.name !== 'air') continue;
    const r = await tryPlaceAt(bot, targetPos, blockName);
    if (r.ok) return r;
  }
  return { ok: false, error: 'no open spot to place in adjacent ring' };
}

function nearestEntityByName(bot, name, maxRange = 32) {
  const me = bot.entity?.position;
  if (!me) return null;
  const wanted = String(name).toLowerCase();
  let best = null, bestD = Infinity;
  for (const e of Object.values(bot.entities ?? {})) {
    if (e === bot.entity || !e.position || isNaN(e.position.x)) continue;
    // OVN-010: drop e.mobType — see comment on _checkHostiles for context.
    const n = (e.name ?? e.username ?? '').toLowerCase();
    if (n !== wanted) continue;
    const dx = e.position.x - me.x, dz = e.position.z - me.z;
    const d = Math.sqrt(dx*dx + dz*dz);
    if (d < bestD && d <= maxRange) { bestD = d; best = e; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Wood variant helpers
// ---------------------------------------------------------------------------

export const WOOD_LOG_VARIANTS = [
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log',
  'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
];
export const WOOD_PLANK_VARIANTS = [
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
  'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
];

// Phase A (Step 2.5, 2026-05-11): static recipe-prereqs table for the wood
// tier. checkRecipePrereqs runs as an UPFRONT gate inside SKILLS.craft —
// before pathfinding to a crafting table — so the LLM gets the missing-
// ingredient list as a structured failure on the first turn instead of
// after a wasted trip. This composes with the existing diagnoseRecipeGap
// (which still runs as a backstop AT the table when mineflayer's recipesFor
// returns empty) — same surface area, two layers of defence.
//
// Each entry is a list of conjunctive requirements: ALL must be satisfied.
// `any: [...]` enumerates substitutable variants — `any: WOOD_PLANK_VARIANTS`
// means "2 of any single plank type" satisfies the stick recipe. `count` is
// the floor — having more is fine.
//
// The table is intentionally narrow: only items where stuck-loops have been
// observed in the fleet logs (planks, sticks, table, wooden_*). Items not in
// the table fall through to mineflayer's recipesFor (the existing path).
// Step 2.6 (2026-05-16): the `sameSpecies: true` flag changes the predicate
// from "≥count of ANY listed variant in aggregate" to "≥count of ONE SPECIFIC
// variant". Required for items like crafting_table and wooden_* whose real
// Minecraft recipes need 4 (or 3) planks of a single species — the Step 2.5
// overnight produced 81 of 110 stuck-loops because the old aggregate gate
// said "you have 4 planks" while mineflayer's recipesFor returned empty for
// mixed-species inventories.
export const RECIPE_PREREQS = {
  // Planks: 1 log of the matching wood type. The existing resolveWoodVariant
  // in SKILLS.craft will substitute whichever variant the bot actually has,
  // so the gate accepts ANY log type and trusts resolveWoodVariant to pick
  // the right one.
  oak_planks:      [{ any: WOOD_LOG_VARIANTS, count: 1 }],
  spruce_planks:   [{ any: WOOD_LOG_VARIANTS, count: 1 }],
  birch_planks:    [{ any: WOOD_LOG_VARIANTS, count: 1 }],
  jungle_planks:   [{ any: WOOD_LOG_VARIANTS, count: 1 }],
  acacia_planks:   [{ any: WOOD_LOG_VARIANTS, count: 1 }],
  dark_oak_planks: [{ any: WOOD_LOG_VARIANTS, count: 1 }],
  mangrove_planks: [{ any: WOOD_LOG_VARIANTS, count: 1 }],
  cherry_planks:   [{ any: WOOD_LOG_VARIANTS, count: 1 }],
  // Sticks: 2 of any plank type yields 4 sticks (recipe accepts mixed species).
  stick:           [{ any: WOOD_PLANK_VARIANTS, count: 2 }],
  // Crafting table: 4 planks of the SAME species.
  crafting_table:  [{ any: WOOD_PLANK_VARIANTS, count: 4, sameSpecies: true }],
  // Wood-tier tools: planks + sticks. The plank requirement is same-species;
  // sticks are species-agnostic. The crafting_table itself is checked by the
  // existing pathfind-to-table logic in SKILLS.craft.
  wooden_pickaxe:  [{ any: WOOD_PLANK_VARIANTS, count: 3, sameSpecies: true }, { any: ['stick'], count: 2 }],
  wooden_axe:      [{ any: WOOD_PLANK_VARIANTS, count: 3, sameSpecies: true }, { any: ['stick'], count: 2 }],
  wooden_sword:    [{ any: WOOD_PLANK_VARIANTS, count: 2, sameSpecies: true }, { any: ['stick'], count: 1 }],
  wooden_shovel:   [{ any: WOOD_PLANK_VARIANTS, count: 1, sameSpecies: true }, { any: ['stick'], count: 2 }],
  wooden_hoe:      [{ any: WOOD_PLANK_VARIANTS, count: 2, sameSpecies: true }, { any: ['stick'], count: 2 }],
};

// Phase A: pure helper. Returns { ok: true } when all prereqs are satisfied
// (or when `item` has no entry — unknown items defer to mineflayer's recipe
// resolver). Returns { ok: false, missing: [{ any, count, have }] } listing
// every requirement that fell short, with `have` reflecting how many of any
// matching variant the inventory currently holds.
export function checkRecipePrereqs(item, inventoryItems) {
  const prereqs = RECIPE_PREREQS[item];
  if (!prereqs) return { ok: true };
  const items = Array.isArray(inventoryItems) ? inventoryItems : [];
  const missing = [];
  for (const req of prereqs) {
    let have = 0;
    if (req.sameSpecies) {
      // Step 2.6: pick the variant with the highest count, not aggregate.
      // A crafting_table needs 4 OF ONE species, not 4 across species.
      let bestVariantCount = 0;
      for (const variant of req.any) {
        let c = 0;
        for (const it of items) if (it.name === variant) c += (it.count | 0);
        if (c > bestVariantCount) bestVariantCount = c;
      }
      have = bestVariantCount;
    } else {
      for (const it of items) {
        if (req.any.includes(it.name)) have += (it.count | 0);
      }
    }
    if (have < req.count) {
      missing.push({
        any:          req.any,
        count:        req.count,
        have,
        sameSpecies:  !!req.sameSpecies,
      });
    }
  }
  if (missing.length === 0) return { ok: true };
  return { ok: false, missing };
}

// Phase A: render the missing-prereqs list into a human-readable string for
// the craft-skill error message. Aliases multi-variant lists ("any plank",
// "any log") so the LLM gets a concise hint instead of an 8-name dump.
function describePrereqsMissing(missing) {
  const parts = [];
  for (const m of missing) {
    let label;
    if (m.any.length === 1) label = m.any[0];
    else if (m.any.every((n) => WOOD_PLANK_VARIANTS.includes(n))) label = m.sameSpecies ? 'planks of one species' : 'any plank';
    else if (m.any.every((n) => WOOD_LOG_VARIANTS.includes(n))) label = 'any log';
    else label = m.any.join('/');
    const tail = m.sameSpecies ? ' of most-abundant species' : '';
    parts.push(`${m.count}x ${label} (have ${m.have}${tail})`);
  }
  return parts.join(', ');
}

// If the requested item is a plank or log variant the bot doesn't have, return
// the variant it actually holds. Keeps the LLM from looping on "oak_planks"
// when its inventory only contains spruce_log.
function resolveWoodVariant(itemName, bot) {
  const plankIdx = WOOD_PLANK_VARIANTS.indexOf(itemName);
  const logIdx   = WOOD_LOG_VARIANTS.indexOf(itemName);
  if (plankIdx === -1 && logIdx === -1) return itemName;

  const variants = plankIdx >= 0 ? WOOD_PLANK_VARIANTS : WOOD_LOG_VARIANTS;
  if (bot.inventory.items().some(i => i.name === itemName)) return itemName;
  const haveVariant = bot.inventory.items().find(i => variants.includes(i.name));
  if (haveVariant) return haveVariant.name;
  if (plankIdx >= 0) {
    const log = bot.inventory.items().find(i => WOOD_LOG_VARIANTS.includes(i.name));
    if (log) return WOOD_PLANK_VARIANTS[WOOD_LOG_VARIANTS.indexOf(log.name)] ?? itemName;
  }
  return itemName;
}

// BUG-018 (2026-05-11): when the brain force-clears a goal on BLOCKED-SIG
// IGNORED (the LLM picked a hardblocked sig despite the banner), the prior
// goal text was a generic "BLOCKED: <label> — pick a different objective."
// The 2026-05-11 overnight run showed all 3 productive bots drifting
// off-strategy after that hint: they picked tangentially-related new goals
// (mining gold, chasing a coal ledge) instead of the missing prerequisite
// in the resource chain. This helper rewrites the cleared goal with a
// concrete next-step from the wood-tier chain (log → planks → stick → tool)
// based on what the bot has in inventory and what the blocked sig was.
//
// Pure, exported for testing. `bot` may be null when called from a unit
// test stub; in that case we fall back to the generic message.
export function deriveBlockedGoalHint(skill, args, bot, lastError) {
  const brief = argsBrief(args);
  const label = `${skill}(${brief})`;
  const generic = `BLOCKED: ${label} is hard-blocked — pick a different objective`;

  const errStr = String(lastError ?? '');

  // Phantom-craft signal: the craft skill succeeded but inventory didn't
  // receive the item (no free slot). Hint at dropping something rather than
  // routing into the chain.
  if (errStr.includes('server reported success but') || errStr.includes('never landed in inventory')) {
    return `BLOCKED: ${label} — server said craft succeeded but the item didn't land in inventory (no free slot). Next step: drop(item=<unused>) to free a slot, then the craft will be unblocked once the cooldown clears.`;
  }

  // place_block surface failure: usually the bot is on uneven terrain.
  if (errStr.includes('no_valid_surface') || errStr.includes('no solid surface')) {
    // Step 2.6 hotfix (2026-05-17): "Next step:" uses parseable parens so
    // the wait-spiral substitution path (extractGoalNextStep) can execute
    // it deterministically when the LLM ignores the hint.
    return `BLOCKED: ${label} — no flat surface in the adjacent ring. Next step: dig_down() to flatten, then place_block again.`;
  }

  // BUG-024 (Path 2, 2026-05-18): pillar_up failed for lack of headroom.
  if (errStr.includes('no_headroom') || errStr.includes('headroom blocked')) {
    return `BLOCKED: ${label} — headroom blocked above (something solid is 2 blocks over your head). Wiki: pillar_up needs at least 2 blocks of air directly above your current standing block to jump+place. Next step: mine the obstructing block above (dig_block at your y+2 with the right pickaxe tier) OR goto_coord somewhere with open sky above.`;
  }
  if (errStr.includes('no_floor') || errStr.includes('no solid block beneath')) {
    return `BLOCKED: ${label} — no solid block beneath your feet. You're standing in air or over a hole. Wiki: pillar_up needs a solid floor to anchor the placement. Next step: wait until you land on solid ground, OR place_block(<solid block>) at your feet first.`;
  }

  // Out-of-range — A4 should have auto-recovered, but if the sig made it to
  // the hardblock list anyway, the LLM needs a "go closer" hint.
  if (errStr.includes('out of use-range') || errStr.includes('out_of_range')) {
    return `BLOCKED: ${label} — target was out of use-range. Next step: goto_coord to the target's coords (see surroundings/anchors), then use_block again after the cooldown clears.`;
  }

  // Step 2.6 hotfix (2026-05-17): wrong-tier pickaxe blocks. Inventory walk-
  // back tells the LLM what to craft next.
  const tierMatch = errStr.match(/needs (\w+_pickaxe)/);
  if (tierMatch && bot?.inventory?.items) {
    const need = tierMatch[1];
    const inv = bot.inventory.items();
    const hasNeeded = inv.some((i) => i.name === need);
    if (hasNeeded) {
      return `BLOCKED: ${label} — you already own ${need}; equip it (equip_item) and retry. The brain should have equipped it automatically — try goto_coord and retry.`;
    }
    // Walk back: cobble + sticks for stone_pickaxe; iron_ingot + sticks for iron.
    const hasStick = inv.some((i) => i.name === 'stick');
    if (need === 'stone_pickaxe') {
      const cobbleCount = inv.filter((i) => i.name === 'cobblestone').reduce((s, i) => s + i.count, 0);
      if (cobbleCount < 3) {
        return `BLOCKED: ${label} — need stone_pickaxe; have ${cobbleCount}/3 cobblestone. Next step: dig_block(<stone block coord>) to get cobblestone — mine 3+ stone blocks with your wooden_pickaxe.`;
      }
      if (!hasStick) {
        return `BLOCKED: ${label} — need stone_pickaxe; have cobblestone but no sticks. Next step: craft(item=stick) — 2 planks → 4 sticks.`;
      }
      return `BLOCKED: ${label} — have all stone_pickaxe ingredients (3 cobble + 2 sticks). Next step: place_block(crafting_table) if not placed, then craft(item=stone_pickaxe).`;
    }
    if (need === 'iron_pickaxe') {
      const ironCount = inv.filter((i) => i.name === 'iron_ingot').reduce((s, i) => s + i.count, 0);
      if (ironCount < 3) {
        return `BLOCKED: ${label} — need iron_pickaxe; have ${ironCount}/3 iron_ingot. Next step: collect_block(block=iron_ore) — mine 3+ iron_ore with stone_pickaxe (dig DOWN to y=-30..16 in stone caves), then smelt(input=raw_iron, fuel=coal).`;
      }
      return `BLOCKED: ${label} — have iron_ingot. Next step: craft(item=iron_pickaxe) at a crafting_table.`;
    }
    return `BLOCKED: ${label} — needs ${need}. Craft it before retrying.`;
  }

  // For craft() of an item in the wood-tier chain, walk back from the
  // blocked item to the first missing material in the bot's current
  // inventory.
  if (skill === 'craft' && args && typeof args.item === 'string' && RECIPE_PREREQS[args.item]) {
    if (!bot?.inventory?.items) return generic;
    const inv = bot.inventory.items();
    const hasLog   = inv.some(i => WOOD_LOG_VARIANTS.includes(i.name));
    const hasPlank = inv.some(i => WOOD_PLANK_VARIANTS.includes(i.name));
    const hasStick = inv.some(i => i.name === 'stick');
    const needsStick = RECIPE_PREREQS[args.item].some(r => r.any.length === 1 && r.any[0] === 'stick');

    if (!hasLog && !hasPlank) {
      return `BLOCKED: ${label} needs the wood chain (log → planks → stick → ${args.item}). Next step: collect_block(<oak_log|spruce_log|birch_log|any_log>) — any wood log will do. No need to retry craft until you have logs.`;
    }
    if (!hasPlank) {
      return `BLOCKED: ${label} needs planks (you have a log). Next step: craft(item=oak_planks) — 1 log → 4 planks. Then sticks if needed, then ${args.item} once the cooldown clears.`;
    }
    if (needsStick && !hasStick) {
      return `BLOCKED: ${label} needs sticks (you have planks). Next step: craft(item=stick) — 2 planks → 4 sticks. Then ${args.item} once the cooldown clears.`;
    }
    // Have all raw materials. The block is probably "need crafting_table nearby."
    return `BLOCKED: ${label} — you have the ingredients but the craft is hardblocked. Next step: confirm a crafting_table is nearby with look_around; if missing, place_block(crafting_table). The original ${args.item} craft will unblock when the cooldown expires.`;
  }

  // Step 2.6 hotfix (2026-05-17): when a dig_block/dig_down/dig_up is
  // hard-blocked because no pickaxe is in inventory, the old generic hint
  // told the LLM "pick a different objective" without saying what. The
  // overnight queue showed all 8 bots churning on this — 20+ BLOCKED-SIG
  // IGNORED events per bot inside 5 minutes because the LLM kept picking
  // more dig actions instead of starting the wood chain. Redirect to the
  // same wood-tier chain logic the craft block uses.
  const isDigSkill = skill === 'dig_block' || skill === 'dig_down' || skill === 'dig_up';
  if (isDigSkill && /no pickaxe in inventory/i.test(errStr) && bot?.inventory?.items) {
    const inv = bot.inventory.items();
    const hasLog   = inv.some(i => WOOD_LOG_VARIANTS.includes(i.name));
    const hasPlank = inv.some(i => WOOD_PLANK_VARIANTS.includes(i.name));
    const hasStick = inv.some(i => i.name === 'stick');
    if (!hasLog && !hasPlank) {
      return `BLOCKED: ${label} needs a pickaxe but you have NO wood. STOP digging. Next step: collect_block(block=<oak_log|spruce_log|birch_log|any wood log>) — any log will do. Then craft planks → sticks → crafting_table → wooden_pickaxe.`;
    }
    if (!hasPlank) {
      return `BLOCKED: ${label} needs a pickaxe; you have a log but no planks. STOP digging. Next step: craft(item=oak_planks) — 1 log → 4 planks. Then craft(item=stick), then place_block(crafting_table), then craft(item=wooden_pickaxe).`;
    }
    if (!hasStick) {
      return `BLOCKED: ${label} needs a pickaxe; you have planks but no sticks. STOP digging. Next step: craft(item=stick) — 2 planks → 4 sticks. Then place_block(crafting_table), then craft(item=wooden_pickaxe).`;
    }
    return `BLOCKED: ${label} needs a pickaxe; you have planks AND sticks already. STOP digging. Next step: place_block(crafting_table) if not placed, then craft(item=wooden_pickaxe) at the table.`;
  }

  return generic;
}

// When a tool recipe fails at the crafting table because planks or sticks are
// missing, auto-craft the intermediates so the LLM doesn't have to manage the
// logs→planks→sticks chain as three separate decision turns.
async function fillWoodChain(bot, mcData) {
  const log = bot.inventory.items().find(i => WOOD_LOG_VARIANTS.includes(i.name));
  if (log) {
    const plankName = WOOD_PLANK_VARIANTS[WOOD_LOG_VARIANTS.indexOf(log.name)];
    const plankDef  = plankName && (mcData.itemsByName[plankName] ?? mcData.blocksByName[plankName]);
    if (plankDef) {
      const pr = bot.recipesFor(plankDef.id, null, 1, null);
      if (pr && pr.length > 0) {
        try { await bot.craft(pr[0], Math.min(log.count, 2), null); } catch { /* continue */ }
      }
    }
  }
  const stickDef = mcData.itemsByName['stick'];
  if (stickDef) {
    const sr = bot.recipesFor(stickDef.id, null, 1, null);
    if (sr && sr.length > 0) {
      try { await bot.craft(sr[0], 2, null); } catch { /* continue */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Step 2.6 (2026-05-16): exported helpers used by tests and SKILLS.craft.
// ---------------------------------------------------------------------------

// consolidateToSingleSpecies — given a flat inventory and a needed plank
// count, returns the species the bot is best positioned to consolidate
// around, plus (when needed) a recipe of "craft N logs into planks" that
// would close the gap. Returns null when no single species can reach the
// target even with all owned logs converted.
//
// Shape: { species: '<plank name>', haveCount: <number>, needCraft?: { from: '<log name>', logs: <number> } }
//
// `haveCount` is the count of the most-abundant existing plank species in
// inventory — when needCraft is absent it equals the planks of the picked
// species; when needCraft is present it surfaces what the LLM can already
// see in its inventory line ("you have 2 planks; craft 1 more log").
export function consolidateToSingleSpecies(inventoryItems, neededCount) {
  const items = Array.isArray(inventoryItems) ? inventoryItems : [];
  const tally = new Map();
  for (const it of items) {
    const plankIdx = WOOD_PLANK_VARIANTS.indexOf(it.name);
    const logIdx   = WOOD_LOG_VARIANTS.indexOf(it.name);
    let plankSpecies = null;
    let isLog = false;
    if (plankIdx >= 0) { plankSpecies = it.name; }
    else if (logIdx >= 0) { plankSpecies = WOOD_PLANK_VARIANTS[logIdx]; isLog = true; }
    if (!plankSpecies) continue;
    const entry = tally.get(plankSpecies) ?? { planks: 0, logs: 0 };
    if (isLog) entry.logs += (it.count | 0);
    else       entry.planks += (it.count | 0);
    tally.set(plankSpecies, entry);
  }
  let best = null;
  for (const [species, d] of tally) {
    const potential = d.planks + 4 * d.logs;
    if (potential < neededCount) continue;
    if (!best || potential > best.potential) {
      best = { species, planks: d.planks, logs: d.logs, potential };
    }
  }
  if (!best) return null;
  let maxPlanksAcrossSpecies = 0;
  for (const d of tally.values()) {
    if (d.planks > maxPlanksAcrossSpecies) maxPlanksAcrossSpecies = d.planks;
  }
  if (best.planks >= neededCount) {
    return { species: best.species, haveCount: best.planks };
  }
  const logName    = WOOD_LOG_VARIANTS[WOOD_PLANK_VARIANTS.indexOf(best.species)];
  const logsNeeded = Math.ceil((neededCount - best.planks) / 4);
  return {
    species:   best.species,
    haveCount: maxPlanksAcrossSpecies,
    needCraft: { from: logName, logs: logsNeeded },
  };
}

// computeBackoffNext — pure helper used by _noteLLMError. Extracted so the
// schedule (5s → 10s → 20s → 40s → 60s cap) is testable without setting up
// a full Brain instance. Step 2.6 lowered the ceiling from 300s to 60s.
export function computeBackoffNext(currentMs) {
  if (!currentMs || currentMs <= 0) return LLM_BACKOFF_INITIAL_MS;
  return Math.min(currentMs * 2, LLM_BACKOFF_MAX_MS);
}

// deriveBrainStatus — pure helper that maps a small state shape onto the
// dashboard's brainStatus enum. `llm_backoff` is the Step 2.6 addition:
// distinguishes "the bot is intentionally sleeping in Cerebras backoff"
// from "the brain is genuinely wedged". The watchdog skips slot recycles
// when brainStatus === 'llm_backoff'.
//
// NOTE: instance.js#brainInfo re-implements the same logic with a 60s stall
// threshold (more sensitive — the dashboard wants earlier visibility) while
// this helper uses 120s (matches the watchdog's eventual recycle path).
// They are intentionally separate: the dashboard "stalled" pill is an early
// warning; this helper feeds the watchdog's decision, which should be more
// conservative. Keep both thresholds in sync with intent, not value.
export function deriveBrainStatus(state) {
  const now = Date.now();
  if (state?.llmBackoffUntil && state.llmBackoffUntil > now) return 'llm_backoff';
  const lastTs = state?.lastDecisionTs ?? 0;
  const ageMs  = lastTs ? (now - lastTs) : Infinity;
  if (ageMs > 120_000) return 'stalled';
  return 'active';
}

// derivePostCraftNudge — fires after a successful plank craft to steer the
// LLM at the stick step, which it otherwise skips (Step 2.5 overnight: 69
// plank crafts, 1 stick). Returns a memory.applyUpdate-shaped object or
// null when no nudge is warranted.
export function derivePostCraftNudge(skillName, args, outcome, bot, currentGoal) {
  if (skillName !== 'craft') return null;
  if (!outcome || outcome.ok !== true) return null;
  const item = args?.item;
  if (!item || !WOOD_PLANK_VARIANTS.includes(item)) return null;
  const items = bot?.inventory?.items?.() ?? [];
  const hasPlank = items.some((i) => WOOD_PLANK_VARIANTS.includes(i.name));
  if (!hasPlank) return null;
  const hasStick = items.some((i) => i.name === 'stick');
  if (hasStick) return null;
  const goalLc = String(currentGoal ?? '').toLowerCase();
  if (goalLc.includes('stick')) return null;
  return {
    set_goal: 'craft sticks (2 planks → 4 sticks, no table needed) — sticks are needed before wooden_pickaxe',
  };
}

// Test-only export — not part of the public API.
export const __testing = {
  fleetBucket: _fleetBucket,
  SKILLS,
  computeBackoffNext,
  deriveBrainStatus,
  derivePostCraftNudge,
  consolidateToSingleSpecies,
  extractGoalNextStep,
};
