// Figma Image Folder Importer
// Incremental synchronisation engine. Unchanged managed nodes are never rewritten or moved.

figma.showUI(__html__, { width: 380, height: 720 });

const META_KEY = 'imageFolderImporterMeta';
const META_VERSION = 1;
const SHARED_DATA_NAMESPACE = 'figma_image_importer';
const CLASSIFICATION_REQUEST_KEY = 'classification-request';
const CLASSIFICATION_PLAN_KEY = 'classification-plan';
const CLASSIFICATION_SCHEMA_VERSION = 1;
const CLASSIFICATION_CONFIDENCE_THRESHOLD = 0.7;
const SHARED_DATA_CHUNK_CHAR_LIMIT = 20000;

const SECTION_GAP = 80;
const SECTION_PADDING = 192;
const SECTION_CONTENT_TOP = 272;
const ITEM_GAP = 100;
const VARIANT_GAP = 20;
const VARIANT_PADDING = 20;
const VARIANT_COLUMNS = 6;
const DEFAULT_VARIANT_PROPERTY = 'Property 1';
const MAX_SECTION_ROW_WIDTH = 10000;
const COMPONENT_SET_STROKE_COLOR = {
  r: 138 / 255,
  g: 56 / 255,
  b: 245 / 255
};
const MAIN_THREAD_YIELD_ITEMS = 64;
const MAIN_THREAD_YIELD_MS = 16;

let activeSync = null;
let preparedScanCache = null;

figma.ui.onmessage = async (message) => {
  if (!message || !message.type) return;

  try {
    let data;
    switch (message.type) {
      case 'prepare-scan':
        data = prepareScan(message.payload || {});
        break;
      case 'prepare-sync':
        data = prepareSync(message.payload || {});
        break;
      case 'begin-sync':
        data = await beginSync(message.payload || {});
        break;
      case 'apply-file':
        data = await applyFile(message.payload || {});
        break;
      case 'apply-batch':
        data = await applyBatch(message.payload || {});
        break;
      case 'finish-sync':
        data = await finishSync();
        break;
      case 'set-classification-mode':
        data = setClassificationMode(message.payload || {});
        break;
      case 'publish-classification-request':
        data = publishClassificationRequest(message.payload || {});
        break;
      case 'load-classification-plan':
        data = loadClassificationPlan();
        break;
      default:
        throw new Error(`未知消息类型：${message.type}`);
    }
    reply(message.requestId, true, data);
  } catch (error) {
    console.error(`[${message.type}]`, error);
    reply(message.requestId, false, null, formatError(error));
  }
};

function reply(requestId, ok, data, error) {
  if (!requestId) return;
  figma.ui.postMessage({ replyTo: requestId, ok, data, error });
}

function emitSyncProgress(relativePath, stage, details) {
  figma.ui.postMessage({
    type: 'sync-progress',
    relativePath,
    stage,
    ...(details || {})
  });
}

function formatError(error) {
  if (!error) return '未知错误';
  if (error.message) return error.message;
  try {
    return JSON.stringify(error, Object.getOwnPropertyNames(error));
  } catch (_) {
    return String(error);
  }
}

function scanManifestKey(manifest) {
  return manifest.map((entry) => [
    entry.relativePath,
    entry.folderPath,
    entry.name,
    entry.width,
    entry.height,
    entry.sourceSize,
    entry.lastModified
  ].join('\u0001')).join('\u0002');
}

function prepareScan(payload) {
  const startedAt = Date.now();
  const rootName = String(payload.rootName || '').trim() || 'resources';
  const manifest = sanitizeManifest(payload.manifest || []);
  if (manifest.length === 0) throw new Error('没有可同步的 PNG 文件。');

  const localFolderPaths = new Set(manifest.map((entry) => entry.folderPath));
  const library = chooseLibrary(rootName, localFolderPaths);
  const libraryId = library ? library.libraryId : createLibraryId(rootName);
  const adoption = adoptLegacySections(manifest, libraryId, rootName);
  const index = scanLibrary(libraryId);
  const knownHashes = [];
  const hashPaths = [];

  for (const entry of manifest) {
    const component = index.components.get(entry.relativePath);
    const meta = component ? (readMeta(component) || {}) : {};
    const statMatches =
      meta.hash &&
      Number(meta.sourceSize) === entry.sourceSize &&
      Number(meta.lastModified) === entry.lastModified &&
      sameSize(meta.width || component.width, meta.height || component.height, entry.width, entry.height);

    if (statMatches) knownHashes.push([entry.relativePath, meta.hash]);
    else hashPaths.push(entry.relativePath);
  }

  preparedScanCache = {
    rootName,
    libraryId,
    manifestKey: scanManifestKey(manifest),
    adoption,
    index
  };

  return {
    rootName,
    libraryId,
    knownHashes,
    hashPaths,
    adopted: adoption.adopted,
    conflicts: adoption.conflicts,
    timingMs: Date.now() - startedAt
  };
}

function prepareSync(payload) {
  const startedAt = Date.now();
  const rootName = String(payload.rootName || '').trim() || 'resources';
  const baseManifest = sanitizeManifest(payload.manifest || []);
  if (baseManifest.length === 0) throw new Error('没有可同步的 PNG 文件。');
  const classificationMode = normalizeClassificationMode(payload.classificationMode);
  const classified = classifyManifest(baseManifest, classificationMode, payload.classificationPlan || null);
  const manifest = classified.manifest;

  const manifestKey = scanManifestKey(baseManifest);
  const canReusePreparedScan = preparedScanCache &&
    preparedScanCache.rootName === rootName &&
    preparedScanCache.manifestKey === manifestKey;
  let libraryId;
  let adoption;
  let index;

  if (canReusePreparedScan) {
    ({ libraryId, adoption, index } = preparedScanCache);
  } else {
    const localFolderPaths = new Set(baseManifest.map((entry) => entry.folderPath));
    const library = chooseLibrary(rootName, localFolderPaths);
    libraryId = library ? library.libraryId : createLibraryId(rootName);
    adoption = adoptLegacySections(baseManifest, libraryId, rootName);
    index = scanLibrary(libraryId);
  }
  preparedScanCache = null;
  const plan = buildSyncPlan(manifest, index, adoption.conflictPaths);

  activeSync = {
    rootName,
    libraryId,
    baseManifest,
    manifest,
    manifestByPath: new Map(manifest.map((entry) => [entry.relativePath, entry])),
    index,
    plan,
    legacyConflictPaths: new Set(adoption.conflictPaths || []),
    legacyConflicts: Array.isArray(adoption.conflicts) ? adoption.conflicts.slice() : [],
    classificationMode,
    classificationSummary: classified.summary,
    classificationRequestId: '',
    expectedComponentSetGroups: plan.expectedComponentSetGroups,
    selectedFolders: new Set(),
    deleteMissing: false,
    stats: emptyStats(),
    touchedNodes: new Set(),
    touchedSections: new Set(),
    touchedComponentSets: new Set(),
    newSections: new Set(),
    repairSections: new Set(),
    pendingDeletes: [],
    variantLayoutCache: new Map(),
    imageHashByContentHash: new Map(),
    performance: emptyPerformanceStats(),
    warnings: [],
    started: false
  };

  return serializeActiveSyncPlan({
    adopted: canReusePreparedScan ? 0 : adoption.adopted,
    scanIndexReused: Boolean(canReusePreparedScan),
    timingMs: Date.now() - startedAt
  });
}

function setClassificationMode(payload) {
  assertActiveSync();
  if (activeSync.started) throw new Error('同步已开始，不能再切换分类方式。');
  const mode = normalizeClassificationMode(payload.mode);
  return rebuildActiveSyncClassification(mode, null);
}

