import { describe, expect, it } from "vitest";
import {
  baseName,
  composePrompt,
  mergeAttachmentPaths,
  pasteCarriesFiles,
  physicalPointInElement,
  pointInRect,
  quotePath,
  type Attachment,
} from "./useAttachments";

const attach = (path: string): Attachment => ({
  id: path,
  path,
  name: baseName(path),
  preview: null,
});

describe("quotePath", () => {
  it("leaves an ordinary path alone", () => {
    // Most paths need no quoting, and an unquoted one reads better.
    expect(quotePath("D:\\000_project\\app\\main.rs")).toBe(
      "D:\\000_project\\app\\main.rs",
    );
  });

  it("quotes a path with spaces, which is most of Windows", () => {
    expect(quotePath("C:\\Program Files\\thing.exe")).toBe(
      '"C:\\Program Files\\thing.exe"',
    );
  });

  it("escapes a quote inside the path rather than ending the quoting early", () => {
    expect(quotePath('C:\\odd"name\\x.txt')).toBe('"C:\\odd\\"name\\x.txt"');
  });

  it("keeps non-ASCII names as they are", () => {
    expect(quotePath("D:\\项目\\说明.md")).toBe("D:\\项目\\说明.md");
    expect(quotePath("D:\\我的 项目\\说明.md")).toBe('"D:\\我的 项目\\说明.md"');
  });
});

describe("baseName", () => {
  it("takes the last segment, whichever separator is used", () => {
    expect(baseName("D:\\a\\b\\main.rs")).toBe("main.rs");
    expect(baseName("/home/me/notes.md")).toBe("notes.md");
    expect(baseName("D:/mixed\\both/file.png")).toBe("file.png");
  });

  it("survives a trailing separator and a bare name", () => {
    expect(baseName("D:\\a\\b\\")).toBe("b");
    expect(baseName("solo.txt")).toBe("solo.txt");
  });
});

describe("composePrompt", () => {
  it("is the message itself when nothing is attached", () => {
    expect(composePrompt("  fix the parser  ", [])).toBe("fix the parser");
  });

  it("appends the paths rather than leaving them in the sentence", () => {
    // Removing a chip has to remove the file from the message; a path inline in
    // someone's sentence is one they would have to delete by hand.
    expect(composePrompt("compare these", [attach("D:\\a.rs"), attach("D:\\b.rs")]))
      .toBe("compare these\n\nAttached files:\n- D:\\a.rs\n- D:\\b.rs");
  });

  it("says file, singular, for one", () => {
    expect(composePrompt("read it", [attach("D:\\a.rs")])).toBe(
      "read it\n\nAttached file:\n- D:\\a.rs",
    );
  });

  it("quotes only the paths that need it", () => {
    expect(composePrompt("x", [attach("C:\\Program Files\\a.txt")])).toBe(
      'x\n\nAttached file:\n- "C:\\Program Files\\a.txt"',
    );
  });

  it("is the list alone when the message is empty", () => {
    // Pasting a screenshot and pressing enter means "look at this".
    expect(composePrompt("   ", [attach("D:\\shot.png")])).toBe(
      "Attached file:\n- D:\\shot.png",
    );
  });
});

describe("pasteCarriesFiles", () => {
  const transfer = (types: string[]) => ({ types }) as unknown as DataTransfer;

  it("recognises a paste that carries files", () => {
    // Explorer files and a screenshot look identical here; only the host tells
    // them apart, which is why that question is asked second.
    expect(pasteCarriesFiles(transfer(["Files"]))).toBe(true);
    expect(pasteCarriesFiles(transfer(["text/plain", "Files"]))).toBe(true);
  });

  it("leaves a text paste to the textarea", () => {
    expect(pasteCarriesFiles(transfer(["text/plain"]))).toBe(false);
    expect(pasteCarriesFiles(transfer(["text/html", "text/plain"]))).toBe(false);
    expect(pasteCarriesFiles(transfer([]))).toBe(false);
  });

  it("says no when there is no clipboard data at all", () => {
    expect(pasteCarriesFiles(null)).toBe(false);
  });
});

describe("mergeAttachmentPaths", () => {
  it("keeps first-seen order and skips blanks and duplicates", () => {
    expect(
      mergeAttachmentPaths(
        ["D:\\a.rs"],
        ["D:\\a.rs", "  ", "D:\\b.rs", "D:\\b.rs"],
      ),
    ).toEqual(["D:\\b.rs"]);
  });
});

describe("physicalPointInElement", () => {
  const box = { left: 10, top: 20, right: 110, bottom: 80 };

  it("tests in CSS pixels", () => {
    expect(pointInRect(10, 20, box)).toBe(true);
    expect(pointInRect(110, 80, box)).toBe(true);
    expect(pointInRect(9, 50, box)).toBe(false);
  });

  it("converts a physical drop coordinate by devicePixelRatio", () => {
    const element = { getBoundingClientRect: () => box };
    expect(physicalPointInElement({ x: 40, y: 80 }, element, 2)).toBe(true);
    expect(physicalPointInElement({ x: 8, y: 80 }, element, 2)).toBe(false);
    expect(physicalPointInElement({ x: 40, y: 80 }, null, 2)).toBe(false);
  });
});
