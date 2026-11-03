// Run in the actual Electron renderer with agent-browser eval -b (UTF-8 base64).
// Scale changes use only input events; the user's persisted settings are not changed.
(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const selectors = [".bubble", ".panel", ".pet-button", ".fx-layer"];
  const nodes = selectors.map((selector) => document.querySelector(selector));
  const click = (selector) => document.querySelector(selector).click();
  const measure = () => {
    const stage = document.querySelector(".stage").getBoundingClientRect();
    const pet = document.querySelector(".pet-button").getBoundingClientRect();
    const actions = document.querySelector(".window-actions").getBoundingClientRect();
    return {
      width: innerWidth, height: innerHeight, x: screenX, y: screenY,
      stage: { left: stage.left, top: stage.top, right: stage.right, bottom: stage.bottom },
      petScreenX: screenX + pet.left + pet.width / 2,
      petScreenY: screenY + pet.bottom,
      menuGap: stage.top - actions.bottom,
      panelHidden: document.querySelector(".panel").hidden,
    };
  };
  click('[data-action="close-panel"]');
  await wait(350);
  const baseline = measure();
  click('[data-action="toggle-panel"]');
  await wait(350);
  const expanded = measure();
  click('[data-action="close-panel"]');
  await wait(350);
  const collapsed = measure();
  click('[data-action="settings"]');
  await wait(250);
  const originalScale = document.querySelector('[data-setting="scale"]').value;
  const scaleAndCollapse = async (value) => {
    if (document.querySelector(".panel").hidden) {
      click('[data-action="settings"]');
      await wait(250);
    }
    const input = document.querySelector('[data-setting="scale"]');
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    click('[data-action="close-panel"]');
    await wait(350);
    return measure();
  };
  let large, small;
  try {
    large = await scaleAndCollapse("1.6");
    small = await scaleAndCollapse("0.65");
  } finally {
    await scaleAndCollapse(originalScale);
  }
  const restored = measure();
  const fits = (view) => view.stage.left >= -1 && view.stage.top >= 35
    && view.stage.right <= view.width + 1 && view.stage.bottom <= view.height;
  const result = {
    baseline, expanded, collapsed, large, small, restored,
    checks: {
      compactNativeWindow: collapsed.width < expanded.width && collapsed.height < expanded.height,
      restoredPanelSize: expanded.width === 380 && expanded.height === 520,
      menuNearStage: collapsed.menuGap >= 8 && collapsed.menuGap <= 10,
      samePetPosition: baseline.petScreenX === collapsed.petScreenX && baseline.petScreenY === collapsed.petScreenY,
      largeFits: fits(large), smallFits: fits(small),
      noScaleRoundTripDrift: baseline.x === restored.x && baseline.y === restored.y,
      stableNodes: selectors.every((selector, index) => nodes[index] === document.querySelector(selector)),
    },
  };
  if (Object.values(result.checks).some((value) => !value)) throw new Error(JSON.stringify(result));
  return result;
})();
