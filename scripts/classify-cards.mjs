// A language model reads the rules and the whole public card pool and sorts every card: what its effect does, what job it does in a deck, which axis it belongs to, a first rating.
//
//   node scripts/classify-cards.mjs --stage estimate|taxonomy|classify|review --out <folder> [--config llm/classify.json] [--game <game checkout>] [--dry] [--yes] [--only STD-001,...]
//   (the key: powershell -NoProfile -File scripts/with-llm-keys.ps1 -Configs llm/classify.json -Run "node scripts/classify-cards.mjs ..."; FORGE_ANTHROPIC_API_KEY, nothing else)
//
// Three stages, each a run of its own (the folder <out> holds what the stages make and what they need from each other):
//   taxonomy   the model sees the rules and the pool once and writes the lists it will sort by: kinds of effect, roles in a deck, axis tags, each with a definition      -> taxonomy.json (stop here, a person reads it)
//   classify   batches of cards, the approved taxonomy added to the system text; one JSON per card (a schema fixes the form)                                            -> classification.json
//   review     all of the results at once; the model looks for cards of one kind that were rated or sorted differently; it proposes, nothing is overwritten              -> review.json
// What the model is given is src/teachers/context.mjs: the public rulebook, the game's RULES.md (with the note that they say what is intended), and the text of every public card. They go in the system
// text and are kept by the API between calls (cache_control). Nothing of any deck is given.
// A call is asked once: its answer is kept in <out>/responses under the hash of everything that was sent, and the same input is never sent again. Every call is written in <out>/ledger.jsonl with its tokens and
// its cost; a call is not made when it could take the spent total over the limit of the settings (budget.maxUsd), and a run whose estimate is over budget.stopAboveUsd is not started without --yes.
// Where a card's text or the rules can be read two ways, the model says so (`ambiguity`): that is a ruling on the card, it is listed for a person and never decided here.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildContext } from '../src/teachers/context.mjs';
import { PROMPT_VERSION } from '../src/teachers/prompt.mjs';
import { openLedger, priceOf } from '../src/teachers/ledger.mjs';
import { keyEnvOf, readApiKey, redact } from '../src/teachers/secrets.mjs';

export const CLASSIFY_VERSION = 1;
const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(`--${name}`); return at < 0 || args[at + 1] === undefined || args[at + 1].startsWith('--') ? null : args[at + 1]; };
const flag = (name) => args.includes(`--${name}`);
const die = (message) => { console.error(`classify-cards: ${message}`); process.exit(2); };

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const stage = option('stage') ?? die('--stage estimate|taxonomy|classify|review');
const outDir = path.resolve(option('out') ?? die('--out <folder>'));
const configFile = path.resolve(option('config') ?? path.join(root, 'llm/classify.json'));
const gameDir = path.resolve(option('game') ?? process.env.GAME_DIR ?? die('--game <game checkout> (or GAME_DIR)'));
const config = JSON.parse(readFileSync(configFile, 'utf8'));
const s = { model: 'claude-sonnet-5-5', effort: 'medium', maxTokens: 32000, batchSize: 20, endpoint: 'https://api.anthropic.com/v1/messages', version: '2023-06-01', retries: 4,
  pricing: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, budget: { maxUsd: 5, stopAboveUsd: 3 }, set: 'classify-1', ...config };
if (s.provider && s.provider !== 'anthropic') die('provider: anthropic only');
keyEnvOf('anthropic', s.keyEnv);
mkdirSync(path.join(outDir, 'responses'), { recursive: true });

const sha = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeOut = (name, data) => writeFileSync(path.join(outDir, name), typeof data === 'string' ? data : `${JSON.stringify(data, null, 1)}\n`);

