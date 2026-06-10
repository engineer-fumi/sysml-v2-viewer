# SysML v2 Viewer

ブラウザで動作する SysML v2 のビューワー / オーサリングツールです。
[SysIDE](https://sensmetry.com/syside/) を参考に、`.sysml` ファイル(SysML v2 テキスト記法)の
**Authoring(編集)** と **Visualization(可視化)** をひとつの画面で行えます。

![screenshot](docs/screenshot.png)

## 機能

### マルチファイル・ワークスペース
- 複数の `.sysml` / `.kerml` ファイルをタブで切り替えて編集
- 「ファイルを開く…」(複数選択可)/「フォルダを開く…」(再帰的に `.sysml` を収集)
- ファイル / フォルダのドラッグ&ドロップ読み込み(サブフォルダも走査)
- 全ファイルをひとつのモデルに結合して表示 — `import` などの
  **ファイル横断参照がツリー / ダイアグラムで解決**される
- ツリーや図で他ファイルの要素をクリックすると自動でそのファイルのタブに切替してジャンプ
- アンドゥ履歴・カーソル位置はファイルごとに保持
- 問題パネルは全ファイルのエラーをファイル名付きで一覧表示

### 上書き保存(File System Access API)
- Chrome / Edge では「ファイルを開く…」「フォルダを開く…」「フォルダの D&D」で
  開いたファイルに **その場で上書き保存** できます(`Ctrl+S` / 保存ボタン)
- `Ctrl+Shift+S` / 「全て保存」で未保存の全ファイルを一括保存
- 未保存の変更はタブに ● で表示。未対応ブラウザでは従来どおりダウンロード保存

### リモート接続(SSH / SFTP)
- 同梱サーバー経由でリモートホスト上の `.sysml` プロジェクトを直接開けます
- ツールバーの「リモート (SSH)…」からホスト / ユーザー / パスワードまたは秘密鍵 /
  リモートパスを指定 → パス以下を再帰走査して一括読み込み
- 編集後は `Ctrl+S` でリモートファイルへ直接上書き保存
- 認証情報はサーバーが SSH 接続を開くためにのみ使用し、保存しません
  (セッションは 30 分無操作で自動切断)

```bash
# SSH を使う場合は同梱サーバーを起動しておく
npm run server          # http://localhost:3001 (API + ビルド済みアプリ配信)

# 開発時は 2 プロセス併用 (vite が /api を 3001 へプロキシ)
npm run server & npm run dev

# 本番相当: ビルドしてサーバーのみで配信
npm run start
```

### Authoring(テキスト編集)
- CodeMirror 6 ベースのエディタ
- SysML v2 キーワードのシンタックスハイライト
- キーワード / スニペット / モデル内要素名(全ファイル横断)の自動補完
- リアルタイム構文チェック(エラーはエディタ内の波線・ガター・問題パネルに表示)
- アクティブなファイルを `.sysml` として保存

### Visualization(可視化)
- **モデルツリー** — パッケージ / 定義 / 使用の階層をアウトライン表示
- **ダイアグラム** — SVG によるインターコネクション図
  - part / package などのネストされたボックス表示(属性コンパートメント付き)
  - port をボックス境界上に表示
  - `connect` / `connection` / `flow` / `bind` / `allocate` を接続線として描画
  - `state` + `transition` を状態遷移図として描画(トリガ / ガード付き)
  - `action` + `first ... then ...`(succession)をアクションフローとして描画
  - パン / ズーム / 全体フィット、SVG エクスポート
- **双方向同期** — ツリーや図の要素をクリックするとエディタの該当箇所へジャンプ。
  エディタのカーソル移動でツリー / 図側の要素がハイライト
- 図のルート要素(パッケージ・part など)を切り替えて部分図を表示可能

### 対応している SysML v2 テキスト記法(サブセット)
`package` / `part def` / `part` / `attribute` / `port` / `item` / `action` /
`state` / `transition` / `requirement` / `constraint` / `interface` /
`connection` / `connect` / `bind` / `flow` / `import` / `alias` / `doc` /
`enum` / `use case` / `perform` / `exhibit` / `satisfy` /
特化 (`:>`, `specializes`, `subsets`) / 再定義 (`:>>`, `redefines`) /
多重度 (`[n..m]`) / 値 (`= expr`) / 方向 (`in` / `out` / `inout`) など。

未対応の構文はエラー回復しながら読み飛ばすため、部分的なモデルでも表示できます。

## 使い方

```bash
npm install
npm run dev      # 開発サーバー (http://localhost:5173)
npm run build    # プロダクションビルド (dist/)
npm run preview  # ビルド結果のプレビュー
```

起動するとサンプル(車両アーキテクチャ)が表示されます。
ツールバーの「サンプルを読み込む…」から状態機械 / アクションフローの例も試せます。

## 構成

```
server/
└── index.mjs         # 同梱サーバー (SSH/SFTP API + 静的配信)
src/
├── sysml/            # SysML v2 テキスト記法の処理系
│   ├── lexer.ts      #   トークナイザ
│   ├── parser.ts     #   再帰下降パーサ(エラー回復付き)
│   └── ast.ts        #   簡易 AST 定義
├── editor/
│   └── sysmlLanguage.ts  # CodeMirror 言語サポート(ハイライト・補完)
├── diagram/
│   └── layout.ts     # ネストボックスレイアウト + 接続エッジ解決
├── components/
│   ├── EditorPane.tsx    # エディタ
│   ├── OutlineTree.tsx   # モデルツリー
│   └── DiagramView.tsx   # SVG ダイアグラム(パン/ズーム)
├── samples.ts        # サンプルモデル
└── App.tsx           # 全体レイアウトと状態管理
```

## 制限事項

- パーサは SysML v2 仕様の実用的なサブセットです。式(constraint / calc の本体)は
  不透明テキストとして扱い、意味解析(型チェック・名前解決の検証)は行いません。
- 標準ライブラリ(`ScalarValues` など)の import は記法として受理しますが、
  ライブラリ本体は同梱していません。
