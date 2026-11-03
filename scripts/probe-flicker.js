// Execute with agent-browser eval --stdin (or eval -b with UTF-8 base64 on Windows).
(() => {
  // The Boba skin has no inline SVG, so probe stable container nodes instead.
  const selectors = [".bubble", ".panel", ".toast", ".pet-button", ".fx-layer"];
  const nodes = selectors.map((selector) => document.querySelector(selector));
  let snapshots = 0;
  const animations = { bubble: 0, panel: 0, toast: 0 };
  const onAnimation = (event) => {
    for (const name of Object.keys(animations)) {
      if (event.target.matches(`.${name}`)) animations[name]++;
    }
  };
  document.addEventListener("animationstart", onAnimation);
  const unsubscribe = window.opencodePet.onSnapshot(() => snapshots++);
  window.__petFlickerProbe = {
    result: () => ({
      snapshots,
      stableNodes: selectors.every((selector, index) => nodes[index] && nodes[index] === document.querySelector(selector) && nodes[index].isConnected),
      animations,
      visibleBubbleOpacity: getComputedStyle(document.querySelector(".bubble")).opacity,
    }),
    stop: () => { unsubscribe(); document.removeEventListener("animationstart", onAnimation); },
  };
  return "Flicker probe ready";
})();
