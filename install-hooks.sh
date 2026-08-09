#!/bin/bash
# コミット前に自動でシークレットスキャンを行うフックを設置します。
# 使い方: リポジトリのルートで ./install-hooks.sh を実行

set -e

HOOK_DIR="$(git rev-parse --git-dir)/hooks"
HOOK_FILE="$HOOK_DIR/pre-commit"

mkdir -p "$HOOK_DIR"

cat > "$HOOK_FILE" << 'EOF'
#!/bin/bash
# gitleaksが入っていればコミット前にスキャンする
if command -v gitleaks &> /dev/null; then
    echo "🔍 gitleaksでシークレットをスキャン中..."
    gitleaks protect --staged --verbose --config .gitleaks.toml
    if [ $? -ne 0 ]; then
        echo "❌ シークレットの疑いがある変更が検出されました。コミットを中止します。"
        echo "   誤検知の場合は .gitleaks.toml の allowlist に追加してください。"
        exit 1
    fi
else
    echo "⚠️  gitleaksが未インストールです。シークレットスキャンをスキップします。"
    echo "   インストール推奨: https://github.com/gitleaks/gitleaks#installing"
fi
EOF

chmod +x "$HOOK_FILE"
echo "✅ pre-commitフックを設置しました: $HOOK_FILE"
echo "   gitleaks未インストールの場合は下記を参照してインストールしてください:"
echo "   https://github.com/gitleaks/gitleaks#installing"
