# zcode-cli-container

[zcode CLI](https://github.com/zai-org/ZCode)（Z.ai のコーディングエージェント）を、
サプライチェーンリスクを最小化した GitHub Actions パイプラインでビルドし、
GitHub Container Registry (ghcr.io) に公開するための構成一式です。

- ビルド・公開は **GitHub の無料枠**のみで完結（public リポジトリ前提）
- 更新は **検知 → 通知（PR）→ 人間がマージ → 初めて publish** の人間ゲート方式
- 成果物は **cosign keyless 署名 + SBOM + provenance attestation** 付き
- セキュリティ設計の詳細と批判的レビューの記録は [SECURITY.md](SECURITY.md)

## ファイル構成

```
Containerfile                       マルチステージビルド（全ピン必須・fail-fast）
zcode-version.env                   ピン留めの単一情報源（厳格パーサーで検証される）
scripts/verify-pin.mjs              ピン検証（CI側 + 厳格パーサー）
scripts/check-upstream-update.mjs   更新検知（upstreamタグ / node パッチ / digest）
scripts/smoke-test.sh               push後・署名前の機能テスト
.github/workflows/build-and-publish.yml   ビルド→公開→テスト→署名→タグ付け
.github/workflows/upstream-update-check.yml  週次更新検知→PR作成（自動マージなし）
.github/workflows/pin-verify.yml          PR上でピン検証のみ実行（fork安全）
.github/dependabot.yml              アクションSHAの更新PR（人間マージ）
examples/Containerfile.devcontainer  ビルド済みCLIを任意イメージへCOPYする例（実機検証済）
```

## セットアップ手順

1. **新規リポジトリを作成**（public 推奨。無料枠の観点は後述）し、この一式を
   リポジトリルートに置く。`.github/` はリポジトリルート直下に配置。

2. **ブランチ保護を設定**（必須）:
   - `main` への直接 push を禁止、PR 必須 + 1人以上の承認
   - force push / branch delete を禁止
   - （必須）`CODEOWNERS` でピン・検証スクリプト・ワークフローの変更に
     オーナーレビューを要求。`docs/CODEOWNERS.template` を
     `.github/CODEOWNERS` としてコピーし、`@OWNER` を置き換えてください。
     `scripts/verify-pin.mjs` を対象に含めることが重要です
     （これが書き換えられるとCI検証自体が無効化されるため）。

   この「マージ = 人間の承認」ゲートが供給網防御の中核です。

3. **初回 publish**: `main` に push すると `build-and-publish` が走り、
   `ghcr.io/<owner>/<repo名小文字>:<zcodeバージョン>` と `:latest` が作られます。
   GHCR パッケージの初期可視性は **private** のため、
   `Settings → Packages → <package> → Package settings → Danger Zone → Change visibility`
   で **public** に変更してください（以降のバージョンは public 扱いで上書きされる挙動にならないため、
   バージョンを重ねる前に一度実施するのが確実です）。

4. **Secrets は不要**です。`GITHUB_TOKEN` のみで動作し、ワークフロー内で
   最小権限（`packages: write` / `id-token: write`）に絞られています。

## イメージの使い方

```bash
# 対話TUI（カレントディレクトリをワークスペースとして）
docker run -it --rm -v "$PWD":/workspace ghcr.io/<owner>/<repo>:latest

# ヘッドレス実行（CI等）
docker run --rm -v "$PWD":/workspace ghcr.io/<owner>/<repo>:latest \
  --prompt "このプロジェクトの構造を説明して" --locale auto

# Web UI
docker run --rm --network host -v "$PWD":/workspace \
  ghcr.io/<owner>/<repo>:latest --web --no-open
```

- イメージは **digest で参照**することを推奨（タグは可変）。digest は Actions の
  Job Summary と `cosign verify` で確認できます。
- ランタイムは `/opt/zcode` に root 所有・読み取り専用で配置され、コンテナ内で
  自己更新はできません。更新は新しいイメージの公開によってのみ行われます。
- 認証情報はコンテナの `$HOME`（`/home/zcode`）に置かれます。永続化したい場合は
  `-v zcode-home:/home/zcode` のようなボリュームを検討してください。

### 消費者側の検証

```bash
# 署名検証（keyless: このリポジトリのActionsワークフローによる署名であること）
cosign verify \
  --certificate-identity-regexp '^https://github.com/<owner>/<repo>/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/<owner>/<repo>@sha256:<digest>

# SBOM / provenance の確認
docker buildx imagetools inspect ghcr.io/<owner>/<repo>@sha256:<digest> --raw | jq '.manifests[].annotations'
```

### 他イメージへの組み込み（COPY パターン）

一度ハードニング済みパイプラインでビルドして公開すれば、**再ビルドなし**で
ビルド済み zcode CLI を任意のベースイメージに組み込めます。
`examples/Containerfile.devcontainer` がテンプレートです。

```dockerfile
ARG ZCODE_IMAGE=ghcr.io/<owner>/<repo>@sha256:<リリースdigest>
FROM ${ZCODE_IMAGE} AS zcode
FROM mcr.microsoft.com/devcontainers/base:bookworm
COPY --from=zcode /opt/zcode /opt/zcode
COPY --from=zcode /usr/local/bin/node /usr/local/bin/node
COPY --from=zcode /usr/local/bin/zcode /usr/local/bin/zcode
RUN chmod -R a-w /opt/zcode
```

- マルチステージの `FROM` に公開済みイメージを指定し `COPY --from` で回収する
  標準的な BuildKit 構文です。public パッケージなら匿名 pull でログイン不要。
- ソース側は **digest 固定が必須**。署名検証済み・smoke-test 通過済みの
  バイト集合を参照させるためで、digest は
  `docker buildx imagetools inspect ghcr.io/<owner>/<repo>:v3.15.1` で取得します。
  組み込み前に `cosign verify`（前節）を通すのが理想です。
- **検証済み事実**（`devcontainers/base:bookworm` の実 rootfs から chroot 実行で確認）:
  `zcode --version` → 3.15.1、`--help` 正常描画、node-pty のネイティブ prebuild の
  dlopen 成功、web サーバが `/api/server-info` に正常応答、同梱 git 2.56 も動作。
- **組み込み先の要件**: linux/amd64、glibc ≥ 2.34（Debian 12+ / Ubuntu 22.04+ /
  RHEL 9+）、GLIBCXX ≥ 3.4.22。**node の事前インストールは不要**
  （CLI の検証に使った node 24.14.1 本体を zcode イメージから COPY するため、
  ベースイメージの node 有無・バージョンに左右されません）。
  node 同梱済みイメージ（devcontainers/javascript-node 等）では node の COPY を
  省略可能ですが、検証済みバージョンに固定する意味でも COPY 推奨。
- ENTRYPOINT を設定しないので、組み込み先では `zcode` は普通のコマンドとして
  呼び出せます（devcontainer 内・`docker exec`・CI など）。
- devcontainer.json での利用例:

```json
{
  "name": "zcode",
  "build": { "dockerfile": "Containerfile.devcontainer" },
  "remoteUser": "vscode"
}
```

## 更新の仕組み（自動検知・人間ゲート）

週次（月曜 03:17 UTC）に `upstream-update-check` が3種類の更新を検知し、
それぞれ**独立した PR** を1本ずつ作ります。自動マージは行いません。

| 検知対象 | 内容 | ゲート |
| --- | --- | --- |
| upstream zcodeタグ | `zai-org/ZCode` の最新 stable タグ | コミット作成から **7日以上**経過したもののみ（冷却期間） |
| Node ベースイメージ | `24.14.x-bookworm-slim` の新パッチ | タグ+digest をセットで bump PR |
| ベースイメージ digest | 同一タグの manifest 再構築 | digest bump PR |

PR には対象バージョン・コミット・経過日数・upstream差分リンクが含まれ、
**PR 自体が通知**です（GitHub の通知/メールに加え、リポジトリに webhook を
設定すれば `pull_request.opened` を任意のチャネルへ中継できます）。
人間が差分を確認してマージ → `main` への push が `build-and-publish` を起動し、
そこで再度ピン検証 → ビルド → 機能テスト → 署名 → タグ付けが行われます。

> 脅威モデルの整理: 「人間がマージする」フローは自動更新より手間が1クリック増えますが、
> 「検知されたものを無条件に配送する」方式は、サプライチェーン防御として自己矛盾します
> （upstream の汚染をそのまま自動配送してしまう）。マージ操作こそが、
> 自動化では代替できない審査ポイントです。

## 設計の要点（なぜこうしたか）

### フォークしない（upstream 直接 checkout）

調達方式として npm パッケージ・CDN・フォークを比較した結果、**フォークしない**
（ビルド時に upstream をピン固定で直接 checkout）を選びました。

- 公式 npm パッケージは存在しない（`@zhipu/zcode` 等は 404。npm の `zcode-cli`/
  `zcode` は無関係な第三者、`zcode-app-cli` は非公式ラッパーで依存すると
  供給網リスクになるため不採用）
- 公式 CLI tarball の公開 CDN URL は未確認（デスクトップ版の artifacts のみ確認済み）
- フォークは「乖離管理コスト + 自動同期による汚染伝播経路 + 二重管理」を
  増やすだけで、本目的では利益がない。パッチが必要になったとしても、
  ビルド時に pinned タグへ `.patch` を適用する方式のほうが乖離が見える化される
- CI は `zai-org/ZCode` を **タグ + コミットSHA 二重固定**で取得し、
  ランナー側（verify-pin.mjs）とコンテナ内（git rev-parse）の**二か所で独立検証**。
  タグの移動・再付け替えはビルド失敗として検出される

### 依存解決の防御層

1. **pinned コミット**のコード（タグは可変、コミットは不変）
2. **upstream の pnpm-lock.yaml を frozen install**（解決を行わない = バージョン
   固定 + lockfile の整合性ハッシュで tarball を検証）
3. **npm.flatt.tech**（Flatt Security のフィルタリング proxy）を既定レジストリに。
   既知の悪意あるパッケージ版をメタデータレベルで遮断し、tarball は npmjs へ
   302 リダイレクト（integrity 値は npmjs と完全一致であることを実測検証済み）。
   lockfile 整合が主防御、proxy は縦深防御という位置づけ。障害時は
   `zcode-version.env` の `NPM_REGISTRY` を `https://registry.npmjs.org/` に
   変更するだけで切替可能
4. **pnpm `minimumReleaseAge`（10080分 = 7日）**: frozen lockfile 下では通常
   発動しないが、何らかの理由で再解決が起きた場合の縦深防御
5. **ビルドスクリプト許可リスト**: pnpm 10 のデフォルト（依存の postinstall を
   基本ブロック、upstream の `allowBuilds` 許可リストのみ実行）をそのまま利用

### 成果物の検証可能性

- ベースイメージ `node:24.14.1-bookworm-slim` は**マルチアーキ index digest**で固定
- pnpm は npmjs から**正確なバージョン + integrity カナリア**で導入
- イメージは **SBOM + provenance attestation** 付きで push され、
  **cosign keyless 署名**（OIDC、GitHub Actions の署名アイデンティティ）が付く
- 機能テスト（smoke-test.sh）は**公開済みの同一 digest** に対して実行され、
  合格後にのみリリースタグが付く（テスト対象 = 署名対象 = タグ対象）

## 無料枠の内訳（public リポジトリ前提）

| 項目 | 消費 | 無料枠 |
| --- | --- | --- |
| Actions 実行 | ビルド ~15-25分/回 + 週次検知 ~1分 | public リポジトリの標準ランナーは無料 |
| Actions キャッシュ | Containerfile レイヤー | 10GB（自動的に古いものから削除） |
| GHCR ストレージ | public パッケージ | 無料（帯域含む） |
| cosign / Sigstore | keyless 署名 | 無料 |
| Dependabot | アクション更新 PR | 無料 |

private リポジトリにすると Actions 2000分/月・Packages 500MB の無料枠に収まる
必要があり、本構成のビルド時間では継続公開に支障が出る可能性があります。

## 初回 run のチェックリスト

初回の `build-and-publish` 成功後、以下を確認してください:

1. **cosign verify が通ること**（Job Summary のコマンドをそのまま実行）
2. **リリースタグが署名済み digest を指していること**
   （ワークフロー内で `imagetools inspect` による digest 一致アサーションを
   自動実行済みですが、初回のみ手動でも確認を推奨）
3. **GHCR パッケージを public 化**（上記手順3）
4. `docker run <image>@<digest> --version` が pull から動くこと
   （attestation manifest 入り index の digest 参照は docker 23+ で正常動作します）
5. `upstream-update-check` を `workflow_dispatch` で一度手動実行し、
   「検知結果が PR または no-op ログになること」を確認

## 既知の制約・注意

- **初回ビルドのメモリ**: `@zcode/web` の vite build はピークで 4GB 超を使用します
  （標準ランナー 16GB なら問題なし。この検証プロセスで確認済み）
- **cron の 60日無効化**: リポジトリの活動が60日途絶えるとスケジュール workflow は
  GitHub 側で無効化されます。更新PRのマージ等の push があれば継続します
- **`ci-<sha>` タグの蓄積**: ビルド用の一時タグが GHCR に残ります（問題ありませんが、
  気になる場合は Packages 画面から削除してください）
- **flatt.tech 障害時**: `NPM_REGISTRY` を npmjs に変更してビルドしてください
- **Node のメジャー/マイナー更新**: 検知は `24.14.x` パッチのみ追従します。
  ライン自体の更新（例: 24.15.x / 25.x）は意図的な手動判断が必要です
  （`scripts/check-upstream-update.mjs` の `NODE_TRACKING_PREFIX` と pin を変更）
- zcode 本体の telemetry / 自動更新挙動は upstream のドキュメント・ソースで
  確認のうえ、必要に応じて Containerfile に ENV を追加してください