// ---- what is sorted
const { BUILDABLE_CARDS } = await import(pathToFileURL(path.join(gameDir, 'src/game/deck-builder.js')).href);
const context = await buildContext({ gameDir });
let gameCommit = null; try { gameCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gameDir, encoding: 'utf8' }).trim(); } catch { /* not a git checkout */ }
const meta = () => ({ model: s.model, effort: s.effort, classifyVersion: CLASSIFY_VERSION, promptVersion: PROMPT_VERSION, contextSha256: context.sha256, contextChars: context.chars, poolCards: BUILDABLE_CARDS.length, gameCommit, at: new Date().toISOString() });

// ---- the words
const SYSTEM = [
  'あなたはカードゲーム「Siege÷Zeke」のカードを分類する分析者です。',
  '次に、公開のルールブックとゲームのルールのメモ、公開されているカード全部の本文が渡されます。ルールのメモは「意図したルール」で、実装が同じとは限りません。',
  '判断の根拠は、カードの本文とルールだけです。本文やルールから言えないことは言わず、確からしさを下げてください。',
  '本文やルールで読み方が分かれる所は、勝手に決めずに「読みが分かれる」として、どこが分かれるかを書いてください。それはカードの裁定になるので、人が決めます。',
  '特定のデッキや相手のデッキは与えられません。カードの強さは、デッキに入れて使う前提で、単体と性格との合い方の両方から、その場の本文だけで考えてください。'
].join('\n');

const TIMINGS = ['自分の手番', '相手の手番', '攻撃宣言時', '攻撃を受けた時', 'ターン開始時', 'ターン終了時', '登場時(ログイン)', '退場時(ログアウト)', '常時(場にある間)', '手札から', '応答(条件・if)', 'その他'];
const TAXONOMY_USER = [
  '公開カードプール全体を見て、これから全カードを分類するための3つの一覧を作ってください。それぞれに定義をつけます。',
  '1. 効果の種類（effectKinds）：効果が何をするかの仕組みによる分け方（例：破壊する・引く・探す・メモリを増やす・置く・強める・手札や場に戻す、など。本文に実際にあるものから作る）。15〜30個。',
  '2. 役割（roles）：デッキの中でそのカードがする仕事（例：除去・手札の補充・メモリの加速・盤面の展開・守り・決め手・妨害・回収・組み合わせの部品、など）。10〜20個。',
  '3. 軸のタグ（axisTags）：デッキの軸になる要素（クラス・キーワード・テーマ・Script 主体・旧支配者や狂気のような、本文やクラスに実際にあるものだけ）。それを持つカードの数の見当も書いてください。',
  '各一覧は、互いに重ならず、プール全体で見て抜けがないようにします。id は英数字のスネークケース、name は日本語。definition は「どのカードがこれに入るか」が分かる1〜2文。examples はそれに当たるカードの id を3つまで。',
  '最後に notes に、分け方を決めるときに迷った所や、人に決めてほしい所を書いてください。'
].join('\n');

const kindItem = { type: 'object', additionalProperties: false, required: ['id', 'name', 'definition', 'examples'], properties: {
  id: { type: 'string' }, name: { type: 'string' }, definition: { type: 'string' }, examples: { type: 'array', items: { type: 'string' } } } };
const TAXONOMY_SCHEMA = { type: 'object', additionalProperties: false, required: ['effectKinds', 'roles', 'axisTags', 'notes'], properties: {
  effectKinds: { type: 'array', items: kindItem }, roles: { type: 'array', items: kindItem },
  axisTags: { type: 'array', items: { ...kindItem, required: [...kindItem.required, 'approxCards'], properties: { ...kindItem.properties, approxCards: { type: 'integer' } } } },
  notes: { type: 'string' } } };

const taxonomyText = (taxonomy) => ['# 分類の一覧（人が確かめた、この通りに分類する）',
  '## 効果の種類', ...taxonomy.effectKinds.map((k) => `- ${k.id}（${k.name}）：${k.definition}`),
  '## 役割', ...taxonomy.roles.map((k) => `- ${k.id}（${k.name}）：${k.definition}`),
  '## 軸のタグ', ...taxonomy.axisTags.map((k) => `- ${k.id}（${k.name}）：${k.definition}`),
  '## 使う時（timing）', ...TIMINGS.map((t) => `- ${t}`)].join('\n');

