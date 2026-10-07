#!/usr/bin/env bash
# ============================================================
#  setup-branch-protection.sh — 一次性配置 master 分支保护
# ------------------------------------------------------------
#  配置内容：
#    · 必须通过 CI 状态检查（test / node 20 / 22 / 24）
#    · 合并必须走 Pull Request（可设最少批准人数）
#    · 禁止强推（force push）、禁止删除分支
#    · enforce_admins 决定「管理员是否也受约束」（见下方说明）
#
#  用法：
#    GITHUB_TOKEN=ghp_xxx bash scripts/setup-branch-protection.sh
#
#  可选环境变量：
#    REPO=bg1avd/claude-code-node   BRANCH=master
#    APPROVALS=1                    # PR 最少批准数（0~6）
#    ENFORCE_ADMINS=false           # true = 管理员也被规则约束
#
#  ⚠️ enforce_admins 的取舍（实测结论）：
#    false → 规则约束协作者，**管理员（你/你的 SSH key）仍可直推与发版**
#            → 单人项目推荐（否则自己无法批准自己的 PR，会被卡死）
#    true  → 连管理员也必须走 PR；但 GitHub **不允许自批**，
#            单人项目需要第二个账号来批准，否则永久 pending
#
#  token 权限：classic PAT 需 `repo`；fine-grained 需
#              Repository permissions → Administration: Read and write
# ============================================================
set -euo pipefail

: "${GITHUB_TOKEN:?请先设置 GITHUB_TOKEN（见脚本头部说明）}"
REPO="${REPO:-bg1avd/claude-code-node}"
BRANCH="${BRANCH:-master}"
APPROVALS="${APPROVALS:-1}"
ENFORCE_ADMINS="${ENFORCE_ADMINS:-false}"

API="https://api.github.com/repos/$REPO"
AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN"
      -H "Accept: application/vnd.github+json"
      -H "X-GitHub-Api-Version: 2022-11-28")

echo "▶ 目标：$REPO  分支：$BRANCH  批准数：$APPROVALS  enforce_admins：$ENFORCE_ADMINS"

# required checks 必须是该分支上**真实出现过**的 check 名，否则 PR 会永远停在
# "Expected — waiting for status"。这些名字来自 .github/workflows/ci.yml 的 job name。
CONTEXTS='["test / node 20","test / node 22","test / node 24"]'

BODY=$(cat <<EOF
{
  "required_status_checks": { "strict": false, "contexts": $CONTEXTS },
  "enforce_admins": $ENFORCE_ADMINS,
  "required_pull_request_reviews": {
    "required_approving_review_count": $APPROVALS,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": false
}
EOF
)

echo "▶ 写入保护规则..."
code=$(curl -sS -o /tmp/cc-protection-resp.json -w '%{http_code}' -X PUT \
  "${AUTH[@]}" "$API/branches/$BRANCH/protection" -d "$BODY")

if [ "$code" != "200" ]; then
  echo "✖ 失败（HTTP $code）："
  cat /tmp/cc-protection-resp.json
  exit 1
fi
echo "✅ 保护规则已生效"

echo "▶ 独立验证..."
echo -n "  branch protected : "
curl -sS "${AUTH[@]}" "$API/branches/$BRANCH" | grep -q '"protected":[[:space:]]*true' && echo "true ✅" || echo "false ❌"
echo -n "  required checks  : "
curl -sS "${AUTH[@]}" "$API/branches/$BRANCH/protection" \
  | tr -d ' \n' | grep -o '"contexts":\[[^]]*\]' || echo "(读取失败)"
echo -n "  force push 允许  : "
curl -sS "${AUTH[@]}" "$API/branches/$BRANCH/protection" \
  | tr -d ' \n' | grep -o '"allow_force_pushes":{"enabled":[a-z]*}' || true
echo
echo "完成。查看：https://github.com/$REPO/settings/branches"
