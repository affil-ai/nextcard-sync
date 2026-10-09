// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readOfferContent } from "./offer-content";

describe("issuer offer content", () => {
  it("preserves exclusions, paragraphs, entities, and safe link destinations", () => {
    const text = readOfferContent('<h3>Qualifying Purchases</h3><p>US&nbsp;purchases only.<br>Excludes gift cards.</p><p>Use <a href="https://merchant.example/terms">this website</a>.</p>');
    expect(text).toBe("Qualifying Purchases\n\nUS purchases only.\nExcludes gift cards.\n\nUse this website (https://merchant.example/terms).");
  });
  it("removes executable markup without losing ordinary restriction text", () => {
    expect(readOfferContent('<script>alert(1)</script><style>p {color:red}</style><p>No gift cards. <a href="javascript:alert(1)">Issuer terms</a></p>')).toBe("No gift cards. Issuer terms");
    expect(readOfferContent(null)).toBeUndefined();
    expect(readOfferContent(" ")).toBeUndefined();
  });
});
