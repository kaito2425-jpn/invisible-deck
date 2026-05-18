# Invisible Deck App

スマートフォン向け Invisible Deck（古典マジック）アプリ。バニラJS（HTML/CSS/JS）の3ファイル構成。

## 構成

```
/
├── index.html
├── style.css
├── app.js
├── assets/
│   └── cards/        # Phase 2 で 52枚 + back を配置
└── README.md
```

## 開発フェーズ

- **Phase 1（現在）**: State機械の骨格、13ホットスポット、観客モード。カードはCSS仮描画。裏返しは画面下の `FLIP (tap)` ボタンまたはカード長押し（700ms）で代替。
- **Phase 2**: 52枚の SVG カード組み込み、スライド/めくれアニメ、履歴回避ランダム。
- **Phase 3**: DeviceOrientation API（β角で裏返し検知）、iOS Safari 許可ダイアログ、30秒自動リセット、デバッグモード仕上げ。

## デバッグモード

URL に `?debug=1` を付与すると有効化:

- 13ホットスポットの半透明オーバーレイ（番号付き）
- 現在の State / encodedCard / インデックス表示
- スワイプ方向ログ（コンソール + HUD）
- `FLIP (tap)` ボタン表示

## Phase 1 動作確認手順

1. `?debug=1` で起動 → `INITIAL_SHUFFLE`、ランダムカード1枚
2. 左→右スワイプ：別のランダムカードに切り替わる
3. `FLIP` ボタン or カード長押し：`BACK_SHUFFLE`（裏面表示）
4. もう一度 `FLIP`：`READY_TO_ENCODE`、ランダムな10カード表示
5. 13ホットスポット領域を押して方向スワイプ：`ENCODED`（見た目変化なし）、HUDに `encoded` が出る
6. ホットスポット外で左→右スワイプ：`AUDIENCE_SWIPING`、カードが流れる
7. 7〜13枚目のどこかで裏向きカードが出現
8. 裏向きカードをタップ：めくれ演出 → 仕込んだカードが表示 → `FINISHED`

## デプロイ

GitHub → Vercel 連携で自動デプロイ。

```sh
cd /Volumes/SSD-PUTA/invisible-deck
git add .
git commit -m "更新"
git push
```
