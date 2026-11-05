// R9 tab strip behaviours driven through the shell page with real input:
// dnd-kit pointer reorder (both directions), keyboard reorder (handle + Space/Arrows),
// keyboard activate/close, overflow scrolling keeps the active tab in view, titles update.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from 'playwright';
import { startFixtureServers, type FixtureServers } from '../fixtures/http';
import {
  dragTab,
  launchApp,
  openTab,
  readEvents,
  shellPage,
  state,
  waitForEvent,
  waitForEventCount,
  waitForTabCount,
  waitForTabTitle,
} from './helpers';

let fixtures: FixtureServers;

test.beforeAll(async () => {
  fixtures = await startFixtureServers();
});

test.afterAll(async () => {
  await fixtures.close();
});

async function order(app: ElectronApplication): Promise<string[]> {
  return (await state(app)).tabs.tabs.map((tab) => tab.id);
}

// Fractions of the 1338 px available at the 1400 px test window (see core/layout paneAvailable).
const WIDE_PANE = 0.568; // ≈760 px, rendered at 698 px so the devin view keeps MIN_DEVIN_WIDTH
// ≈460 px: after the 138 px caption overlay and the back/forward/reload/+/star
// buttons the strip still fits one 104 px min-width tab, so "fully visible" holds.
const NARROW_PANE = 0.344;

async function setPaneFraction(app: ElectronApplication, fraction: number): Promise<void> {
  await app.evaluate(
    (_e, value: number) => (globalThis as any).__agentworkspace.setPaneFraction(value),
    fraction,
  );
}

async function domOrder(shell: Page): Promise<string[]> {
  return shell.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('#tabStrip .tab')].map((el) => el.dataset.tabId ?? ''),
  );
}

