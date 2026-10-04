# RhineLabUI 上游说明
#
# 本面板的前端直接构建自上游 RhineLabUI（MIT，Copyright (c) 2026 LBEILC）：
# https://github.com/LBEILC/RhineLabUI
#
# - 构建输入：上游指定 commit 的完整检出 + 本目录 overlay/ 的覆盖层
#   （`traffic.ts` 流量控制台、`traffic.css` 对应样式）。
# - 覆盖层只做加法：向 `.system-nav` 加一个 TRAFFIC 按钮、打开独立的
#   `#traffic-root` 弹窗读 Go 后端 `/api/*`；不动上游场景、档案、动效逻辑。
# - 构建产物（`../web/rhine/`）随本仓库提交，内含上游 GLB 模型、MiSans 字体
#   切片、原创配乐，均遵循上游各自许可（源码 MIT；字体见
#   `web/rhine/fonts/MiSans-license.pdf`；rolling-number 见
#   `web/rhine/licenses/rolling-number.txt`）。《明日方舟》相关名称与设定
#   的权利归原权利人所有。
#
# 上游 commit（构建 build.sh 时 pin 住，升级需重新验证）：
UPSTREAM_COMMIT=129553bce3496f3826ef343b539ca46d25b94852