const classifySchema = (taxonomy, ids) => {
  const enumOf = (list) => ({ type: 'string', enum: list.map((k) => k.id) });
  const rating = { type: 'integer', enum: [1, 2, 3, 4, 5] };
  return { type: 'object', additionalProperties: false, required: ['cards'], properties: { cards: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['id', 'effectKinds', 'roles', 'axisTags', 'timing', 'conditionAndCost', 'strength', 'fit', 'confidence', 'reason', 'ambiguity'], properties: {
      id: { type: 'string', enum: ids },
      effectKinds: { type: 'array', items: enumOf(taxonomy.effectKinds) },
      roles: { type: 'array', items: enumOf(taxonomy.roles) },
      axisTags: { type: 'array', items: enumOf(taxonomy.axisTags) },
      timing: { type: 'array', items: { type: 'string', enum: TIMINGS } },
      conditionAndCost: { type: 'string' },
      strength: rating,
      fit: { type: 'object', additionalProperties: false, required: ['beatdown', 'midrange', 'control', 'tactic'], properties: { beatdown: rating, midrange: rating, control: rating, tactic: rating } },
      confidence: { type: 'string', enum: ['高', '中', '低'] },
      reason: { type: 'string' },
      ambiguity: { type: 'object', additionalProperties: false, required: ['ambiguous', 'note'], properties: { ambiguous: { type: 'boolean' }, note: { type: 'string' } } } } } } } };
};
const classifyUser = (cards) => [
  '次のカードを1枚ずつ分類してください（本文は、渡された公開カードプールにあるものです）。', cards.map((c) => `- ${c.id} 「${c.name}」`).join('\n'), '',
  '1枚につき次を返します。',
  '- effectKinds：効果の種類（複数可。一覧の id）。効果のないカードは空でよい。',
  '- roles：役割を1〜3個、主なものを先に。一覧の id。',
  '- axisTags：軸のタグ（一覧の id、なければ空）。',
  '- timing：使う時（一覧の中から複数可）。',
  '- conditionAndCost：発動の条件とコストの要点（短く）。',
  '- strength：単体の強さ 1〜5（3が普通。コストに見合うかで見る）。',
  '- fit：性格ごとの合い方 1〜5（beatdown＝攻めて押し切る、midrange＝場の力と相打ちの得、control＝手札とレジストリで勝つ・相手の場を減らす・自分のSTRを守る、tactic＝成立の難しい特定の組み合わせ）。',
  '- confidence：この分類と評価の確からしさ（高・中・低）。',
  '- reason：理由を2文まで。カードの本文とルールのどこから言えるかを示す。',
  '- ambiguity：本文やルールで読み方が分かれるなら ambiguous を true にして、どこが分かれるかを note に書く。分かれないなら false と空文字。',
  '評価は初期評価です。使った結果で見直します。'].join('\n');

const REVIEW_USER = (rows) => ['次は、全カードの分類と初期評価の結果です。同じ種類のカードの間で、評価・役割・軸のタグが食い違っていないかを見てください。',
  '食い違いは inconsistencies に、どのカード（cardIds）の、何が食い違っているか（problem）と、直す案（proposals：cardId・field・from・to・why）を書きます。直す案は出すだけで、上書きはしません。',
  '分け方（一覧）に足りない所・重なっている所があれば taxonomyNotes に。全体の様子は summary に（役割ごとの枚数の偏り、評価の偏りなど）。', '', JSON.stringify(rows)].join('\n');
const REVIEW_SCHEMA = { type: 'object', additionalProperties: false, required: ['inconsistencies', 'taxonomyNotes', 'summary'], properties: {
  inconsistencies: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['cardIds', 'problem', 'proposals'], properties: {
    cardIds: { type: 'array', items: { type: 'string' } }, problem: { type: 'string' },
    proposals: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['cardId', 'field', 'from', 'to', 'why'], properties: { cardId: { type: 'string' }, field: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, why: { type: 'string' } } } } } } },
  taxonomyNotes: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } } };

// ---- the call
const price = () => s.pricing;
const systemBlocks = (extra) => [{ type: 'text', text: SYSTEM },
  ...context.blocks.map((b) => ({ type: 'text', text: b.text, ...(b.cache ? { cache_control: { type: 'ephemeral' } } : {}) })),
  ...(extra ? [{ type: 'text', text: extra, cache_control: { type: 'ephemeral' } }] : [])];
const approxTokens = (chars) => Math.ceil(chars / 1.2);      // Japanese text: close to a token a character; a high guess

const ledger = openLedger(path.join(outDir, 'ledger.jsonl'), { maxUsd: s.budget.maxUsd });
const host = new URL(s.endpoint).host;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function streamRequest(body, apiKey) {
  const response = await fetch(s.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': s.version }, body: JSON.stringify(body) });
  if (!response.ok) return { error: { status: response.status, message: redact(`HTTP ${response.status}: ${(await response.text()).slice(0, 400)}`) }, retryAfter: Number(response.headers.get('retry-after')) || null };
  const usage = {}; let text = ''; let stopReason = null; let buffer = '';
  const decoder = new TextDecoder();
  const take = (raw) => {
    const dataLine = raw.split('\n').find((line) => line.startsWith('data:')); if (!dataLine) return null;
    let event; try { event = JSON.parse(dataLine.slice(5).trim()); } catch { return null; }
    if (event.type === 'message_start') Object.assign(usage, event.message?.usage ?? {});
    else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') text += event.delta.text;
    else if (event.type === 'message_delta') { stopReason = event.delta?.stop_reason ?? stopReason; for (const [k, v] of Object.entries(event.usage ?? {})) if (typeof v === 'number') usage[k] = Math.max(usage[k] ?? 0, v); }
    else if (event.type === 'error') return { error: { status: 0, message: redact(JSON.stringify(event.error ?? event).slice(0, 400)) } };
    return null;
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = buffer.indexOf('\n\n')) >= 0) { const failed = take(buffer.slice(0, at)); buffer = buffer.slice(at + 2); if (failed) return failed; }
  }
  if (buffer.trim()) { const failed = take(buffer); if (failed) return failed; }
  return { text, usage, stopReason };
}

// one question: the answer kept under the hash of everything sent; a call is made only when the spent total allows it
async function ask({ id, extraSystem = null, user, schema }) {
  const body = { model: s.model, max_tokens: s.maxTokens, stream: true, thinking: { type: 'adaptive' }, output_config: { effort: s.effort, format: { type: 'json_schema', schema } },
    system: systemBlocks(extraSystem), messages: [{ role: 'user', content: user }] };
  const key = sha({ model: s.model, effort: s.effort, maxTokens: s.maxTokens, system: body.system.map((b) => b.text), user, schema, version: CLASSIFY_VERSION });
  const file = path.join(outDir, 'responses', `${key}.json`);
  if (existsSync(file)) { const saved = readJson(file); return { ...saved, cached: true, usd: 0 }; }
  if (flag('dry')) return { dry: true, text: null };
  const apiKey = readApiKey(process.env, 'anthropic'); if (!apiKey) die(`no key: ${keyEnvOf('anthropic')} is not in the environment (run through scripts/with-llm-keys.ps1)`);
  const chars = body.system.reduce((n, b) => n + b.text.length, 0) + user.length;
  const worst = (approxTokens(chars) * price().cacheWrite + s.maxTokens * price().output) / 1e6;
  const ok = ledger.canSpend(worst, 'anthropic'); if (!ok.ok) die(`budget: ${ok.reason}`);
  let result; const started = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    try { result = await streamRequest(body, apiKey); } catch (error) { result = { error: { status: 0, message: redact(String(error?.message ?? error)) } }; }
    const again = result.error && (result.error.status === 429 || result.error.status >= 500 || result.error.status === 0) && attempt < s.retries;
    if (!again) break;
    await sleep((result.retryAfter ?? 2 * 2 ** attempt) * 1000);
  }
  if (result.error) { ledger.record({ id, usd: 0, model: s.model, provider: 'anthropic', set: s.set, endpoint: host, error: String(result.error.status), latencyMs: Date.now() - started }); die(`${id}: ${result.error.message}`); }
  const usd = priceOf(result.usage, price());
  ledger.record({ id, usd, usage: result.usage, model: s.model, provider: 'anthropic', set: s.set, endpoint: host, stopReason: result.stopReason, latencyMs: Date.now() - started });
  if (result.stopReason === 'max_tokens' || result.stopReason === 'refusal') die(`${id}: the answer stopped with ${result.stopReason} (not kept)`);
  const saved = { text: result.text, usage: result.usage, stopReason: result.stopReason, usd, model: s.model, at: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(saved));
  return { ...saved, cached: false };
}

