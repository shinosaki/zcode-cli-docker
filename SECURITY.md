# SECURITY.md — 脅威モデル・対策・レビュー記録

このドキュメントは、本パイプラインのセキュリティ設計と、実装時に実施した
批判的レビュー（敵対的レビュー → 修正 → 再検証）の記録です。

## 1. 資産と脅威モデル

**守る資産**: ビルドパイプライン（GitHub Actions 上の実行環境と GITHUB_TOKEN）、
公開されるイメージの完全性、それを利用する消費者の環境。

**想定する攻撃者**:

| 攻撃者 | 能力 |
| --- | --- |
| A1 | このリポジトリへ PR を出せる第三者（fork 含む） |
| A2 | このリポジトリへの書き込み権限を持つ内部者/侵害されたアカウント |
| A3 | upstream リポジトリ（zai-org/ZCode）を侵害した攻撃者 |
| A4 | npm レジストリ上で悪意あるパッケージを公開する攻撃者 |
| A5 | ネットワーク経路上の攻撃者（MITM） |

**明示的に守らないもの**: upstream そのものの完全性（A3 が成立した場合、
下記「残余リスク」のとおり限定的な防御のみ有効）。zcode CLI 実行時の挙動
（エージェントがワークスペース内で行うこと）はこのパイプラインのスコープ外。

## 2. 要求と対策のマッピング

| 要求 | 実装 |
| --- | --- |
| アクションは commit hash pinning | 全 `uses:` を 40桁 SHA 固定 + バージョンコメント。Dependabot が SHA 更新 PR を週次作成（人間マージ） |
| セキュアな npm レジストリ | `npm.flatt.tech`（Flatt Security のフィルタリング proxy）を既定に。npmjs と同一 integrity の実測検証済み。`NPM_REGISTRY` ピンで即時切替可能。lockfile 整合が主防御、proxy は縦深防御 |
| minimumReleaseAge 等の pnpm 構成 | `MINIMUM_RELEASE_AGE_MINUTES=10080`（7日、pnpm は分単位）を `--config.minimum-release-age` で install に付与（frozen lockfile 下では通常 no-op の縦深防御）。主ゲートは更新検知側の `MINIMUM_RELEASE_AGE_DAYS=7` |
| フォークしない場合の乖離抑制 | フォーク自体を採用しない。upstream をタグ+コミットSHA二重固定で直接取得し、ランナーとコンテナ内の二か所で独立検証（乖離=ビルド失敗） |
| 無料枠 | public リポジトリ標準ランナー + GHA cache + GHCR public + Sigstore keyless = 全て無料 |
| 更新の自動化 | 週次検知 → 種類別に独立した PR（= 通知）→ 人間マージ → push で publish。**自動マージ・自動 publish は存在しない** |
| 脅威モデリングとの整合 | 「人間レス更新」は脅威モデルと矛盾するため不採用（マージ操作が審査ポイント） |

### 多層防御の内訳

```
[upstream コード]  ── タグ+コミット二重固定（ランナー検証 + コンテナ内検証）
[依存パッケージ]   ── frozen lockfile（整合ハッシュ）→ flatt.tech proxy → minimumReleaseAge
[依存のpostinstall] ── pnpm 10 デフォルトブロック + upstream allowBuilds 許可リスト
[ツールチェーン]   ── pnpm は npmjs から正確バージョン + integrity カナリア
[ベースイメージ]   ── マルチアーキ index digest 固定 + パッチ追従 PR
[CI 実行環境]      ── 最小権限 / persist-credentials:false / egress allowlist(block) / 第三者アクション不在
[成果物]           ── 同一 digest でテスト→署名→タグ / cosign keyless / SBOM / provenance
[更新フロー]       ── 検知→PR→人間マージ（自動配送なし）
```

## 3. 批判的レビューの記録

### ラウンド1: 敵対的レビュー（独立レビュアー）→ 修正

実装完了直後に、供給網セキュリティ専門の観点から敵対的レビューを実施しました。
16件の指摘のうち、修正したものと判断の記録:

| # | 深刻度 | 指摘 | 処置 |
| --- | --- | --- | --- |
| 1 | **high** | harden-runner の egress block が Debian apt リポジトリを遮断しビルド不能 | 修正: `deb.debian.org:80` `security.debian.org:80` `api.stepsecurity.io:443` とキャッシュ用 `*.blob.core.windows.net:443` を allowlist に追加 |
| 2 | medium | envファイルのパーサー差異（first-wins/last-wins）と「load後にverify」の順序 → 重複キーで検証迂回、verify前に任意キーがジョブ環境へ注入可能 | 修正: verify-pin.mjs を厳格canonicalパーサー化（重複キー・未知キー・CR・末尾改行欠落を全て拒否）し、**verify→load の順に変更**、ローダーも key パターン検証 + CR除去。敵対的テスト（重複/CRLF/未知キー）で拒否を確認 |
| 3 | medium | `ZCODE_UPSTREAM_URL` がピンファイル内の可変データ → 1行の PR で取得元リポジトリを差し替え可能（全検証が自己整合的に通る） | 修正: URL をピンファイルから削除し、3か所（verify-pin / update-check / workflow）にハードコード。「bump PR は WHAT を、WHERE は変えられない」原則 |
| 4 | medium | `NPM_REGISTRY` が検証されるだけで pnpm に接続されていない（装飾的。upstream 側の設定を黙って継承する恐れ） | 修正: ビルダーで `ENV npm_config_registry=${NPM_REGISTRY}` を設定（upstream由来の設定より優先）。sandbox 実測で flatt.tech 経由インストール成功済み |
| 5 | medium | 更新WF: 2本目のPRが1本目のブランチから切れる（2つの変更が1つのPRに混入）+ 決定的ブランチ名で先週のPRが残ると詰む | 修正: 各PRごとに `origin/main` から `checkout -B`、ブランチ名に日付追加、`gh pr list --head` で既存オープンPRなら skip（failしない） |
| 6 | medium | テスト対象（build#1）と公開・署名対象（build#2）が別物（キャッシュミス時に再取得が発生しうる）+ cancel-in-progress が push〜署名間のジョブを殺しうる | 修正: 単一ビルド+push（`ci-<sha>` タグ）→ **同一digestに smoke test** → cosign 署名 → `imagetools create` でサーバーサイドにリリースタグ。`cancel-in-progress: false` |
| 7 | medium | smoke-test が pipefail 下で SIGPIPE（exit 141）による偽失敗 | 修正: HTTPボディを一旦ファイルに保存してから grep（`grep -q` / `head -c` パイプを廃止） |
| 8 | low | tarball sha256 検査が同一ビルド産の自己参照で「upstream検証」と謳うのは過大 | 修正: コメントを正確化（破損/カナリア検査である旨）。※ 公開CDNの `sha256.txt` との突合はCLI配布URL未確認のため不採用、READMEに記載 |
| 9 | low | digest検知が同一タグの drift のみで、新パッチタグ（セキュリティ修正）を検知できない | 修正: `24.14.x` パッチタグのプローブ検知を追加（HEAD manifest を連番走査、上限40）。実データで `24.14.1` を検出し、初回ピンを更新して実証済み |
| 10 | low | `workflow_dispatch` が任意ブランチから `:latest` を publish できる | 修正: ジョブに `if: github.ref == 'refs/heads/main'` を追加 |
| 11 | low | git push のURL埋め込みトークンがプロセス引数に露出 | 修正: `GIT_ASKPASS`（ファイル内は変数名のみ、トークンは実行時 env 参照）に変更 |
| 12 | low | 年齢ゲートが committer date（正しい選択）だが upstream により偽装可能 + 先行ゼロ semver の比較曖昧性 | 修正: committer date は維持、semver 正規表現で先行ゼロを拒否、偽装可能性は「残余リスク」に明記（下記） |
| 13 | low | PR 上で一切 CI が走らず、マージ前にピン検証の証拠がない | 修正: `pin-verify.yml` を追加（`pull_request` で verify-pin.mjs のみ、secretなし・書込なし → fork PR でも安全） |
| 14 | low | `minimumReleaseAge` の単位誤り（pnpm は**分**単位。604800秒を渡すと約420日になる） | 修正: 公式ドキュメントで確認（`1440` = 1日）→ `10080` 分（7日）に修正、変数名も `_MINUTES` に変更、verify-pin で days×1440 との整合を検査 |
| 15 | info | flatt.tech の残余リスク分析（lockfile整合が authority である旨、可用性依存） | 修正: 役割を「縦深防御」と明記、npmjs への切替手順を README に記載 |
| 16 | info | 検証済みで問題なしと確認された項目（SHA pin完全性、シェルインジェクション不在、TOCTOU閉鎖、マルチアーキdigest取り扱い、fork/無料枠の安全性等） | 記録として保持 |

### ラウンド2: 修正検証（独立レビュアーによる再レビュー）

修正版を元のレビュアーが再レビューし、**指摘1〜14は全て「FIXED VERIFIED」判定**。
新規指摘（N1〜N9、全て low/info）にも対応:

