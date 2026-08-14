/**
 * 桌面端图标生成脚本
 * ------------------------------------------------------------------
 * 作用：把官方 DeepSeek Harness 的鲸鱼图标（SVG）渲染为 Electron 打包所需的
 *       位图格式：
 *         1. build/icon.svg   —— 官方 SVG 源（复制自参考仓库 website/public/favicon.svg）
 *         2. build/icon.png   —— 512×512 PNG（开发模式窗口图标 / 备用）
 *         3. build/icon.ico   —— 多尺寸 ICO（Windows 打包，electron-builder win.icon）
 *
 * 说明：
 * - Harness 官方 favicon 是「黑色鲸鱼」（fill="#000"，深色模式自适应变白），
 *   桌面图标取浅色主题的黑色版本，与产品主色一致。
 * - ICO 采用 PNG 压缩条目（16/24/32/48/64/128/256），Windows Vista 及以上均支持，
 *   相比传统 BMP 条目体积更小、256px 高清尺寸不丢失。
 * - 仅依赖项目内已安装的 sharp（无需新增依赖）。
 *
 * 用法：node scripts/generate-icon.cjs
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// 官方鲸鱼图标 SVG 源：参考仓库 apps/web/public/favicon.svg
// 注意：DeepSeek 有两条产品线，图标颜色不同——
//   - DeepSeek 官网（website/）与模型 App 是品牌蓝鲸鱼（fill="#4D6BFE"）
//   - DeepSeek Harness（apps/web/，即本桌面端承载的产品）是黑色鲸鱼（fill="#000"，
//     深色模式下才通过 prefers-color-scheme 自适应变白）
// 桌面端图标必须取 Harness 的黑色版本，与产品主视觉一致。
const SOURCE_SVG = path.resolve(__dirname, '../../参考项目/deepseek-harness/apps/web/public/favicon.svg');
// 输出目录：electron-builder 默认扫描的 build/ 目录
const OUT_DIR = path.resolve(__dirname, '../build');

// ICO 中包含的尺寸列表（Windows 快捷方式/任务栏常用档位）
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * 把 PNG buffer 组装进 ICO 容器（PNG 格式条目，Vista+ 支持）。
 * ICO 结构：6 字节头 + N×16 字节目录项 + 各图像数据。
 *
 * @param {Buffer[]} pngBuffers 与 sizes 一一对应的 PNG 数据
 * @param {number[]} sizes      对应尺寸列表
 * @returns {Buffer} 完整 ICO 文件
 */
function buildIco(pngBuffers, sizes) {
  const count = pngBuffers.length;

  // ICO 头部：reserved(2B,=0) + type(2B,=1 图标) + imageCount(2B)
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = 1 (icon)
  header.writeUInt16LE(count, 4);

  // 目录项：每项 16 字节
  const dirSize = 16 * count;
  const dir = Buffer.alloc(dirSize);

  // 数据区从「头 + 目录」之后开始
  let offset = 6 + dirSize;
  const dataBuffers = [];

  for (let i = 0; i < count; i++) {
    const size = sizes[i];
    const png = pngBuffers[i];
    const entry = dir.subarray(i * 16, i * 16 + 16);

    // 宽/高：0 表示 256（Vista+ 约定），其余为实际像素
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // 调色板数（PNG 条目无调色板）
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8); // 图像数据字节数
    entry.writeUInt32LE(offset, 12); // 数据偏移

    offset += png.length;
    dataBuffers.push(png);
  }

  return Buffer.concat([header, dir, ...dataBuffers]);
}

async function main() {
  // 1. 校验官方 SVG 源存在
  if (!fs.existsSync(SOURCE_SVG)) {
    console.error(`[generate-icon] 官方 SVG 源不存在: ${SOURCE_SVG}`);
    process.exit(1);
  }

  // 2. 确保输出目录存在
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 3. 复制官方 SVG 到 build/（保留源，便于后续调整）
  fs.copyFileSync(SOURCE_SVG, path.join(OUT_DIR, 'icon.svg'));
  console.log('[generate-icon] 已复制官方 SVG -> build/icon.svg');

  // 4. 渲染各尺寸 PNG（官方 viewBox 0 0 50 50，等比放大到目标尺寸）
  const pngBuffers = [];
  for (const size of ICO_SIZES) {
    const buf = await sharp(SOURCE_SVG, { density: 300 })
      .resize(size, size)
      .png()
      .toBuffer();
    pngBuffers.push(buf);
  }

  // 5. 输出 512×512 主 PNG（开发模式窗口图标）
  const png512 = await sharp(SOURCE_SVG, { density: 600 })
    .resize(512, 512)
    .png()
    .toBuffer();
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png512);
  console.log('[generate-icon] 已生成 build/icon.png (512×512)');

  // 6. 组装多尺寸 ICO
  const ico = buildIco(pngBuffers, ICO_SIZES);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
  console.log(`[generate-icon] 已生成 build/icon.ico (尺寸: ${ICO_SIZES.join('/')})`);
  console.log('[generate-icon] 完成');
}

main().catch((err) => {
  console.error('[generate-icon] 失败:', err);
  process.exit(1);
});
