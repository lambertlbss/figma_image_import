const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const META_KEY = 'imageFolderImporterMeta';

test('UI inline script parses', () => {
  const html = fs.readFileSync(path.join(ROOT, 'ui.html'), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/i);
  assert.ok(match, 'inline script should exist');
  assert.doesNotThrow(() => new vm.Script(match[1]));
});

test('initial import creates a managed component set and identical sync is idempotent', async () => {
  const runtime = createRuntime();
  const manifest = [
    asset('icons/home.png', 'icons', 'home', 'h-home', 24, 24),
    asset('icons/search.png', 'icons', 'search', 'h-search', 24, 24)
  ];

  const prepared = await runtime.send('prepare-sync', { rootName: 'library', manifest });
  assert.equal(prepared.summary.add, 2);
  assert.equal(prepared.folders[0].status, 'new');

  await runtime.send('begin-sync', { selectedFolders: ['icons'], deleteMissing: true });
  await runtime.apply('icons/home.png', 24, 24);
  await runtime.apply('icons/search.png', 24, 24);
  await runtime.send('finish-sync', {});

  const section = runtime.section('icons');
  assert.ok(section);
  const componentSet = section.children.find((node) => node.type === 'COMPONENT_SET');
  assert.ok(componentSet);
  assert.equal(componentSet.name, '24x24');
  assert.equal(componentSet.children.length, 2);
  assertComponentSetStroke(componentSet);

  const before = runtime.componentSnapshot();
  const sectionBefore = {
    x: section.x,
    y: section.y,
    width: section.width,
    height: section.height
  };
  const second = await runtime.send('prepare-sync', { rootName: 'library', manifest });
  assert.equal(second.summary.unchanged, 2);
  assert.equal(second.summary.add, 0);
  assert.equal(second.summary.update, 0);

  await runtime.send('begin-sync', { selectedFolders: ['icons'], deleteMissing: true });
  const finish = await runtime.send('finish-sync', {});
  assert.equal(finish.stats.unchanged, 2);
  assert.deepEqual(runtime.componentSnapshot(), before);
  assert.deepEqual(
    { x: section.x, y: section.y, width: section.width, height: section.height },
    sectionBefore
  );
});

test('a single resource stays as a standalone Component', async () => {
  const runtime = createRuntime();
  const manifest = [asset('icons/home.png', 'icons', 'home', 'h-home', 24, 24)];
  await importAll(runtime, manifest);

  const section = runtime.section('icons');
  const component = runtime.component('icons/home.png').node;
  assert.equal(section.children.some((node) => node.type === 'COMPONENT_SET'), false);
  assert.equal(component.parent.id, section.id);
  assert.equal(component.name, 'home');
  const componentId = component.id;

  const prepared = await runtime.send('prepare-sync', { rootName: 'library', manifest });
  assert.equal(prepared.summary.move, 0);
  assert.equal(prepared.summary.unchanged, 1);
  await runtime.send('begin-sync', { selectedFolders: ['icons'], deleteMissing: true });
  await runtime.send('finish-sync', {});

  const after = runtime.component('icons/home.png').node;
  assert.equal(after.id, componentId);
  assert.equal(after.parent.id, section.id);
  assert.equal(after.name, 'home');
});

test('existing Component Set strokes are forcibly normalized during a style-only resync', async () => {
  const runtime = createRuntime();
  const manifest = [
    asset('icons/home.png', 'icons', 'home', 'h-home', 24, 24),
    asset('icons/search.png', 'icons', 'search', 'h-search', 24, 24)
  ];
  await importAll(runtime, manifest);
  const componentSet = runtime.section('icons').children.find((node) => node.type === 'COMPONENT_SET');
  componentSet.strokes = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }];
  componentSet.strokeWeight = 4;
  componentSet.strokeAlign = 'OUTSIDE';

  const prepared = await runtime.send('prepare-sync', { rootName: 'library', manifest });
  assert.equal(prepared.summary.move, 1);
  assert.equal(prepared.summary.unchanged, 1);
  await runtime.send('begin-sync', { selectedFolders: ['icons'], deleteMissing: true });
  await runtime.send('finish-sync', {});

  assertComponentSetStroke(componentSet);
});

test('deleting down to one resource dissolves the Component Set and keeps the Component id', async () => {
  const runtime = createRuntime();
  const original = [
    asset('icons/home.png', 'icons', 'home', 'h-home', 24, 24),
    asset('icons/search.png', 'icons', 'search', 'h-search', 24, 24)
  ];
  await importAll(runtime, original);
  const componentSet = runtime.section('icons').children.find((node) => node.type === 'COMPONENT_SET');
  const remainingId = runtime.component('icons/home.png').node.id;

  await runtime.send('prepare-sync', { rootName: 'library', manifest: [original[0]] });
  await runtime.send('begin-sync', { selectedFolders: ['icons'], deleteMissing: true });
  await runtime.send('finish-sync', {});

  const remaining = runtime.component('icons/home.png').node;
  assert.equal(componentSet.removed, true);
  assert.equal(remaining.id, remainingId);
  assert.equal(remaining.parent.type, 'SECTION');
  assert.equal(remaining.name, 'home');
});

test('invalid legacy variant names are repaired to strict key-value syntax', async () => {
  const runtime = createRuntime();
  const manifest = [
    asset('icons/home.png', 'icons', 'home', 'h-home', 24, 24),
    asset('icons/a,b=c.png', 'icons', 'a,b=c', 'h-special', 24, 24)
  ];
  const created = runtime.createManagedFolder('icons', manifest);
  created.components[0].name = 'home';
  created.components[1].name = 'a,b=c';

  const prepared = await runtime.send('prepare-sync', { rootName: 'library', manifest });
  assert.equal(prepared.summary.move, 2);
  assert.equal(prepared.summary.unchanged, 0);
  await runtime.send('begin-sync', { selectedFolders: ['icons'], deleteMissing: true });

  assert.deepEqual(
    Array.from(created.components, (component) => component.name),
    ['Property 1=home', 'Property 1=a_b_c']
  );
  for (const component of created.components) {
    assert.match(component.name, /^[^=,]+=[^=,]+$/);
  }
  await runtime.send('finish-sync', {});
});

test('an existing standalone managed Component remains standalone without image transfer', async () => {
  const runtime = createRuntime();
  const entry = asset('icons/home.png', 'icons', 'home', 'h-home', 24, 24);
  const created = runtime.createManagedFolder('icons', [entry]);
  const component = created.components[0];
  assert.equal(component.parent.type, 'SECTION');

  const prepared = await runtime.send('prepare-sync', {
    rootName: 'library',
    manifest: [entry]
  });
  assert.equal(prepared.summary.move, 1);
  assert.equal(prepared.summary.unchanged, 0);

  const begin = await runtime.send('begin-sync', {
    selectedFolders: ['icons'],
    deleteMissing: true
  });
  assert.deepEqual(Array.from(begin.fileActions), []);
  assert.equal(component.parent.type, 'SECTION');
  assert.equal(component.name, 'home');
  await runtime.send('finish-sync', {});
});

test('adding a second same-size resource converts standalone Components into a Component Set', async () => {
  const runtime = createRuntime();
  const first = asset('icons/home.png', 'icons', 'home', 'h-home', 24, 24);
  await importAll(runtime, [first]);
  const firstId = runtime.component(first.relativePath).node.id;
  const second = asset('icons/search.png', 'icons', 'search', 'h-search', 24, 24);

  await runtime.send('prepare-sync', { rootName: 'library', manifest: [first, second] });
  const begin = await runtime.send('begin-sync', { selectedFolders: ['icons'], deleteMissing: true });
  assert.deepEqual(Array.from(begin.fileActions), [second.relativePath]);
  await runtime.apply(second.relativePath, 24, 24);
  await runtime.send('finish-sync', {});

  const componentSet = runtime.section('icons').children.find((node) => node.type === 'COMPONENT_SET');
  assert.ok(componentSet);
  assert.equal(componentSet.children.length, 2);
  assert.equal(runtime.component(first.relativePath).node.id, firstId);
  assert.deepEqual(
    componentSet.children.map((node) => node.name).sort(),
    ['Property 1=home', 'Property 1=search']
  );
});

test('prepare scan reuses hashes for unchanged files and requests only changed content', async () => {
  const runtime = createRuntime();
  const manifest = [
    asset('icons/home.png', 'icons', 'home', 'h-home', 24, 24),
    asset('icons/search.png', 'icons', 'search', 'h-search', 24, 24),
    asset('weather/sun.png', 'weather', 'sun', 'h-sun', 32, 32)
  ];
  await importAll(runtime, manifest);

  const unchangedScan = await runtime.send('prepare-scan', {
    rootName: 'library',
    manifest: manifest.map(({ hash, ...entry }) => entry)
  });
  assert.equal(unchangedScan.hashPaths.length, 0);
  assert.equal(unchangedScan.knownHashes.length, 3);

  const changedStats = manifest.map(({ hash, ...entry }) => ({ ...entry }));
  changedStats[1].lastModified += 1;
  const changedScan = await runtime.send('prepare-scan', {
    rootName: 'library',
    manifest: changedStats
  });
  assert.deepEqual(Array.from(changedScan.hashPaths), ['icons/search.png']);
  assert.equal(changedScan.knownHashes.length, 2);

  const prepared = await runtime.send('prepare-sync', {
    rootName: 'library',
    manifest: changedStats.map((entry, index) => ({ ...entry, hash: manifest[index].hash }))
  });
  assert.equal(prepared.scanIndexReused, true);
});