function publishClassificationRequest(payload) {
  assertActiveSync();
  if (activeSync.started) throw new Error('同步已开始，不能再生成 AI 请求。');
  const availableFolders = new Set(activeSync.baseManifest.map((entry) => entry.folderPath));
  const selectedFolders = new Set(
    (Array.isArray(payload.selectedFolders) ? payload.selectedFolders : [])
      .map(normalizeFolderPath)
      .filter((folderPath) => availableFolders.has(folderPath))
  );
  if (selectedFolders.size === 0) throw new Error('请先在下方至少选择一个文件夹。');
  const requestId = `classification-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const requestManifest = activeSync.baseManifest.filter((entry) => selectedFolders.has(entry.folderPath));
  const assets = requestManifest.map((entry) => {
    const component = activeSync.index.components.get(entry.relativePath);
    return {
      relativePath: entry.relativePath,
      folderPath: entry.folderPath,
      name: entry.name,
      width: entry.width,
      height: entry.height,
      nodeId: component && !component.removed ? component.id : null
    };
  });
  const strict = classifyManifest(requestManifest, 'strict', null);
  const strictGroups = summarizeClassificationGroups(strict.manifest)
    .filter((group) => group.members.length >= 2);
  const request = {
    schemaVersion: CLASSIFICATION_SCHEMA_VERSION,
    requestId,
    createdAt: new Date().toISOString(),
    fileKey: figma.fileKey || null,
    pageId: figma.currentPage.id,
    rootName: activeSync.rootName,
    libraryId: activeSync.libraryId,
    selectedFolders: Array.from(selectedFolders),
    assets,
    strictGroups,
    responseContract: {
      schemaVersion: CLASSIFICATION_SCHEMA_VERSION,
      requestId,
      groups: [{
        id: 'stable-group-id',
        name: '组件集名称',
        confidence: 0.95,
        variantProperty: 'Variant',
        members: [{ relativePath: 'folder/file.png', variantValue: 'value' }]
      }],
      standalone: ['folder/file.png'],
      transport: {
        namespace: SHARED_DATA_NAMESPACE,
        indexKey: CLASSIFICATION_PLAN_KEY,
        encoding: 'chunked-json',
        chunkKeyPattern: `${CLASSIFICATION_PLAN_KEY}_{index}`,
        maxChunkCharacters: SHARED_DATA_CHUNK_CHAR_LIMIT,
        writeIndexLast: true
      }
    }
  };
  const transport = writeChunkedSharedJson(CLASSIFICATION_REQUEST_KEY, request);
  clearChunkedSharedJson(CLASSIFICATION_PLAN_KEY);
  activeSync.classificationRequestId = requestId;
  activeSync.classificationRequestFolders = new Set(selectedFolders);
  activeSync.classificationRequestPaths = new Set(requestManifest.map((entry) => entry.relativePath));
  return {
    requestId,
    pageId: figma.currentPage.id,
    fileKey: figma.fileKey || null,
    assetCount: assets.length,
    folderCount: selectedFolders.size,
    selectedFolders: Array.from(selectedFolders),
    strictGroupCount: strictGroups.length,
    namespace: SHARED_DATA_NAMESPACE,
    requestKey: CLASSIFICATION_REQUEST_KEY,
    planKey: CLASSIFICATION_PLAN_KEY,
    requestChunks: transport.chunkCount,
    prompt: buildClassificationPrompt(request)
  };
}

function loadClassificationPlan() {
  assertActiveSync();
  if (activeSync.started) throw new Error('同步已开始，不能再读取 AI 分类方案。');
  const plan = readSharedJson(CLASSIFICATION_PLAN_KEY, 'AI 分类方案');
  if (Number(plan.schemaVersion) !== CLASSIFICATION_SCHEMA_VERSION) {
    throw new Error(`AI 分类方案版本不兼容：${plan.schemaVersion || '未知'}`);
  }
  if (!activeSync.classificationRequestId) {
    throw new Error('当前扫描尚未生成 AI 分类请求。');
  }
  if (plan.requestId !== activeSync.classificationRequestId) {
    throw new Error('AI 分类方案不属于当前扫描请求，请重新生成。');
  }
  validateAiPlanScope(
    plan,
    activeSync.classificationRequestPaths,
    new Set(activeSync.baseManifest.map((entry) => entry.relativePath))
  );
  return rebuildActiveSyncClassification('ai', plan);
}

function validateAiPlanScope(plan, allowedPaths, manifestPaths) {
  if (!(allowedPaths instanceof Set) || allowedPaths.size === 0) {
    throw new Error('当前 AI 请求没有有效的文件夹范围，请重新生成。');
  }
  const referenced = [];
  for (const group of Array.isArray(plan.groups) ? plan.groups : []) {
    for (const member of Array.isArray(group && group.members) ? group.members : []) {
      const normalized = normalizeAiPlanMember(member);
      if (normalized) referenced.push(normalized.relativePath);
    }
  }
  for (const relativePath of Array.isArray(plan.standalone) ? plan.standalone : []) {
    referenced.push(normalizeRelativePath(relativePath));
  }
  const missing = referenced.filter((relativePath) => relativePath && !manifestPaths.has(relativePath));
  if (missing.length > 0) {
    throw new Error(`AI 分类方案引用了不存在的资源：${missing[0]}`);
  }
  const outside = referenced.filter((relativePath) => relativePath && !allowedPaths.has(relativePath));
  if (outside.length > 0) {
    throw new Error(`AI 分类方案包含未选中文件夹的资源：${outside[0]}`);
  }
}

function rebuildActiveSyncClassification(mode, aiPlan) {
  const classified = classifyManifest(activeSync.baseManifest, mode, aiPlan);
  const plan = buildSyncPlan(classified.manifest, activeSync.index, activeSync.legacyConflictPaths);
  activeSync.classificationMode = normalizeClassificationMode(mode);
  activeSync.classificationSummary = classified.summary;
  activeSync.manifest = classified.manifest;
  activeSync.manifestByPath = new Map(classified.manifest.map((entry) => [entry.relativePath, entry]));
  activeSync.plan = plan;
  activeSync.expectedComponentSetGroups = plan.expectedComponentSetGroups;
  return serializeActiveSyncPlan({ adopted: 0, scanIndexReused: true, timingMs: 0 });
}

function serializeActiveSyncPlan(extra) {
  return {
    rootName: activeSync.rootName,
    libraryId: activeSync.libraryId,
    adopted: Number(extra && extra.adopted) || 0,
    conflicts: activeSync.legacyConflicts || [],
    actions: activeSync.plan.actions.map(serializeAction),
    folders: buildFolderSummaries(activeSync.plan, activeSync.index),
    summary: countActions(activeSync.plan.actions),
    classification: activeSync.classificationSummary,
    scanIndexReused: Boolean(extra && extra.scanIndexReused),
    timingMs: Number(extra && extra.timingMs) || 0
  };
}

function summarizeClassificationGroups(manifest) {
  const groups = new Map();
  for (const entry of manifest) {
    if (!entry.componentSetKey) continue;
    const id = groupKey(entry.folderPath, entry.componentSetKey);
    if (!groups.has(id)) groups.set(id, {
      id: entry.componentSetKey,
      name: entry.componentSetName,
      folderPath: entry.folderPath,
      variantProperty: entry.variantProperty,
      confidence: entry.classificationConfidence,
      members: []
    });
    groups.get(id).members.push({
      relativePath: entry.relativePath,
      variantValue: entry.variantValue,
      width: entry.width,
      height: entry.height
    });
  }
  return Array.from(groups.values());
}

function buildClassificationPrompt(request) {
  return [
    '请使用 Figma MCP 审核当前页面的图片组件分类。',
    `页面节点：${request.pageId}`,
    `读取 shared plugin data 索引：namespace="${SHARED_DATA_NAMESPACE}", key="${CLASSIFICATION_REQUEST_KEY}"。`,
    '该索引是 encoding="chunked-json" 的 JSON；按 chunkKeys 顺序读取所有分片，拼接字符串后 JSON.parse 得到请求。',
    '以严格尺寸候选组为基础，结合资源路径、名称、尺寸和现有节点截图，只调整确有必要的组件集。',
    '未写入 groups 或 standalone 的资源继续保持严格尺寸分类；不要跨一级文件夹合并资源。',
    `将结果按 request.responseContract 写回同一页面：namespace="${SHARED_DATA_NAMESPACE}", index key="${CLASSIFICATION_PLAN_KEY}"。`,
    `先 JSON.stringify 方案，按最多 ${SHARED_DATA_CHUNK_CHAR_LIMIT} 个字符拆分并依次写入 ${CLASSIFICATION_PLAN_KEY}_0、${CLASSIFICATION_PLAN_KEY}_1…；最后再写索引 key。`,
    '索引格式：{"encoding":"chunked-json","chunkCount":N,"chunkKeys":[...],"schemaVersion":1,"requestId":"..."}。',
    '不要直接移动或合并节点；只写回分类计划，由插件校验和执行。'
  ].join('\n');
}

function writeChunkedSharedJson(baseKey, value) {
  clearChunkedSharedJson(baseKey);
  const serialized = JSON.stringify(value);
  const chunks = splitSharedDataChunks(serialized);
  const chunkKeys = chunks.map((_, index) => `${baseKey}_${index}`);
  for (let index = 0; index < chunks.length; index++) {
    figma.currentPage.setSharedPluginData(SHARED_DATA_NAMESPACE, chunkKeys[index], chunks[index]);
  }
  const index = {
    encoding: 'chunked-json',
    chunkCount: chunks.length,
    chunkKeys,
    schemaVersion: CLASSIFICATION_SCHEMA_VERSION,
    requestId: value && value.requestId ? value.requestId : null
  };
  figma.currentPage.setSharedPluginData(SHARED_DATA_NAMESPACE, baseKey, JSON.stringify(index));
  return index;
}

function readSharedJson(baseKey, label) {
  const raw = figma.currentPage.getSharedPluginData(SHARED_DATA_NAMESPACE, baseKey);
  if (!raw) throw new Error(`尚未发现${label}，请先让 MCP 客户端写回 ${baseKey}。`);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new Error(`${label}索引不是有效 JSON。`);
  }
  if (!parsed || parsed.encoding !== 'chunked-json') return parsed;
  const chunkKeys = Array.isArray(parsed.chunkKeys) ? parsed.chunkKeys : [];
  if (chunkKeys.length === 0 || chunkKeys.length !== Number(parsed.chunkCount)) {
    throw new Error(`${label}分片索引无效。`);
  }
  let serialized = '';
  for (const chunkKey of chunkKeys) {
    const chunk = figma.currentPage.getSharedPluginData(SHARED_DATA_NAMESPACE, String(chunkKey));
    if (!chunk) throw new Error(`${label}缺少分片：${chunkKey}`);
    serialized += chunk;
  }
  try {
    return JSON.parse(serialized);
  } catch (_) {
    throw new Error(`${label}分片拼接后不是有效 JSON。`);
  }
}

function clearChunkedSharedJson(baseKey) {
  const raw = figma.currentPage.getSharedPluginData(SHARED_DATA_NAMESPACE, baseKey);
  if (raw) {
    try {
      const index = JSON.parse(raw);
      if (index && index.encoding === 'chunked-json' && Array.isArray(index.chunkKeys)) {
        for (const chunkKey of index.chunkKeys) {
          figma.currentPage.setSharedPluginData(SHARED_DATA_NAMESPACE, String(chunkKey), '');
        }
      }
    } catch (_) {
      // A legacy direct JSON entry has no chunks to remove.
    }
  }
  figma.currentPage.setSharedPluginData(SHARED_DATA_NAMESPACE, baseKey, '');
}

function splitSharedDataChunks(value) {
  const chunks = [];
  let offset = 0;
  while (offset < value.length) {
    let end = Math.min(value.length, offset + SHARED_DATA_CHUNK_CHAR_LIMIT);
    if (end < value.length && end > offset) {
      const lastCodeUnit = value.charCodeAt(end - 1);
      const nextCodeUnit = value.charCodeAt(end);
      if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff &&
          nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) end--;
    }
    chunks.push(value.slice(offset, end));
    offset = end;
  }
  return chunks.length > 0 ? chunks : [''];
}

async function beginSync(payload) {
  const startedAt = Date.now();
  assertActiveSync();
  const selectedFolders = Array.isArray(payload.selectedFolders)
    ? payload.selectedFolders.map(normalizeFolderPath)
    : [];

  activeSync.selectedFolders = new Set(selectedFolders);
  activeSync.deleteMissing = payload.deleteMissing !== false;
  activeSync.stats = emptyStats();
  activeSync.touchedNodes = new Set();
  activeSync.touchedSections = new Set();
  activeSync.touchedComponentSets = new Set();
  activeSync.newSections = new Set();
  activeSync.repairSections = new Set();
  activeSync.pendingDeletes = [];
  activeSync.imageHashByContentHash = new Map();
  activeSync.performance = emptyPerformanceStats();
  activeSync.performance.startedAt = startedAt;
  activeSync.warnings = [];
  activeSync.started = true;

  const selectedActions = activeSync.plan.actions.filter((action) =>
    activeSync.selectedFolders.has(action.folderPath)
  );

  await repairSelectedComponentSetNames();

  // Moves are metadata/layout operations and do not need image bytes. This also
  // performs the one-time migration from old deep-folder Sections into their
  // first-level Section.
  const moveActions = selectedActions.filter((item) => item.type === 'move');
  const yieldMoves = createMainThreadYielder();
  for (let index = 0; index < moveActions.length; index++) {
    const action = moveActions[index];
    emitSyncProgress(action.entry.relativePath, 'structure', {
      completed: index,
      total: moveActions.length
    });
    try {
      moveExistingComponent(action);
      activeSync.stats.moved++;
    } catch (error) {
      activeSync.stats.skipped++;
      activeSync.warnings.push(`${action.entry.relativePath}：${formatError(error)}`);
    }
    await yieldMoves(index + 1 < moveActions.length, () => {
      emitSyncProgress(action.entry.relativePath, 'structure', {
        completed: index + 1,
        total: moveActions.length
      });
    });
  }

  activeSync.pendingDeletes = selectedActions.filter((item) =>
    item.type === 'delete' && (activeSync.deleteMissing || item.required)
  );

  activeSync.stats.unchanged = selectedActions.filter((item) => item.type === 'unchanged').length;
  activeSync.stats.conflicts = selectedActions.filter((item) => item.type === 'conflict').length;

  return {
    fileActions: selectedActions
      .filter((item) => item.type === 'add' || item.type === 'update')
      .map((item) => item.entry.relativePath),
    pendingDeletes: activeSync.pendingDeletes.length,
    stats: activeSync.stats,
    warnings: activeSync.warnings,
    timingMs: Date.now() - startedAt
  };
}

async function applyBatch(payload) {
  const startedAt = Date.now();
  const files = Array.isArray(payload.files) ? payload.files : [];
  if (files.length === 0) return { results: [] };

  emitSyncProgress(files[0].relativePath, 'batch', { total: files.length });
  const results = [];
  const yieldFiles = createMainThreadYielder();
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    results.push(await applyFile(file, { reportProgress: false }));
    await yieldFiles(index + 1 < files.length, () => {
      emitSyncProgress(file.relativePath, 'batch-item', {
        completed: index + 1,
        total: files.length
      });
    });
  }
  emitSyncProgress(files[files.length - 1].relativePath, 'batch-done', {
    total: files.length
  });
  const timingMs = Date.now() - startedAt;
  activeSync.performance.applyMs += timingMs;
  activeSync.performance.batchCount++;
  return { results, timingMs };
}

async function applyFile(payload, options) {
  assertActiveSync();
  if (!activeSync.started) throw new Error('同步尚未开始。');
  const reportProgress = !options || options.reportProgress !== false;

  const relativePath = normalizeRelativePath(payload.relativePath);
  const entry = activeSync.manifestByPath.get(relativePath);
  if (!entry) throw new Error(`同步清单中不存在：${relativePath}`);
  if (!activeSync.selectedFolders.has(entry.folderPath)) {
    return { status: 'skipped', relativePath, reason: 'folder-not-selected' };
  }

  const action = activeSync.plan.actionByPath.get(relativePath);
  if (!action || (action.type !== 'add' && action.type !== 'update')) {
    return { status: 'skipped', relativePath, reason: 'no-file-operation' };
  }

  try {
    if (reportProgress) emitSyncProgress(relativePath, 'received');
    const reusableContentHash = entry.hash && entry.hash.startsWith('sha256:')
      ? entry.hash
      : '';
    let imageHash = reusableContentHash
      ? activeSync.imageHashByContentHash.get(reusableContentHash)
      : '';

    if (!imageHash) {
      const bytes = payload.bytes instanceof Uint8Array
        ? payload.bytes
        : new Uint8Array(payload.bytes || []);
      if (bytes.byteLength === 0) throw new Error('图片内容为空。');

      if (reportProgress) emitSyncProgress(relativePath, 'image');
      const imageStartedAt = Date.now();
      imageHash = figma.createImage(bytes).hash;
      activeSync.performance.imageMs += Date.now() - imageStartedAt;
      activeSync.performance.imagesCreated++;
      if (reusableContentHash) {
        activeSync.imageHashByContentHash.set(reusableContentHash, imageHash);
      }
    } else {
      activeSync.performance.imagesReused++;
    }
    // PNG dimensions were validated from the IHDR header during scanning.
    // Avoid getSizeAsync here: on large imports the Figma image bridge can leave
    // that promise pending and the UI appears frozen on the very first file.
    const actualEntry = entry;

    if (reportProgress) emitSyncProgress(relativePath, 'layout');
    const nodeStartedAt = Date.now();
    if (action.type === 'update' && action.node && !action.node.removed) {
      updateExistingComponent(action.node, actualEntry, imageHash, action);
      activeSync.stats.updated++;
    } else {
      createManagedComponent(actualEntry, imageHash);
      activeSync.stats.added++;
    }
    activeSync.performance.nodeMs += Date.now() - nodeStartedAt;

    if (reportProgress) emitSyncProgress(relativePath, 'done');
    return { status: 'ok', type: action.type, relativePath };
  } catch (error) {
    if (reportProgress) emitSyncProgress(relativePath, 'failed');
    const warning = `${relativePath}：${formatError(error)}`;
    activeSync.stats.skipped++;
    activeSync.warnings.push(warning);
    console.error('[skip file]', warning);
    return { status: 'skipped', relativePath, reason: formatError(error) };
  }
}

async function finishSync() {
  const finishStartedAt = Date.now();
  assertActiveSync();

  const deleteStartedAt = Date.now();
  if (activeSync.stats.skipped === 0) {
    const yieldDeletes = createMainThreadYielder();
    for (let index = 0; index < activeSync.pendingDeletes.length; index++) {
      const action = activeSync.pendingDeletes[index];
      try {
        deleteManagedComponent(action);
        activeSync.stats.deleted++;
      } catch (error) {
        activeSync.stats.skipped++;
        activeSync.warnings.push(`${action.relativePath}：${formatError(error)}`);
      }
      await yieldDeletes(index + 1 < activeSync.pendingDeletes.length, () => {
        emitSyncProgress(action.relativePath, 'delete', {
          completed: index + 1,
          total: activeSync.pendingDeletes.length
        });
      });
    }
  } else if (activeSync.pendingDeletes.length > 0) {
    activeSync.warnings.push(
      `有 ${activeSync.stats.skipped} 个资源处理失败，本轮已取消 ${activeSync.pendingDeletes.length} 个删除操作。`
    );
  }
  const deleteMs = Date.now() - deleteStartedAt;

  const layoutStartedAt = Date.now();
  emitSyncProgress('', 'final-layout', {
    componentSets: activeSync.touchedComponentSets.size,
    sections: activeSync.touchedSections.size
  });
  await dissolveSingletonComponentSets();
  await compactTouchedComponentSets();
  await cleanupTouchedSections();
  await layoutMovableSections();
  const layoutMs = Date.now() - layoutStartedAt;

  const nodes = Array.from(activeSync.touchedNodes).filter((node) => node && !node.removed);
  if (nodes.length > 0) figma.viewport.scrollAndZoomIntoView(nodes);

  const stats = { ...activeSync.stats };
  const warnings = activeSync.warnings.slice();
  const changed = stats.added + stats.updated + stats.deleted + stats.moved;

  figma.notify(
    changed > 0
      ? `同步完成：新增 ${stats.added}，更新 ${stats.updated}，删除 ${stats.deleted}，移动 ${stats.moved}`
      : '资源已经是最新状态',
    { timeout: 3500 }
  );

  activeSync.started = false;
  return {
    stats,
    warnings,
    timings: {
      applyMs: activeSync.performance.applyMs,
      imageMs: activeSync.performance.imageMs,
      nodeMs: activeSync.performance.nodeMs,
      deleteMs,
      layoutMs,
      finishMs: Date.now() - finishStartedAt,
      totalMs: Date.now() - activeSync.performance.startedAt,
      batchCount: activeSync.performance.batchCount,
      imagesCreated: activeSync.performance.imagesCreated,
      imagesReused: activeSync.performance.imagesReused
    }
  };
}

function sanitizeManifest(items) {
  const newestByName = new Map();

  for (const item of items) {
    const relativePath = normalizeRelativePath(item.relativePath);
    if (!relativePath) continue;

    const folderPath = classifySectionFolder(relativePath);
    const entry = {
      relativePath,
      folderPath,
      name: String(item.name || basenameWithoutExtension(relativePath)),
      hash: String(item.hash || ''),
      width: positiveNumber(item.width),
      height: positiveNumber(item.height),
      sourceSize: nonNegativeNumber(item.sourceSize),
      lastModified: nonNegativeNumber(item.lastModified)
    };
    const identity = resourceNameKey(folderPath, entry.name);
    const previous = newestByName.get(identity);
    if (!previous || isNewerManifestEntry(entry, previous)) {
      newestByName.set(identity, entry);
    }
  }

  const result = Array.from(newestByName.values());
  result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return result;
}

function normalizeClassificationMode(value) {
  return value === 'ai' ? 'ai' : 'strict';
}

function classifyManifest(baseManifest, mode, aiPlan) {
  const normalizedMode = normalizeClassificationMode(mode);
  const manifest = baseManifest.map((entry) => ({
    ...entry,
    componentSetKey: null,
    componentSetName: '',
    variantProperty: DEFAULT_VARIANT_PROPERTY,
    variantValue: entry.name,
    classificationSource: 'standalone',
    classificationConfidence: 0
  }));

  assignStrictClassifications(manifest);
  if (normalizedMode === 'ai' && aiPlan) applyAiClassificationPlan(manifest, aiPlan);
  assignClassificationLayoutOrder(manifest);

  const groupSizes = new Map();
  for (const entry of manifest) {
    if (!entry.componentSetKey) continue;
    const id = groupKey(entry.folderPath, entry.componentSetKey);
    groupSizes.set(id, (groupSizes.get(id) || 0) + 1);
  }
  const grouped = manifest.filter((entry) => entry.componentSetKey &&
    groupSizes.get(groupKey(entry.folderPath, entry.componentSetKey)) >= 2
  );
  const groupIds = new Set(grouped.map((entry) => groupKey(entry.folderPath, entry.componentSetKey)));
  return {
    manifest,
    summary: {
      mode: normalizedMode,
      groups: groupIds.size,
      groupedAssets: grouped.length,
      standaloneAssets: manifest.length - grouped.length,
      aiGroups: new Set(grouped
        .filter((entry) => entry.classificationSource === 'ai')
        .map((entry) => groupKey(entry.folderPath, entry.componentSetKey))).size
    }
  };
}

function assignStrictClassifications(manifest) {
  for (const entry of manifest) {
    const key = sizeKey(entry.width, entry.height);
    assignEntryClassification(entry, {
      key,
      name: key,
      property: DEFAULT_VARIANT_PROPERTY,
      value: entry.name,
      source: 'strict',
      confidence: 1
    });
  }
}

function applyAiClassificationPlan(manifest, plan) {
  if (!plan || !Array.isArray(plan.groups)) throw new Error('AI 分类方案缺少 groups 数组。');
  const byPath = new Map(manifest.map((entry) => [entry.relativePath, entry]));
  const assigned = new Set();
  const explicitStandalone = new Set(Array.isArray(plan.standalone) ? plan.standalone.map(normalizeRelativePath) : []);
  const usedGroupKeys = new Set();

  for (const rawGroup of plan.groups) {
    const confidence = Number(rawGroup && rawGroup.confidence);
    if (!rawGroup || !Array.isArray(rawGroup.members) || rawGroup.members.length < 2) continue;
    if (!Number.isFinite(confidence) || confidence < CLASSIFICATION_CONFIDENCE_THRESHOLD) continue;
    const members = rawGroup.members.map(normalizeAiPlanMember).filter(Boolean);
    const missingPaths = members
      .filter((member) => !byPath.has(member.relativePath))
      .map((member) => member.relativePath);
    if (missingPaths.length > 0) {
      throw new Error(`AI 分类方案引用了不存在的资源：${missingPaths.join('、')}`);
    }
    const entries = members.map((member) => byPath.get(member.relativePath));
    if (entries.length < 2) continue;
    const folders = new Set(entries.map((entry) => entry.folderPath));
    if (folders.size !== 1) throw new Error(`AI 组“${rawGroup.name || rawGroup.id || '未命名'}”跨越了多个一级文件夹。`);
    for (const entry of entries) {
      if (assigned.has(entry.relativePath)) throw new Error(`AI 分类方案重复分配资源：${entry.relativePath}`);
      assigned.add(entry.relativePath);
    }
    const id = safeClassificationId(rawGroup.id || rawGroup.name || entries[0].name);
    const groupStorageKey = groupKey(entries[0].folderPath, `ai:${id}`);
    if (usedGroupKeys.has(groupStorageKey)) {
      throw new Error(`AI 分类方案存在重复的组 ID：${id}`);
    }
    usedGroupKeys.add(groupStorageKey);
    const property = String(rawGroup.variantProperty || DEFAULT_VARIANT_PROPERTY).trim() || DEFAULT_VARIANT_PROPERTY;
    const variantValues = members.map((member, index) =>
      sanitizeVariantToken(member.variantValue || entries[index].name, entries[index].name)
    );
    if (new Set(variantValues).size !== variantValues.length) {
      throw new Error(`AI 组“${rawGroup.name || id}”存在重复的 Variant 值。`);
    }
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      assignEntryClassification(entry, {
        key: `ai:${id}`,
        name: String(rawGroup.name || id).trim() || id,
        property,
        value: variantValues[index],
        source: 'ai',
        confidence
      });
    }
  }

  for (const relativePath of explicitStandalone) {
    const entry = byPath.get(relativePath);
    if (!entry) throw new Error(`AI 分类方案引用了不存在的资源：${relativePath}`);
    if (assigned.has(relativePath)) throw new Error(`资源同时出现在 AI 组件集与 standalone 中：${relativePath}`);
    assignEntryClassification(entry, null);
  }
}

function normalizeAiPlanMember(value) {
  if (typeof value === 'string') {
    const relativePath = normalizeRelativePath(value);
    return relativePath ? { relativePath, variantValue: '' } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const relativePath = normalizeRelativePath(value.relativePath || value.path);
  return relativePath ? { relativePath, variantValue: String(value.variantValue || value.value || '') } : null;
}

function safeClassificationId(value) {
  return String(value || 'group').trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'group';
}

function assignEntryClassification(entry, classification) {
  if (!classification) {
    entry.componentSetKey = null;
    entry.componentSetName = '';
    entry.variantProperty = DEFAULT_VARIANT_PROPERTY;
    entry.variantValue = entry.name;
    entry.classificationSource = 'standalone';
    entry.classificationConfidence = 0;
    return;
  }
  entry.componentSetKey = classification.key;
  entry.componentSetName = classification.name;
  entry.variantProperty = classification.property || DEFAULT_VARIANT_PROPERTY;
  entry.variantValue = classification.value || entry.name;
  entry.classificationSource = classification.source || 'strict';
  entry.classificationConfidence = Number(classification.confidence) || 0;
}

function assignClassificationLayoutOrder(manifest) {
  const counters = new Map();
  for (const entry of manifest) {
    const key = entry.componentSetKey
      ? groupKey(entry.folderPath, entry.componentSetKey)
      : `${entry.folderPath}\u0000standalone:${entry.relativePath}`;
    entry.layoutOrder = counters.get(key) || 0;
    counters.set(key, entry.layoutOrder + 1);
  }
}

function isNewerManifestEntry(candidate, previous) {
  if (candidate.lastModified !== previous.lastModified) {
    return candidate.lastModified > previous.lastModified;
  }
  return candidate.relativePath.localeCompare(previous.relativePath) >= 0;
}

function normalizeRelativePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/');
}

function normalizeFolderPath(value) {
  const path = normalizeRelativePath(value);
  return path || '_root';
}

function classifySectionFolder(relativePath) {
  const parts = normalizeRelativePath(relativePath).split('/').filter(Boolean);
  return parts.length > 1 ? parts[0] : '_root';
}

function resourceNameKey(folderPath, name) {
  return `${normalizeFolderPath(folderPath)}\u0000${String(name || '')}`;
}

function componentResourceName(component, meta, relativePath) {
  const storedName = meta && String(meta.resourceName || '').trim();
  if (storedName) return storedName;

  const pathName = basenameWithoutExtension(relativePath || (meta && meta.relativePath));
  if (pathName) return pathName;

  const rawName = String(component && component.name || '').trim();
  const pairs = parseVariantName(rawName);
  return pairs.length > 0 ? pairs[0].value : rawName;
}

function parseVariantName(value) {
  const segments = String(value || '').split(',');
  const pairs = [];
  for (const segment of segments) {
    const separator = segment.indexOf('=');
    if (separator <= 0 || separator !== segment.lastIndexOf('=')) return [];
    const property = segment.slice(0, separator).trim();
    const variantValue = segment.slice(separator + 1).trim();
    if (!property || !variantValue) return [];
    pairs.push({ property, value: variantValue });
  }
  return pairs;
}

function sanitizeVariantToken(value, fallback) {
  const sanitized = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[=,]/g, '_')
    .trim();
  return sanitized || fallback;
}

function variantPropertyName(componentSet) {
  if (componentSet && componentSet.type === 'COMPONENT_SET') {
    try {
      const properties = Object.keys(componentSet.variantGroupProperties || {});
      if (properties.length > 0) {
        return sanitizeVariantToken(properties[0], DEFAULT_VARIANT_PROPERTY);
      }
    } catch (_) {
      // Invalid legacy variant names can make the derived property map unavailable.
    }

    for (const child of componentSet.children) {
      if (child.type !== 'COMPONENT') continue;
      const pairs = parseVariantName(child.name);
      if (pairs.length > 0) {
        return sanitizeVariantToken(pairs[0].property, DEFAULT_VARIANT_PROPERTY);
      }
    }
  }
  return DEFAULT_VARIANT_PROPERTY;
}

function formatVariantName(componentSet, resourceName) {
  const property = variantPropertyName(componentSet);
  const value = sanitizeVariantToken(resourceName, 'Resource');
  return `${property}=${value}`;
}

function formatEntryVariantName(componentSet, entry) {
  if (!entry) return formatVariantName(componentSet, 'Resource');
  const property = sanitizeVariantToken(
    entry.variantProperty || variantPropertyName(componentSet),
    DEFAULT_VARIANT_PROPERTY
  );
  const value = sanitizeVariantToken(entry.variantValue || entry.name, 'Resource');
  return `${property}=${value}`;
}

function setManagedComponentName(component, entryOrName) {
  const entry = typeof entryOrName === 'object'
    ? entryOrName
    : { name: String(entryOrName || ''), variantValue: String(entryOrName || '') };
  component.name = component.parent && component.parent.type === 'COMPONENT_SET'
    ? formatEntryVariantName(component.parent, entry)
    : entry.name;
}

function normalizeComponentSetVariantNames(componentSet) {
  if (!componentSet || componentSet.removed || componentSet.type !== 'COMPONENT_SET') return 0;
  const setMeta = readMeta(componentSet) || {};
  const property = sanitizeVariantToken(
    setMeta.variantProperty || variantPropertyName(componentSet),
    DEFAULT_VARIANT_PROPERTY
  );
  let repaired = 0;

  for (const component of componentSet.children) {
    if (component.type !== 'COMPONENT') continue;
    const meta = readMeta(component) || {};
    const resourceName = componentResourceName(component, meta, meta.relativePath || '');
    const variantValue = meta.variantValue || resourceName;
    const nextName = `${property}=${sanitizeVariantToken(variantValue, 'Resource')}`;
    if (component.name !== nextName) {
      component.name = nextName;
      repaired++;
    }
  }
  return repaired;
}

async function normalizeComponentSetVariantNamesInChunks(componentSet) {
  if (!componentSet || componentSet.removed || componentSet.type !== 'COMPONENT_SET') return 0;
  const setMeta = readMeta(componentSet) || {};
  const property = sanitizeVariantToken(
    setMeta.variantProperty || variantPropertyName(componentSet),
    DEFAULT_VARIANT_PROPERTY
  );
  const components = componentSet.children.filter((component) => component.type === 'COMPONENT');
  const yieldComponents = createMainThreadYielder();
  let repaired = 0;

  for (let index = 0; index < components.length; index++) {
    const component = components[index];
    const meta = readMeta(component) || {};
    const resourceName = componentResourceName(component, meta, meta.relativePath || '');
    const variantValue = meta.variantValue || resourceName;
    const nextName = `${property}=${sanitizeVariantToken(variantValue, 'Resource')}`;
    if (component.name !== nextName) {
      component.name = nextName;
      repaired++;
    }
    await yieldComponents(index + 1 < components.length, () => {
      emitSyncProgress(componentSet.name || '', 'repair-names', {
        completed: index + 1,
        total: components.length
      });
    });
  }
  return repaired;
}

async function repairSelectedComponentSetNames() {
  const seen = new Set();
  const componentSets = [];
  for (const [mapKey, componentSet] of activeSync.index.componentSets.entries()) {
    if (!componentSet || componentSet.removed || seen.has(componentSet.id)) continue;
    seen.add(componentSet.id);
    const meta = readMeta(componentSet) || {};
    const separator = mapKey.indexOf('\u0000');
    const indexedFolder = separator >= 0 ? mapKey.slice(0, separator) : '';
    const folderPath = normalizeFolderPath(meta.folderPath || indexedFolder);
    if (!activeSync.selectedFolders.has(folderPath)) continue;
    componentSets.push(componentSet);
  }

  const yieldSets = createMainThreadYielder();
  for (let index = 0; index < componentSets.length; index++) {
    const componentSet = componentSets[index];
    await normalizeComponentSetVariantNamesInChunks(componentSet);
    await yieldSets(index + 1 < componentSets.length, () => {
      emitSyncProgress(componentSet.name || '', 'repair-names', {
        completed: index + 1,
        total: componentSets.length
      });
    });
  }
}

function basenameWithoutExtension(path) {
  const last = normalizeRelativePath(path).split('/').pop() || '';
  return last.replace(/\.[^.]+$/, '');
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 1;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function createLibraryId(rootName) {
  const slug = rootName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'resources';
  return `${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function chooseLibrary(rootName, localFolderPaths) {
  const libraries = new Map();

  for (const section of getTopLevelSections()) {
    const meta = readMeta(section);
    if (!meta || meta.role !== 'section' || !meta.libraryId) continue;
    if (!libraries.has(meta.libraryId)) {
      libraries.set(meta.libraryId, {
        libraryId: meta.libraryId,
        rootName: meta.rootName || '',
        folders: new Set()
      });
    }
    libraries.get(meta.libraryId).folders.add(normalizeFolderPath(meta.folderPath));
  }

  const ranked = Array.from(libraries.values()).map((library) => {
    let score = library.rootName === rootName ? 1000 : 0;
    for (const folder of localFolderPaths) {
      if (library.folders.has(folder)) score++;
    }
    return { library, score };
  }).sort((a, b) => b.score - a.score);

  return ranked.length > 0 && ranked[0].score > 0 ? ranked[0].library : null;
}

function adoptLegacySections(manifest, libraryId, rootName) {
  const manifestByFolder = groupBy(manifest, (entry) => entry.folderPath);
  const topLevelSections = getTopLevelSections();
  const managedFolders = new Set(
    topLevelSections
      .map((section) => readMeta(section))
      .filter((meta) => meta && meta.role === 'section' && meta.libraryId === libraryId)
      .map((meta) => normalizeFolderPath(meta.folderPath))
  );
  const legacySectionsByName = groupBy(
    topLevelSections.filter((section) => !readMeta(section)),
    (section) => section.name
  );

  const conflicts = [];
  const conflictPaths = new Set();
  let adopted = 0;

  for (const [folderPath, entries] of manifestByFolder) {
    if (managedFolders.has(folderPath)) continue;
    const displayName = folderDisplayName(folderPath);
    const candidates = legacySectionsByName.get(displayName) || [];
    if (candidates.length > 1) {
      conflicts.push(`存在 ${candidates.length} 个同名 Section“${displayName}”，无法自动选择。`);
      for (const entry of entries) conflictPaths.add(entry.relativePath);
      continue;
    }
    if (candidates.length === 0) continue;

    const section = candidates[0];
    const components = collectComponents(section);
    const componentsByName = groupBy(
      components,
      (component) => componentResourceName(component, readMeta(component), '')
    );
    const used = new Set();
    const matches = [];

    for (const entry of entries) {
      const possible = (componentsByName.get(entry.name) || [])
        .filter((component) => !used.has(component.id));
      const exactSize = possible.filter((component) =>
        sameSize(component.width, component.height, entry.width, entry.height)
      );
      const selected = exactSize[0] || possible[0] || null;

      if (selected) {
        used.add(selected.id);
        matches.push({ entry, component: selected });
      }
    }

    // A unique top-level Section with the same name is the intended target even
    // when it is empty or contains unrelated manual content. Only matched
    // Components become managed; every other child remains untouched.
    writeMeta(section, {
      role: 'section', libraryId, rootName, folderPath
    });

    for (const { entry, component } of matches) {
      writeComponentMeta(component, entry, libraryId, '');
      const rectangle = findImageRectangle(component);
      if (rectangle) writeMeta(rectangle, {
        role: 'image', libraryId, relativePath: entry.relativePath
      });
      if (component.parent && component.parent.type === 'COMPONENT_SET') {
        writeMeta(component.parent, {
          role: 'component-set',
          libraryId,
          rootName,
          folderPath,
          sizeKey: sizeKey(entry.width, entry.height)
        });
      }
      adopted++;
    }
  }

  return { adopted, conflicts, conflictPaths };
}

function scanLibrary(libraryId) {
  const sections = new Map();
  const components = new Map();
  const componentRecords = [];
  const unmanagedComponents = [];
  const componentSets = new Map();

  for (const section of getTopLevelSections()) {
    const sectionMeta = readMeta(section);
    if (!sectionMeta || sectionMeta.role !== 'section' || sectionMeta.libraryId !== libraryId) continue;

    const folderPath = normalizeFolderPath(sectionMeta.folderPath);
    if (!sections.has(folderPath)) sections.set(folderPath, section);

    for (const child of section.children) {
      if (child.type === 'COMPONENT_SET') {
        const setMeta = readMeta(child);
        const key = componentSetStorageKey(setMeta, child);
        if (key && !componentSets.has(groupKey(folderPath, key))) {
          componentSets.set(groupKey(folderPath, key), child);
        }
      }
    }

    for (const component of collectComponents(section)) {
      const meta = readMeta(component);
      if (!meta || meta.role !== 'component' || meta.libraryId !== libraryId || !meta.relativePath) {
        unmanagedComponents.push({
          folderPath,
          name: componentResourceName(component, meta, ''),
          width: component.width,
          height: component.height,
          node: component
        });
        continue;
      }

      const relativePath = normalizeRelativePath(meta.relativePath);
      componentRecords.push({ relativePath, node: component });
      if (!components.has(relativePath)) components.set(relativePath, component);
    }
  }

  return { libraryId, sections, components, componentRecords, unmanagedComponents, componentSets };
}

function buildSyncPlan(manifest, index, legacyConflictPaths) {
  const actions = [];
  const actionByPath = new Map();
  const expectedComponentSetGroups = buildExpectedComponentSetGroups(manifest);
  const expectedEntryByPath = new Map(manifest.map((entry) => [entry.relativePath, entry]));
  const componentRecords = Array.isArray(index.componentRecords)
    ? index.componentRecords
    : Array.from(index.components.entries()).map(([relativePath, node]) => ({ relativePath, node }));
  const remotes = componentRecords.map(({ relativePath, node }) => {
    const meta = readMeta(node) || {};
    const resourceName = componentResourceName(node, meta, relativePath);
    const insideComponentSet = node.parent && node.parent.type === 'COMPONENT_SET';
    const folderPath = classifySectionFolder(relativePath);
    const width = meta.width || node.width;
    const height = meta.height || node.height;
    const expectedEntry = expectedEntryByPath.get(relativePath);
    const expectedSetKey = expectedEntry ? componentSetKeyForEntry(expectedEntry) : null;
    const expectsComponentSet = Boolean(expectedSetKey && expectedComponentSetGroups.has(
      groupKey(folderPath, expectedSetKey)
    ));
    const currentSetKey = insideComponentSet
      ? componentSetStorageKey(readMeta(node.parent), node.parent)
      : null;
    return {
      relativePath,
      folderPath,
      storedFolderPath: normalizeFolderPath(meta.folderPath),
      name: resourceName,
      hash: meta.hash || '',
      lastModified: nonNegativeNumber(meta.lastModified),
      width,
      height,
      needsStructureRepair: expectsComponentSet
        ? (!insideComponentSet || currentSetKey !== expectedSetKey ||
          node.name !== formatEntryVariantName(node.parent, expectedEntry))
        : (insideComponentSet || node.name !== resourceName),
      managed: true,
      node
    };
  });
  const unmanagedRemotes = (index.unmanagedComponents || []).map((remote) => ({
    relativePath: '',
    folderPath: normalizeFolderPath(remote.folderPath),
    storedFolderPath: normalizeFolderPath(remote.folderPath),
    name: remote.name,
    hash: '',
    lastModified: 0,
    width: remote.width,
    height: remote.height,
    managed: false,
    node: remote.node
  }));
  const allRemotes = remotes.concat(unmanagedRemotes);
  const remoteByPath = groupBy(remotes, (remote) => remote.relativePath);
  const usedRemoteIds = new Set();
  let unmatchedLocal = [];

  for (const entry of manifest) {
    const candidates = remoteByPath.get(entry.relativePath) || [];
    if (candidates.length === 0) {
      unmatchedLocal.push(entry);
      continue;
    }
    const remote = chooseReplacementCandidate(candidates, entry);
    usedRemoteIds.add(remote.node.id);
    addMatchedResourceAction(actions, actionByPath, entry, remote);
  }

  // Within one Section the Component name is the resource identity. A new file
  // with the same name replaces the existing managed Component even if its
  // subfolder, hash, or dimensions changed.
  const remainingByName = groupBy(
    allRemotes.filter((remote) => !usedRemoteIds.has(remote.node.id)),
    (remote) => resourceNameKey(remote.folderPath, remote.name)
  );
  const afterNameMatching = [];
  for (const entry of unmatchedLocal) {
    const candidates = (remainingByName.get(resourceNameKey(entry.folderPath, entry.name)) || [])
      .filter((remote) => !usedRemoteIds.has(remote.node.id));
    if (candidates.length === 0) {
      afterNameMatching.push(entry);
      continue;
    }
    const remote = chooseReplacementCandidate(candidates, entry);
    usedRemoteIds.add(remote.node.id);
    addMatchedResourceAction(actions, actionByPath, entry, remote);
  }
  unmatchedLocal = afterNameMatching;

  // A unique identical hash on both sides is a rename or folder move.
  const unmatchedRemote = remotes.filter((remote) => !usedRemoteIds.has(remote.node.id));
  const localByHash = groupBy(unmatchedLocal.filter((entry) => entry.hash), (entry) => entry.hash);
  const remoteByHash = groupBy(unmatchedRemote.filter((entry) => entry.hash), (entry) => entry.hash);
  const consumedLocal = new Set();

  for (const [hash, localItems] of localByHash) {
    const remoteItems = (remoteByHash.get(hash) || [])
      .filter((remote) => !usedRemoteIds.has(remote.node.id));
    if (localItems.length === 1 && remoteItems.length === 1) {
      const entry = localItems[0];
      const remote = remoteItems[0];
      consumedLocal.add(entry.relativePath);
      usedRemoteIds.add(remote.node.id);
      addAction(actions, actionByPath, {
        type: 'move',
        folderPath: entry.folderPath,
        relativePath: entry.relativePath,
        oldRelativePath: remote.relativePath,
        entry,
        node: remote.node
      });
    }
  }

  for (const entry of unmatchedLocal) {
    if (consumedLocal.has(entry.relativePath)) continue;
    const type = legacyConflictPaths.has(entry.relativePath) ? 'conflict' : 'add';
    addAction(actions, actionByPath, {
      type,
      folderPath: entry.folderPath,
      relativePath: entry.relativePath,
      entry
    });
  }

  const localNameKeys = new Set(
    manifest.map((entry) => resourceNameKey(entry.folderPath, entry.name))
  );
  const requiredDeleteIds = new Set();

  for (const remote of allRemotes) {
    if (usedRemoteIds.has(remote.node.id)) continue;
    if (!localNameKeys.has(resourceNameKey(remote.folderPath, remote.name))) continue;
    requiredDeleteIds.add(remote.node.id);
    addAction(actions, actionByPath, {
      type: 'delete',
      folderPath: remote.folderPath,
      relativePath: remote.relativePath || `${remote.folderPath}/__duplicate__/${remote.node.id}`,
      name: remote.name,
      required: true,
      reason: 'duplicate-name',
      node: remote.node
    });
  }

  for (const remote of remotes) {
    if (usedRemoteIds.has(remote.node.id) || requiredDeleteIds.has(remote.node.id)) continue;
    addAction(actions, actionByPath, {
      type: 'delete',
      folderPath: remote.folderPath,
      relativePath: remote.relativePath,
      name: remote.name,
      required: false,
      reason: 'missing-local',
      node: remote.node
    });
  }

  actions.sort((a, b) => {
    const order = { conflict: 0, update: 1, move: 2, add: 3, delete: 4, unchanged: 5 };
    return (order[a.type] - order[b.type]) || a.relativePath.localeCompare(b.relativePath);
  });

  promoteLayoutRepairActions(actions, index);

  return { actions, actionByPath, expectedComponentSetGroups };
}

function promoteLayoutRepairActions(actions, index) {
  for (const [folderPath, section] of index.sections) {
    if (!sectionNeedsLayoutRepair(section, index.libraryId)) continue;
    let candidate = actions.find((action) =>
      action.folderPath === folderPath && action.type === 'unchanged'
    );
    if (!candidate) {
      candidate = actions.find((action) =>
        action.folderPath === folderPath && action.type === 'update'
      );
    }
    if (candidate) {
      if (candidate.type === 'unchanged') candidate.type = 'move';
      candidate.layoutOnly = true;
    }
  }
  actions.sort((a, b) => {
    const order = { conflict: 0, update: 1, move: 2, add: 3, delete: 4, unchanged: 5 };
    return (order[a.type] - order[b.type]) || a.relativePath.localeCompare(b.relativePath);
  });
}

function sectionNeedsLayoutRepair(section, libraryId) {
  if (!section || section.removed) return false;
  const managedNodes = section.children.filter((child) => isManagedSectionChild(child, libraryId));
  if (managedNodes.some((node) =>
    node.type === 'COMPONENT_SET' && componentSetNeedsLayoutRepair(node)
  )) return true;
  if (nodesOverlap(managedNodes, ITEM_GAP)) return true;

  let maxRight = 0;
  let maxBottom = 0;
  for (const child of section.children) {
    maxRight = Math.max(maxRight, child.x + child.width);
    maxBottom = Math.max(maxBottom, child.y + child.height);
  }
  const expectedWidth = Math.max(360, maxRight + SECTION_PADDING);
  const expectedHeight = Math.max(320, maxBottom + SECTION_PADDING);
  return Math.abs(section.width - expectedWidth) > 1 || Math.abs(section.height - expectedHeight) > 1;
}

function componentSetNeedsLayoutRepair(componentSet) {
  const children = componentSet.children.filter((child) => !child.removed);
  if (children.length === 0) return false;
  if (children.length === 1) return true;
  if (componentSetNeedsStrokeRepair(componentSet)) return true;
  if (nodesOverlap(children, VARIANT_GAP)) return true;

  const minX = children.reduce((min, node) => Math.min(min, node.x), children[0].x);
  const minY = children.reduce((min, node) => Math.min(min, node.y), children[0].y);
  const maxRight = children.reduce((max, node) => Math.max(max, node.x + node.width), 0);
  const maxBottom = children.reduce((max, node) => Math.max(max, node.y + node.height), 0);
  const expectedWidth = maxRight + VARIANT_PADDING;
  const expectedHeight = maxBottom + VARIANT_PADDING;
  const ratio = componentSet.width / Math.max(1, componentSet.height);
  return Math.abs(minX - VARIANT_PADDING) > 1 ||
    Math.abs(minY - VARIANT_PADDING) > 1 ||
    Math.abs(componentSet.width - expectedWidth) > 1 ||
    Math.abs(componentSet.height - expectedHeight) > 1 ||
    (children.length >= 4 && (ratio > 1.6 || ratio < 1 / 1.6));
}

function componentSetNeedsStrokeRepair(componentSet) {
  const strokes = Array.isArray(componentSet.strokes) ? componentSet.strokes : [];
  if (componentSet.strokeWeight !== 1 || componentSet.strokeAlign !== 'INSIDE') return true;
  if (strokes.length !== 1) return true;
  const stroke = strokes[0];
  const color = stroke && stroke.color;
  return !stroke || stroke.type !== 'SOLID' || stroke.visible === false || !color ||
    Math.abs(color.r - COMPONENT_SET_STROKE_COLOR.r) > 0.0001 ||
    Math.abs(color.g - COMPONENT_SET_STROKE_COLOR.g) > 0.0001 ||
    Math.abs(color.b - COMPONENT_SET_STROKE_COLOR.b) > 0.0001;
}

function applyComponentSetStroke(componentSet) {
  componentSet.strokes = [{
    type: 'SOLID',
    color: { ...COMPONENT_SET_STROKE_COLOR }
  }];
  componentSet.strokeWeight = 1;
  componentSet.strokeAlign = 'INSIDE';
}

function nodesOverlap(nodes, gap) {
  if (nodes.length < 2) return false;
  const averageSpan = nodes.reduce(
    (sum, node) => sum + Math.max(node.width, node.height) + gap,
    0
  ) / nodes.length;
  const cellSize = Math.max(32, averageSpan);
  const buckets = new Map();

  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const minColumn = Math.floor(node.x / cellSize);
    const maxColumn = Math.floor((node.x + node.width + gap - 0.001) / cellSize);
    const minRow = Math.floor(node.y / cellSize);
    const maxRow = Math.floor((node.y + node.height + gap - 0.001) / cellSize);
    const nearby = new Set();

    for (let row = minRow; row <= maxRow; row++) {
      for (let column = minColumn; column <= maxColumn; column++) {
        const bucket = buckets.get(`${column}:${row}`);
        if (bucket) for (const candidate of bucket) nearby.add(candidate);
      }
    }
    for (const candidate of nearby) {
      if (rectanglesOverlap(nodeRect(node), nodeRect(nodes[candidate]), gap)) return true;
    }
    for (let row = minRow; row <= maxRow; row++) {
      for (let column = minColumn; column <= maxColumn; column++) {
        const key = `${column}:${row}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(index);
      }
    }
  }
  return false;
}

function addMatchedResourceAction(actions, actionByPath, entry, remote) {
  const contentUnchanged =
    remote.hash && remote.hash === entry.hash &&
    sameSize(remote.width, remote.height, entry.width, entry.height);
  const pathChanged = remote.relativePath !== entry.relativePath;
  const folderChanged = remote.storedFolderPath !== entry.folderPath;
  const structureChanged = remote.needsStructureRepair === true;
  addAction(actions, actionByPath, {
    type: contentUnchanged && (pathChanged || folderChanged || structureChanged)
      ? 'move'
      : (contentUnchanged ? 'unchanged' : 'update'),
    folderPath: entry.folderPath,
    relativePath: entry.relativePath,
    oldRelativePath: pathChanged ? remote.relativePath : null,
    entry,
    node: remote.node
  });
}

function chooseReplacementCandidate(candidates, entry) {
  return candidates.slice().sort((a, b) => {
    const aHash = a.hash && a.hash === entry.hash ? 1 : 0;
    const bHash = b.hash && b.hash === entry.hash ? 1 : 0;
    if (aHash !== bHash) return bHash - aHash;
    const aSize = sameSize(a.width, a.height, entry.width, entry.height) ? 1 : 0;
    const bSize = sameSize(b.width, b.height, entry.width, entry.height) ? 1 : 0;
    if (aSize !== bSize) return bSize - aSize;
    if (a.lastModified !== b.lastModified) return b.lastModified - a.lastModified;
    return a.relativePath.localeCompare(b.relativePath);
  })[0];
}

function addAction(actions, actionByPath, action) {
  actions.push(action);
  if (action.type !== 'delete') actionByPath.set(action.relativePath, action);
}

function serializeAction(action) {
  return {
    type: action.type,
    folderPath: action.folderPath,
    relativePath: action.relativePath,
    oldRelativePath: action.oldRelativePath || null,
    name: action.entry ? action.entry.name : (action.name || basenameWithoutExtension(action.relativePath)),
    required: action.required === true,
    reason: action.reason || null
  };
}

function buildFolderSummaries(plan, index) {
  const summaries = new Map();
  const foldersWithLocalResources = new Set(
    plan.actions
      .filter((action) => action.type !== 'delete')
      .map((action) => action.folderPath)
  );

  for (const action of plan.actions) {
    if (!summaries.has(action.folderPath)) {
      summaries.set(action.folderPath, {
        folderPath: action.folderPath,
        status: index.sections.has(action.folderPath) ? 'existing' : 'new',
        counts: emptyActionCounts()
      });
    }
    summaries.get(action.folderPath).counts[action.type]++;
  }

  for (const [folderPath] of index.sections) {
    if (!summaries.has(folderPath)) continue;
    const summary = summaries.get(folderPath);
    const hasLocal = foldersWithLocalResources.has(folderPath);
    if (!hasLocal && summary.counts.delete > 0) summary.status = 'removed';
  }

  return Array.from(summaries.values()).sort((a, b) => a.folderPath.localeCompare(b.folderPath));
}

function countActions(actions) {
  const counts = emptyActionCounts();
  for (const action of actions) counts[action.type]++;
  return counts;
}

function emptyActionCounts() {
  return { add: 0, update: 0, delete: 0, move: 0, unchanged: 0, conflict: 0 };
}

function emptyStats() {
  return { added: 0, updated: 0, deleted: 0, moved: 0, unchanged: 0, skipped: 0, conflicts: 0 };
}

function emptyPerformanceStats() {
  return {
    startedAt: Date.now(),
    applyMs: 0,
    imageMs: 0,
    nodeMs: 0,
    batchCount: 0,
    imagesCreated: 0,
    imagesReused: 0
  };
}

function updateExistingComponent(component, entry, imageHash, action) {
  const previousMeta = readMeta(component) || {};
  const previousParent = component.parent;
  const oldWidth = component.width;
  const oldHeight = component.height;
  let rectangle = findImageRectangle(component);

  if (!rectangle) {
    rectangle = figma.createRectangle();
    rectangle.name = component.name;
    component.appendChild(rectangle);
  }

  rectangle.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash }];
  setManagedComponentName(component, entry);
  rectangle.name = entry.name;

  const dimensionsChanged = !sameSize(oldWidth, oldHeight, entry.width, entry.height);
  const folderChanged = normalizeFolderPath(previousMeta.folderPath) !== entry.folderPath;
  const expectsComponentSet = shouldUseComponentSet(entry);
  const insideComponentSet = previousParent && previousParent.type === 'COMPONENT_SET';
  const containerChanged = expectsComponentSet !== Boolean(insideComponentSet);
  const groupChanged = expectsComponentSet && insideComponentSet &&
    componentSetStorageKey(readMeta(previousParent), previousParent) !== componentSetKeyForEntry(entry);
  if (dimensionsChanged) {
    component.resizeWithoutConstraints(entry.width, entry.height);
    rectangle.resizeWithoutConstraints(entry.width, entry.height);
  }

  writeComponentMeta(component, entry, activeSync.libraryId, entry.hash);
  writeMeta(rectangle, {
    role: 'image',
    libraryId: activeSync.libraryId,
    relativePath: entry.relativePath
  });

  if (dimensionsChanged || folderChanged || groupChanged || containerChanged) {
    attachComponentToManagedGroup(component, entry);
    cleanupFormerContainer(previousParent);
  } else if (action && action.layoutOnly) {
    markTouchedContainer(component.parent);
  }

  activeSync.index.components.delete(normalizeRelativePath(previousMeta.relativePath));
  activeSync.index.components.set(entry.relativePath, component);
  activeSync.touchedNodes.add(component);
}

function createManagedComponent(entry, imageHash) {
  const component = figma.createComponent();
  component.name = entry.name;
  component.resizeWithoutConstraints(entry.width, entry.height);

  const rectangle = figma.createRectangle();
  rectangle.name = entry.name;
  rectangle.resizeWithoutConstraints(entry.width, entry.height);
  rectangle.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash }];
  component.appendChild(rectangle);

  writeComponentMeta(component, entry, activeSync.libraryId, entry.hash);
  writeMeta(rectangle, {
    role: 'image',
    libraryId: activeSync.libraryId,
    relativePath: entry.relativePath
  });

  attachComponentToManagedGroup(component, entry);
  activeSync.index.components.set(entry.relativePath, component);
  activeSync.touchedNodes.add(component);
  return component;
}

function moveExistingComponent(action) {
  const component = action.node;
  if (!component || component.removed) throw new Error('原 Component 已不存在。');
  const previousParent = component.parent;
  const previousMeta = readMeta(component) || {};
  const folderChanged = normalizeFolderPath(previousMeta.folderPath) !== action.entry.folderPath;
  const expectsComponentSet = shouldUseComponentSet(action.entry);
  const insideComponentSet = previousParent && previousParent.type === 'COMPONENT_SET';
  const containerChanged = expectsComponentSet !== Boolean(insideComponentSet);
  const groupChanged = expectsComponentSet && insideComponentSet &&
    componentSetStorageKey(readMeta(previousParent), previousParent) !== componentSetKeyForEntry(action.entry);
  const dimensionsChanged = !sameSize(
    previousMeta.width || component.width,
    previousMeta.height || component.height,
    action.entry.width,
    action.entry.height
  );

  activeSync.index.components.delete(normalizeRelativePath(previousMeta.relativePath));
  setManagedComponentName(component, action.entry);
  const rectangle = findImageRectangle(component);
  if (rectangle) rectangle.name = action.entry.name;

  writeComponentMeta(component, action.entry, activeSync.libraryId, action.entry.hash);
  if (rectangle) writeMeta(rectangle, {
    role: 'image',
    libraryId: activeSync.libraryId,
    relativePath: action.entry.relativePath
  });

  if (folderChanged || dimensionsChanged || groupChanged || containerChanged) {
    attachComponentToManagedGroup(component, action.entry);
    cleanupFormerContainer(previousParent);
  }
  if (action.layoutOnly) {
    const section = containingSection(component);
    if (section) {
      activeSync.repairSections.add(section);
      activeSync.touchedSections.add(section);
      for (const child of section.children) {
        if (child.type === 'COMPONENT_SET' && isManagedSectionChild(child)) {
          markTouchedComponentSet(child);
        }
      }
    } else {
      markTouchedContainer(component.parent);
    }
  }
  activeSync.index.components.set(action.entry.relativePath, component);
  activeSync.touchedNodes.add(component);
}

function deleteManagedComponent(action) {
  const component = action.node;
  if (!component || component.removed) return;
  const parent = component.parent;
  rememberTouchedSection(parent);
  if (activeSync.index.components.get(action.relativePath) === component) {
    activeSync.index.components.delete(action.relativePath);
  }
  safeRemoveNode(component);
  cleanupFormerContainer(parent);
}

function attachComponentToManagedGroup(component, entry) {
  const section = ensureManagedSection(entry.folderPath);
  activeSync.touchedSections.add(section);
  const key = componentSetKeyForEntry(entry);
  const setMapKey = groupKey(entry.folderPath, key);

  if (!shouldUseComponentSet(entry)) {
    const parentChanged = component.parent !== section;
    if (parentChanged) {
      section.appendChild(component);
      stageDirectChildForFinalLayout(section, component);
    }
    component.name = entry.name;
    activeSync.touchedNodes.add(component);
    return;
  }

  let componentSet = activeSync.index.componentSets.get(setMapKey);
  if (componentSet && componentSet.removed) {
    activeSync.index.componentSets.delete(setMapKey);
    componentSet = null;
  }

  if (componentSet) {
    component.name = formatEntryVariantName(componentSet, entry);
    componentSet.appendChild(component);
    writeComponentSetClassificationMeta(componentSet, entry);
    markTouchedComponentSet(componentSet);
    activeSync.touchedNodes.add(componentSet);
    return;
  }

  const standalone = findStandaloneComponent(section, key, component);
  if (standalone) {
    const anchorX = standalone.x;
    const anchorY = standalone.y;
    const standaloneMeta = readMeta(standalone) || {};
    standalone.name = `${sanitizeVariantToken(
      standaloneMeta.variantProperty || entry.variantProperty,
      DEFAULT_VARIANT_PROPERTY
    )}=${sanitizeVariantToken(standaloneMeta.variantValue || componentResourceName(
      standalone,
      standaloneMeta,
      standaloneMeta.relativePath || ''
    ), 'Resource')}`;
    component.name = formatEntryVariantName(null, entry);
    section.appendChild(component);
    const componentSetNode = figma.combineAsVariants([standalone, component], section);
    componentSetNode.name = entry.componentSetName || key;
    componentSetNode.x = anchorX - VARIANT_PADDING;
    componentSetNode.y = anchorY - VARIANT_PADDING;
    standalone.x = VARIANT_PADDING;
    standalone.y = VARIANT_PADDING;
    component.x = VARIANT_PADDING;
    component.y = VARIANT_PADDING;
    writeComponentSetClassificationMeta(componentSetNode, entry);
    normalizeComponentSetVariantNames(componentSetNode);
    activeSync.index.componentSets.set(setMapKey, componentSetNode);
    markTouchedComponentSet(componentSetNode);
    activeSync.touchedNodes.add(componentSetNode);
    return;
  }

  section.appendChild(component);
  stageDirectChildForFinalLayout(section, component);
  component.name = entry.name;
  activeSync.touchedNodes.add(component);
}

function ensureManagedSection(folderPath) {
  let section = activeSync.index.sections.get(folderPath);
  if (section && !section.removed) return section;

  section = figma.createSection();
  section.name = folderDisplayName(folderPath);
  section.resizeWithoutConstraints(360, 320);
  section.x = 0;
  section.y = 0;
  figma.currentPage.appendChild(section);
  writeMeta(section, {
    role: 'section',
    libraryId: activeSync.libraryId,
    rootName: activeSync.rootName,
    folderPath
  });
  activeSync.index.sections.set(folderPath, section);
  activeSync.newSections.add(section);
  activeSync.touchedNodes.add(section);
  activeSync.touchedSections.add(section);
  return section;
}

function findStandaloneComponent(section, key, excluded) {
  return section.children.find((child) => {
    if (child === excluded || child.type !== 'COMPONENT') return false;
    const meta = readMeta(child);
    if (!meta || meta.role !== 'component' || meta.libraryId !== activeSync.libraryId) return false;
    return componentStorageKey(meta, child) === key;
  }) || null;
}

function placeVariantWithoutMovingExisting(componentSet, component) {
  const state = getVariantLayoutState(componentSet, component);
  const componentMeta = readMeta(component) || {};
  const preferredSlot = Number.isInteger(componentMeta.layoutOrder)
    ? componentMeta.layoutOrder
    : state.nextSlot;
  const slots = [preferredSlot];
  for (let offset = 0; offset < 64; offset++) slots.push(state.nextSlot + offset);

  let fallback = null;
  let selected = null;
  let selectedSlot = null;
  const checked = new Set();

  for (const slot of slots) {
    if (slot < 0 || checked.has(slot) || state.occupiedSlots.has(slot)) continue;
    checked.add(slot);
    const candidate = variantSlotPosition(slot, component.width, component.height);
    const childRect = { x: candidate.x, y: candidate.y, width: component.width, height: component.height };
    if (state.hasIrregularRects &&
        state.rects.some((rect) => rectanglesOverlap(childRect, rect, VARIANT_GAP / 2))) continue;
    if (!fallback) fallback = { candidate, slot };

    const projectedWidth = Math.max(componentSet.width, candidate.x + component.width + VARIANT_PADDING);
    const projectedHeight = Math.max(componentSet.height, candidate.y + component.height + VARIANT_PADDING);
    if (!wouldOverlapSectionSiblings(componentSet, projectedWidth, projectedHeight)) {
      selected = candidate;
      selectedSlot = slot;
      break;
    }
  }

  if (!selected && fallback) {
    selected = fallback.candidate;
    selectedSlot = fallback.slot;
  }
  if (!selected) {
    selectedSlot = Math.max(state.nextSlot, state.occupiedSlots.size);
    selected = variantSlotPosition(selectedSlot, component.width, component.height);
  }

  component.x = selected.x;
  component.y = selected.y;
  state.occupiedSlots.add(selectedSlot);
  state.rects.push({ x: component.x, y: component.y, width: component.width, height: component.height });
  while (state.occupiedSlots.has(state.nextSlot)) state.nextSlot++;
  writeMeta(component, { ...componentMeta, slotIndex: selectedSlot });

  const width = Math.max(componentSet.width, component.x + component.width + VARIANT_PADDING);
  const height = Math.max(componentSet.height, component.y + component.height + VARIANT_PADDING);
  const collision = wouldOverlapSectionSiblings(componentSet, width, height);
  componentSet.resizeWithoutConstraints(width, height);
  if (componentSet.parent && componentSet.parent.type === 'SECTION') {
    expandSectionToFit(componentSet.parent);
  }

  return collision ? 'Component Set 扩展空间不足，已保持旧节点不动，请检查相邻布局。' : null;
}

function getVariantLayoutState(componentSet, excludedComponent) {
  let state = activeSync.variantLayoutCache.get(componentSet.id);
  if (state) return state;

  const occupiedSlots = new Set();
  const rects = [];
  let hasIrregularRects = false;
  let fallbackSlot = 0;
  const children = componentSet.children
    .filter((child) => child !== excludedComponent)
    .slice()
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));

  for (const child of children) {
    const meta = readMeta(child) || {};
    let slot = Number.isInteger(meta.slotIndex) ? meta.slotIndex : fallbackSlot;
    while (occupiedSlots.has(slot)) slot++;
    occupiedSlots.add(slot);
    fallbackSlot = Math.max(fallbackSlot, slot + 1);
    rects.push(nodeRect(child));
    const expected = variantSlotPosition(slot, child.width, child.height);
    if (Math.round(child.x) !== Math.round(expected.x) ||
        Math.round(child.y) !== Math.round(expected.y)) {
      hasIrregularRects = true;
    }
  }

  let nextSlot = 0;
  while (occupiedSlots.has(nextSlot)) nextSlot++;
  state = { occupiedSlots, rects, nextSlot, hasIrregularRects };
  activeSync.variantLayoutCache.set(componentSet.id, state);
  return state;
}

function variantSlotPosition(slot, width, height) {
  return {
    x: VARIANT_PADDING + (slot % VARIANT_COLUMNS) * (width + VARIANT_GAP),
    y: VARIANT_PADDING + Math.floor(slot / VARIANT_COLUMNS) * (height + VARIANT_GAP)
  };
}

function wouldOverlapSectionSiblings(node, projectedWidth, projectedHeight) {
  const parent = node.parent;
  if (!parent || parent.type !== 'SECTION') return false;
  const projected = { x: node.x, y: node.y, width: projectedWidth, height: projectedHeight };
  return parent.children.some((sibling) =>
    sibling !== node && rectanglesOverlap(projected, nodeRect(sibling), ITEM_GAP / 2)
  );
}

function stageDirectChildForFinalLayout(section, node) {
  // Direct children may overlap briefly while a batch is being imported. Their
  // only meaningful position is assigned once by relayoutManagedSection(). This
  // avoids an increasingly expensive empty-slot search for every standalone item.
  node.x = SECTION_PADDING;
  node.y = SECTION_CONTENT_TOP;
  activeSync.touchedSections.add(section);
}

function placeNewSection(section) {
  const sections = getTopLevelSections().filter((node) => node !== section);
  if (sections.length === 0) {
    section.x = 0;
    section.y = 0;
    return;
  }

  const minX = sections.reduce((min, node) => Math.min(min, node.x), sections[0].x);
  const maxRight = sections.reduce((max, node) => Math.max(max, node.x + node.width), 0);
  const maxBottom = sections.reduce((max, node) => Math.max(max, node.y + node.height), 0);

  if (maxRight - minX + SECTION_GAP + section.width <= MAX_SECTION_ROW_WIDTH) {
    section.x = maxRight + SECTION_GAP;
    section.y = sections.reduce((min, node) => Math.min(min, node.y), sections[0].y);
  } else {
    section.x = minX;
    section.y = maxBottom + SECTION_GAP;
  }
}

function expandSectionToFit(section) {
  if (!section || section.removed || section.type !== 'SECTION') return;
  let maxRight = 0;
  let maxBottom = 0;
  for (const child of section.children) {
    maxRight = Math.max(maxRight, child.x + child.width);
    maxBottom = Math.max(maxBottom, child.y + child.height);
  }
  section.resizeWithoutConstraints(
    Math.max(section.width, maxRight + SECTION_PADDING, 360),
    Math.max(section.height, maxBottom + SECTION_PADDING, 320)
  );
}

function cleanupFormerContainer(parent) {
  if (!parent || parent.removed) return;
  rememberTouchedSection(parent);
  if (parent.type === 'COMPONENT_SET') markTouchedComponentSet(parent);
  if (parent.type === 'COMPONENT_SET' && parent.children.length === 0) {
    const meta = readMeta(parent);
    if (meta && activeSync) {
      activeSync.index.componentSets.delete(groupKey(
        normalizeFolderPath(meta.folderPath),
        componentSetStorageKey(meta, parent)
      ));
    }
    safeRemoveNode(parent);
  }
}

async function cleanupTouchedSections() {
  const sections = Array.from(activeSync.touchedSections);
  const yieldSections = createMainThreadYielder();
  for (let index = 0; index < sections.length; index++) {
    const section = sections[index];
    if (!section) continue;
    const meta = readMeta(section) || {};
    const folderPath = normalizeFolderPath(meta.folderPath);
    if (section.removed) {
      activeSync.index.sections.delete(folderPath);
      continue;
    }
    if (section.children.length === 0 && meta.role === 'section' && meta.libraryId === activeSync.libraryId) {
      safeRemoveNode(section);
      activeSync.index.sections.delete(folderPath);
      continue;
    }
    await relayoutManagedSection(section);
    await yieldSections(index + 1 < sections.length, () => {
      emitSyncProgress(section.name || '', 'sections', {
        completed: index + 1,
        total: sections.length
      });
    });
  }
}

function markTouchedComponentSet(componentSet) {
  if (!activeSync || !componentSet || componentSet.type !== 'COMPONENT_SET') return;
  activeSync.touchedComponentSets.add(componentSet);
  rememberTouchedSection(componentSet);
}

function markTouchedContainer(node) {
  if (!node) return;
  if (node.type === 'COMPONENT_SET') markTouchedComponentSet(node);
  else rememberTouchedSection(node);
}

async function dissolveSingletonComponentSets() {
  const componentSets = Array.from(activeSync.touchedComponentSets);
  const yieldSets = createMainThreadYielder();
  for (let index = 0; index < componentSets.length; index++) {
    const componentSet = componentSets[index];
    if (!componentSet || componentSet.removed || componentSet.type !== 'COMPONENT_SET') continue;
    const components = componentSet.children.filter((child) =>
      child.type === 'COMPONENT' && !child.removed
    );
    if (components.length !== 1 || componentSet.children.length !== 1) continue;
    const section = componentSet.parent;
    if (!section || section.type !== 'SECTION') continue;

    const component = components[0];
    const componentMeta = readMeta(component) || {};
    const setMeta = readMeta(componentSet) || {};
    const absoluteX = componentSet.x + component.x;
    const absoluteY = componentSet.y + component.y;
    const setMapKey = groupKey(
      normalizeFolderPath(setMeta.folderPath || componentMeta.folderPath),
      componentSetStorageKey(setMeta, componentSet)
    );

    section.appendChild(component);
    component.x = absoluteX;
    component.y = absoluteY;
    component.name = componentResourceName(component, componentMeta, componentMeta.relativePath || '');
    const cleanedMeta = { ...componentMeta };
    delete cleanedMeta.slotIndex;
    writeMeta(component, cleanedMeta);

    if (activeSync.index.componentSets.get(setMapKey) === componentSet) {
      activeSync.index.componentSets.delete(setMapKey);
    }
    activeSync.touchedComponentSets.delete(componentSet);
    activeSync.touchedNodes.delete(componentSet);
    activeSync.touchedNodes.add(component);
    activeSync.touchedSections.add(section);
    // Moving the last child out can make Figma auto-delete the empty container.
    // safeRemoveNode keeps this cleanup idempotent in that case.
    safeRemoveNode(componentSet);
    await yieldSets(index + 1 < componentSets.length);
  }
}

async function compactTouchedComponentSets() {
  const componentSets = Array.from(activeSync.touchedComponentSets);
  const yieldSets = createMainThreadYielder();
  for (let index = 0; index < componentSets.length; index++) {
    const componentSet = componentSets[index];
    if (!componentSet || componentSet.removed || componentSet.children.length === 0) continue;
    await relayoutComponentSet(componentSet);
    await yieldSets(index + 1 < componentSets.length, () => {
      emitSyncProgress(componentSet.name || '', 'component-sets', {
        completed: index + 1,
        total: componentSets.length
      });
    });
  }
  activeSync.variantLayoutCache = new Map();
}

async function relayoutComponentSet(componentSet) {
  const children = componentSet.children
    .filter((child) => !child.removed)
    .slice()
    .sort(compareVariantLayoutOrder);
  if (children.length === 0) return;

  applyComponentSetStroke(componentSet);

  const layout = createNearSquareGrid(children, VARIANT_GAP);
  const yieldVariants = createMainThreadYielder();
  for (let index = 0; index < children.length; index++) {
    children[index].x = VARIANT_PADDING + layout.positions[index].x;
    children[index].y = VARIANT_PADDING + layout.positions[index].y;
    await yieldVariants(index + 1 < children.length);
  }
  componentSet.resizeWithoutConstraints(
    Math.max(1, layout.width + VARIANT_PADDING * 2),
    Math.max(1, layout.height + VARIANT_PADDING * 2)
  );
}

function compareVariantLayoutOrder(a, b) {
  const aMeta = readMeta(a) || {};
  const bMeta = readMeta(b) || {};
  const aEntry = activeSync.manifestByPath.get(normalizeRelativePath(aMeta.relativePath));
  const bEntry = activeSync.manifestByPath.get(normalizeRelativePath(bMeta.relativePath));
  const aOrder = aEntry && Number.isInteger(aEntry.layoutOrder)
    ? aEntry.layoutOrder
    : (Number.isInteger(aMeta.layoutOrder) ? aMeta.layoutOrder : Number.MAX_SAFE_INTEGER);
  const bOrder = bEntry && Number.isInteger(bEntry.layoutOrder)
    ? bEntry.layoutOrder
    : (Number.isInteger(bMeta.layoutOrder) ? bMeta.layoutOrder : Number.MAX_SAFE_INTEGER);
  return (aOrder - bOrder) || String(a.name || '').localeCompare(String(b.name || ''));
}

async function relayoutManagedSection(section) {
  if (!section || section.removed || section.type !== 'SECTION') return;
  const managedNodes = [];
  const manualNodes = [];

  for (const child of section.children) {
    if (isManagedSectionChild(child)) managedNodes.push(child);
    else manualNodes.push(child);
  }

  if (managedNodes.length > 0) {
    managedNodes.sort(compareSectionLayoutOrder);
    const layout = createCompactPacking(managedNodes, ITEM_GAP);
    const origin = chooseSectionLayoutOrigin(layout, manualNodes);
    const yieldNodes = createMainThreadYielder();
    for (let index = 0; index < managedNodes.length; index++) {
      managedNodes[index].x = origin.x + layout.positions[index].x;
      managedNodes[index].y = origin.y + layout.positions[index].y;
      await yieldNodes(index + 1 < managedNodes.length, () => {
        emitSyncProgress(section.name || '', 'section-layout', {
          completed: index + 1,
          total: managedNodes.length
        });
      });
    }
  }

  resizeSectionToContents(section);
}

function isManagedSectionChild(node, libraryId) {
  const targetLibraryId = libraryId || activeSync.libraryId;
  const meta = readMeta(node) || {};
  if (meta.libraryId === targetLibraryId &&
      (meta.role === 'component-set' || meta.role === 'component')) return true;
  return node.type === 'COMPONENT_SET' && node.children.some((child) => {
    const childMeta = readMeta(child) || {};
    return childMeta.role === 'component' && childMeta.libraryId === targetLibraryId;
  });
}

function compareSectionLayoutOrder(a, b) {
  const aMeta = readMeta(a) || {};
  const bMeta = readMeta(b) || {};
  const aSizeValue = aMeta.sizeKey || (aMeta.role === 'component'
    ? sizeKey(aMeta.width || a.width, aMeta.height || a.height)
    : a.name);
  const bSizeValue = bMeta.sizeKey || (bMeta.role === 'component'
    ? sizeKey(bMeta.width || b.width, bMeta.height || b.height)
    : b.name);
  const aSize = parseSizeKey(aSizeValue);
  const bSize = parseSizeKey(bSizeValue);
  return (aSize.area - bSize.area) ||
    (aSize.width - bSize.width) ||
    (aSize.height - bSize.height) ||
    String(a.name || '').localeCompare(String(b.name || ''));
}

function parseSizeKey(value) {
  const match = String(value || '').match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i);
  const width = match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  const height = match ? Number(match[2]) : Number.MAX_SAFE_INTEGER;
  return { width, height, area: width * height };
}

function chooseSectionLayoutOrigin(layout, manualNodes) {
  if (manualNodes.length === 0) {
    return { x: SECTION_PADDING, y: SECTION_CONTENT_TOP };
  }

  const manualRight = manualNodes.reduce((max, node) => Math.max(max, node.x + node.width), 0);
  const manualBottom = manualNodes.reduce((max, node) => Math.max(max, node.y + node.height), 0);
  const candidates = [
    { x: SECTION_PADDING, y: Math.max(SECTION_CONTENT_TOP, manualBottom + ITEM_GAP) },
    { x: Math.max(SECTION_PADDING, manualRight + ITEM_GAP), y: SECTION_CONTENT_TOP }
  ];
  let best = null;
  let minimumArea = Infinity;

  for (const candidate of candidates) {
    candidate.requiredWidth = Math.max(manualRight, candidate.x + layout.width) + SECTION_PADDING;
    candidate.requiredHeight = Math.max(manualBottom, candidate.y + layout.height) + SECTION_PADDING;
    candidate.area = candidate.requiredWidth * candidate.requiredHeight;
    minimumArea = Math.min(minimumArea, candidate.area);
  }
  for (const candidate of candidates) {
    const ratio = candidate.requiredWidth / Math.max(1, candidate.requiredHeight);
    const score = Math.abs(Math.log(ratio)) + (candidate.area / Math.max(1, minimumArea) - 1) * 0.18;
    if (!best || score < best.score) best = { ...candidate, score };
  }
  return { x: best.x, y: best.y };
}

function resizeSectionToContents(section) {
  let maxRight = 0;
  let maxBottom = 0;
  for (const child of section.children) {
    maxRight = Math.max(maxRight, child.x + child.width);
    maxBottom = Math.max(maxBottom, child.y + child.height);
  }
  section.resizeWithoutConstraints(
    Math.max(360, maxRight + SECTION_PADDING),
    Math.max(320, maxBottom + SECTION_PADDING)
  );
}

function createNearSquareGrid(nodes, gap) {
  const count = nodes.length;
  if (count === 0) return { width: 0, height: 0, positions: [] };
  const averageWidth = nodes.reduce((sum, node) => sum + node.width, 0) / count;
  const averageHeight = nodes.reduce((sum, node) => sum + node.height, 0) / count;
  const targetColumns = Math.max(1, Math.min(
    count,
    Math.round(Math.sqrt(count * (averageHeight + gap) / Math.max(1, averageWidth + gap)))
  ));
  const candidates = new Set([1, count]);
  for (let offset = -8; offset <= 8; offset++) {
    const columns = targetColumns + offset;
    if (columns >= 1 && columns <= count) candidates.add(columns);
  }

  let best = null;
  for (const columns of candidates) {
    const candidate = measureGrid(nodes, columns, gap);
    const ratio = candidate.width / Math.max(1, candidate.height);
    const emptyRatio = (candidate.rows * columns - count) / count;
    const score = Math.abs(Math.log(ratio)) + emptyRatio * 0.08;
    if (!best || score < best.score) best = { ...candidate, score };
  }
  return best;
}

function createCompactPacking(nodes, gap) {
  const count = nodes.length;
  if (count === 0) return { width: 0, height: 0, positions: [] };
  const totalArea = nodes.reduce(
    (sum, node) => sum + (node.width + gap) * (node.height + gap),
    0
  );
  const widest = nodes.reduce((max, node) => Math.max(max, node.width), 0);
  const baseWidth = Math.max(widest, Math.sqrt(totalArea));
  const widths = new Set([widest]);
  for (const factor of [0.7, 0.85, 1, 1.15, 1.35, 1.6, 1.9, 2.25]) {
    widths.add(Math.max(widest, Math.round(baseWidth * factor)));
  }

  let best = null;
  for (const width of widths) {
    const candidate = packIntoShelves(nodes, width, gap);
    const ratio = candidate.width / Math.max(1, candidate.height);
    const occupiedArea = nodes.reduce((sum, node) => sum + node.width * node.height, 0);
    const unusedRatio = 1 - occupiedArea / Math.max(1, candidate.width * candidate.height);
    const score = Math.abs(Math.log(ratio)) + unusedRatio * 0.42;
    if (!best || score < best.score) best = { ...candidate, score };
  }
  return best;
}

function packIntoShelves(nodes, targetWidth, gap) {
  const order = nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) =>
      (b.node.height - a.node.height) ||
      (b.node.width - a.node.width) ||
      (b.node.width * b.node.height - a.node.width * a.node.height) ||
      (a.index - b.index)
    );
  const positions = new Array(nodes.length);
  const shelves = [];
  let usedWidth = 0;
  let usedHeight = 0;

  for (const item of order) {
    let selected = null;
    for (const shelf of shelves) {
      if (item.node.height > shelf.height || shelf.nextX + item.node.width > targetWidth) continue;
      const heightWaste = shelf.height - item.node.height;
      const widthWaste = targetWidth - (shelf.nextX + item.node.width);
      const score = heightWaste * 2 + widthWaste;
      if (!selected || score < selected.score) selected = { shelf, score };
    }

    if (!selected) {
      const y = shelves.length === 0 ? 0 : usedHeight + gap;
      const shelf = { y, height: item.node.height, nextX: 0 };
      shelves.push(shelf);
      selected = { shelf, score: 0 };
      usedHeight = y + item.node.height;
    }

    const shelf = selected.shelf;
    positions[item.index] = { x: shelf.nextX, y: shelf.y };
    shelf.nextX += item.node.width + gap;
    usedWidth = Math.max(usedWidth, shelf.nextX - gap);
  }

  const height = shelves.reduce(
    (max, shelf) => Math.max(max, shelf.y + shelf.height),
    0
  );
  return { positions, width: usedWidth, height };
}

function measureGrid(nodes, columns, gap) {
  const rows = Math.ceil(nodes.length / columns);
  const columnWidths = new Array(columns).fill(0);
  const rowHeights = new Array(rows).fill(0);

  for (let index = 0; index < nodes.length; index++) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    columnWidths[column] = Math.max(columnWidths[column], nodes[index].width);
    rowHeights[row] = Math.max(rowHeights[row], nodes[index].height);
  }

  const columnOffsets = cumulativeOffsets(columnWidths, gap);
  const rowOffsets = cumulativeOffsets(rowHeights, gap);
  const positions = nodes.map((node, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      x: columnOffsets[column] + (columnWidths[column] - node.width) / 2,
      y: rowOffsets[row] + (rowHeights[row] - node.height) / 2
    };
  });
  return {
    columns,
    rows,
    positions,
    width: columnWidths.reduce((sum, value) => sum + value, 0) + gap * Math.max(0, columns - 1),
    height: rowHeights.reduce((sum, value) => sum + value, 0) + gap * Math.max(0, rows - 1)
  };
}

function cumulativeOffsets(sizes, gap) {
  const offsets = new Array(sizes.length).fill(0);
  for (let index = 1; index < sizes.length; index++) {
    offsets[index] = offsets[index - 1] + sizes[index - 1] + gap;
  }
  return offsets;
}

function containingSection(node) {
  let current = node;
  while (current && current.type !== 'SECTION') current = current.parent;
  return current && current.type === 'SECTION' ? current : null;
}

async function layoutMovableSections() {
  const candidates = new Map();
  for (const section of activeSync.newSections) candidates.set(section.id, section);
  for (const section of activeSync.repairSections) candidates.set(section.id, section);
  const sections = Array.from(candidates.values())
    .filter((section) => section && !section.removed)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  if (sections.length === 0) return;
  if (activeSync.newSections.size === 0 && sections.length === 1) return;

  const movableIds = new Set(sections.map((section) => section.id));
  const fixedSections = getTopLevelSections().filter((section) => !movableIds.has(section.id));
  const layout = createCompactPacking(sections, SECTION_GAP);
  const origin = fixedSections.length === 0
    ? {
        x: sections.reduce((min, section) => Math.min(min, section.x), sections[0].x),
        y: sections.reduce((min, section) => Math.min(min, section.y), sections[0].y)
      }
    : {
        x: fixedSections.reduce((min, section) => Math.min(min, section.x), fixedSections[0].x),
        y: fixedSections.reduce((max, section) => Math.max(max, section.y + section.height), 0) + SECTION_GAP
      };

  const yieldSections = createMainThreadYielder();
  for (let index = 0; index < sections.length; index++) {
    sections[index].x = origin.x + layout.positions[index].x;
    sections[index].y = origin.y + layout.positions[index].y;
    await yieldSections(index + 1 < sections.length);
  }
}

function createMainThreadYielder(maxItems, maxMilliseconds) {
  const itemLimit = Math.max(1, Number(maxItems) || MAIN_THREAD_YIELD_ITEMS);
  const timeLimit = Math.max(1, Number(maxMilliseconds) || MAIN_THREAD_YIELD_MS);
  let itemsSinceYield = 0;
  let lastYieldAt = Date.now();

  return async function checkpoint(hasMoreWork, beforeYield) {
    itemsSinceYield++;
    if (!hasMoreWork ||
        (itemsSinceYield < itemLimit && Date.now() - lastYieldAt < timeLimit)) return false;
    if (beforeYield) beforeYield();
    await new Promise((resolve) => setTimeout(resolve, 0));
    itemsSinceYield = 0;
    lastYieldAt = Date.now();
    return true;
  };
}

function safeRemoveNode(node) {
  if (!node) return false;
  try {
    if (node.removed) return false;
    node.remove();
    return true;
  } catch (error) {
    // Figma may auto-delete an empty structural node while its last child is
    // being reparented. Multiplayer edits can also remove a stored node between
    // the defensive check above and remove(). Both cases already reached the
    // requested end state, so they are safe to treat as an idempotent delete.
    try {
      if (node.removed) return false;
    } catch (_) {
      // Some stale node proxies throw even when reading `removed`.
    }
    const message = formatError(error);
    if (/node with id .* does not exist|node .* does not exist|has been removed/i.test(message)) {
      return false;
    }
    throw error;
  }
}

function rememberTouchedSection(node) {
  if (!activeSync || !node) return;
  if (node.type === 'SECTION') {
    activeSync.touchedSections.add(node);
    return;
  }
  if (node.parent && node.parent.type === 'SECTION') {
    activeSync.touchedSections.add(node.parent);
  }
}

function collectComponents(section) {
  const result = [];
  for (const child of section.children) {
    if (child.type === 'COMPONENT') result.push(child);
    if (child.type === 'COMPONENT_SET') {
      for (const variant of child.children) {
        if (variant.type === 'COMPONENT') result.push(variant);
      }
    }
  }
  return result;
}

function findImageRectangle(component) {
  const tagged = component.children.find((child) => {
    const meta = readMeta(child);
    return meta && meta.role === 'image';
  });
  if (tagged && tagged.type === 'RECTANGLE') return tagged;
  return component.children.find((child) => child.type === 'RECTANGLE') || null;
}

function writeComponentMeta(component, entry, libraryId, hash) {
  const old = readMeta(component) || {};
  writeMeta(component, {
    ...old,
    role: 'component',
    libraryId,
    rootName: activeSync ? activeSync.rootName : old.rootName,
    relativePath: entry.relativePath,
    resourceName: entry.name,
    folderPath: entry.folderPath,
    hash,
    width: entry.width,
    height: entry.height,
    sourceSize: entry.sourceSize,
    lastModified: entry.lastModified,
    layoutOrder: entry.layoutOrder,
    componentSetKey: entry.componentSetKey || null,
    componentSetName: entry.componentSetName || '',
    variantProperty: entry.variantProperty || DEFAULT_VARIANT_PROPERTY,
    variantValue: entry.variantValue || entry.name,
    classificationSource: entry.classificationSource || 'strict',
    classificationConfidence: Number(entry.classificationConfidence) || 0
  });
}

function readMeta(node) {
  if (!node || typeof node.getPluginData !== 'function') return null;
  const raw = node.getPluginData(META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function writeMeta(node, data) {
  node.setPluginData(META_KEY, JSON.stringify({ version: META_VERSION, ...data }));
}

function getTopLevelSections() {
  return figma.currentPage.children.filter((node) => node.type === 'SECTION');
}

function inferSetSizeKey(componentSet) {
  const first = componentSet.children.find((child) => child.type === 'COMPONENT');
  return first ? sizeKey(first.width, first.height) : '';
}

function componentSetKeyForEntry(entry) {
  return entry && entry.componentSetKey ? String(entry.componentSetKey) : null;
}

function componentStorageKey(meta, component) {
  if (meta && meta.componentSetKey) return String(meta.componentSetKey);
  return sizeKey((meta && meta.width) || component.width, (meta && meta.height) || component.height);
}

function componentSetStorageKey(meta, componentSet) {
  if (meta && meta.componentSetKey) return String(meta.componentSetKey);
  if (meta && meta.sizeKey) return String(meta.sizeKey);
  return inferSetSizeKey(componentSet);
}

function writeComponentSetClassificationMeta(componentSet, entry) {
  const key = componentSetKeyForEntry(entry);
  writeMeta(componentSet, {
    role: 'component-set',
    libraryId: activeSync.libraryId,
    rootName: activeSync.rootName,
    folderPath: entry.folderPath,
    componentSetKey: key,
    componentSetName: entry.componentSetName || key,
    variantProperty: entry.variantProperty || DEFAULT_VARIANT_PROPERTY,
    classificationSource: entry.classificationSource || 'strict',
    classificationConfidence: Number(entry.classificationConfidence) || 0,
    sizeKey: entry.classificationSource === 'strict' ? key : null
  });
  componentSet.name = entry.componentSetName || key;
}

function sizeKey(width, height) {
  return `${Math.round(width)}x${Math.round(height)}`;
}

function buildExpectedComponentSetGroups(manifest) {
  const counts = new Map();
  for (const entry of manifest) {
    const componentSetKey = componentSetKeyForEntry(entry);
    if (!componentSetKey) continue;
    const key = groupKey(entry.folderPath, componentSetKey);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return new Set(
    Array.from(counts.entries())
      .filter(([, count]) => count >= 2)
      .map(([key]) => key)
  );
}

function shouldUseComponentSet(entry) {
  const componentSetKey = componentSetKeyForEntry(entry);
  return Boolean(componentSetKey && activeSync && activeSync.expectedComponentSetGroups &&
    activeSync.expectedComponentSetGroups.has(groupKey(entry.folderPath, componentSetKey)));
}

function groupKey(folderPath, key) {
  return `${normalizeFolderPath(folderPath)}\u0000${key}`;
}

function folderDisplayName(folderPath) {
  if (folderPath === '_root') return '_root';
  return folderPath.split('/').pop() || folderPath;
}

function sameSize(aWidth, aHeight, bWidth, bHeight) {
  return Math.round(aWidth) === Math.round(bWidth) && Math.round(aHeight) === Math.round(bHeight);
}

function nodeRect(node) {
  return { x: node.x, y: node.y, width: node.width, height: node.height };
}

function rectanglesOverlap(a, b, gap) {
  return !(
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
  );
}

function groupBy(items, keyFn) {
  const result = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(item);
  }
  return result;
}

function assertActiveSync() {
  if (!activeSync) throw new Error('请先选择并扫描资源文件夹。');
}
