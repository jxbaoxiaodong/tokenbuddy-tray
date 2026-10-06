# tokenbuddy: 恢复 SUID chrome-sandbox  ← 由 scripts/patch-deb-postinst.js 追加到 electron-builder 生成的 postinst 末尾
#
# 为什么需要:electron-builder 生成的 postinst 里有这段判断——
#     if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
#         chmod 4755 '/opt/TokenBuddy/chrome-sandbox'   # 无 user namespace 才给 SUID
#     else
#         chmod 0755 '/opt/TokenBuddy/chrome-sandbox'   # 有 user namespace 就去掉 SUID
#     fi
# 该判断以 root 运行 unshare,在这台机器上会成功,于是装成 0755。
# 但 Ubuntu 24.04 的 AppArmor(kernel.apparmor_restrict_unprivileged_userns=1)
# 会让 userns 内的进程拿不到 CAP_SYS_ADMIN:
#     apparmor="DENIED" operation="capable" profile="unprivileged_userns"
#     capability=21 capname="sys_admin"
# Chromium 的 userns 沙箱因此不可用,只能回退到 SUID 沙箱;而 chrome-sandbox
# 文件存在却不是 setuid 时,Chromium 会直接 FATAL 退出:
#     The SUID sandbox helper binary was found, but is not configured correctly.
# 这里在 postinst 末尾把 setuid 位补回来,让 SUID 沙箱可用。
SANDBOX_PATH='/opt/TokenBuddy/chrome-sandbox'
if [ -f "$SANDBOX_PATH" ]; then
    if chmod 4755 "$SANDBOX_PATH" && [ "$(stat -c '%a' "$SANDBOX_PATH")" = "4755" ]; then
        echo "tokenbuddy: 已恢复 SUID 沙箱 $SANDBOX_PATH (mode 4755)"
    else
        echo "tokenbuddy: 警告 $SANDBOX_PATH 未能设为 4755 (当前 $(stat -c '%a' "$SANDBOX_PATH"))" >&2
    fi
else
    echo "tokenbuddy: 找不到 $SANDBOX_PATH,跳过 SUID 沙箱设置" >&2
fi