const parse = (answer, id) => { try { return JSON.parse(answer.text); } catch { die(`${id}: the answer is not JSON`); } };
const usageLine = (answer) => `${answer.cached ? '(from the kept answer)' : `$${answer.usd.toFixed(4)}`} in=${answer.usage?.input_tokens ?? 0} cacheWrite=${answer.usage?.cache_creation_input_tokens ?? 0} cacheRead=${answer.usage?.cache_read_input_tokens ?? 0} out=${answer.usage?.output_tokens ?? 0}`;

// ---- estimates (before a run)
function estimate() {
  const p = price(); const ctxTokens = approxTokens(context.chars);
  const taxonomyFile = path.join(outDir, 'taxonomy.json');
  const taxonomyTokens = existsSync(taxonomyFile) ? approxTokens(taxonomyText(readJson(taxonomyFile)).length) : 4000;
  const perOut = (n) => (n * p.output) / 1e6;
  const stage1 = (ctxTokens * p.cacheWrite) / 1e6 + perOut(16000);
  const batches = Math.ceil(BUILDABLE_CARDS.length / s.batchSize);
  const stage2 = (ctxTokens * p.cacheWrite + taxonomyTokens * p.cacheWrite) / 1e6 + batches * ((ctxTokens * p.cacheRead + taxonomyTokens * p.cacheRead + 1500 * p.input) / 1e6 + perOut(s.batchSize * 900));
  const stage3 = ((ctxTokens + taxonomyTokens) * p.cacheRead + BUILDABLE_CARDS.length * 450 * p.input) / 1e6 + perOut(20000);
  const rows = { contextTokens: ctxTokens, taxonomyTokens, batches, stage1Usd: stage1, stage2Usd: stage2, stage3Usd: stage3, totalUsd: stage1 + stage2 + stage3, limitUsd: s.budget.maxUsd, stopAboveUsd: s.budget.stopAboveUsd, spentUsd: ledger.usd };
  return rows;
}

// ---- the stages
if (stage === 'estimate') { console.log(JSON.stringify(estimate(), null, 1)); process.exit(0); }
const est = estimate(); const stageEst = { taxonomy: est.stage1Usd, classify: est.stage2Usd, review: est.stage3Usd }[stage];
if (stageEst === undefined) die(`--stage ${stage}?`);
console.log(`estimate for ${stage}: about $${stageEst.toFixed(2)} (the whole job about $${est.totalUsd.toFixed(2)}; spent so far $${ledger.usd.toFixed(4)}; limit $${s.budget.maxUsd})`);
if (stageEst > s.budget.stopAboveUsd && !flag('yes')) die(`the estimate is over $${s.budget.stopAboveUsd}: not started without --yes (report it first)`);

