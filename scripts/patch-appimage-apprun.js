'use strict';

// 打包后改写 AppImage 内部的 AppRun,固定追加 --no-sandbox --disable-gpu。
//
// 为什么需要:AppImage 是只读 squashfs,无法给 chrome-sandbox 设 setuid;Ubuntu 24.04
// 又默认限制非特权 user namespace(AppArmor),于是 Chromium 只能回退到 SUID 沙箱,
// 而该 helper 没 setuid 时 Chromium 会直接 FATAL 退出:
//     FATAL:setuid_sandbox_host.cc(163) The SUID sandbox helper binary was found,
//     but is not configured correctly ... aborting now.
// 手动加 --no-sandbox 能解决,但部分桌面(GNOME)从应用网格启动时不会把 .desktop 的
// Exec 参数传进来,导致点图标毫无反应。把参数写进 AppRun 本体后,任何人以任何方式
// 启动该 AppImage 都能带上参数,不再依赖启动器是否传参。
//
// 与 scripts/patch-deb-postinst.js 一起由 scripts/after-all-artifact-build.js 调用。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const EXTRA_ARGS = ' --no-sandbox --disable-gpu';
const MARKER = 'tokenbuddy: 固定追加 --no-sandbox --disable-gpu';

function run(command, args, options) {
  return execFileSync(command, args, Object.assign({ encoding: 'utf8', maxBuffer: 1 << 28 }, options));
}

function patchAppRun(appRunPath) {
  if (!fs.existsSync(appRunPath)) {
    throw new Error(`AppImage 里没有 AppRun: ${appRunPath}`);
  }
  let source = fs.readFileSync(appRunPath, 'utf8');
  if (source.includes('--no-sandbox --disable-gpu')) return false;

  const before = source;
  source = source.replace('exec "$BIN"\n', 'exec "$BIN"' + EXTRA_ARGS + '\n');
  source = source.replace('exec "$BIN" "${args[@]}"', 'exec "$BIN"' + EXTRA_ARGS + ' "${args[@]}"');
  if (source === before || !source.includes(EXTRA_ARGS.trim())) {
    throw new Error('AppRun 结构与预期不符,无法追加启动参数(请检查 electron-builder 模板)');
  }

  fs.writeFileSync(appRunPath, `# ${MARKER}${source}`, { mode: 0o755 });
  return true;
}

module.exports = async function afterAllArtifactBuild(context) {
  for (const artifactPath of context.artifactPaths || []) {
    if (!artifactPath.endsWith('.AppImage')) continue;

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenbuddy-appimage-'));
    try {
      run(artifactPath, ['--appimage-extract'], { cwd: workDir });

      const appRunPath = path.join(workDir, 'squashfs-root', 'AppRun');
      if (!patchAppRun(appRunPath)) {
        console.log(`  • ${path.basename(artifactPath)} 的 AppRun 已含启动参数,跳过`);
        continue;
      }

      const offset = parseInt(run(artifactPath, ['--appimage-offset']).trim(), 10);
      if (!Number.isInteger(offset) || offset <= 0) {
        throw new Error(`${path.basename(artifactPath)}: 无法解析 --appimage-offset`);
      }
      const original = fs.readFileSync(artifactPath);
      const runtimePath = path.join(workDir, 'runtime');
      fs.writeFileSync(runtimePath, original.subarray(0, offset));

      const squashfsPath = path.join(workDir, 'new.squashfs');
      run('mksquashfs', [
        path.join(workDir, 'squashfs-root'), squashfsPath,
        '-comp', 'gzip', '-b', '131072', '-noappend', '-no-progress', '-no-xattrs',
      ], { cwd: workDir });

      const outputPath = path.join(workDir, 'patched.AppImage');
      fs.writeFileSync(outputPath, Buffer.concat([fs.readFileSync(runtimePath), fs.readFileSync(squashfsPath)]));
      fs.chmodSync(outputPath, 0o755);
      fs.copyFileSync(outputPath, artifactPath);

      console.log(`  • 已为 ${path.basename(artifactPath)} 的 AppRun 追加${EXTRA_ARGS}`);
    } catch (error) {
      throw new Error(`改写 ${path.basename(artifactPath)} 的 AppRun 失败: ${error.message}`);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
};
