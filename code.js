// Figma 插件主逻辑 - 逐张处理，按 section 完成后 flush

figma.showUI(__html__, { width: 340, height: 400 });

const COMPONENT_GAP = 20;
const COLUMNS = 10;
const SECTION_GAP = 80;
const SECTION_PADDING = 100;
const SECTION_TITLE_H = 40;
const MAX_ROW_WIDTH = 10000; // 每行 section 累计宽度上限，超过换行

// section 节点和布局状态
const sectionState = {};  // { [name]: { node: SectionNode } }
const sectionLayout = {}; // { [name]: { items: [{node,w,h}] } }

// 待 flush 缓冲：{ [section]: { [sizeKey]: ComponentNode[] } }
let pendingBySection = {};

let totalImported = 0;

// 起始 X：从现有内容右边开始
let baseX = 0;
let nextSectionX = 0;
let positionsInitialized = false;

figma.ui.onmessage = async (msg) => {
  if (msg.type !== 'import-one') return;

  try {
    const { name, section, bytes, isLast, isSectionLast } = msg;

    // 首次使用时计算起始 X
    if (!positionsInitialized) {
      positionsInitialized = true;
      baseX = getRightBoundary();
      nextSectionX = baseX;
    }

    ensureSection(section);

    // 创建图片
    let figmaImage;
    try {
      figmaImage = figma.createImage(new Uint8Array(bytes));
    } catch (e) {
      console.error(`[skip] createImage failed for "${name}":`, e);
      figma.ui.postMessage({ type: 'batch-ack' });
      return;
    }

    let width, height;
    try {
      ({ width, height } = await figmaImage.getSizeAsync());
    } catch (e) {
      console.error(`[skip] getSizeAsync failed for "${name}":`, e);
      figma.ui.postMessage({ type: 'batch-ack' });
      return;
    }

    const component = figma.createComponent();
    component.name = name;
    component.resize(width, height);

    const rect = figma.createRectangle();
    rect.name = name;
    rect.resize(width, height);
    rect.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: figmaImage.hash }];
    component.appendChild(rect);

    // 离屏暂存
    component.x = -99999;
    component.y = -99999;
    figma.currentPage.appendChild(component);

    // 按 section + 尺寸分组
    if (!pendingBySection[section]) pendingBySection[section] = {};
    const sizeKey = `${width}x${height}`;
    if (!pendingBySection[section][sizeKey]) pendingBySection[section][sizeKey] = [];
    pendingBySection[section][sizeKey].push(component);

    totalImported++;

    // 当前 section 全部收完 → flush 该 section
    if (isSectionLast) {
      flushSection(section);
      delete pendingBySection[section];
      updateSectionPositions();
    }

    if (isLast) {
      // 保险：flush 剩余的（理论上不会有）
      for (const sName of Object.keys(pendingBySection)) {
        flushSection(sName);
      }
      pendingBySection = {};
      updateSectionPositions();

      figma.viewport.scrollAndZoomIntoView(getSectionNodes());
      figma.ui.postMessage({
        type: 'done',
        total: totalImported,
        sections: Object.keys(sectionState).length
      });
      figma.closePlugin(`导入完成：共 ${totalImported} 个 Component`);
    } else {
      figma.ui.postMessage({ type: 'batch-ack' });
    }
  } catch (e) {
    let msg;
    try { msg = JSON.stringify(e, Object.getOwnPropertyNames(e)); } catch (_) { msg = String(e); }
    console.error('[import-one crash]', msg, e);
    figma.ui.postMessage({ type: 'error', message: msg || String(e) });
  }
};