if (stage === 'taxonomy') {
  const answer = await ask({ id: 'taxonomy', user: TAXONOMY_USER, schema: TAXONOMY_SCHEMA });
  if (answer.dry) { console.log('dry: no call'); process.exit(0); }
  const taxonomy = parse(answer, 'taxonomy');
  writeOut('taxonomy.json', { meta: meta(), taxonomy });
  console.log(`taxonomy: ${taxonomy.effectKinds.length} kinds of effect, ${taxonomy.roles.length} roles, ${taxonomy.axisTags.length} axis tags; ${usageLine(answer)}`);
} else if (stage === 'classify') {
  const taxonomyFile = path.join(outDir, 'taxonomy.approved.json'); if (!existsSync(taxonomyFile)) die('taxonomy.approved.json is not in the folder: a person approves the lists first (copy taxonomy.json, edit it, save it under that name)');
  const taxonomy = readJson(taxonomyFile).taxonomy ?? readJson(taxonomyFile);
  const only = option('only')?.split(',');
  const doneFile = path.join(outDir, 'classification.json');
  const done = existsSync(doneFile) ? readJson(doneFile) : { meta: null, cards: {} };
  const todo = BUILDABLE_CARDS.filter((c) => (only ? only.includes(c.id) : !done.cards[c.id]));
  const extra = taxonomyText(taxonomy);
  let spent = 0; const problems = [];
  for (let i = 0; i < todo.length; i += s.batchSize) {
    const batch = todo.slice(i, i + s.batchSize); const ids = batch.map((c) => c.id);
    const answer = await ask({ id: `classify|${ids[0]}..${ids.at(-1)}`, extraSystem: extra, user: classifyUser(batch), schema: classifySchema(taxonomy, ids) });
    if (answer.dry) continue;
    const data = parse(answer, 'classify');
    for (const row of data.cards) {
      const bad = [];
      if (!ids.includes(row.id)) bad.push('id not in the batch');
      if (row.roles.length < 1 || row.roles.length > 3) bad.push(`roles ${row.roles.length}`);
      if (bad.length) { problems.push({ id: row.id, bad }); continue; }
      done.cards[row.id] = { ...row, name: lookup(row.id) };
    }
    for (const id of ids) if (!data.cards.some((r) => r.id === id)) problems.push({ id, bad: ['missing in the answer'] });
    spent += answer.usd ?? 0;
    console.log(`classify ${ids[0]}..${ids.at(-1)}: ${data.cards.length} cards; ${usageLine(answer)}`);
    done.meta = meta(); writeOut('classification.json', done);
  }
  if (problems.length) { writeOut('classification-problems.json', problems); console.log(`problems: ${problems.length} (classification-problems.json; run again with --only to ask for them)`); }
  console.log(`classified ${Object.keys(done.cards).length} of ${BUILDABLE_CARDS.length}; this run $${spent.toFixed(4)}`);
} else if (stage === 'review') {
  const taxonomy = readJson(path.join(outDir, 'taxonomy.approved.json')); const classification = readJson(path.join(outDir, 'classification.json'));
  const rows = Object.values(classification.cards).map((c) => ({ id: c.id, name: c.name, effectKinds: c.effectKinds, roles: c.roles, axisTags: c.axisTags, strength: c.strength, fit: c.fit, confidence: c.confidence, ambiguous: c.ambiguity.ambiguous }));
  const answer = await ask({ id: 'review', extraSystem: taxonomyText(taxonomy.taxonomy ?? taxonomy), user: REVIEW_USER(rows), schema: REVIEW_SCHEMA });
  if (answer.dry) { console.log('dry: no call'); process.exit(0); }
  const review = parse(answer, 'review');
  writeOut('review.json', { meta: meta(), review });
  console.log(`review: ${review.inconsistencies.length} inconsistencies; ${usageLine(answer)}`);
}
console.log(`spent in all so far: $${ledger.usd.toFixed(4)} (limit $${s.budget.maxUsd})`);

function lookup(id) { return BUILDABLE_CARDS.find((c) => c.id === id)?.name ?? null; }