| # | 深刻度 | 指摘 | 処置 |
| --- | --- | --- | --- |
| N1 | low | 閉じた（未マージ）PRと同名ブランチへの同日再実行で push が非FF拒否 | 修正: 更新ブランチは常に origin/main から再生成されるため `--force` push に変更（安全） |
| N2 | low | ピン済みタグが Docker Hub から削除された場合に `digest=null` の搬送 PR を出しうる | 修正: 404時は警告にして検知をスキップ（null digest は絶対に提案しない） |
| N3 | low | CODEOWNERS の対象が `zcode-version.env` のみ → `verify-pin.mjs` 自体の書き換えでCI検証が無効化可能 | 修正: テンプレートで `scripts/verify-pin.mjs`・`scripts/`・`.github/workflows/` もオーナーレビュー対象に（`docs/CODEOWNERS.template`） |
| N4 | info | レジストリプローブのレート制限露出 | 修正: トークンを1回取得して再利用、上位パッチから降順プローブで早期打ち切り |
| N5 | info | Containerfile の ARG デフォルトが node bump PR 後に陳腐化 | 修正: 「CIは常に build-args を渡す」旨の注記を追加（装飾的影響のみ） |
| N6 | info | 初回 run 確認事項（attestation index の digest 参照、retag の digest 一致等） | 修正: retag 後の digest 一致アサーションを workflow に自動組込み + README に初回チェックリスト追加 |
| N7 | info | smoke-test の二重 trap で tmp ディレクトリが掃除されない | 修正: 単一 EXIT trap に統合 |
| N8 | info | env値に `<<` 等が含まれる場合の GITHUB_ENV multiline 構文との干渉 | 修正: `<` `>` `"` `\` を値の禁止文字に追加（verify-pin） |
| N9 | info | check-upstream-update 側パーサーが verify-pin と非一貫 | 修正: 未知キー・空白値の拒否を含め verify-pin と同一の厳格仕様に統一 |

修正後に以下を再検証し、全て合格:

- 全スクリプト `node --check` / `bash -n`、全 workflow YAML パース
- `verify-pin.mjs`: 実 upstream に対する tag→commit 検証（annotated tag の peeled 解決を含む）
- `check-upstream-update.mjs`: 現行ピンで no-op、古いピンで bump 提案、`--apply` 往復書き換え、
  node パッチ検知（実データで 24.14.1 を検出）
- 厳格パーサーの敵対的テスト（重複キー / CRLF / 未知キー = 全て拒否）
- Containerfile のコマンド列は sandbox で実ビルド済み（node 24.22.1 で `--version`/`--help` 動作確認、
  webビルドのみランナー16GB前提、README記載）

## 4. 残余リスク（明示的に受け入れるもの）

| リスク | 影響 | 緩和 |
| --- | --- | --- |
| upstream リポジトリ侵害（A3）+ コミット日付偽装 | 7日ゲートは迂回可能 | PR 差分の人間審査が最終防御。CI 失敗時の無条件リトライ禁止を運用規律とする |
| apt パッケージのフロート | ベースイメージ内の git/openssh 等がビルド時点の Debian 版に依存（再現性が完全ではない） | Debian リポジトリの署名検証に依存。snapshot.debian.org による完全固定は運用コストと引き換えに不採用 |
| flatt.tech の可用性・信頼 | ビルド失敗またはメタデータ経路への第三者関与 | integrity は lockfile が authority（proxy が改変した整合値は tarball 検証で fail-closed）。障害時は `NPM_REGISTRY` で npmjs に切替 |
| `ci-<sha>` ビルドタグが署名前に公開される | 短時間・テスト前のイメージが参照可能 | リリースタグ（version/latest）は smoke 合格後のみ付与。消費者は digest + cosign verify を前提とする |
| zcode 実行時の挙動（telemetry 等） | エージェントの外部通信はイメージビルドのスコープ外 | upstream ソースは公開済み。運用者は `--web` の `--token`、ネットワークポリシー等で制御 |

## 5. 運用者が必ず行うこと

1. **ブランチ保護**: `main` に PR 必須 + 承認必須、force push 禁止。
   これがないと「マージ = 人間ゲート」の設計全体が崩壊します
2. **CODEOWNERS** で `zcode-version.env` の変更にオーナーレビューを要求
   （無関係な PR にピン変更が紛れ込むのを防止）
3. 初回 publish 後に **GHCR パッケージを public 化**（既定は private）
4. 初回 run 後に `cosign verify` の identity regexp が実際の署名と一致することを確認
5. CI が失敗した場合の**盲目的な再実行をしない**（ピン検証の失敗 = タグ移動の
   可能性 = 調査が必要というシグナル）

## 6. 消費者側の推奨

- タグではなく **digest で参照**し、pull 前に `cosign verify`
- `--certificate-identity-regexp` は自分のリポジトリのワークフローに限定する
- SBOM（`sbom: true` で生成）を社内の脆弱性スキャンに渡す