test('reusing the prepared scan does not count legacy Section adoption twice', async () => {
  const runtime = createRuntime();
  const manifest = [asset('common/home.png', 'common', 'home', 'h-home', 24, 24)];
  runtime.createLegacyFolder('common', manifest);

  const preflight = await runtime.send('prepare-scan', {
    rootName: 'library',
    manifest: manifest.map(({ hash, ...entry }) => entry)
  });
  const prepared = await runtime.send('prepare-sync', { rootName: 'library', manifest });

  assert.equal(preflight.adopted, 1);
  assert.equal(prepared.scanIndexReused, true);
  assert.equal(prepared.adopted, 0);
  assert.equal(preflight.adopted + prepared.adopted, 1);
});

test('same-size replacement updates only the target image and preserves positions', async () => {
  const runtime = createRuntime();
  const original = [
    asset('icons/home.png', 'icons', 'home', 'h-home', 24, 24),
    asset('icons/search.png', 'icons', 'search', 'h-search', 24, 24)
  ];
  await importAll(runtime, original);

  const before = runtime.componentSnapshot();
  const changed = [
    asset('icons/home.png', 'icons', 'home', 'h-home-v2', 24, 24),
    original[1]
  ];
  const prepared = await runtime.send('prepare-sync', { rootName: 'library', manifest: changed });
  assert.equal(prepared.summary.update, 1);
  assert.equal(prepared.summary.unchanged, 1);

  const componentSet = runtime.section('icons').children.find((node) => node.type === 'COMPONENT_SET');
  let componentSetResizeCount = 0;
  const originalResize = componentSet.resizeWithoutConstraints.bind(componentSet);
  componentSet.resizeWithoutConstraints = (width, height) => {
    componentSetResizeCount++;
    originalResize(width, height);
  };

  await runtime.send('begin-sync', { selectedFolders: ['icons'], deleteMissing: true });
  await runtime.apply('icons/home.png', 24, 24);
  await runtime.send('finish-sync', {});

  const after = runtime.componentSnapshot();
  assert.deepEqual(
    after.map(({ id, x, y, parentId }) => ({ id, x, y, parentId })),
    before.map(({ id, x, y, parentId }) => ({ id, x, y, parentId }))
  );
  assert.equal(runtime.component('icons/home.png').meta.hash, 'h-home-v2');
  assert.equal(componentSetResizeCount, 0, 'content-only updates should not relayout the Component Set');
});

test('a newer same-name resource in the same Section replaces the old path and keeps the node id', async () => {
  const runtime = createRuntime();
  const original = asset('common/old/home.png', 'common/old', 'home', 'h-old', 24, 24);
  await importAll(runtime, [original]);
  const before = runtime.component(original.relativePath);

  const replacement = {
    ...asset('common/new/home.png', 'common/new', 'home', 'h-new', 24, 24),
    lastModified: original.lastModified + 1000
  };
  const prepared = await runtime.send('prepare-sync', {
    rootName: 'library',
    manifest: [replacement]
  });
  assert.equal(prepared.summary.update, 1);
  assert.equal(prepared.summary.add, 0);
  assert.equal(prepared.summary.delete, 0);

  await runtime.send('begin-sync', { selectedFolders: ['common'], deleteMissing: true });
  await runtime.apply(replacement.relativePath, 24, 24);
  await runtime.send('finish-sync', {});

  const after = runtime.component(replacement.relativePath);
  assert.equal(after.node.id, before.node.id);
  assert.equal(after.meta.hash, replacement.hash);
  assert.equal(runtime.component(original.relativePath), null);
});

test('a same-name replacement can change dimensions without creating another Component', async () => {
  const runtime = createRuntime();
  const original = asset('common/small/badge.png', 'common/small', 'badge', 'h-small', 24, 24);
  await importAll(runtime, [original]);
  const before = runtime.component(original.relativePath);
  const replacement = asset('common/large/badge.png', 'common/large', 'badge', 'h-large', 48, 32);

  const prepared = await runtime.send('prepare-sync', {
    rootName: 'library',
    manifest: [replacement]
  });
  assert.equal(prepared.summary.update, 1);
  await runtime.send('begin-sync', { selectedFolders: ['common'], deleteMissing: true });
  await runtime.apply(replacement.relativePath, 48, 32);
  await runtime.send('finish-sync', {});

  const after = runtime.component(replacement.relativePath);
  assert.equal(after.node.id, before.node.id);
  assert.equal(after.node.width, 48);
  assert.equal(after.node.height, 32);
  assert.equal(runtime.componentSnapshot().length, 1);
});

test('local same-name resources in one Section keep only the newest file', async () => {
  const runtime = createRuntime();
  const older = {
    ...asset('common/a/icon.png', 'common/a', 'icon', 'h-old', 24, 24),
    lastModified: 100
  };
  const newer = {
    ...asset('common/b/icon.png', 'common/b', 'icon', 'h-new', 24, 24),
    lastModified: 200
  };

  const prepared = await runtime.send('prepare-sync', {
    rootName: 'library',
    manifest: [older, newer]
  });
  assert.equal(prepared.summary.add, 1);
  assert.equal(prepared.actions.length, 1);
  assert.equal(prepared.actions[0].relativePath, newer.relativePath);

  const begin = await runtime.send('begin-sync', {
    selectedFolders: ['common'],
    deleteMissing: true
  });
  assert.deepEqual(Array.from(begin.fileActions), [newer.relativePath]);
  await runtime.apply(newer.relativePath, 24, 24);
  await runtime.send('finish-sync', {});
  assert.ok(runtime.component(newer.relativePath));
  assert.equal(runtime.component(older.relativePath), null);
});

test('existing managed duplicates are removed even when missing-file deletion is disabled', async () => {
  const runtime = createRuntime();
  const existing = [
    asset('icon/a/hero_caopi_01.png', 'icon/a', 'hero_caopi_01', 'h-a', 90, 90),
    asset('icon/b/hero_caopi_01.png', 'icon/b', 'hero_caopi_01', 'h-b', 90, 90),
    asset('icon/c/hero_caopi_01.png', 'icon/c', 'hero_caopi_01', 'h-c', 90, 90)
  ];
  const created = runtime.createManagedFolder('icon', existing);
  for (const component of created.components) {
    component.name = 'Property 1=hero_caopi_01';
  }

  const replacement = asset(
    'icon/latest/hero_caopi_01.png',
    'icon/latest',
    'hero_caopi_01',
    'h-latest',
    90,
    90
  );
  const prepared = await runtime.send('prepare-sync', {
    rootName: 'library',
    manifest: [replacement]
  });

  assert.equal(prepared.summary.update, 1);
  assert.equal(prepared.summary.delete, 2);
  assert.equal(prepared.actions.filter((action) => action.type === 'delete' && action.required).length, 2);

  const begin = await runtime.send('begin-sync', {
    selectedFolders: ['icon'],
    deleteMissing: false
  });
  assert.equal(begin.pendingDeletes, 2);
  await runtime.apply(replacement.relativePath, 90, 90);
  const finish = await runtime.send('finish-sync', {});

  assert.equal(finish.stats.updated, 1);
  assert.equal(finish.stats.deleted, 2);
  assert.equal(runtime.componentSnapshot().length, 1);
  assert.ok(runtime.component(replacement.relativePath));
});

test('untagged same-name variants inside a managed Section are cleaned without touching other manual content', async () => {
  const runtime = createRuntime();
  const current = asset('icon/current/home.png', 'icon/current', 'home', 'h-home', 90, 90);
  const duplicateA = asset('icon/old-a/home.png', 'icon/old-a', 'home', 'h-old-a', 90, 90);
  const duplicateB = asset('icon/old-b/home.png', 'icon/old-b', 'home', 'h-old-b', 90, 90);
  const created = runtime.createManagedFolder('icon', [current, duplicateA, duplicateB]);

  created.components.forEach((component, index) => {
    component.name = 'Property 1=home';
    if (index > 0) component.setPluginData(META_KEY, '');
  });
  const unrelated = runtime.figma.createComponent();
  unrelated.name = 'Property 1=manual-only';
  created.section.appendChild(unrelated);

  const prepared = await runtime.send('prepare-sync', {
    rootName: 'library',
    manifest: [current]
  });
  assert.equal(prepared.summary.unchanged, 0);
  assert.equal(prepared.summary.move, 1);
  assert.equal(prepared.summary.delete, 2);

  const begin = await runtime.send('begin-sync', {
    selectedFolders: ['icon'],
    deleteMissing: false
  });
  assert.equal(begin.pendingDeletes, 2);
  const finish = await runtime.send('finish-sync', {});

  assert.equal(finish.stats.deleted, 2);
  assert.equal(created.components.filter((component) => !component.removed).length, 1);
  assert.equal(unrelated.removed, false);
  assert.ok(runtime.component(current.relativePath));
});