test('pointer and keyboard reorder, keyboard activate/close, titles', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-strip-'));
  const logFile = join(profile, 'events.jsonl');
  // Quiet like every spec: dnd-kit's pointer and keyboard sensors work without
  // an activated window (verified on Electron 44, 20/20 over repeats).
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
    await setPaneFraction(app, WIDE_PANE);
    const a = await openTab(app, `${fixtures.githubUrl}/page/strip-a`);
    const b = await openTab(app, `${fixtures.githubUrl}/page/strip-b`);
    const c = await openTab(app, `${fixtures.githubUrl}/page/strip-c`);
    await waitForTabTitle(app, 'strip-c');
    await waitForTabTitle(app, 'strip-a');
    const shell = await shellPage(app);
    await expect(shell.locator('#tabStrip .tab')).toHaveCount(3);
    await expect(shell.locator(`[data-tab-id="${a}"] .tabTitle`)).toHaveText('GitHub fixture: strip-a');
    expect(await domOrder(shell)).toEqual([a, b, c]);
    // dragTab is strict: it refuses clipped tabs — the strip must not overflow.
    const stripMetrics = await shell
      .locator('#tabStrip')
      .evaluate((el) => ({ clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }));
    console.log('stripMetrics', JSON.stringify(stripMetrics));
    expect(stripMetrics.scrollWidth).toBeLessThanOrEqual(stripMetrics.clientWidth + 1);

    // Pointer: first -> last.
    await dragTab(shell, a, c);
    await waitForEvent(logFile, 'tab-reorder');
    await expect.poll(() => order(app)).toEqual([b, c, a]);
    await expect.poll(() => domOrder(shell)).toEqual([b, c, a]);
    expect((await state(app)).tabs.activeId).toBe(c);

    // Pointer: last -> first.
    await dragTab(shell, a, b);
    await expect.poll(() => order(app)).toEqual([a, b, c]);

    // Pointer: a tiny move (< activation distance) is a click, not a drag: activates.
    const bTab = shell.locator(`[data-tab-id="${b}"]`);
    await bTab.scrollIntoViewIfNeeded();
    const bBox = (await bTab.boundingBox())!;
    await shell.mouse.move(bBox.x + 20, bBox.y + bBox.height / 2);
    await shell.mouse.down();
    await shell.mouse.move(bBox.x + 22, bBox.y + bBox.height / 2);
    await shell.mouse.up();
    await expect.poll(async () => (await state(app)).tabs.activeId).toBe(b);
    expect(await order(app)).toEqual([a, b, c]);

    // Keyboard: focus the handle of A, Space picks up, ArrowRight x2, Space drops at the end.
    // dnd-kit re-measures droppables between moves, so give each key a frame.
    const key = async (name: string) => {
      await shell.keyboard.press(name);
      await shell.waitForTimeout(120);
    };
    await shell.focus(`[data-tab-id="${a}"] .dragHandle`);
    await key('Space');
    await key('ArrowRight');
    await key('ArrowRight');
    await key('Space');
    await expect.poll(() => order(app)).toEqual([b, c, a]);

    // Keyboard: Escape cancels a pick-up.
    await shell.focus(`[data-tab-id="${a}"] .dragHandle`);
    await key('Space');
    await key('ArrowLeft');
    await key('Escape');
    await shell.waitForTimeout(200);
    expect(await order(app)).toEqual([b, c, a]);

    // Keyboard on the tab itself: Enter activates, Delete closes (right neighbour becomes active).
    await shell.focus(`[data-tab-id="${c}"]`);
    await shell.keyboard.press('Enter');
    await expect.poll(async () => (await state(app)).tabs.activeId).toBe(c);
    await shell.keyboard.press('Delete');
    await waitForTabCount(app, 2);
    expect((await state(app)).tabs.activeId).toBe(a);
    expect(await order(app)).toEqual([b, a]);

    // Close button and middle-click still work with real input.
    await shell.click(`[data-tab-id="${a}"] .closeMark`);
    await waitForTabCount(app, 1);
    expect((await state(app)).tabs.activeId).toBe(b);
    await shell.click(`[data-tab-id="${b}"]`, { button: 'middle' });
    await waitForTabCount(app, 0);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

test('right-click tab menu lists Copy address and copies the tab URL', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-strip-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
    const url = `${fixtures.githubUrl}/page/menu-a`;
    const id = await openTab(app, url);
    const shell = await shellPage(app);
    await shell.click(`[data-tab-id="${id}"]`, { button: 'right' });
    const hook = <T>(fn: string, ...args: unknown[]) =>
      app.evaluate(
        (_e, p: { fn: string; args: unknown[] }) => (globalThis as any).__agentworkspace[p.fn](...p.args),
        { fn, args },
      ) as Promise<T>;
    await expect
      .poll(async () => (await hook<{ id: string; label: string }[] | null>('tabMenuItems'))?.map((i) => i.label))
      .toEqual(['Copy address', 'Review pull request']);
    const items = (await hook<{ id: string; label: string; enabled: boolean }[]>('tabMenuItems'))!;
    expect(items[1]!.enabled).toBe(false);
    const copy = items.find((i) => i.label === 'Copy address')!;
    expect(await hook<{ action: string }>('tabMenuClick', copy.id)).toEqual({ action: 'copy' });
    expect(await hook<string>('clipboardRead')).toBe(url);
    expect(await hook<string | null>('lastReviewRefusal')).toBeNull();
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

test('overflowing strip scrolls the active tab into view', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-strip-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
    await setPaneFraction(app, NARROW_PANE);
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      ids.push(await openTab(app, `${fixtures.githubUrl}/page/overflow-${i}`));
    }
    await waitForTabCount(app, 8);
    const shell = await shellPage(app);
    const strip = shell.locator('#tabStrip');
    const metrics = () =>
      strip.evaluate((el) => ({ scrollLeft: el.scrollLeft, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    const visible = (id: string) =>
      shell.evaluate((tabId: string) => {
        const strip = document.getElementById('tabStrip')!;
        const el = strip.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`)!;
        const s = strip.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return r.left >= s.left - 1 && r.right <= s.right + 1;
      }, id);

    const initial = await metrics();
    expect(initial.scrollWidth).toBeGreaterThan(initial.clientWidth);
    // Last tab is active (opened last) and must be in view.
    await expect.poll(() => visible(ids[7]!)).toBe(true);
    expect((await metrics()).scrollLeft).toBeGreaterThan(0);

    // Activate the first tab -> strip scrolls back.
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.activate(id), ids[0]!);
    await expect.poll(() => visible(ids[0]!)).toBe(true);
    expect((await metrics()).scrollLeft).toBe(0);

    // Ctrl+Tab cycles; the newly active tab is always visible.
    for (let i = 0; i < 5; i += 1) {
      await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.activate(id), ids[i + 1]!);
      await expect.poll(() => visible(ids[i + 1]!)).toBe(true);
    }
    // Middle-click close on a visible tab in the overflowed strip.
    // (Chromium would otherwise start middle-button autoscroll on the scrollable strip.)
    const tabBox = (await shell.locator(`[data-tab-id="${ids[5]}"]`).boundingBox())!;
    const stripBox = (await strip.boundingBox())!;
    // Scrollbar hidden: tabs fill the full strip height.
    expect(tabBox.height).toBe(stripBox.height);
    await shell.click(`[data-tab-id="${ids[5]}"]`, { button: 'middle' });
    await waitForTabCount(app, 7);

    // Vertical wheel over the strip scrolls it horizontally.
    const before = (await metrics()).scrollLeft;
    await shell.mouse.move(stripBox.x + stripBox.width / 2, stripBox.y + stripBox.height / 2);
    await shell.mouse.wheel(0, -200);
    await expect.poll(async () => (await metrics()).scrollLeft).toBeLessThan(before);
    await shell.mouse.wheel(0, 400);
    await expect.poll(async () => (await metrics()).scrollLeft).toBeGreaterThan(before);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

test('clicking the active tab re-attaches at once', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'agent-workspace-strip-diag-'));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures);
  try {
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
    await setPaneFraction(app, WIDE_PANE);
    const a = await openTab(app, `${fixtures.githubUrl}/page/diag-a`);
    const b = await openTab(app, `${fixtures.githubUrl}/page/diag-b`);
    await waitForTabTitle(app, 'diag-a');
    await waitForTabTitle(app, 'diag-b');
    expect((await state(app)).tabs.activeId).toBe(b);
    const shell = await shellPage(app);

    // A click on another tab is a plain activation.
    await shell.click(`[data-tab-id="${a}"] .tabTitle`);
    await expect.poll(async () => (await state(app)).tabs.activeId).toBe(a);
    const before = (await readEvents(logFile)).filter((entry) => entry.event === 'tab-activate').length;

    // Clicking the already-active tab is the blank-pane workaround: it re-attaches with no wait.
    await shell.click(`[data-tab-id="${a}"] .tabTitle`);
    await waitForEventCount(logFile, 'tab-activate', before + 1);
    const activations = (await readEvents(logFile)).filter((entry) => entry.event === 'tab-activate');
    expect(activations).toHaveLength(before + 1);
    const last = activations[activations.length - 1]!;
    expect(last.detail).toMatchObject({ id: a, history: { wasActive: true } });
    expect(last.detail).not.toHaveProperty('via');
    expect((await readEvents(logFile)).filter((entry) => entry.event === 'tab-reactivate-diag')).toHaveLength(0);
    expect((await state(app)).tabs.activeId).toBe(a);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});

type TabEvent = Record<string, unknown> & { detail?: Record<string, unknown>; ts: string };

async function eventsNamed(logFile: string, name: string): Promise<TabEvent[]> {
  return (await readEvents(logFile)).filter((entry) => entry.event === name) as TabEvent[];
}

const RELOAD_CASES = [
  { name: 'test hook', source: 'test' },
  { name: 'Ctrl+R via sendInputEvent', source: 'ctrl-r' },
] as const;

async function withApp(
  prefix: string,
  body: (app: ElectronApplication, logFile: string) => Promise<void>,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), prefix));
  const logFile = join(profile, 'events.jsonl');
  const app = await launchApp(profile, logFile, join(profile, 'downloads'), fixtures, extraEnv);
  try {
    await expect.poll(async () => app.evaluate(() => Boolean((globalThis as any).__agentworkspace))).toBe(true);
    await setPaneFraction(app, WIDE_PANE);
    await body(app, logFile);
  } finally {
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

for (const reloadCase of RELOAD_CASES) {
  test(`reloading the active tab (${reloadCase.name}) logs one reload before the load starts`, async () => {
    await withApp('agent-workspace-strip-reload-', async (app, logFile) => {
      await openTab(app, `${fixtures.githubUrl}/page/reload-a`);
      await waitForTabTitle(app, 'reload-a');
      // Main-process clock of the next load start on the active tab.
      await app.evaluate(({ webContents }) => {
        const g = globalThis as any;
        const contents = webContents.fromId(g.__agentworkspace.activeTabWebContentsId());
        g.__loadStartedAt = null;
        contents!.once('did-start-loading', () => {
          g.__loadStartedAt = Date.now();
        });
      });
      if (reloadCase.source === 'test') {
        await app.evaluate(() => (globalThis as any).__agentworkspace.navigate('reload'));
      } else {
        // page.keyboard bypasses before-input-event; sendInputEvent takes the native path.
        await app.evaluate(({ webContents }) => {
          const g = globalThis as any;
          const contents = webContents.fromId(g.__agentworkspace.activeTabWebContentsId())!;
          contents.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: ['control'] });
          contents.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers: ['control'] });
        });
      }
      await expect
        .poll(async () => app.evaluate(() => (globalThis as any).__loadStartedAt as number | null))
        .not.toBeNull();
      const loadStartedAt = (await app.evaluate(() => (globalThis as any).__loadStartedAt)) as number;

      const reloads = await eventsNamed(logFile, 'tab-reload');
      expect(reloads).toHaveLength(1);
      expect(reloads[0]!.detail).toMatchObject({ source: reloadCase.source, tab: true, view: 'tab' });
      expect(reloads[0]!.detail).not.toHaveProperty('coalesced');
      expect(await eventsNamed(logFile, 'tab-reactivate-diag')).toHaveLength(0);
      expect(Date.parse(reloads[0]!.ts)).toBeLessThanOrEqual(loadStartedAt);
      const line = JSON.stringify(reloads[0]);
      expect(reloads[0]!.url).toBeUndefined();
      expect(line).not.toContain('reload-a');
      expect(line).not.toContain('GitHub fixture');
    });
  });
}

test('a background tab activated later reports loadedHidden and not shownSinceLoad', async () => {
  await withApp('agent-workspace-strip-bg-', async (app, logFile) => {
    const front = await openTab(app, `${fixtures.githubUrl}/page/bg-front`);
    await waitForTabTitle(app, 'bg-front');
    const bg = await app.evaluate(
      (_e, url: string) => (globalThis as any).__agentworkspace.openBackground(url),
      `${fixtures.githubUrl}/page/bg-loaded`,
    );
    expect(typeof bg).toBe('string');
    expect(bg).not.toBe('');
    await waitForTabTitle(app, 'bg-loaded');
    expect((await state(app)).tabs.activeId).toBe(front);

    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.activate(id), bg as string);
    await expect.poll(async () => (await state(app)).tabs.activeId).toBe(bg);
    const activations = (await eventsNamed(logFile, 'tab-activate')).filter((entry) => entry.detail?.id === bg);
    expect(activations).toHaveLength(1);
    expect(activations[0]!.detail!.history).toMatchObject({ loadedHidden: true, shownSinceLoad: false });
  });
});

test('re-attaching a hidden tab logs its history; pane hide/show logs tab-pane-shown', async () => {
  await withApp('agent-workspace-strip-reattach-', async (app, logFile) => {
    const a = await openTab(app, `${fixtures.githubUrl}/page/re-a`);
    const b = await openTab(app, `${fixtures.githubUrl}/page/re-b`);
    await waitForTabTitle(app, 're-a');
    await waitForTabTitle(app, 're-b');
    const activate = (id: string) =>
      app.evaluate((_e, tabId: string) => (globalThis as any).__agentworkspace.activate(tabId), id);

    await activate(a);
    await activate(b);
    await activate(a);
    const activations = (await eventsNamed(logFile, 'tab-activate')).filter((entry) => entry.detail?.id === a);
    const last = activations[activations.length - 1]!;
    const history = last.detail!.history as Record<string, unknown>;
    expect(history.wasActive).toBe(false);
    expect(history.hiddenMs).toBeGreaterThanOrEqual(0);
    expect(typeof history.hiddenMs).toBe('number');

    // A surface round trip leaves the pane (and so the tab view) laid out: no re-attach, no pane-shown.
    const activationsBefore = (await eventsNamed(logFile, 'tab-activate')).length;
    const setSurface = (value: string) =>
      app.evaluate((_e, v: string) => (globalThis as any).__agentworkspace.setSurface(v), value);
    await setSurface('settings');
    await setSurface('cloud');
    expect(await eventsNamed(logFile, 'tab-pane-shown')).toHaveLength(0);
    expect((await eventsNamed(logFile, 'tab-activate')).length).toBe(activationsBefore);

    // Hiding and re-showing the pane keeps the view attached at 0x0: pane-shown, not tab-activate.
    const setPaneOpen = (value: boolean) =>
      app.evaluate((_e, v: boolean) => (globalThis as any).__agentworkspace.setPaneOpen(v), value);
    await setPaneOpen(false);
    await setPaneOpen(true);
    await waitForEvent(logFile, 'tab-pane-shown');
    const shown = (await eventsNamed(logFile, 'tab-pane-shown'))[0]!;
    expect(shown.detail).toMatchObject({ id: a });
    expect(typeof shown.detail!.hiddenMs).toBe('number');
    expect(shown.detail!.hiddenMs as number).toBeGreaterThanOrEqual(0);
    expect((await eventsNamed(logFile, 'tab-activate')).length).toBe(activationsBefore);
  });
});

test('a tab activated while the pane is hidden logs tab-pane-shown when the pane opens', async () => {
  await withApp('agent-workspace-strip-hidden-attach-', async (app, logFile) => {
    const a = await openTab(app, `${fixtures.githubUrl}/page/ha-a`);
    const b = await openTab(app, `${fixtures.githubUrl}/page/ha-b`);
    await waitForTabTitle(app, 'ha-a');
    await waitForTabTitle(app, 'ha-b');
    const setPaneOpen = (value: boolean) =>
      app.evaluate((_e, v: boolean) => (globalThis as any).__agentworkspace.setPaneOpen(v), value);

    await setPaneOpen(false);
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.activate(id), a);
    await expect.poll(async () => (await state(app)).tabs.activeId).toBe(a);
    const attach = (await eventsNamed(logFile, 'tab-activate')).filter((entry) => entry.detail?.id === a).pop()!;
    // Attached into the hidden pane, at 0x0.
    expect(attach.detail!.history).toMatchObject({ wasActive: false });
    expect(await eventsNamed(logFile, 'tab-pane-shown')).toHaveLength(0);

    await setPaneOpen(true);
    await waitForEvent(logFile, 'tab-pane-shown');
    const shown = await eventsNamed(logFile, 'tab-pane-shown');
    expect(shown).toHaveLength(1);
    expect(shown[0]!.detail).toMatchObject({ id: a });
    expect(typeof shown[0]!.detail!.hiddenMs).toBe('number');

    // The pane show is what made it shown: a later re-attach reports shownSinceLoad.
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.activate(id), b);
    await app.evaluate((_e, id: string) => (globalThis as any).__agentworkspace.activate(id), a);
    const again = (await eventsNamed(logFile, 'tab-activate')).filter((entry) => entry.detail?.id === a).pop()!;
    expect(again.detail!.history).toMatchObject({ shownSinceLoad: true, loadedHidden: false });
  });
});

test('a hidden tab reloaded in the background reports loadedHidden on its next activation', async () => {
  await withApp('agent-workspace-strip-bg-reload-', async (app, logFile) => {
    const front = await openTab(app, `${fixtures.githubUrl}/page/bgr-front`);
    const back = await openTab(app, `${fixtures.githubUrl}/page/bgr-back`);
    await waitForTabTitle(app, 'bgr-front');
    await waitForTabTitle(app, 'bgr-back');
    expect((await state(app)).tabs.activeId).toBe(back);
    const activate = (id: string) =>
      app.evaluate((_e, tabId: string) => (globalThis as any).__agentworkspace.activate(tabId), id);

    // `back` was shown; capture its webContents, then hide it behind `front`.
    const backContentsId = (await app.evaluate(() =>
      (globalThis as any).__agentworkspace.activeTabWebContentsId(),
    )) as number;
    await activate(front);
    await expect.poll(async () => (await state(app)).tabs.activeId).toBe(front);

    await app.evaluate(({ webContents }, id: number) => {
      const g = globalThis as any;
      g.__backReloaded = false;
      webContents.fromId(id)!.once('did-stop-loading', () => {
        g.__backReloaded = true;
      });
    }, backContentsId);
    await app.evaluate(() => (globalThis as any).__agentworkspace.reloadScope());
    await expect.poll(async () => app.evaluate(() => (globalThis as any).__backReloaded as boolean)).toBe(true);

    await activate(back);
    await expect.poll(async () => (await state(app)).tabs.activeId).toBe(back);
    const last = (await eventsNamed(logFile, 'tab-activate')).filter((entry) => entry.detail?.id === back).pop()!;
    expect(last.detail!.history).toMatchObject({ loadedHidden: true, shownSinceLoad: false, wasActive: false });
  });
});

// Presses the button and waits for its cooldown (disabled, then enabled again).
async function pressMark(shell: Page): Promise<void> {
  await shell.click('#tabMarkBlank');
  await expect(shell.locator('#tabMarkBlank')).toBeDisabled();
  await expect(shell.locator('#tabMarkBlank')).toBeEnabled();
}

test('the mark button repaints, then re-attaches, then reloads', async () => {
  await withApp('agent-workspace-strip-blank-', async (app, logFile) => {
    const a = await openTab(app, `${fixtures.githubUrl}/page/blank-a`);
    await waitForTabTitle(app, 'blank-a');
    const b = await openTab(app, `${fixtures.githubUrl}/page/blank-b`);
    await waitForTabTitle(app, 'blank-b');
    const shell = await shellPage(app);
    await shell.click(`[data-tab-id="${a}"] .tabTitle`);
    await expect.poll(async () => (await state(app)).tabs.activeId).toBe(a);

    // Spies on the active tab: invalidate() calls, adds of its view to the window, loads.
    await app.evaluate(({ BaseWindow, webContents }) => {
      const g = globalThis as any;
      const contents = webContents.fromId(g.__agentworkspace.activeTabWebContentsId())!;
      const spy = { id: contents.id, invalidate: 0, adds: 0, loads: 0 };
      g.__markSpy = spy;
      const originalInvalidate = contents.invalidate.bind(contents);
      contents.invalidate = () => {
        spy.invalidate++;
        originalInvalidate();
      };
      const contentView = BaseWindow.getAllWindows()[0]!.contentView as any;
      const originalAdd = contentView.addChildView.bind(contentView);
      contentView.addChildView = (view: any, index?: number) => {
        if (view?.webContents?.id === spy.id) spy.adds++;
        return originalAdd(view, index);
      };
      contents.on('did-start-loading', () => {
        spy.loads++;
      });
    });
    const spy = () =>
      app.evaluate(() => (globalThis as any).__markSpy as { invalidate: number; adds: number; loads: number });
    const activations = async () => (await eventsNamed(logFile, 'tab-activate')).length;
    const marks = () => eventsNamed(logFile, 'tab-blank-marked');
    const reloadsBefore = (await eventsNamed(logFile, 'tab-reload')).length;

    // Press 1: repaint only.
    let activationsBefore = await activations();
    let spyBefore = await spy();
    await pressMark(shell);
    await expect.poll(async () => (await marks()).length).toBe(1);
    expect((await marks())[0]!.detail).toMatchObject({
      id: a,
      press: 1,
      action: 'invalidate',
      applied: true,
      sincePrevPressMs: null,
      attached: true,
      crashed: false,
    });
    expect(await spy()).toMatchObject({ invalidate: spyBefore.invalidate + 1, adds: spyBefore.adds, loads: 0 });
    expect(await activations()).toBe(activationsBefore);

    // Press 2: the same re-attach as clicking the active tab, tagged `via:'mark'`.
    activationsBefore = await activations();
    spyBefore = await spy();
    await pressMark(shell);
    await expect.poll(async () => (await marks()).length).toBe(2);
    expect((await marks())[1]!.detail).toMatchObject({ id: a, press: 2, action: 'reattach', applied: true });
    expect(typeof (await marks())[1]!.detail!.sincePrevPressMs).toBe('number');
    await expect.poll(activations).toBe(activationsBefore + 1);
    const activate = (await eventsNamed(logFile, 'tab-activate')).pop()!;
    expect(activate.detail).toMatchObject({ id: a, via: 'mark', history: { wasActive: true } });
    expect(await spy()).toMatchObject({ invalidate: spyBefore.invalidate, adds: spyBefore.adds + 1, loads: 0 });

    // Press 3: reload.
    spyBefore = await spy();
    await pressMark(shell);
    await expect.poll(async () => (await marks()).length).toBe(3);
    expect((await marks())[2]!.detail).toMatchObject({ id: a, press: 3, action: 'reload', applied: true });
    await expect.poll(async () => (await spy()).loads).toBeGreaterThan(0);
    const reloads = (await eventsNamed(logFile, 'tab-reload')).slice(reloadsBefore);
    expect(reloads).toHaveLength(1);
    expect(reloads[0]!.detail).toMatchObject({ source: 'mark', tab: true, view: 'tab', id: a });
    expect((await spy()).invalidate).toBe(spyBefore.invalidate);

    // Another tab restarts the ladder.
    await shell.click(`[data-tab-id="${b}"] .tabTitle`);
    await expect.poll(async () => (await state(app)).tabs.activeId).toBe(b);
    await pressMark(shell);
    await expect.poll(async () => (await marks()).length).toBe(4);
    expect((await marks())[3]!.detail).toMatchObject({ id: b, press: 1, action: 'invalidate', applied: true });

    for (const entry of await marks()) {
      const line = JSON.stringify(entry);
      expect(entry.url).toBeUndefined();
      expect(line).not.toContain('blank-a');
      expect(line).not.toContain('blank-b');
      expect(line).not.toContain('GitHub fixture');
      expect(entry.detail).toMatchObject({ attached: true, crashed: false });
    }
    expect(await eventsNamed(logFile, 'tab-reactivate-diag')).toHaveLength(0);
  });
});

test('the mark-as-blank button is disabled without an active tab', async () => {
  await withApp('agent-workspace-strip-blank-none-', async (app, logFile) => {
    const shell = await shellPage(app);
    await expect(shell.locator('#tabMarkBlank')).toBeDisabled();
    expect(await eventsNamed(logFile, 'tab-blank-marked')).toHaveLength(0);
  });
});
