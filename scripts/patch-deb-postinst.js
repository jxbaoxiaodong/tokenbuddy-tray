'use strict';

// 把 scripts/deb-sandbox-postinst.sh 的内容追加到 electron-builder 生成的 deb postinst 末尾。
//
// 不能用 build.deb.afterInstall:fpm 的 after-install 就是 postinst,配置它会
// 整体覆盖 electron-builder 自己生成的 postinst(丢掉 update-alternatives 注册),
// 因此改为在打包完成后修改产物里的 postinst。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BLOCK_FILE = path.join(__dirname, 'deb-sandbox-postinst.sh');
const MARKER = '# tokenbuddy: 恢复 SUID chrome-sandbox';

const CONTROL_TAR_COMPRESSION = [
  { suffix: '.gz', flag: '-z' },
  { suffix: '.xz', flag: '-J' },
  { suffix: '.zst', flag: '--zstd' }
];

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' });
}

function patchControlMember(debPath, workDir) {
  const members = fs.readdirSync(workDir);
  const controlMember = members.find((name) => name.startsWith('control.tar'));
  if (!controlMember) {
    throw new Error(`${debPath}: 找不到 control.tar 成员,实际成员: ${members.join(', ')}`);
  }

  const compression = CONTROL_TAR_COMPRESSION.find((item) =>
    controlMember.endsWith(item.suffix)
  );
  if (!compression) {
    throw new Error(`${debPath}: 不支持的 control.tar 压缩格式 ${controlMember}`);
  }

  const controlDir = path.join(workDir, 'control');
  fs.mkdirSync(controlDir);
  run('tar', [`${compression.flag}xf`, controlMember, '-C', controlDir], workDir);

  const postinstPath = path.join(controlDir, 'postinst');
  if (!fs.existsSync(postinstPath)) {
    throw new Error(`${debPath}: control.tar 里没有 postinst`);
  }

  const original = fs.readFileSync(postinstPath, 'utf8');
  if (original.includes(MARKER)) return false;

  const block = fs.readFileSync(BLOCK_FILE, 'utf8');
  const patched = `${original.replace(/\s*$/, '')}\n\n${block}`;
  fs.writeFileSync(postinstPath, patched);
  fs.chmodSync(postinstPath, 0o755);

  run('tar', [`${compression.flag}cf`, controlMember, '-C', controlDir, '.'], workDir);
  return true;
}

module.exports = async function afterAllArtifactBuild(context) {
  const block = fs.readFileSync(BLOCK_FILE, 'utf8');
  if (!block.includes(MARKER)) {
    throw new Error(`${BLOCK_FILE} 缺少标记 ${MARKER}`);
  }

  for (const artifactPath of context.artifactPaths || []) {
    if (!artifactPath.endsWith('.deb')) continue;

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenbuddy-deb-'));
    try {
      run('ar', ['x', artifactPath], workDir);
      const changed = patchControlMember(artifactPath, workDir);
      if (changed) {
        const controlMember = fs
          .readdirSync(workDir)
          .find((name) => name.startsWith('control.tar'));
        run('ar', ['r', artifactPath, controlMember], workDir);
        console.log(`  • afterAllArtifactBuild 已向 ${path.basename(artifactPath)} 的 postinst 追加 SUID 沙箱修复`);
      } else {
        console.log(`  • afterAllArtifactBuild ${path.basename(artifactPath)} 的 postinst 已含修复,跳过`);
      }
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
};