test('a legacy Section containing duplicate variants is adopted and deduplicated in one sync', async () => {
  const runtime = createRuntime();
  const legacyEntries = [
    asset('legacy/a/home.png', 'legacy/a', 'home', '', 90, 90),
    asset('legacy/b/home.png', 'legacy/b', 'home', '', 90, 90),
    asset('legacy/c/home.png', 'legacy/c', 'home', '', 90, 90)
  ];
  const created = runtime.createLegacyFolder('icon', legacyEntries);
  for (const component of created.components) {
    component.name = 'Property 1=home';
  }

  const replacement = asset('icon/latest/home.png', 'icon/latest', 'home', 'h-latest', 90, 90);
  const prepared = await runtime.send('prepare-sync', {
    rootName: 'library',
    manifest: [replacement]
  });

  assert.equal(prepared.adopted, 1);
  assert.equal(prepared.summary.update, 1);
  assert.equal(prepared.summary.delete, 2);

  const begin = await runtime.send('begin-sync', {
    selectedFolders: ['icon'],
    deleteMissing: false
  });
  assert.equal(begin.pendingDeletes, 2);
  await runtime.apply(replacement.relativePath, 90, 90);
  const finish = await runtime.send('finish-sync', {});

  assert.equal(finish.stats.updated, 1);
  assert.equal(finish.stats.deleted, 2);
  assert.equal(created.components.filter((component) => !component.removed).length, 1);
  assert.ok(runtime.component(replacement.relativePath));
});

test('add and delete inside one component set leave unchanged variants in place', async () => {
  const runtime = createRuntime();
  const original = [
    asset('icons/home.png', 'icons', 'home', 'h-home', 24, 24),
    asset('icons/search.png', 'icons', 'search', 'h-search', 24, 24)
  ];
  await importAll(runtime, original);
  const homeBefore = runtime.component('icons/home.png');

  const next = [
    original[0],
    asset('icons/settings.png', 'icons', 'settings', 'h-settings', 24, 24)
  ];
  const prepared = await runtime.send('prepare-sync', { rootName: 'library', manifest: next });
  assert.equal(prepared.summary.add, 1);
  assert.equal(prepared.summary.delete, 1);

  await runtime.send('begin-sync', { selectedFolders: ['icons'], deleteMissing: true });
  await runtime.apply('icons/settings.png', 24, 24);
  await runtime.send('finish-sync', {});

  const homeAfter = runtime.component('icons/home.png');
  assert.equal(homeAfter.node.id, homeBefore.node.id);
  assert.equal(homeAfter.node.x, homeBefore.node.x);
  assert.equal(homeAfter.node.y, homeBefore.node.y);
  assert.equal(homeAfter.node.parent.id, homeBefore.node.parent.id);
  assert.equal(runtime.component('icons/search.png'), null);
  assert.ok(runtime.component('icons/settings.png'));
});

test('new folder creates a new section without moving existing sections', async () => {
  const runtime = createRuntime();
  const original = [asset('icons/home.png', 'icons', 'home', 'h-home', 24, 24)];
  await importAll(runtime, original);
  const existing = runtime.section('icons');
  const oldPosition = { x: existing.x, y: existing.y };

  const next = [
    ...original,
    asset('weather/sun.png', 'weather', 'sun', 'h-sun', 32, 32)
  ];
  const prepared = await runtime.send('prepare-sync', { rootName: 'library', manifest: next });
  assert.equal(prepared.folders.find((folder) => folder.folderPath === 'weather').status, 'new');

  await runtime.send('begin-sync', { selectedFolders: ['icons', 'weather'], deleteMissing: true });
  await runtime.apply('weather/sun.png', 32, 32);
  await runtime.send('finish-sync', {});

  assert.deepEqual({ x: existing.x, y: existing.y }, oldPosition);
  assert.ok(runtime.section('weather'));
});

test('nested directories share one Section named after the first-level folder', async () => {
  const runtime = createRuntime();
  const manifest = [
    asset('common/zhandouli/a.png', 'common/zhandouli', 'a', 'h-a', 24, 24),
    asset('common/战斗字体/b.png', 'common/战斗字体', 'b', 'h-b', 32, 32)
  ];

  const prepared = await runtime.send('prepare-sync', { rootName: 'library', manifest });
  assert.deepEqual(Array.from(prepared.folders, (folder) => folder.folderPath), ['common']);
  await runtime.send('begin-sync', { selectedFolders: ['common'], deleteMissing: true });
  await runtime.apply(manifest[0].relativePath, 24, 24);
  await runtime.apply(manifest[1].relativePath, 32, 32);
  await runtime.send('finish-sync', {});

  assert.ok(runtime.section('common'));
  assert.equal(runtime.section('common/zhandouli'), null);
  assert.equal(runtime.section('common/战斗字体'), null);
  const firstParent = runtime.component(manifest[0].relativePath).node.parent;
  const secondParent = runtime.component(manifest[1].relativePath).node.parent;
  assert.equal(firstParent.type, 'SECTION');
  assert.equal(secondParent.type, 'SECTION');
  assert.equal(firstParent.id, runtime.section('common').id);
  assert.equal(secondParent.id, runtime.section('common').id);
});

test('identical nested folder names under different first-level folders stay separate', async () => {
  const runtime = createRuntime();
  const manifest = [
    asset('common/icons/home.png', 'common/icons', 'home', 'h-home', 24, 24),
    asset('battle/icons/sword.png', 'battle/icons', 'sword', 'h-sword', 24, 24)
  ];
  await importAll(runtime, manifest);

  assert.ok(runtime.section('common'));
  assert.ok(runtime.section('battle'));
  assert.equal(runtime.section('icons'), null);
});

test('dimension changes keep the component id and move only that component to a new size group', async () => {
  const runtime = createRuntime();
  const original = [
    asset('icons/home.png', 'icons', 'home', 'h-home', 24, 24),
    asset('icons/search.png', 'icons', 'search', 'h-search', 24, 24)
  ];
  await importAll(runtime, original);
  const homeBefore = runtime.component('icons/home.png');
  const searchBefore = runtime.component('icons/search.png');

  const changed = [
    asset('icons/home.png', 'icons', 'home', 'h-home-large', 32, 32),
    original[1]
  ];
  await runtime.send('prepare-sync', { rootName: 'library', manifest: changed });
  await runtime.send('begin-sync', { selectedFolders: ['icons'], deleteMissing: true });
  await runtime.apply('icons/home.png', 32, 32);
  await runtime.send('finish-sync', {});

  const homeAfter = runtime.component('icons/home.png');
  const searchAfter = runtime.component('icons/search.png');
  assert.equal(homeAfter.node.id, homeBefore.node.id);
  assert.equal(homeAfter.node.width, 32);
  assert.equal(homeAfter.node.height, 32);
  assert.equal(searchAfter.node.id, searchBefore.node.id);
  assert.equal(homeAfter.node.parent.type, 'SECTION');
  assert.equal(searchAfter.node.parent.type, 'SECTION');
  assert.equal(runtime.section('icons').children.some((node) => node.type === 'COMPONENT_SET'), false);
});

test('same-folder rename preserves node id and coordinates', async () => {
  const runtime = createRuntime();
  const original = [asset('icons/home.png', 'icons', 'home', 'same-hash', 24, 24)];
  await importAll(runtime, original);
  const before = runtime.component('icons/home.png');

  const renamed = [asset('icons/house.png', 'icons', 'house', 'same-hash', 24, 24)];
  const prepared = await runtime.send('prepare-sync', { rootName: 'library', manifest: renamed });
  assert.equal(prepared.summary.move, 1);
  await runtime.send('begin-sync', { selectedFolders: ['icons'], deleteMissing: true });
  await runtime.send('finish-sync', {});

  const after = runtime.component('icons/house.png');
  assert.equal(after.node.id, before.node.id);
  assert.equal(after.node.x, before.node.x);
  assert.equal(after.node.y, before.node.y);
  assert.equal(after.node.name, 'house');
});

test('delete preview can be declined without removing managed components', async () => {
  const runtime = createRuntime();
  const original = [
    asset('icons/home.png', 'icons', 'home', 'h-home', 24, 24),
    asset('icons/search.png', 'icons', 'search', 'h-search', 24, 24)
  ];
  await importAll(runtime, original);

  await runtime.send('prepare-sync', { rootName: 'library', manifest: [original[0]] });
  await runtime.send('begin-sync', { selectedFolders: ['icons'], deleteMissing: false });
  await runtime.send('finish-sync', {});
  assert.ok(runtime.component('icons/search.png'));
});

test('special folder names do not collide with object prototypes', async () => {
  const runtime = createRuntime();
  const manifest = [asset('__proto__/safe.png', '__proto__', 'safe', 'h-safe', 16, 16)];
  await importAll(runtime, manifest);
  assert.ok(runtime.section('__proto__'));
  assert.ok(runtime.component('__proto__/safe.png'));
});

