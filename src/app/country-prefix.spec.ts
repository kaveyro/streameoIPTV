import { displayName, splitCountryPrefix, toCountryPrefixMode } from "./country-prefix";

describe("country prefix", () => {
  it("splits the common playlist prefixes", () => {
    expect(splitCountryPrefix("TR: Kanal D")).toEqual({ code: "TR", name: "Kanal D" });
    expect(splitCountryPrefix("DE| ARD")).toEqual({ code: "DE", name: "ARD" });
    expect(splitCountryPrefix("tr - ATV")).toEqual({ code: "TR", name: "ATV" });
    expect(splitCountryPrefix("[UK] BBC One")).toEqual({ code: "UK", name: "BBC One" });
    expect(splitCountryPrefix("[UK] - BBC One")).toEqual({ code: "UK", name: "BBC One" });
  });

  it("leaves other names alone", () => {
    expect(splitCountryPrefix("Kanal D")).toEqual({ name: "Kanal D" });
    expect(splitCountryPrefix("TV Asia")).toEqual({ name: "TV Asia" });
    expect(splitCountryPrefix("Al-Jazeera")).toEqual({ name: "Al-Jazeera" });
    expect(splitCountryPrefix("TV - 1000")).toEqual({ name: "TV - 1000" });
    expect(splitCountryPrefix("TR- ATV")).toEqual({ code: "TR", name: "ATV" });
    expect(splitCountryPrefix("SD: beIN Sports 1")).toEqual({ name: "SD: beIN Sports 1" });
    expect(splitCountryPrefix("TR:")).toEqual({ name: "TR:" });
    expect(splitCountryPrefix(undefined)).toEqual({ name: "" });
  });

  it("applies the display mode", () => {
    expect(displayName("TR: ATV", "show")).toBe("TR: ATV");
    expect(displayName("TR: ATV", "hide")).toBe("ATV");
    expect(displayName("TR: ATV", "badge")).toBe("ATV");
    expect(toCountryPrefixMode("badge")).toBe("badge");
    expect(toCountryPrefixMode("nonsense")).toBe("show");
    expect(toCountryPrefixMode(undefined)).toBe("show");
  });
});
