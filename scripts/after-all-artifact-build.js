'use strict';

// electron-builder 的 afterAllArtifactBuild 只接受一个模块,这里把两个打包后处理串起来:
//   1. patch-deb-postinst   —— 给 deb 的 postinst 追加 SUID 沙箱修复
//   2. patch-appimage-apprun —— 给 AppImage 的 AppRun 追加 --no-sandbox --disable-gpu
module.exports = async function afterAllArtifactBuild(context) {
  await require('./patch-deb-postinst')(context);
  await require('./patch-appimage-apprun')(context);
};