test('legacy sections are adopted in place before the first incremental sync', async () => {
  const runtime = createRuntime();
  const manifest = [
    asset('icons/home.png', 'icons', 'home', 'h-home', 24, 24),
    asset('icons/search.png', 'icons', 'search', 'h-search', 24, 24)
  ];
  const legacy = runtime.createLegacyFolder('icons', manifest);
  const oldSectionPosition = { x: legacy.section.x, y: legacy.section.y };
  const oldIds = legacy.components.map((node) => node.id).sort();

  const prepared = await runtime.send('prepare-sync', { rootName: 'library', manifest });
  assert.equal(prepared.adopted, 2);
  assert.equal(prepared.summary.update, 2);
  assert.equal(prepared.summary.add, 0);

  await runtime.send('begin-sync', { selectedFolders: ['icons'], deleteMissing: true });
  await runtime.apply('icons/home.png', 24, 24);
  await runtime.apply('icons/search.png', 24, 24);
  await runtime.send('finish-sync', {});

  assert.deepEqual({ x: legacy.section.x, y: legacy.section.y }, oldSectionPosition);
  assert.deepEqual(runtime.componentSnapshot().map((item) => item.id).sort(), oldIds);
});

test('a unique legacy same-name Component is replaced even when its dimensions changed', async () => {
  const runtime = createRuntime();
  const oldEntry = asset('common/home.png', 'common', 'home', 'old', 24, 24);
  const legacy = runtime.createLegacyFolder('common', [oldEntry]);
  const replacement = asset('common/nested/home.png', 'common/nested', 'home', 'new', 40, 32);

  const prepared = await runtime.send('prepare-sync', {
    rootName: 'library',
    manifest: [replacement]
  });
  assert.equal(prepared.adopted, 1);
  assert.equal(prepared.summary.update, 1);
  await runtime.send('begin-sync', { selectedFolders: ['common'], deleteMissing: true });
  await runtime.apply(replacement.relativePath, 40, 32);
  await runtime.send('finish-sync', {});

  const after = runtime.component(replacement.relativePath);
  assert.equal(after.node.id, legacy.components[0].id);
  assert.equal(after.node.width, 40);
  assert.equal(after.node.height, 32);
});

test('a unique empty same-name Section is reused and its manual content is preserved', async () => {
  const runtime = createRuntime();
  const existing = runtime.createLegacyFolder('common', []);
  const manualNode = runtime.figma.createRectangle();
  manualNode.name = 'manual-note';
  manualNode.x = 48;
  manualNode.y = 156;
  manualNode.resizeWithoutConstraints(80, 40);
  const manualPosition = { x: manualNode.x, y: manualNode.y };
  existing.section.appendChild(manualNode);
  const manifest = [asset('common/icons/home.png', 'common', 'home', 'h-home', 24, 24)];

  const prepared = await runtime.send('prepare-sync', { rootName: 'library', manifest });
  assert.equal(prepared.summary.add, 1);
  await runtime.send('begin-sync', { selectedFolders: ['common'], deleteMissing: true });
  await runtime.apply(manifest[0].relativePath, 24, 24);
  await runtime.send('finish-sync', {});

  assert.equal(runtime.section('common').id, existing.section.id);
  assert.equal(manualNode.parent.id, existing.section.id);
  assert.equal(manualNode.removed, false);
  assert.deepEqual({ x: manualNode.x, y: manualNode.y }, manualPosition);
  assertNoOverlap(existing.section.children, 0);
});

test('multiple untagged same-name Sections are reported as a conflict instead of creating another', async () => {
  const runtime = createRuntime();
  runtime.createLegacyFolder('common', []);
  runtime.createLegacyFolder('common', []);
  const manifest = [asset('common/home.png', 'common', 'home', 'h-home', 24, 24)];

  const prepared = await runtime.send('prepare-sync', { rootName: 'library', manifest });
  assert.equal(prepared.summary.conflict, 1);
  assert.equal(prepared.summary.add, 0);
  assert.ok(prepared.conflicts.some((message) => message.includes('2 个同名 Section')));
});

test('apply batch imports multiple resources in order through one request', async () => {
  const runtime = createRuntime();
  const manifest = Array.from({ length: 16 }, (_, index) =>
    asset(`common/icon-${index}.png`, 'common', `icon-${index}`, `h-${index}`, 24, 24)
  );
  await runtime.send('prepare-sync', { rootName: 'library', manifest });
  await runtime.send('begin-sync', { selectedFolders: ['common'], deleteMissing: true });
  const batch = await runtime.send('apply-batch', {
    files: manifest.map((entry) => ({
      relativePath: entry.relativePath,
      bytes: new Uint8Array([1, 2, 3]).buffer
    }))
  });
  const componentSet = runtime.section('common').children.find((node) => node.type === 'COMPONENT_SET');
  assert.equal(componentSet.children.length, manifest.length);
  assert.equal(componentSet.width, 1, 'variant layout should be deferred until finish-sync');
  const finish = await runtime.send('finish-sync', {});

  assert.equal(batch.results.length, manifest.length);
  assert.ok(batch.results.every((result) => result.status === 'ok'));
  assert.equal(finish.stats.added, manifest.length);
  assert.ok(componentSet.width > 1);
  assert.ok(finish.timings.layoutMs >= 0);
});

test('identical SHA-256 resources reuse one Figma image during the same sync', async () => {
  const runtime = createRuntime();
  const sharedHash = `sha256:${'a'.repeat(64)}`;
  const manifest = [
    asset('common/first.png', 'common', 'first', sharedHash, 24, 24),
    asset('common/second.png', 'common', 'second', sharedHash, 24, 24)
  ];
  await runtime.send('prepare-sync', { rootName: 'library', manifest });
  await runtime.send('begin-sync', { selectedFolders: ['common'], deleteMissing: true });
  await runtime.send('apply-batch', {
    files: manifest.map((entry) => ({
      relativePath: entry.relativePath,
      bytes: new Uint8Array([1, 2, 3]).buffer
    }))
  });
  const finish = await runtime.send('finish-sync', {});

  assert.equal(finish.timings.imagesCreated, 1);
  assert.equal(finish.timings.imagesReused, 1);
});

test('managed deep-folder Sections migrate into one first-level Section without replacing components', async () => {
  const runtime = createRuntime();
  const first = asset('common/a/home.png', 'common/a', 'home', 'h-home', 24, 24);
  const second = asset('common/b/search.png', 'common/b', 'search', 'h-search', 24, 24);
  const oldA = runtime.createManagedFolder('common/a', [first]);
  const oldB = runtime.createManagedFolder('common/b', [second]);
  const oldIds = [...oldA.components, ...oldB.components].map((node) => node.id).sort();

  const prepared = await runtime.send('prepare-sync', {
    rootName: 'library',
    manifest: [first, second]
  });
  assert.equal(prepared.summary.move, 2);
  assert.deepEqual(Array.from(prepared.folders, (folder) => folder.folderPath), ['common']);

  await runtime.send('begin-sync', { selectedFolders: ['common'], deleteMissing: true });
  await runtime.send('finish-sync', {});

  assert.ok(runtime.section('common'));
  assert.equal(runtime.section('common/a'), null);
  assert.equal(runtime.section('common/b'), null);
  assert.deepEqual(runtime.componentSnapshot().map((item) => item.id).sort(), oldIds);
});

test('large Component Sets are compacted into a near-square grid and shrink after deletions', async () => {
  const runtime = createRuntime();
  const original = Array.from({ length: 63 }, (_, index) =>
    asset(`icons/icon-${index}.png`, 'icons', `icon-${index}`, `h-${index}`, 24, 24)
  );
  await importAll(runtime, original);

  const section = runtime.section('icons');
  const componentSet = section.children.find((node) => node.type === 'COMPONENT_SET');
  const originalSize = { width: componentSet.width, height: componentSet.height };
  assertNoOverlap(componentSet.children, 20);
  assert.ok(aspectRatio(componentSet) <= 1.15, `Component Set ratio was ${aspectRatio(componentSet)}`);
  assert.equal(componentSet.width, Math.max(...componentSet.children.map((node) => node.x + node.width)) + 20);
  assert.equal(componentSet.height, Math.max(...componentSet.children.map((node) => node.y + node.height)) + 20);

  const remaining = original.slice(0, 16);
  await runtime.send('prepare-sync', { rootName: 'library', manifest: remaining });
  await runtime.send('begin-sync', { selectedFolders: ['icons'], deleteMissing: true });
  await runtime.send('finish-sync', {});

  assert.equal(componentSet.children.length, remaining.length);
  assert.ok(componentSet.width < originalSize.width);
  assert.ok(componentSet.height < originalSize.height);
  assertNoOverlap(componentSet.children, 20);
  assert.ok(aspectRatio(componentSet) <= 1.15, `Shrunk Component Set ratio was ${aspectRatio(componentSet)}`);
});

