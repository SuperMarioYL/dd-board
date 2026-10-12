# DD-Board 演示 — init → propose → probe → 治疗授权门拒绝 → render（约 30s）
#
# 录制产物：assets/demo.cast（asciinema 格式，plan 指定的 demo 载体）。
# 录制环境：vhs（charmbracelet/vhs）+ 网络（npm registry 与 GitHub）。
# 已知坑：vhs 0.12.x 配 ffmpeg 9 会在编码阶段报
#   `Invalid 0xRRGGBB[AA] color string: ''`（fillborders）→ render failed: exit status 234。
#   用 ffmpeg 7/8（brew install ffmpeg@7 并放早 PATH）即可正常出片。
# 若要 GIF 而非 .cast，把下面 Output 的扩展名换成 .gif。

Output assets/demo.cast
Set Width 1150
Set Height 700
Set FontSize 15
Set Theme {"name": "Dracula"}
Set TypingSpeed 10ms

Hide
Type "mkdir -p /tmp/ddboard-demo && cd /tmp/ddboard-demo && clear" Enter
Show

# ---- 1. init：生成会话模板与 MCP 配置片段 --------------------------------
Type "npx -y dd-board init" Enter
Sleep 2500ms

Type "cat .ddboard/session.json" Enter
Sleep 1500ms

# ---- 2-4. agent 侧协议流程（发生在 coding agent 会话内，无法在纯终端驱动）----
# 把 init 打印的 MCP 配置片段接入 host 后，agent 在本项目内依次执行：
#   propose_hypotheses   提交 top-N 根因假设并各绑一条区分性探针
#   record_probe_result  逐条落盘探针 verdict 与耗时证据
#   request_treatment    存在 untested 假设时被治疗授权门拒绝并返回缺口清单
# 完整工具调用 transcript 见 assets/demo-script.md。
# 以下用仓库自带的已完成示例会话（合成 bug）继续终端侧演示。

Type "git clone --depth 1 https://github.com/SuperMarioYL/dd-board.git" Enter
Sleep 3000ms

# ---- 5. validate + render：静态诊断板 ------------------------------------
Type "npx -y dd-board validate dd-board/examples/session.example.json" Enter
Sleep 1500ms

Type "npx -y dd-board render dd-board/examples/session.example.json" Enter
Sleep 1500ms

Type "sed -n '1,40p' board.md" Enter
Sleep 4000ms
