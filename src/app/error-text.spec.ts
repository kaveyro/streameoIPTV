import { TestBed } from "@angular/core/testing";
import { TranslateService } from "@ngx-translate/core";
import { errorText, firstErrorLine } from "./error-text";
import { TEST_IMPORTS } from "../testing/test-helpers";

describe("errorText", () => {
  let translate: TranslateService;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: TEST_IMPORTS });
    translate = TestBed.inject(TranslateService);
  });

  it("maps known backend messages to their translation", () => {
    // The test translations render the key itself.
    expect(errorText("Wrong PIN", translate)).toBe("PARENTAL.WRONG_PIN");
    expect(errorText("The PIN must be 4 to 8 digits", translate)).toBe(
      "PARENTAL.PIN_FORMAT_INVALID",
    );
    expect(errorText("The link does not point to an M3U playlist", translate)).toBe(
      "ERROR.NOT_M3U_PLAYLIST",
    );
  });

  it("maps a known message that comes with a cause chain", () => {
    const e = "The server did not answer like an Xtream Codes server\n\nCaused by:\n    0: EOF";
    expect(errorText(e, translate)).toBe("ERROR.NOT_XTREAM_SERVER");
  });

  it("strips the Caused by chain of unknown messages", () => {
    const e =
      "error sending request for url (http://h/player_api.php?password=***)\n\nCaused by:\n" +
      "    0: client error (Connect)\n    1: dns error";
    expect(errorText(e, translate)).toBe(
      "error sending request for url (http://h/player_api.php?password=***)",
    );
  });

  it("accepts Error objects and empty values", () => {
    expect(firstErrorLine(new Error("boom\nmore"))).toBe("boom");
    expect(firstErrorLine(undefined)).toBe("");
    expect(firstErrorLine("\n\nonly later")).toBe("only later");
  });
});