// 把一个 section 的 pending 组件合并/放入 section
function flushSection(sectionName) {
  const pending = pendingBySection[sectionName];
  if (!pending) return;

  const sectionNode = sectionState[sectionName].node;
  const layout = sectionLayout[sectionName];

  for (const [sizeKey, components] of Object.entries(pending)) {
    let slotNode;

    if (components.length === 1) {
      const comp = components[0];
      sectionNode.appendChild(comp);
      slotNode = comp;
    } else {
      // 合并为 ComponentSet，每个 component 仍是独立 variant
      const variantSet = figma.combineAsVariants(components, figma.currentPage);
      variantSet.name = sizeKey;

      // combineAsVariants 后 variant 全叠在 (0,0)，手动网格排列
      const vw = components[0].width;
      const vh = components[0].height;
      const VCOLS = Math.min(components.length, Math.ceil(Math.sqrt(components.length)));
      const VGAP = 20;
      const VPAD = 20;

      for (let i = 0; i < components.length; i++) {
        components[i].x = VPAD + (i % VCOLS) * (vw + VGAP);
        components[i].y = VPAD + Math.floor(i / VCOLS) * (vh + VGAP);
      }

      const rows = Math.ceil(components.length / VCOLS);
      variantSet.resizeWithoutConstraints(
        VPAD * 2 + VCOLS * vw + (VCOLS - 1) * VGAP,
        VPAD * 2 + rows * vh + (rows - 1) * VGAP
      );

      sectionNode.appendChild(variantSet);
      slotNode = variantSet;
    }

    layout.items.push({ node: slotNode, w: slotNode.width, h: slotNode.height });
  }

  relayoutSection(sectionName);
}

// 重排 section 内网格
function relayoutSection(sectionName) {
  const layout = sectionLayout[sectionName];
  const sectionNode = sectionState[sectionName].node;
  const items = layout.items;
  if (items.length === 0) return;

  const colWidths = new Array(COLUMNS).fill(0);
  const rowHeights = [];

  for (let i = 0; i < items.length; i++) {
    const colIdx = i % COLUMNS;
    const rowIdx = Math.floor(i / COLUMNS);
    if (items[i].w > colWidths[colIdx]) colWidths[colIdx] = items[i].w;
    if (!rowHeights[rowIdx] || items[i].h > rowHeights[rowIdx]) rowHeights[rowIdx] = items[i].h;
  }

  const colOffsets = computeColOffsets(colWidths);

  for (let i = 0; i < items.length; i++) {
    const colIdx = i % COLUMNS;
    const rowIdx = Math.floor(i / COLUMNS);
    items[i].node.x = SECTION_PADDING + colOffsets[colIdx];
    items[i].node.y = SECTION_PADDING + SECTION_TITLE_H +
      rowHeights.slice(0, rowIdx).reduce((s, h) => s + h + COMPONENT_GAP, 0);
  }

  let maxRight = 0, maxBottom = 0;
  for (const item of items) {
    if (item.node.x + item.node.width > maxRight) maxRight = item.node.x + item.node.width;
    if (item.node.y + item.node.height > maxBottom) maxBottom = item.node.y + item.node.height;
  }
  sectionNode.resizeWithoutConstraints(
    Math.max(maxRight + SECTION_PADDING, 300),
    Math.max(maxBottom + SECTION_PADDING, 300)
  );
}

function updateSectionPositions() {
  let x = baseX;
  let y = 0;
  let rowMaxHeight = 0;

  for (const name of Object.keys(sectionState)) {
    const node = sectionState[name].node;

    // 如果当前行已有内容且加上这个 section 会超宽，则换行
    if (x > baseX && (x - baseX) + node.width > MAX_ROW_WIDTH) {
      x = baseX;
      y += rowMaxHeight + SECTION_GAP;
      rowMaxHeight = 0;
    }

    node.x = x;
    node.y = y;
    x += node.width + SECTION_GAP;

    if (node.height > rowMaxHeight) rowMaxHeight = node.height;
  }
  nextSectionX = x;
}

function getRightBoundary() {
  const children = figma.currentPage.children;
  if (children.length === 0) return 0;
  let maxRight = 0;
  for (const node of children) {
    const right = node.x + node.width;
    if (right > maxRight) maxRight = right;
  }
  return maxRight > 0 ? maxRight + SECTION_GAP : 0;
}

function getSectionNodes() {
  return Object.values(sectionState).map(s => s.node);
}

function ensureSection(sectionName) {
  if (sectionState[sectionName]) return;
  const node = figma.createSection();
  node.name = sectionName;
  node.x = nextSectionX;
  node.y = 0;
  node.resizeWithoutConstraints(300, 300);
  figma.currentPage.appendChild(node);
  sectionState[sectionName] = { node };
  sectionLayout[sectionName] = { items: [] };
  nextSectionX += 300 + SECTION_GAP;
}

function computeColOffsets(colWidths) {
  const offsets = [0];
  for (let i = 0; i < COLUMNS - 1; i++) {
    offsets.push(offsets[i] + (colWidths[i] || 0) + COMPONENT_GAP);
  }
  return offsets;
}
