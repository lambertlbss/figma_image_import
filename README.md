# Figma Image Folder Importer

把本地 PNG 资源目录导入 Figma，并在后续选择同一资源目录时执行增量同步。

## 功能

- 只根据资源根目录下的第一级文件夹创建和识别 Section；更深层目录仍保留在资源相对路径中，不会额外创建 Section。
- 图片以原始尺寸创建为 Component，名称为不含扩展名的文件名。
- 同一 Section 内、相同尺寸的 Component 自动归入以 `宽x高` 命名的 Component Set。
- 使用 SHA-256 对比资源，区分新增、更新、删除、移动和未变化内容。
- 重复同步先用文件大小、修改时间和图片尺寸快速比对，只为疑似变化的文件重新计算 SHA-256；升级后的首次扫描会建立这份快速索引。
- 同步时并发读取文件，并按图片平均大小自适应组成批次：小图片最多 48 个、中等图片最多 32 个、大图片最多 16 个，同时严格限制单批不超过 12MB。
- 新增和结构变化期间只收集待排版节点，结束时每个 Component Set 和 Section 统一排版一次；同尺寸的纯图片更新不会触发布局变化。
- 同一 Section、同一尺寸只有 1 个资源时保留普通 Component；达到 2 个时自动组成 Component Set，删除到只剩 1 个时自动拆回普通 Component，并保留 Component ID。
- “快速检查”产生的 Figma 页面索引会直接复用于差异分析，避免连续扫描同一批 Section 和 Component。
- 同一次同步内，SHA-256 完全相同的图片复用同一个 Figma Image，并在完成提示中展示读取、导入和排版耗时。
- 同尺寸替换只更新图片填充，保留 Component ID、位置和 Component Set。
- 新资源使用空闲位置，未变化的节点和 Section 不参与重排。
- 每个尺寸组始终保持为 Component Set，即使只剩一个资源，也保留 Figma 默认的组件集紫色边界。
- Variant 名称统一为合法的 `Property 1=资源名`；旧版非法名称会在下一次同步时自动修复。
- 删除本地资源前显示差异并要求确认。
- 首次升级可根据 Section、Component 名称和尺寸接管旧版本导入的内容。
- 当前页面只有一个同名顶层 Section 时会直接复用；其中未被插件识别的手工内容保持不动。

## 本地安装

1. 在 Figma 中打开 `Plugins → Development → Import plugin from manifest…`。
2. 选择本项目中的 `manifest.json`。
3. 运行插件并选择 PNG 资源根目录。
4. 查看差异列表，选择需要同步的文件夹后开始同步。

## 同步标识

插件通过 Figma `pluginData` 保存资源库 ID、相对路径、内容 Hash、尺寸和所属文件夹。同一个 Section 内以 Component 名称作为唯一资源身份；路径不同但名称相同的新资源会替换旧 Component，并保留节点 ID。

本地同一 Section 内存在多个同名文件时，只保留 `lastModified` 最新的文件。Figma 中已存在的同名 Component（包括旧版本留下的未标记节点）会在同步成功后归并为一个，即使关闭“同步本地删除操作”也会清理同名副本；其他未匹配的手工内容不受影响。文件内容和路径均未变化时，插件不会写入或移动对应节点；唯一 Hash 能匹配的新旧名称仍会被识别为重命名或文件夹移动。

## 验证

```bash
npm test
npm run check
```

测试覆盖重复同步幂等、快速索引、同尺寸替换、Component Set 内增删、尺寸变化、新文件夹、重命名、删除取消、旧资源接管、大规模资源库、特殊文件夹名和无效图片。
