import { renderReleaseNotes } from "./release-notes";

describe("renderReleaseNotes", () => {
  it("renders headings, bullets, bold and code", () => {
    const html = renderReleaseNotes(
      "## What's new\n- **Faster** start\n- Fixed `--fs` flag\n\nThanks to all.",
    );
    expect(html).toBe(
      "<h5>What&#39;s new</h5>" +
        "<ul><li><strong>Faster</strong> start</li><li>Fixed <code>--fs</code> flag</li></ul>" +
        "<p>Thanks to all.</p>",
    );
  });

  it("escapes HTML in the notes", () => {
    const html = renderReleaseNotes('<img src=x onerror="alert(1)"> **<b>x</b>**');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("<strong>&lt;b&gt;x&lt;/b&gt;</strong>");
  });

  it("keeps no bold inside code and returns nothing for empty notes", () => {
    expect(renderReleaseNotes("`**a**`")).toBe("<p><code>**a**</code></p>");
    expect(renderReleaseNotes("")).toBe("");
  });
});
