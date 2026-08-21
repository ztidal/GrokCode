import { describe, expect, it } from "vitest";
import {
  formatPathsForPrompt,
  pasteCarriesFiles,
  quotePath,
} from "./usePastedPaths";

describe("quotePath", () => {
  it("leaves an ordinary path alone", () => {
    // Most paths need no quoting, and an unquoted one is easier to read back.
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

describe("formatPathsForPrompt", () => {
  it("separates several files with spaces", () => {
    expect(formatPathsForPrompt(["a.txt", "b.txt"])).toBe("a.txt b.txt");
  });

  it("quotes only the ones that need it", () => {
    expect(
      formatPathsForPrompt(["C:\\a b\\one.txt", "D:\\two.txt"]),
    ).toBe('"C:\\a b\\one.txt" D:\\two.txt');
  });

  it("is empty for nothing, so an empty answer inserts nothing", () => {
    expect(formatPathsForPrompt([])).toBe("");
  });
});

describe("pasteCarriesFiles", () => {
  const transfer = (types: string[]) => ({ types }) as unknown as DataTransfer;

  it("recognises a paste that carries files", () => {
    // Explorer files and a screenshot look identical here; only the host can
    // tell them apart, which is why this question is the one asked first.
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