test('mixed-size Component Sets are compactly packed with doubled Section margins', async () => {
  const runtime = createRuntime();
  const specs = [
    { width: 16, height: 16, count: 16 },
    { width: 24, height: 24, count: 12 },
    { width: 32, height: 32, count: 9 },
    { width: 64, height: 32, count: 8 }
  ];
  const manifest = specs.flatMap((spec) => Array.from({ length: spec.count }, (_, index) =>
    asset(
      `common/${spec.width}x${spec.height}-${index}.png`,
      'common',
      `${spec.width}x${spec.height}-${index}`,
      `h-${spec.width}-${spec.height}-${index}`,
      spec.width,
      spec.height
    )
  ));
  await importAll(runtime, manifest);

  const section = runtime.section('common');
  const componentSets = section.children.filter((node) => node.type === 'COMPONENT_SET');
  assert.equal(componentSets.length, specs.length);
  assertNoOverlap(componentSets, 100);
  const minX = Math.min(...componentSets.map((node) => node.x));
  const minY = Math.min(...componentSets.map((node) => node.y));
  const maxRight = Math.max(...componentSets.map((node) => node.x + node.width));
  const maxBottom = Math.max(...componentSets.map((node) => node.y + node.height));
  const occupiedArea = componentSets.reduce((sum, node) => sum + node.width * node.height, 0);
  const contentArea = (maxRight - minX) * (maxBottom - minY);
  assert.equal(minX, 192);
  assert.equal(minY, 272);
  assert.ok(section.width - maxRight >= 192);
  assert.ok(section.height - maxBottom >= 192);
  assert.ok(occupiedArea / contentArea >= 0.55, `Section content fill was ${occupiedArea / contentArea}`);
  assert.equal(section.width, Math.max(360, ...componentSets.map((node) => node.x + node.width + 192)));
  assert.equal(section.height, Math.max(320, ...componentSets.map((node) => node.y + node.height + 192)));
  assert.ok(aspectRatio(section) <= 1.8, `Section ratio was ${aspectRatio(section)}`);
});

test('an unchanged but malformed layout is exposed as one repair move and fixed on resync', async () => {
  const runtime = createRuntime();
  const manifest = Array.from({ length: 16 }, (_, index) =>
    asset(`icons/icon-${index}.png`, 'icons', `icon-${index}`, `h-${index}`, 24, 24)
  );
  await importAll(runtime, manifest);

  const section = runtime.section('icons');
  const componentSet = section.children.find((node) => node.type === 'COMPONENT_SET');
  componentSet.children.forEach((node, index) => {
    node.x = 20;
    node.y = 20 + index * 44;
  });
  componentSet.resizeWithoutConstraints(120, 900);
  section.resizeWithoutConstraints(1800, 1500);

  const prepared = await runtime.send('prepare-sync', { rootName: 'library', manifest });
  assert.equal(prepared.summary.move, 1);
  assert.equal(prepared.summary.unchanged, manifest.length - 1);
  await runtime.send('begin-sync', { selectedFolders: ['icons'], deleteMissing: true });
  await runtime.send('finish-sync', {});

  assert.ok(aspectRatio(componentSet) <= 1.15);
  assertNoOverlap(componentSet.children, 20);
  assert.equal(section.width, Math.max(360, ...section.children.map((node) => node.x + node.width + 192)));
  assert.equal(section.height, Math.max(320, ...section.children.map((node) => node.y + node.height + 192)));
});

test('multiple newly created Sections use a compact grid instead of transient import dimensions', async () => {
  const runtime = createRuntime();
  const folders = ['common', 'battle', 'weather', 'navigation'];
  const manifest = folders.map((folder, index) =>
    asset(`${folder}/icon.png`, folder, `icon-${index}`, `h-${index}`, 24, 24)
  );
  await importAll(runtime, manifest);

  const sections = folders.map((folder) => runtime.section(folder));
  assertNoOverlap(sections, 80);
  const minX = Math.min(...sections.map((section) => section.x));
  const minY = Math.min(...sections.map((section) => section.y));
  const maxRight = Math.max(...sections.map((section) => section.x + section.width));
  const maxBottom = Math.max(...sections.map((section) => section.y + section.height));
  const bounds = { width: maxRight - minX, height: maxBottom - minY };
  assert.ok(aspectRatio(bounds) <= 1.3, `New Section grid ratio was ${aspectRatio(bounds)}`);
});

test('large legacy libraries are indexed without quadratic matching', async () => {
  const runtime = createRuntime();
  const manifest = Array.from({ length: 1200 }, (_, index) =>
    asset(`icons/icon-${index}.png`, 'icons', `icon-${index}`, `h-${index}`, 24, 24)
  );
  runtime.createLegacyFolder('icons', manifest);

  const startedAt = Date.now();
  const prepared = await runtime.send('prepare-sync', { rootName: 'library', manifest });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(prepared.adopted, manifest.length);
  assert.equal(prepared.summary.add, 0);
  assert.equal(prepared.summary.update, manifest.length);
  assert.ok(elapsedMs < 2500, `large legacy preparation took ${elapsedMs}ms`);
});

test('large component sets allocate unique slots within a bounded time', async () => {
  const runtime = createRuntime();
  const manifest = Array.from({ length: 3800 }, (_, index) =>
    asset(`icons/icon-${index}.png`, 'icons', `icon-${index}`, `h-${index}`, 24, 24)
  );

  const startedAt = Date.now();
  await importAll(runtime, manifest);
  const elapsedMs = Date.now() - startedAt;
  const positions = runtime.componentSnapshot().map(({ x, y }) => `${x},${y}`);

  assert.equal(new Set(positions).size, manifest.length);
  assert.ok(elapsedMs < 2500, `large component import took ${elapsedMs}ms`);
  const rescanStartedAt = Date.now();
  const prepared = await runtime.send('prepare-sync', { rootName: 'library', manifest });
  const rescanElapsedMs = Date.now() - rescanStartedAt;
  assert.equal(prepared.summary.move, 0);
  assert.equal(prepared.summary.unchanged, manifest.length);
  assert.ok(rescanElapsedMs < 2500, `large layout audit took ${rescanElapsedMs}ms`);
});

test('invalid image bytes are skipped and the sync still finishes', async () => {
  const runtime = createRuntime();
  const manifest = [asset('icons/broken.png', 'icons', 'broken', 'h-broken', 24, 24)];
  await runtime.send('prepare-sync', { rootName: 'library', manifest });
  await runtime.send('begin-sync', { selectedFolders: ['icons'], deleteMissing: true });
  runtime.figma.failNextImage = true;
  const result = await runtime.send('apply-file', {
    relativePath: 'icons/broken.png',
    bytes: new Uint8Array([1]).buffer
  });
  assert.equal(result.status, 'skipped');
  const finish = await runtime.send('finish-sync', {});
  assert.equal(finish.stats.skipped, 1);
});

test('deletions are cancelled when another file fails during the same sync', async () => {
  const runtime = createRuntime();
  const original = [
    asset('icons/home.png', 'icons', 'home', 'h-home', 24, 24),
    asset('icons/search.png', 'icons', 'search', 'h-search', 24, 24)
  ];
  await importAll(runtime, original);

  const changed = [asset('icons/home.png', 'icons', 'home', 'h-home-v2', 24, 24)];
  await runtime.send('prepare-sync', { rootName: 'library', manifest: changed });
  await runtime.send('begin-sync', { selectedFolders: ['icons'], deleteMissing: true });
  runtime.figma.failNextImage = true;
  await runtime.send('apply-file', {
    relativePath: 'icons/home.png',
    bytes: new Uint8Array([1]).buffer
  });
  const finish = await runtime.send('finish-sync', {});

  assert.equal(finish.stats.deleted, 0);
  assert.ok(runtime.component('icons/search.png'));
  assert.ok(finish.warnings.some((warning) => warning.includes('取消')));
});

test('strict and AI modes defer standalone placement and converge to the same baseline layout', async () => {
  const modes = ['strict', 'ai'];
  const finalLayouts = [];

  for (const mode of modes) {
    const runtime = createRuntime();
    const manifest = Array.from({ length: 120 }, (_, index) => {
      const name = `resource-${String(index).padStart(3, '0')}`;
      return asset(`common/${name}.png`, 'common', name, `h-${index}`, 16 + index, 24);
    });
    const prepared = await runtime.send('prepare-sync', {
      rootName: 'library',
      manifest,
      classificationMode: mode
    });
    assert.equal(prepared.classification.groups, 0);
    assert.equal(prepared.classification.standaloneAssets, manifest.length);

    await runtime.send('begin-sync', { selectedFolders: ['common'], deleteMissing: true });
    await runtime.send('apply-batch', {
      files: manifest.map((entry) => ({
        relativePath: entry.relativePath,
        bytes: new Uint8Array([1, 2, 3]).buffer
      }))
    });

    const sectionBeforeFinish = runtime.section('common');
    assert.ok(sectionBeforeFinish.children.every((node) => node.x === 192 && node.y === 272));
    await runtime.send('finish-sync', {});

    const section = runtime.section('common');
    assertNoOverlap(section.children, 100);
    finalLayouts.push(section.children
      .map((node) => ({ name: node.name, x: node.x, y: node.y, width: node.width, height: node.height }))
      .sort((a, b) => a.name.localeCompare(b.name)));

    const rescan = await runtime.send('prepare-sync', {
      rootName: 'library',
      manifest,
      classificationMode: mode
    });
    assert.equal(rescan.summary.move, 0);
    assert.equal(rescan.summary.unchanged, manifest.length);
  }

  assert.deepEqual(finalLayouts[1], finalLayouts[0]);
});

