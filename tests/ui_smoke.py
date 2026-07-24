from pathlib import Path
import os
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "graphify-out" / "ui-sync-preview.png"
DETAIL_OUTPUT = ROOT / "graphify-out" / "ui-change-preview.png"


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    edge_candidates = [
        Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Microsoft/Edge/Application/msedge.exe",
        Path(os.environ.get("PROGRAMFILES", "")) / "Microsoft/Edge/Application/msedge.exe",
    ]
    edge = next((candidate for candidate in edge_candidates if candidate.exists()), None)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=str(edge) if edge else None,
        )
        page = browser.new_page(viewport={"width": 380, "height": 720}, device_scale_factor=1)
        page.goto((ROOT / "ui.html").as_uri())
        page.wait_for_load_state("networkidle")
        page.evaluate(
            """
            renderPlan({
              rootName: 'game-assets',
              libraryId: 'preview-library',
              adopted: 18,
              conflicts: ['旧资源匹配冲突'],
              classification: {
                mode: 'ai',
                groups: 12,
                groupedAssets: 30,
                standaloneAssets: 6,
                aiGroups: 4
              },
              summary: { add: 24, update: 6, delete: 3, move: 2, unchanged: 418, conflict: 1 },
              actions: [
                { type: 'add', folderPath: 'weather', relativePath: 'weather/day/sun.png', name: 'sun', width: 64, height: 64 },
                { type: 'update', folderPath: 'common', relativePath: 'common/home.png', name: 'home', width: 32, height: 32, previousWidth: 24, previousHeight: 24 },
                { type: 'delete', folderPath: 'legacy', relativePath: 'legacy/old.png', name: 'old', width: 40, height: 40, reason: 'missing-local' },
                { type: 'move', folderPath: 'navigation', relativePath: 'navigation/arrows/back.png', oldRelativePath: 'navigation/old/back.png', name: 'back', width: 20, height: 20, previousWidth: 20, previousHeight: 20 },
                { type: 'unchanged', folderPath: 'common', relativePath: 'common/menu.png', name: 'menu', width: 24, height: 24 },
                { type: 'conflict', folderPath: 'common', relativePath: 'common/duplicate.png', name: 'duplicate', width: 24, height: 24 }
              ],
              folders: [
                { folderPath: 'common', status: 'existing', counts: { add: 0, update: 6, delete: 0, move: 0, unchanged: 218, conflict: 1 } },
                { folderPath: 'navigation', status: 'existing', counts: { add: 0, update: 0, delete: 0, move: 2, unchanged: 200, conflict: 0 } },
                { folderPath: 'weather', status: 'new', counts: { add: 24, update: 0, delete: 0, move: 0, unchanged: 0, conflict: 0 } },
                { folderPath: 'legacy', status: 'removed', counts: { add: 0, update: 0, delete: 3, move: 0, unchanged: 0, conflict: 0 } }
              ]
            });
            """
        )
        page.screenshot(path=str(OUTPUT), full_page=True)

        assert page.locator("#plan").is_visible()
        assert page.locator("#classificationMode").input_value() == "ai"
        assert page.locator("#aiActions").is_visible()
        assert page.locator("#publishAiRequest").is_visible()
        assert page.locator("#loadAiPlan").is_visible()
        assert "4 个 AI 组" in page.locator("#classificationSummary").inner_text()
        assert page.locator(".folder-row").count() == 4
        assert page.locator("#toggleAllFolders").inner_text() == "全取消"
        assert page.locator(".folder-row input:checked").count() == 4
        page.locator("#toggleAllFolders").click()
        assert page.locator("#toggleAllFolders").inner_text() == "全选"
        assert page.locator("#selectedFolderCount").text_content() == "0 selected"
        assert page.locator(".folder-row input:checked").count() == 0
        assert page.locator("#syncButton").is_disabled()
        assert page.locator("#publishAiRequest").is_disabled()
        page.locator("#toggleAllFolders").click()
        assert page.locator("#toggleAllFolders").inner_text() == "全取消"
        assert page.locator("#selectedFolderCount").text_content() == "4 selected"
        assert page.locator(".folder-row input:checked").count() == 4
        assert page.locator("#deleteOption").is_visible()
        assert page.locator("#syncButton").is_enabled()
        assert page.locator("#publishAiRequest").is_enabled()
        page.locator('[data-preview-type="update"]').click()
        assert page.locator("#previewView").is_visible()
        assert page.locator('[data-preview-filter="update"]').get_attribute("aria-pressed") == "true"
        assert page.locator(".change-row.update").count() == 1
        assert "24×24 → 32×32" in page.locator(".change-row.update .change-detail").inner_text()
        assert page.locator("#previewFolderFilter option").count() == 5
        page.locator("#previewSearch").fill("home")
        assert page.locator(".change-row.update").count() == 1
        page.locator("#previewSearch").fill("missing")
        assert page.locator(".preview-empty").is_visible()
        page.locator("#previewSearch").fill("")
        page.locator('[data-preview-filter="changes"]').click()
        assert page.locator(".change-row").count() == 5
        assert page.locator(".change-row.unchanged").count() == 0
        page.locator('[data-preview-filter="move"]').click()
        assert "navigation/old/back.png" in page.locator(".change-row.move .change-path").inner_text()
        assert "navigation/arrows/back.png" in page.locator(".change-row.move .change-path").inner_text()
        page.locator('[data-preview-filter="unchanged"]').click()
        assert page.locator(".change-row.unchanged").count() == 1
        page.screenshot(path=str(DETAIL_OUTPUT), full_page=True)
        page.locator("#previewReturn").click()
        assert not page.locator("#previewView").is_visible()
        page.evaluate(
            """
            currentPlan.actions = Array.from({ length: 95 }, (_, index) => ({
              type: 'unchanged',
              folderPath: 'common',
              relativePath: `common/icon-${index}.png`,
              name: `icon-${index}`,
              width: 24,
              height: 24
            }));
            selectedFolders = new Set(['common']);
            openChangePreview('unchanged');
            """
        )
        assert page.locator(".change-row.unchanged").count() == 80
        assert page.locator("#previewLoadMore").is_visible()
        page.locator("#previewLoadMore").click()
        assert page.locator(".change-row.unchanged").count() == 95
        assert not page.locator("#previewLoadMore").is_visible()
        page.locator("#previewBack").click()
        assert page.evaluate("document.documentElement.scrollWidth <= 380")
        assert page.evaluate("document.body.scrollHeight <= 720")
        batch_lengths = page.evaluate(
            """
            fileByPath = new Map(Array.from({ length: 33 }, (_, index) => [
              `common/icon-${index}.png`,
              { size: 1024 }
            ]));
            buildFileBatches(Array.from(fileByPath.keys())).map((batch) => batch.length);
            """
        )
        assert batch_lengths == [33]
        adaptive_batch_lengths = page.evaluate(
            """
            fileByPath = new Map(Array.from({ length: 100 }, (_, index) => [
              `common/icon-${index}.png`,
              { size: 1024 }
            ]));
            buildFileBatches(Array.from(fileByPath.keys())).map((batch) => batch.length);
            """
        )
        assert adaptive_batch_lengths == [48, 48, 4]
        newest_path = page.evaluate(
            """
            dedupeNewestResources([
              { folderPath: 'common', name: 'home', relativePath: 'common/old/home.png', lastModified: 100 },
              { folderPath: 'common', name: 'home', relativePath: 'common/new/home.png', lastModified: 200 }
            ])[0].relativePath;
            """
        )
        assert newest_path == "common/new/home.png"
        browser.close()


if __name__ == "__main__":
    main()
