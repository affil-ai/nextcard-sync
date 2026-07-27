import { describe, expect, it } from "vitest";
import {
  createMarriottCertificateKey,
  extractMarriottAwardDescription,
} from "./marriott-certificate";

describe("Marriott certificate normalization", () => {
  const cleanDescription =
    "Free Night Award valued up to 35K pts: Boundless Anniversary";

  it("removes adjacent refunded activity from a certificate description", () => {
    expect(extractMarriottAwardDescription(
      `${cleanDescription}July 21, 2026 Refunded: +0 Awards`,
      "Free Night Award",
    )).toBe(cleanDescription);
  });

  it("normalizes the three screenshot variants to one certificate identity", () => {
    const variants = [
      cleanDescription,
      `${cleanDescription}July 21, 2026 Refunded: +0 Awards`,
      `${cleanDescription}July 21, 2026 Refunded: +0 Awards0 Points`,
    ];
    const keys = variants.map((value) => {
      const description = extractMarriottAwardDescription(value, "Free Night Award");
      expect(description).not.toBeNull();
      return createMarriottCertificateKey({
        type: "Free Night Award",
        description: description!,
        expiryDate: null,
      });
    });

    expect(new Set(keys)).toHaveLength(1);
  });

  it("keeps expiry outside the description while preserving it in identity", () => {
    const description = extractMarriottAwardDescription(
      `${cleanDescription} Expires Dec 31, 2026`,
      "Free Night Award",
    );
    expect(description).toBe(cleanDescription);
    expect(createMarriottCertificateKey({
      type: "Free Night Award",
      description: description!,
      expiryDate: "Dec 31, 2026",
    })).not.toBe(createMarriottCertificateKey({
      type: "Free Night Award",
      description: description!,
      expiryDate: "Dec 31, 2027",
    }));
  });
});
