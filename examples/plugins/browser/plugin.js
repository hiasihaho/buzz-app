export const inject = ["react", "panels", "browser"];

export function apply(ctx) {
  // Cordis wraps service functions on access; keep React's component identity.
  const View = ctx.browser.View;
  ctx.panels.register({
    id: "example-site",
    title: "Example site",
    matches: (target) => ctx.browser.available && target.startsWith("https://"),
    order: 100,
    component: ({ target }) =>
      // A storage name keeps cookies and parks the guest on unmount, so a
      // page or channel switch and back finds the site as it was.
      ctx.react.createElement(View, {
        url: target,
        storage: "example-browser",
      }),
  });
}
