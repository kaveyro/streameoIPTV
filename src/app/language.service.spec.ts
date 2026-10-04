import { TestBed } from "@angular/core/testing";
import { TranslateService } from "@ngx-translate/core";
import { LanguageService, NATIVE_STRING_KEYS } from "./language.service";
import {
  IpcCall,
  TEST_IMPORTS,
  callsOf,
  mockTauri,
  resetTauri,
  settle,
} from "../testing/test-helpers";

describe("LanguageService", () => {
  let calls: IpcCall[];

  function setup(handlers: Record<string, unknown> = {}): LanguageService {
    calls = mockTauri(handlers);
    TestBed.configureTestingModule({ imports: TEST_IMPORTS });
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation("de", {
      NATIVE: { TRAY_SHOW: "Anzeigen", TRAY_QUIT: "Beenden", QUIT_TITLE: "Beenden?" },
    });
    translate.setTranslation("ar", { NATIVE: { TRAY_SHOW: "إظهار" } });
    return TestBed.inject(LanguageService);
  }

  afterEach(() => {
    document.documentElement.lang = "en";
    document.documentElement.dir = "ltr";
    resetTauri();
  });

  it("sets the language and direction of the document", async () => {
    const service = setup();
    await service.apply("ar");
    expect(document.documentElement.lang).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");
    await service.apply("de");
    expect(document.documentElement.lang).toBe("de");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("hands the backend its strings in the new language", async () => {
    const service = setup();
    await service.apply("de");
    await settle();
    const sent = callsOf(calls, "set_native_strings");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[sent.length - 1].args["strings"]).toEqual({
      tray_show: "Anzeigen",
      tray_quit: "Beenden",
      quit_title: "Beenden?",
    });
    expect(Object.keys(NATIVE_STRING_KEYS).length).toBe(16);
  });

  it("sends the strings again on every language change", async () => {
    const service = setup();
    await service.apply("de");
    await service.apply("ar");
    await settle();
    const sent = callsOf(calls, "set_native_strings");
    expect(sent[sent.length - 1].args["strings"]).toEqual({ tray_show: "إظهار" });
  });

  it("swallows a backend without the command", async () => {
    const service = setup({
      set_native_strings: () => Promise.reject("command set_native_strings not found"),
    });
    const error = spyOn(console, "error");
    await service.apply("de");
    await settle();
    expect(error).toHaveBeenCalled();
  });
});