test('MCP classification request round-trips through shared plugin data and applies an approved AI plan', async () => {
  const runtime = createRuntime();
  const manifest = [
    asset('common/close_primary.png', 'common', 'close_primary', 'h-primary', 45, 49),
    asset('common/close_compact.png', 'common', 'close_compact', 'h-compact', 44, 48)
  ];
  const prepared = await runtime.send('prepare-sync', {
    rootName: 'library',
    manifest,
    classificationMode: 'ai'
  });
  assert.equal(prepared.classification.groups, 0);

  const published = await runtime.send('publish-classification-request', { selectedFolders: ['common'] });
  assert.equal(published.assetCount, 2);
  const request = readSharedJson(runtime.figma.currentPage, 'classification-request');
  assert.equal(request.requestId, published.requestId);
  assert.equal(request.fileKey, 'test-file-key');
  assert.equal(request.pageId, runtime.figma.currentPage.id);
  assert.equal(request.pageName, 'Page 1');
  assert.equal(
    request.pageUrl,
    `https://www.figma.com/design/test-file-key/current-page?node-id=${runtime.figma.currentPage.id.replace(/:/g, '-')}`
  );
  assert.equal(published.pageUrl, request.pageUrl);
  assert.match(published.prompt, new RegExp(`当前页面链接：${request.pageUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(published.prompt, /页面名称：Page 1/);
  assert.match(published.prompt, /固定使用资源名作为 Variant 值/);
  assert.match(published.prompt, /必须做双向审核/);
  assert.match(published.prompt, /合并跨尺寸/);
  assert.ok(Array.isArray(request.semanticCandidates));
  assert.ok(Array.isArray(request.classificationGuidance.requiredPasses));
  assert.deepEqual(
    JSON.parse(JSON.stringify(request.responseContract.groups[0].members)),
    ['folder/file.png']
  );
  assert.equal(request.assets.length, 2);
  assert.equal(request.strictGroups.length, 0);

  writeSharedJson(runtime.figma.currentPage, 'classification-plan', {
      schemaVersion: 1,
      requestId: published.requestId,
      groups: [{
        id: 'close-control',
        name: 'Controls/Close',
        confidence: 0.96,
        variantProperty: 'Size',
        members: [
          { relativePath: 'common/close_primary.png', variantValue: 'Primary' },
          { relativePath: 'common/close_compact.png', variantValue: 'Compact' }
        ]
      }],
      standalone: []
    }, 40);
  const loaded = await runtime.send('load-classification-plan', {});
  assert.equal(loaded.classification.aiGroups, 1);
  assert.equal(loaded.classification.groupedAssets, 2);

  await runtime.send('begin-sync', { selectedFolders: ['common'], deleteMissing: true });
  for (const entry of manifest) await runtime.apply(entry.relativePath, entry.width, entry.height);
  await runtime.send('finish-sync', {});

  const componentSet = runtime.section('common').children.find((node) => node.type === 'COMPONENT_SET');
  assert.ok(componentSet);
  assert.equal(componentSet.name, 'Controls/Close');
  assert.deepEqual(
    componentSet.children.map((node) => node.name).sort(),
    ['Size=close_compact', 'Size=close_primary']
  );
});

test('AI classification collapses legacy multi-property variants to one Property with resource-name values', async () => {
  const runtime = createRuntime();
  const manifest = [
    asset('common/close_primary.png', 'common', 'close_primary', 'h-primary', 24, 24),
    asset('common/close_compact.png', 'common', 'close_compact', 'h-compact', 24, 24)
  ];
  await importAll(runtime, manifest);

  const legacySet = runtime.section('common').children.find((node) => node.type === 'COMPONENT_SET');
  const legacySetMeta = JSON.parse(legacySet.getPluginData(META_KEY));
  legacySet.setPluginData(META_KEY, JSON.stringify({
    ...legacySetMeta,
    variantProperty: 'Legacy'
  }));
  legacySet.children.forEach((component, index) => {
    const meta = JSON.parse(component.getPluginData(META_KEY));
    component.setPluginData(META_KEY, JSON.stringify({
      ...meta,
      variantProperty: 'Legacy',
      variantValue: index === 0 ? 'Primary' : 'Compact'
    }));
    component.name = `Legacy=${index === 0 ? 'Primary' : 'Compact'}, Theme=${index === 0 ? 'Light' : 'Dark'}`;
  });

  await runtime.send('prepare-sync', {
    rootName: 'library',
    manifest,
    classificationMode: 'ai'
  });
  const published = await runtime.send('publish-classification-request', {
    selectedFolders: ['common']
  });
  writeSharedJson(runtime.figma.currentPage, 'classification-plan', {
    schemaVersion: 1,
    requestId: published.requestId,
    groups: [{
      id: 'close-controls',
      name: 'Controls/Close',
      confidence: 0.98,
      variantProperty: 'State',
      members: [
        { relativePath: 'common/close_primary.png', variantValue: 'AI Primary' },
        { relativePath: 'common/close_compact.png', variantValue: 'AI Compact' }
      ]
    }],
    standalone: []
  });
  await runtime.send('load-classification-plan', {});
  await runtime.send('begin-sync', { selectedFolders: ['common'], deleteMissing: true });
  await runtime.send('finish-sync', {});

  const componentSet = runtime.section('common').children.find((node) => node.type === 'COMPONENT_SET');
  assert.ok(componentSet);
  assert.deepEqual(
    componentSet.children.map((node) => node.name).sort(),
    ['State=close_compact', 'State=close_primary']
  );
  for (const component of componentSet.children) {
    assert.equal(component.name.split(',').length, 1);
    assert.equal((component.name.match(/=/g) || []).length, 1);
    const meta = JSON.parse(component.getPluginData(META_KEY));
    assert.equal(meta.variantProperty, 'State');
    assert.equal(meta.variantValue, meta.resourceName);
  }
});

test('MCP classification requests discover cross-size semantic series without over-grouping incompatible prefixes', async () => {
  const runtime = createRuntime();
  const manifest = [
    asset('common/zhandouli/zhandouli_2_0.png', 'common', 'zhandouli_2_0', 'h-p0', 24, 31),
    asset('common/zhandouli/zhandouli_2_1.png', 'common', 'zhandouli_2_1', 'h-p1', 15, 31),
    asset('common/zhandouli/zhandouli_2_2.png', 'common', 'zhandouli_2_2', 'h-p2', 24, 31),
    asset('common/zhandouli/zhandouli_2_3.png', 'common', 'zhandouli_2_3', 'h-p3', 22, 31),
    asset('common/zhandouli/zhandouli_2_4.png', 'common', 'zhandouli_2_4', 'h-p4', 24, 31),
    asset('common/zhandouli/zhandouli_2_5.png', 'common', 'zhandouli_2_5', 'h-p5', 25, 31),
    asset('common/战斗字体/img_shanghai_01_0.png', 'common', 'img_shanghai_01_0', 'h-d0', 24, 32),
    asset('common/战斗字体/img_shanghai_01_1.png', 'common', 'img_shanghai_01_1', 'h-d1', 16, 32),
    asset('common/战斗字体/img_shanghai_01_2.png', 'common', 'img_shanghai_01_2', 'h-d2', 22, 32),
    asset('common/战斗字体/img_shanghai_01_3.png', 'common', 'img_shanghai_01_3', 'h-d3', 22, 32),
    asset('common/战斗字体/img_shanghai_01_4.png', 'common', 'img_shanghai_01_4', 'h-d4', 24, 32),
    asset('common/战斗字体/img_shanghai_01_bao.png', 'common', 'img_shanghai_01_bao', 'h-db', 34, 36),
    asset('common/button_normal.png', 'common', 'button_normal', 'h-normal', 24, 24),
    asset('common/button_hover.png', 'common', 'button_hover', 'h-hover', 25, 24),
    asset('common/button_disabled.png', 'common', 'button_disabled', 'h-disabled', 24, 24),
    asset('common/icon_arrow_left.png', 'common', 'icon_arrow_left', 'h-left', 20, 20),
    asset('common/icon_arrow_right.png', 'common', 'icon_arrow_right', 'h-right', 20, 20),
    asset('common/icon_arrow_up.png', 'common', 'icon_arrow_up', 'h-up', 20, 21),
    asset('common/quality_red.png', 'common', 'quality_red', 'h-red', 32, 32),
    asset('common/quality_blue.png', 'common', 'quality_blue', 'h-blue', 32, 32),
    asset('common/quality_purple.png', 'common', 'quality_purple', 'h-purple', 32, 32),
    asset('common/badge_x1.png', 'common', 'badge_x1', 'h-x1', 16, 16),
    asset('common/badge_x2.png', 'common', 'badge_x2', 'h-x2', 32, 32),
    asset('common/badge_x3.png', 'common', 'badge_x3', 'h-x3', 48, 48),
    asset('common/sparkle_frame_001.png', 'common', 'sparkle_frame_001', 'h-f1', 30, 30),
    asset('common/sparkle_frame_002.png', 'common', 'sparkle_frame_002', 'h-f2', 31, 30),
    asset('common/sparkle_frame_003.png', 'common', 'sparkle_frame_003', 'h-f3', 30, 30),
    asset('common/common_bg_panel_01.png', 'common', 'common_bg_panel_01', 'h-bg1', 20, 20),
    asset('common/common_bg_panel_04.png', 'common', 'common_bg_panel_04', 'h-bg4', 400, 100),
    asset('common/common_bg_panel_99.png', 'common', 'common_bg_panel_99', 'h-bg99', 50, 300)
  ];
  await runtime.send('prepare-sync', {
    rootName: 'library',
    manifest,
    classificationMode: 'ai'
  });
  const published = await runtime.send('publish-classification-request', {
    selectedFolders: ['common']
  });
  const request = readSharedJson(runtime.figma.currentPage, 'classification-request');
  const byPrefix = new Map(request.semanticCandidates.map((candidate) => [
    candidate.stablePrefix,
    candidate
  ]));

  const power = byPrefix.get('zhandouli_2');
  assert.ok(power);
  assert.equal(power.relationType, 'glyph-series');
  assert.equal(power.suggestedVariantProperty, '字形');
  assert.equal(power.members.length, 6);
  assert.equal(power.evidence.crossesStrictSizes, true);
  assert.ok(power.evidence.sizes.includes('15x31'));
  assert.ok(power.evidence.sizes.includes('25x31'));

  const damage = byPrefix.get('img_shanghai_01');
  assert.ok(damage);
  assert.equal(damage.relationType, 'glyph-series');
  assert.equal(damage.members.length, 6);
  assert.equal(damage.evidence.crossesStrictSizes, true);

  const states = byPrefix.get('button');
  assert.ok(states);
  assert.equal(states.relationType, 'state-series');
  assert.equal(states.suggestedVariantProperty, '状态');
  assert.equal(states.members.length, 3);

  assert.equal(byPrefix.get('icon_arrow').relationType, 'direction-series');
  assert.equal(byPrefix.get('quality').relationType, 'quality-series');
  assert.equal(byPrefix.get('badge').relationType, 'scale-series');
  assert.equal(byPrefix.get('sparkle_frame').relationType, 'frame-series');
  assert.equal(byPrefix.has('common_bg_panel'), false);
  assert.equal(published.semanticCandidateCount, request.semanticCandidates.length);
  assert.ok(request.classificationGuidance.requiredPasses.some((rule) =>
    rule.includes('合并跨尺寸')
  ));
});

test('AI classification plans reject duplicate membership before touching the canvas', async () => {
  const runtime = createRuntime();
  const manifest = [
    asset('common/a.png', 'common', 'a', 'h-a', 20, 20),
    asset('common/b.png', 'common', 'b', 'h-b', 20, 20),
    asset('common/c.png', 'common', 'c', 'h-c', 20, 20)
  ];
  await runtime.send('prepare-sync', { rootName: 'library', manifest, classificationMode: 'ai' });
  const published = await runtime.send('publish-classification-request', { selectedFolders: ['common'] });
  runtime.figma.currentPage.setSharedPluginData(
    'figma_image_importer',
    'classification-plan',
    JSON.stringify({
      schemaVersion: 1,
      requestId: published.requestId,
      groups: [
        { id: 'one', name: 'One', confidence: 0.95, members: ['common/a.png', 'common/b.png'] },
        { id: 'two', name: 'Two', confidence: 0.95, members: ['common/a.png', 'common/c.png'] }
      ],
      standalone: []
    })
  );

  await assert.rejects(
    () => runtime.send('load-classification-plan', {}),
    /重复分配资源/
  );
  assert.equal(runtime.section('common'), null);
});

test('AI classification plans reject unknown resources before touching the canvas', async () => {
  const runtime = createRuntime();
  const manifest = [
    asset('common/a.png', 'common', 'a', 'h-a', 20, 20),
    asset('common/b.png', 'common', 'b', 'h-b', 20, 20)
  ];
  await runtime.send('prepare-sync', { rootName: 'library', manifest, classificationMode: 'ai' });
  const published = await runtime.send('publish-classification-request', { selectedFolders: ['common'] });
  runtime.figma.currentPage.setSharedPluginData(
    'figma_image_importer',
    'classification-plan',
    JSON.stringify({
      schemaVersion: 1,
      requestId: published.requestId,
      groups: [{
        id: 'unknown-member',
        name: 'Unknown',
        confidence: 0.95,
        members: ['common/a.png', 'common/missing.png']
      }],
      standalone: []
    })
  );

  await assert.rejects(
    () => runtime.send('load-classification-plan', {}),
    /不存在的资源/
  );
  assert.equal(runtime.section('common'), null);
});

test('large MCP classification requests stay below the shared plugin data entry limit', async () => {
  const runtime = createRuntime();
  const manifest = Array.from({ length: 1400 }, (_, index) => {
    const suffix = String(index).padStart(4, '0');
    const name = `very_long_component_resource_name_for_chunk_transport_${suffix}`;
    return asset(`common/${name}.png`, 'common', name, `hash-${suffix}`, 24, 24);
  });
  await runtime.send('prepare-sync', { rootName: 'library', manifest, classificationMode: 'ai' });
  const published = await runtime.send('publish-classification-request', { selectedFolders: ['common'] });

  assert.ok(published.requestChunks > 1);
  assert.equal(published.strictGroupCount, 1);
  const request = readSharedJson(runtime.figma.currentPage, 'classification-request');
  assert.equal(request.assets.length, manifest.length);
  assert.equal(request.strictGroups.length, 1);
  assert.equal(request.strictGroups[0].members.length, manifest.length);
  assert.ok(request.strictGroups[0].members.every((member) => !Object.prototype.hasOwnProperty.call(member, 'variantValue')));
  for (const value of runtime.figma.currentPage._sharedPluginData.values()) {
    assert.ok(Buffer.byteLength(value, 'utf8') <= 100000);
  }
});

test('MCP classification requests include only selected folders and reject out-of-scope plans', async () => {
  const runtime = createRuntime();
  const manifest = [
    asset('common/control_0.png', 'common', 'control_0', 'h-c0', 20, 20),
    asset('common/control_1.png', 'common', 'control_1', 'h-c1', 20, 20),
    asset('icons/action_0.png', 'icons', 'action_0', 'h-i0', 24, 24),
    asset('icons/action_1.png', 'icons', 'action_1', 'h-i1', 24, 24)
  ];
  await runtime.send('prepare-sync', { rootName: 'library', manifest, classificationMode: 'ai' });
  const published = await runtime.send('publish-classification-request', {
    selectedFolders: ['common']
  });
  const request = readSharedJson(runtime.figma.currentPage, 'classification-request');

  assert.equal(published.folderCount, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(request.selectedFolders)), ['common']);
  assert.equal(request.assets.length, 2);
  assert.ok(request.assets.every((entry) => entry.folderPath === 'common'));
  assert.ok(request.strictGroups.every((group) => group.folderPath === 'common'));
  assert.equal(request.strictGroups.length, 1);
  assert.equal(request.strictGroups[0].members.length, 2);

  runtime.figma.currentPage.setSharedPluginData(
    'figma_image_importer',
    'classification-plan',
    JSON.stringify({
      schemaVersion: 1,
      requestId: published.requestId,
      groups: [{
        id: 'outside-scope',
        confidence: 0.95,
        members: ['common/control_0.png', 'icons/action_0.png']
      }],
      standalone: []
    })
  );
  await assert.rejects(
    () => runtime.send('load-classification-plan', {}),
    /未选中文件夹/
  );
});

function readSharedJson(page, baseKey) {
  const raw = page.getSharedPluginData('figma_image_importer', baseKey);
  const parsed = JSON.parse(raw);
  if (parsed.encoding !== 'chunked-json') return parsed;
  return JSON.parse(parsed.chunkKeys.map((key) =>
    page.getSharedPluginData('figma_image_importer', key)
  ).join(''));
}

function writeSharedJson(page, baseKey, value, chunkSize = 20000) {
  const serialized = JSON.stringify(value);
  const chunks = [];
  for (let offset = 0; offset < serialized.length; offset += chunkSize) {
    chunks.push(serialized.slice(offset, offset + chunkSize));
  }
  const chunkKeys = chunks.map((_, index) => `${baseKey}_${index}`);
  chunks.forEach((chunk, index) => {
    page.setSharedPluginData('figma_image_importer', chunkKeys[index], chunk);
  });
  page.setSharedPluginData('figma_image_importer', baseKey, JSON.stringify({
    encoding: 'chunked-json',
    chunkCount: chunks.length,
    chunkKeys,
    schemaVersion: 1,
    requestId: value.requestId
  }));
}

async function importAll(runtime, manifest) {
  await runtime.send('prepare-sync', { rootName: 'library', manifest });
  await runtime.send('begin-sync', {
    selectedFolders: Array.from(new Set(manifest.map((entry) => sectionFolder(entry.relativePath)))),
    deleteMissing: true
  });
  for (let index = 0; index < manifest.length; index += 16) {
    const entries = manifest.slice(index, index + 16);
    await runtime.send('apply-batch', {
      files: entries.map((entry) => ({
        relativePath: entry.relativePath,
        bytes: new Uint8Array([1, 2, 3]).buffer
      }))
    });
  }
  return runtime.send('finish-sync', {});
}

function sectionFolder(relativePath) {
  const parts = String(relativePath).replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 1 ? parts[0] : '_root';
}

function aspectRatio(node) {
  return Math.max(node.width / node.height, node.height / node.width);
}

function assertNoOverlap(nodes, gap) {
  for (let left = 0; left < nodes.length; left++) {
    for (let right = left + 1; right < nodes.length; right++) {
      const a = nodes[left];
      const b = nodes[right];
      const separated =
        a.x + a.width + gap <= b.x ||
        b.x + b.width + gap <= a.x ||
        a.y + a.height + gap <= b.y ||
        b.y + b.height + gap <= a.y;
      assert.ok(separated, `${a.name} overlaps ${b.name}`);
    }
  }
}

function assertComponentSetStroke(componentSet) {
  assert.equal(componentSet.strokeWeight, 1);
  assert.equal(componentSet.strokeAlign, 'INSIDE');
  assert.equal(componentSet.strokes.length, 1);
  assert.equal(componentSet.strokes[0].type, 'SOLID');
  assert.ok(Math.abs(componentSet.strokes[0].color.r - 138 / 255) < 0.0001);
  assert.ok(Math.abs(componentSet.strokes[0].color.g - 56 / 255) < 0.0001);
  assert.ok(Math.abs(componentSet.strokes[0].color.b - 245 / 255) < 0.0001);
}

function asset(relativePath, folderPath, name, hash, width, height) {
  return {
    relativePath,
    folderPath,
    name,
    hash,
    width,
    height,
    sourceSize: width * height + relativePath.length,
    lastModified: 1700000000000
  };
}

function createRuntime() {
  let nextNodeId = 1;
  let requestId = 0;
  let imageId = 0;
  const replies = [];

  class MockNode {
    constructor(type) {
      this.id = `${nextNodeId++}:1`;
      this.type = type;
      this.name = type;
      this.x = 0;
      this.y = 0;
      this.width = 1;
      this.height = 1;
      this.parent = null;
      this.children = [];
      this.removed = false;
      this.fills = [];
      this._pluginData = new Map();
      this._sharedPluginData = new Map();
    }

    appendChild(child) {
      const previousParent = child.parent;
      if (previousParent) {
        previousParent.children = previousParent.children.filter((item) => item !== child);
      }
      child.parent = this;
      if (!this.children.includes(child)) this.children.push(child);
      autoRemoveEmptyComponentSet(previousParent);
    }

    resize(width, height) {
      this.width = width;
      this.height = height;
    }

    resizeWithoutConstraints(width, height) {
      this.resize(width, height);
    }

    getPluginData(key) {
      return this._pluginData.get(key) || '';
    }

    setPluginData(key, value) {
      if (value === '') this._pluginData.delete(key);
      else this._pluginData.set(key, value);
    }

    getSharedPluginData(namespace, key) {
      return this._sharedPluginData.get(`${namespace}\u0000${key}`) || '';
    }

    setSharedPluginData(namespace, key, value) {
      if (!/^[a-zA-Z0-9_.]+$/.test(namespace)) {
        throw new Error('invalid shared plugin data namespace');
      }
      if (Buffer.byteLength(String(value), 'utf8') > 100000) {
        throw new Error('shared plugin data entry exceeds 100 kB');
      }
      const mapKey = `${namespace}\u0000${key}`;
      if (value === '') this._sharedPluginData.delete(mapKey);
      else this._sharedPluginData.set(mapKey, value);
    }

    remove() {
      if (this.removed) throw new Error(`in remove: The node with id "${this.id}" does not exist`);
      const previousParent = this.parent;
      if (previousParent) {
        previousParent.children = previousParent.children.filter((item) => item !== this);
      }
      this.parent = null;
      this.removed = true;
      for (const child of this.children) child.removed = true;
      autoRemoveEmptyComponentSet(previousParent);
    }
  }

  function autoRemoveEmptyComponentSet(node) {
    if (!node || node.removed || node.type !== 'COMPONENT_SET' || node.children.length !== 0) return;
    if (node.parent) node.parent.children = node.parent.children.filter((item) => item !== node);
    node.parent = null;
    node.removed = true;
  }

  const page = new MockNode('PAGE');
  page.name = 'Page 1';

  function createSceneNode(type) {
    const node = new MockNode(type);
    page.appendChild(node);
    return node;
  }

  const figma = {
    fileKey: 'test-file-key',
    currentPage: page,
    ui: {
      onmessage: null,
      postMessage(message) { replies.push(message); }
    },
    viewport: { scrollAndZoomIntoView() {} },
    notifications: [],
    nextImageSize: null,
    failNextImage: false,
    showUI() {},
    notify(message) { this.notifications.push(message); },
    createSection() { return createSceneNode('SECTION'); },
    createComponent() { return createSceneNode('COMPONENT'); },
    createRectangle() { return createSceneNode('RECTANGLE'); },
    createImage() {
      if (this.failNextImage) {
        this.failNextImage = false;
        throw new Error('bad image');
      }
      const size = this.nextImageSize || { width: 1, height: 1 };
      this.nextImageSize = null;
      const hash = `figma-image-${++imageId}`;
      return { hash };
    },
    combineAsVariants(components, parent) {
      const set = new MockNode('COMPONENT_SET');
      parent.appendChild(set);
      for (const component of components) set.appendChild(component);
      set.resizeWithoutConstraints(1, 1);
      return set;
    }
  };

  const source = fs.readFileSync(path.join(ROOT, 'code.js'), 'utf8');
  vm.runInNewContext(source, {
    figma,
    __html__: '',
    console,
    Uint8Array,
    ArrayBuffer,
    Map,
    Set,
    Date,
    Math,
    JSON,
    String,
    Number,
    Object,
    Error,
    setTimeout
  });

  async function send(type, payload) {
    const id = `test-${++requestId}`;
    await figma.ui.onmessage({ type, requestId: id, payload });
    const replyIndex = replies.findIndex((message) => message.replyTo === id);
    assert.notEqual(replyIndex, -1, `missing reply for ${type}`);
    const [reply] = replies.splice(replyIndex, 1);
    if (!reply.ok) throw new Error(reply.error);
    return reply.data;
  }

  function meta(node) {
    const raw = node.getPluginData(META_KEY);
    return raw ? JSON.parse(raw) : null;
  }

  function sections() {
    return page.children.filter((node) => node.type === 'SECTION' && !node.removed);
  }

  function section(folderPath) {
    return sections().find((node) => {
      const data = meta(node);
      return data && data.folderPath === folderPath;
    }) || null;
  }

  function allComponents() {
    const result = [];
    for (const sectionNode of sections()) {
      for (const child of sectionNode.children) {
        if (child.type === 'COMPONENT') result.push(child);
        if (child.type === 'COMPONENT_SET') {
          result.push(...child.children.filter((node) => node.type === 'COMPONENT' && !node.removed));
        }
      }
    }
    return result;
  }

  function component(relativePath) {
    const node = allComponents().find((item) => {
      const data = meta(item);
      return data && data.relativePath === relativePath;
    });
    return node ? { node, meta: meta(node) } : null;
  }

  function componentSnapshot() {
    return allComponents()
      .map((node) => {
        const data = meta(node);
        return {
          path: data.relativePath,
          id: node.id,
          x: node.x,
          y: node.y,
          parentId: node.parent && node.parent.id,
          name: node.name
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async function apply(relativePath, width, height) {
    figma.nextImageSize = { width, height };
    return send('apply-file', {
      relativePath,
      bytes: new Uint8Array([1, 2, 3]).buffer
    });
  }

  function createLegacyFolder(folderName, entries) {
    const sectionNode = figma.createSection();
    sectionNode.name = folderName;
    sectionNode.x = 200;
    sectionNode.y = 120;
    sectionNode.resizeWithoutConstraints(800, 500);
    const components = [];

    for (const entry of entries) {
      const componentNode = figma.createComponent();
      componentNode.name = entry.name;
      componentNode.resizeWithoutConstraints(entry.width, entry.height);
      const rectangle = figma.createRectangle();
      rectangle.name = entry.name;
      rectangle.resizeWithoutConstraints(entry.width, entry.height);
      componentNode.appendChild(rectangle);
      sectionNode.appendChild(componentNode);
      componentNode.x = 100 + components.length * (entry.width + 20);
      componentNode.y = 140;
      components.push(componentNode);
    }

    if (components.length > 1) {
      const set = figma.combineAsVariants(components, sectionNode);
      set.name = `${entries[0].width}x${entries[0].height}`;
      set.x = 100;
      set.y = 140;
    }
    return { section: sectionNode, components };
  }

  function createManagedFolder(folderPath, entries) {
    const created = createLegacyFolder(folderPath.split('/').pop(), entries);
    const libraryId = 'managed-library';
    const rootName = 'library';
    created.section.setPluginData(META_KEY, JSON.stringify({
      version: 1,
      role: 'section',
      libraryId,
      rootName,
      folderPath
    }));

    created.components.forEach((componentNode, index) => {
      const entry = entries[index];
      componentNode.setPluginData(META_KEY, JSON.stringify({
        version: 1,
        role: 'component',
        libraryId,
        rootName,
        folderPath,
        relativePath: entry.relativePath,
        hash: entry.hash,
        width: entry.width,
        height: entry.height,
        sourceSize: entry.sourceSize,
        lastModified: entry.lastModified,
        layoutOrder: index
      }));
      if (componentNode.parent && componentNode.parent.type === 'COMPONENT_SET') {
        componentNode.parent.setPluginData(META_KEY, JSON.stringify({
          version: 1,
          role: 'component-set',
          libraryId,
          rootName,
          folderPath,
          sizeKey: `${entry.width}x${entry.height}`
        }));
      }
    });
    return created;
  }

  return {
    figma,
    send,
    apply,
    section,
    component,
    componentSnapshot,
    createLegacyFolder,
    createManagedFolder
  };
}
