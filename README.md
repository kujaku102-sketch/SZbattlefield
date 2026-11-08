# SZbattlefield

Siege÷Zeke の CPU を育てるための道具。CPU 同士を決まった表の通りに対戦させ、強さと速さを測り、新しい CPU を今の CPU と比べる。
ゲーム本体（[Siege_Zeke_openbeta](https://github.com/kujaku102-sketch/Siege_Zeke_openbeta)）はこのリポジトリに含まない。コミットを指定して外から取ってきて、そのコミットを結果に書く。

## 動かすのに要るもの
- node 24 以上、git
- ゲーム本体のコミット。次のどれかで渡す。
  - `GAME_DIR=<パス>`: すでにあるチェックアウトをそのまま使う（GitHub Actions では、指定コミットを checkout した場所）
  - `--commit <sha>`（または環境変数 `GAME_COMMIT`）: `GAME_SOURCE`（既定は公開リポジトリ）から clone して、そのコミットに合わせる
  - どちらも無いとき: `GAME_REF`（既定 `main`）の先頭を取る
  - 手元のリポジトリを使うときは `GAME_SOURCE=<パス>`。clone の置き場は `SZB_WORK`（既定はシステムの一時フォルダ）
- ゲームのリポジトリには何も書き込まない（clone と checkout だけ）。

## 使い方
```
node src/run.mjs --a simple --b simple --seeds 40 --workers 5 --out out/simple-simple
node src/report.mjs out/simple-simple          # summary.md / summary.json
```
- `--a` / `--b`: CPU の指定。名前（`cpus/<名前>.mjs`）かファイルのパス。後ろに `?キー=値&…` を付けるとパラメータが CPU に渡る（重みの調整用）。A が seat-a、B が seat-b。`--swap` で席を入れ替えた分も回す（違う CPU 同士を比べるときは必須）。
- 表は、スタートデッキ全部の総当たり（先手側デッキ × 後手側デッキ。同じデッキ同士も含む）× 固定シード。先手・後手はゲーム自身の開始ダイス（シードで決まる）で決まり、結果の `firstSeat` に残る。
- 試合の打ち切り: 受理されたコマンド 3000 個、900 秒、または同じコマンドが同じ状態（両席の見え方）で 10 回続いたとき（繰り返し。`--max-commands` `--max-wall-sec` `--max-repeat`）。8 手続けて受理されなければ「止まった（stuck）」。
- 同じシード・同じ CPU なら、何度回しても、どの機械で回しても同じ結果になる（`src/determinism.mjs`、`src/compare.mjs` で確かめられる）。

## 分けて回す・続ける・合わせる
```
node src/run.mjs ... --shard 1/4 --out shards/1      # 表を 4 つに分けた 1 つ目だけ回す
node src/run.mjs ... --shard 1/4 --out shards/1      # 止まったら同じコマンド。終わった試合は飛ばす
node src/merge.mjs --out merged shards/1 shards/2 shards/3 shards/4
node src/report.mjs merged
```
詳しくは [docs/sharding.md](docs/sharding.md)。

## ルールを 1 つ変えた試合（実験）
`--variant <id>` は、ゲームのコピーに `variants/<id>.json` の書き換えを当てて回す（`src/variants.mjs`）。ゲームのリポジトリは変えない。使ったルールは `env.json` に入り、違うルールの結果は混ざらない。

## CPU の差し替え口
CPU は `{ id, create(gameDir, params) -> { choose(view) }, versionFiles?(gameDir) }` を default export するモジュール（`cpus/simple.mjs` が見本）。
`choose` に渡るのは `view` だけ。
- `view.query`: その席から見える query（自分の手札は中身、相手の手札・山札は枚数だけ。UI がその席に見せるものと同じ）
- `view.queryAction`: その席のポートで行動を組み立てる関数（他の席・authority・engine の状態には届かない）
- `view.commandId` / `view.seatId`

返すのは `{ ok: true, value: { commandId, expectedRevision, action } }` か `{ ok: false, error: { code } }`。
CPU オブジェクトは試合ごと・席ごとに作り直す（試合をまたいだ状態は持ち越せない）。
`versionFiles` は、そのモジュールの外にあって動きを決めるファイル（`simple` ならゲーム側の方針ファイル）。CPU の版はこれらのハッシュで決まる（改行コードは無視）。
カード名・カード番号に結びついた処理は CPU に入れない。

### 先を読む CPU（`needsSim`）
`needsSim: true` の CPU には `view.sim` と `view.baseline()` も渡る（`src/sim-host.mjs`）。本物の状態・authority・相手の隠しカードは渡らない。
- `sim.moves`: その席の手 `[{id, type, uids}]`（エンジンの状態から作る。`src/candidates.mjs` `src/moves.mjs`）
- `sim.now(k)`: k 番目の「見えない所を引き直した状態」（自分の山札の並び、相手の手札・山札・伏せカード。引く山は、その席がルールで見ているカードとデッキ表から作る。`src/sim.mjs`）
- `sim.after(id, k)`: その状態にその手を当てた結果の状態（なければ null）
- `sim.intent(id, {commandId, expectedRevision})`: 返すべき intent
- `view.baseline()`: 今の CPU（`simple`）がこの局面で選ぶ手
この CPU のファイルは、`cpus/` の中のファイルしか import できない（読み込むときに確かめる）。見本は `cpus/lookahead.mjs`。

## 時間の測り方（1手 = CPU が選んだコマンド1個）
- `choose` = CPU の呼び出し全体 = `own`（CPU 自身のコード）+ `planning`（CPU が呼んだゲームの `queryAction`。ランタイムの時間）
- `query` = 手の前にその席が取る query、`submit` = コマンドの提出。どちらもランタイム側の時間
- 並列で回した表の時間は他の処理と競合する。時間は 1 ワーカー・単独で回した結果を使う。別々の機械の結果を合わせた表の時間は意味がない。

## 1手を試す時間
`probe/probe.mjs` は、今の CPU が打った試合から局面を拾い、ランタイム（検証・射影）を通さずにエンジンで 1 手を試す時間を測る。
見えない情報（相手の手札・自分の山札の並びなど）は、その席が見ているカードとデッキ表から作った山で埋め直した状態の上で試す。`probe/summarize.mjs` で集計する。

## 完成品の CPU（cpus/release/）
学習の途中の重みの CPU（`cpus/forged-*.mjs`）はリポジトリに置かない（`.gitignore`）。仕上がって「完成品」と決めたものだけを `cpus/release/` に置く。
CPU には「<系統>ZIG gen<世代>」の名前を付ける。置き場所は世代ごと: `cpus/release/gen<N>/<系統>ZIG.mjs`（本体）、同じ名前の `.json`（記録）、同じ名前のフォルダ（凍結した部品）。本体は自分のフォルダの部品だけを読むので、`cpus/learned/` などを変えても指し方は変わらない。
- gen1 → `gen1/beatZIG` — beatZIG gen1: 第 1 世代（線形の点数、v3 の特徴、lookahead の手本、勝敗で重み）。`gen1/beatZIG.json` に、重みのハッシュ、学んだデータ、**学んだ時のゲームのルール（b8214a6、staging.19、先攻 0 枚）**、評価（勝率と 95% の幅）、1 手の時間が書いてある。ルールが変わったら作り直す。
- `gen2/beatZIG.mjs` — beatZIG gen2: 小さなネットワーク（v4 の特徴、隠れ 32）で手に点を付け、上位 2 手を読み手（再抽選した状態の評価）で選び直す。手本は deep と lookahead、Haiku 5.5（難所）、人の印。記録は `gen2/beatZIG.json`（学んだデータ、評価、時間）。前の世代の gen1 は比べる相手として残す。
- `gen2/lightZIG.mjs` — lightZIG gen2: beatZIG gen2 と同じネットワークを読み手なしで使う、速くて軽い系統（凍結。のちに速さ重視で育てる）。記録は `gen2/lightZIG.json`。
- 昔の名前: gen1 は `cpus/release/gen1.mjs`、gen2 は `cpus/release/gen2.mjs`、lightZIG gen2 は gen2-light だった。中身（重み・特徴・手の選び方）は変えていない。読み手の再抽選は試合の名前（CPU のファイル名を含む）から決まるので、ファイル名が変わると一部の試合の展開が変わる（強さは同じ）。
- 世代を上げる決め方: 新しい CPU を前の世代と直接戦わせ（両席、評価の seed）、勝率の 95% の幅の下の端が 50% を超えたら昇格の候補。最後に決めるのは人。

## 自分で組んだデッキ（decks/）
スタートデッキ以外のデッキは、ゲームのデッキ構築画面で組んで「書き出し」した JSON（`{ id, name, userId, cards: { カードID: 枚数 } }`）を、`decks/<名前>.json` にして使う。デッキ名で指定する（`--decks start-red,ctl-1`）。
- 取り込み: `node src/deck-import.mjs <書き出した.json>... --id ctl-1[,ctl-2] [--commit <ゲームの sha>] [--check]`。`--id` は対戦台での名前（英数字と - _。`start-` で始められない）。
  構築の確かめは**ゲーム自身の** `normalizeSavedDeck` と `validateDeck`（deck-builder.js）を使う（ユーザーカードが指定する枚数、同名の上限）。ここに決まりを二重に書かない。`run.mjs` も始める前に同じ確かめをする。
  ゲームの checker が見ていないもの（DANGER! の 1 種類 1 枚、カード自身の投入制限）は、ここでも見ない（ゲーム側の穴として報告済み）。
- 席ごとのユーザー: デッキの `userId` のユーザーで始まる（初期手札・前後の上限・STR・メモリ・インシデント・能力）。ゲームの CPU 戦と同じ渡し方（デッキ id は席の `red` / `yellow`、一覧は recipe、ユーザーは `playerUserId` / `aiUserId`）。
- 使い方メモ（なくてよい）: デッキと同じ名前のマークダウンを横に置くと読む（`黒緑コントロール.json` の横に `黒緑コントロール.md`）。`- 狙いの性格:` の行と、`## 使い方`（序盤・中盤）、`## フィニッシュプラン`（勝ち筋）、`## 守るべきカード`（カード名か ID から書く）の節。
  CPU には渡さない。人と LLM の先生の文脈、性格の重みと特定戦術の補正を決める材料、勝ち筋のカードが実行されたかを数える材料に使う。見本は `decks/template-red.json`（スタートデッキ 赤を書き出しの形にしたもの）。
- 先を読む CPU（lookahead など）は、見えない札をそのデッキの一覧から補う。デッキファイルの hash は環境の鍵に入る（別の一覧で回した結果は混ざらない）。
- 確かめ済み: スタートデッキを書き出しの形にして回すと、元のスタートデッキと同じ試合になる（勝敗・ターン数・コマンド数・先攻が一致。simple と lookahead）。

## 置いてあるもの
```
src/      arena（CPU A 対 B の勝敗の集計）、variants（ルールを変えたゲームのコピー）、run（対戦表を回す）、play（1 試合）、worker、table（表と shard の分け方）、env（環境の記録）、
          merge（結果をまとめる）、compare（2 つの結果の一致を見る）、report（集計）、determinism、game-dir（ゲームの取得）、
          sim / sim-host / candidates / moves（先を読む CPU に渡す状態と手を、信頼する側が作る）
cpus/     CPU の差し替え口（index.mjs）、今の CPU の見本（simple.mjs）、1 手先を読む CPU（lookahead.mjs と lookahead/eval.mjs）
probe/    1 手を試す時間の計測、山の食い違いの原因（diagnose-pool）、手の一致（candidates）、局面の拾い方（positions）
docs/     sharding.md
decks/    自分で組んだデッキ（書き出した json を取り込んだもの。上の節）
.github/workflows/bench.yml   GitHub Actions の下書き（手動実行のみ。まだ使っていない）
```
