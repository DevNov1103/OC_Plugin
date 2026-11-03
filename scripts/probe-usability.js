// Run inside the isolated validation renderer with agent-browser eval -b.
(async () => {
  const api = window.opencodePet;
  const original = await api.getSettings();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const click = (selector) => document.querySelector(selector).click();
  const saved = async (predicate) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const settings = await api.getSettings();
      if (predicate(settings)) return settings;
      await wait(25);
    }
    throw new Error("Preference did not persist");
  };
  const inputValue = (selector, value) => {
    const input = document.querySelector(selector);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const checks = {};
  try {
    click('[data-action="settings"]');
    const draft = document.querySelector('[data-shortcut="toggle"]');
    inputValue('[data-shortcut="toggle"]', "Ctrl+Alt+Shift+F9");
    await wait(700);
    checks.streamingKeepsShortcutDraft = draft === document.querySelector('[data-shortcut="toggle"]') && draft.value === "Ctrl+Alt+Shift+F9";

    const lowPower = document.querySelector('[data-setting="lowPower"]');
    lowPower.click();
    await saved((settings) => settings.lowPower === !original.lowPower);
    checks.preferenceTogglePersists = true;

    const quiet = document.querySelector('[data-action="dnd-toggle"]');
    if ((await api.getSettings()).dndUntil > Date.now()) { quiet.click(); await saved((settings) => settings.dndUntil === 0); }
    quiet.click();
    await saved((settings) => settings.dndUntil > Date.now() + 25 * 60_000);
    checks.quietModeKeepsPermissionBadge = !document.querySelector('.badge').hidden && Number(document.querySelector('.badge').textContent) > 0;
    quiet.click();
    await saved((settings) => settings.dndUntil === 0);
    checks.quietModeRestores = true;

    const notice = document.querySelector('[data-notify-kind="task_done"][data-notify-channel="popup"]');
    const wasPopup = (await api.getSettings()).notifications.task_done.popup;
    notice.click();
    await saved((settings) => settings.notifications.task_done.popup === !wasPopup);
    checks.notificationRulePersists = true;

    inputValue('[data-shortcut="toggle"]', "NotARealKeyName");
    inputValue('[data-shortcut="tasks"]', "");
    click('[data-action="save-shortcuts"]');
    await wait(350);
    checks.invalidShortcutKeepsPrevious = JSON.stringify((await api.getSettings()).shortcuts) === JSON.stringify(original.shortcuts);
    inputValue('[data-shortcut="toggle"]', "Ctrl+Alt+Shift+F9");
    inputValue('[data-shortcut="tasks"]', "Ctrl+Alt+Shift+F10");
    click('[data-action="save-shortcuts"]');
    await saved((settings) => settings.shortcuts.toggle === "Ctrl+Alt+Shift+F9" && settings.shortcuts.tasks === "Ctrl+Alt+Shift+F10");
    checks.customShortcutsRegister = true;

    click('[data-tab="tasks"]');
    const project = document.querySelector('[data-task-filter="project"]');
    const choices = Array.from(project.options).map((option) => option.value).filter(Boolean);
    checks.multipleProjectChoices = choices.length >= 2;
    project.value = choices[0];
    project.dispatchEvent(new Event("change", { bubbles: true }));
    await saved((settings) => settings.taskPreferences.project === choices[0]);
    await wait(100);
    checks.projectFilter = Array.from(document.querySelectorAll('.task-active-list .session-label')).every((label) => label.title === choices[0]);
    const status = document.querySelector('[data-task-filter="status"]');
    project.value = "";
    project.dispatchEvent(new Event("change", { bubbles: true }));
    await saved((settings) => settings.taskPreferences.project === "");
    status.value = "permission";
    status.dispatchEvent(new Event("change", { bubbles: true }));
    await saved((settings) => settings.taskPreferences.status === "permission");
    await wait(100);
    const permissionCards = Array.from(document.querySelectorAll('.task-active-list .session-card'));
    checks.permissionFilter = permissionCards.length > 0 && permissionCards.every((card) => card.querySelector('.permission-card'));
    const pin = document.querySelector('.task-active-list [data-action="pin-task"]');
    const pinKey = pin.dataset.pinKey;
    const wasPinned = (await api.getSettings()).pinnedSessions.includes(pinKey);
    pin.click();
    await saved((settings) => settings.pinnedSessions.includes(pinKey) === !wasPinned);
    checks.taskPinPersists = true;

    await api.updateSettings({ locked: true, taskPreferences: { project: "", status: "all", collapseCompleted: true } });
    click('[data-action="close-panel"]');
    await wait(200);
    const before = { x: screenX, y: screenY };
    const gesture = { screenX: screenX + 140, screenY: screenY + 140, timestamp: performance.now() };
    await api.dragStart(gesture);
    await wait(100);
    await api.dragEnd({ ...gesture, timestamp: performance.now() });
    checks.lockedPreventsNativeDrag = before.x === screenX && before.y === screenY;
    click('[data-action="toggle-panel"]');
    checks.lockedPetStillOpensPanel = document.querySelector('.pet-button').getAttribute('aria-expanded') === "true";

    const frame = document.querySelector('#custom-skin-frame');
    let hiddenWrites = 0;
    const observer = new MutationObserver(() => hiddenWrites++);
    observer.observe(frame, { attributes: true, attributeFilter: ["style"] });
    await api.windowAction("hide");
    await wait(100);
    hiddenWrites = 0;
    await wait(550);
    checks.hiddenAnimationPauses = hiddenWrites === 0;
    observer.disconnect();
    await api.windowAction("show");
    await wait(150);
    checks.cardsStayBounded = document.querySelectorAll('.session-card').length <= 50;
  } finally {
    await api.windowAction("show");
    await api.updateSettings({
      locked: original.locked, inertia: original.inertia, lowPower: original.lowPower,
      notifications: original.notifications, dndUntil: original.dndUntil,
      shortcuts: original.shortcuts, pinnedSessions: original.pinnedSessions, taskPreferences: original.taskPreferences,
    });
    click('[data-action="settings"]');
    inputValue('[data-shortcut="toggle"]', original.shortcuts.toggle);
    inputValue('[data-shortcut="tasks"]', original.shortcuts.tasks);
    click('[data-action="save-shortcuts"]');
    await wait(150);
    click('[data-tab="tasks"]');
  }
  if (Object.values(checks).some((passed) => !passed)) throw new Error(JSON.stringify(checks));
  return checks;
})();
