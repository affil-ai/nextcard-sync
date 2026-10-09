/** Preserve issuer copy as inert text, including paragraph breaks and link targets. */
export function readOfferContent(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const doc = new DOMParser().parseFromString(value, "text/html");
  doc.querySelectorAll("script, style, iframe, object").forEach((node) => node.remove());
  doc.querySelectorAll("a[href]").forEach((node) => {
    const href = node.getAttribute("href");
    if (href && /^https?:\/\//i.test(href) && !node.textContent?.includes(href)) {
      node.append(` (${href})`);
    }
  });
  doc.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
  doc.querySelectorAll("p, div, li, h1, h2, h3, h4, section").forEach((node) => node.append("\n\n"));
  const text = doc.body.textContent?.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text || undefined;
}
