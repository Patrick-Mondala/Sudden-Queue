import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CATALOGUES,
  availableLocales,
  currentLocale,
  errorText,
  onLocaleChange,
  resolveLocale,
  setLocale,
  t,
  tn,
} from "./index.js";

beforeEach(() => {
  for (const k of Object.keys(CATALOGUES)) delete CATALOGUES[k];
  setLocale("en");
});

afterEach(() => {
  for (const k of Object.keys(CATALOGUES)) delete CATALOGUES[k];
  setLocale("en");
});

/** Stands in for a shipped language file. */
const german = (entries) => {
  CATALOGUES.de = entries;
  setLocale("de");
};

describe("looking a phrase up", () => {
  it("returns the English it was written in when nothing is translated", () => {
    // The whole point of using the sentence as its own key: an untranslated
    // build is a working English one, not a screen full of dotted keys.
    expect(t("Ready to queue")).toBe("Ready to queue");
  });

  it("returns the translation when there is one", () => {
    german({ "Ready to queue": "Bereit für die Warteschlange" });
    expect(t("Ready to queue")).toBe("Bereit für die Warteschlange");
  });

  it("falls back per phrase, not per language", () => {
    german({ "Ready to queue": "Bereit" });
    // A half-finished catalogue must not blank the strings it has not reached.
    expect(t("Ready to queue")).toBe("Bereit");
    expect(t("Leave queue")).toBe("Leave queue");
  });

  it("fills in placeholders", () => {
    expect(t("{n} of {total} are here", { n: 3, total: 5 })).toBe("3 of 5 are here");
  });

  it("fills them in after translating, not before", () => {
    german({ "{n} of {total} are here": "{n} von {total} sind da" });
    expect(t("{n} of {total} are here", { n: 3, total: 5 })).toBe("3 von 5 sind da");
  });

  it("leaves a placeholder visible when nothing was passed for it", () => {
    // Better a literal {total} in the interface than a sentence with a hole.
    expect(t("{n} of {total}", { n: 3 })).toBe("3 of {total}");
  });
});

describe("counting things", () => {
  it("picks the singular for exactly one", () => {
    expect(tn("{count} match to go", "{count} matches to go", 1)).toBe("1 match to go");
  });

  it("picks the plural for anything else", () => {
    expect(tn("{count} match to go", "{count} matches to go", 3)).toBe("3 matches to go");
    expect(tn("{count} match to go", "{count} matches to go", 0)).toBe("0 matches to go");
  });

  it("translates the form it picked", () => {
    german({ "{count} matches to go": "noch {count} Spiele" });
    expect(tn("{count} match to go", "{count} matches to go", 3)).toBe("noch 3 Spiele");
  });
});

describe("choosing a language", () => {
  it("matches a regional variant to the language we have", () => {
    // Being in Ireland should not change your interface.
    expect(resolveLocale(["en-GB"])).toBe("en");
    CATALOGUES.de = {};
    expect(resolveLocale(["de-AT"])).toBe("de");
  });

  it("takes the first preference it can actually serve", () => {
    CATALOGUES.de = {};
    expect(resolveLocale(["fr", "de", "en"])).toBe("de");
  });

  it("falls back to English for a language we do not have", () => {
    expect(resolveLocale(["fr-CA"])).toBe("en");
  });

  it("ignores blanks in the preference list", () => {
    expect(resolveLocale([null, undefined, "", "en"])).toBe("en");
  });

  it("lists English even though it has no catalogue", () => {
    expect(availableLocales()).toContain("en");
  });

  it("tells anyone rendering that the language changed", () => {
    const seen = [];
    const off = onLocaleChange((l) => seen.push(l));

    CATALOGUES.de = {};
    setLocale("de");
    expect(seen).toEqual(["de"]);
    expect(currentLocale()).toBe("de");

    off();
    setLocale("en");
    expect(seen).toEqual(["de"]);
  });

  it("says nothing when the language did not actually change", () => {
    const seen = [];
    onLocaleChange((l) => seen.push(l));
    setLocale("en");
    expect(seen).toEqual([]);
  });
});

describe("explaining a failure", () => {
  it("prefers a translation keyed on the code", () => {
    german({ "error.CAPTAIN_OFFLINE": "Euer Kapitän ist offline." });
    expect(errorText({ code: "CAPTAIN_OFFLINE", message: "Captain is offline." })).toBe(
      "Euer Kapitän ist offline.",
    );
  });

  it("falls back to the server's own sentence", () => {
    // A refusal added on the server today has to read properly today, not once
    // somebody remembers to add it to a catalogue.
    expect(errorText({ code: "NEVER_SEEN_BEFORE", message: "Something specific happened" })).toBe(
      "Something specific happened",
    );
  });

  it("translates that sentence too when the catalogue knows it", () => {
    german({ "Something specific happened": "Etwas Bestimmtes ist passiert" });
    expect(errorText({ code: "NEVER_SEEN", message: "Something specific happened" })).toBe(
      "Etwas Bestimmtes ist passiert",
    );
  });

  it("has something to say for an error carrying neither", () => {
    expect(errorText({})).toBe("That did not work");
    expect(errorText(null)).toBe("That did not work");
  });

  it("takes a caller's own fallback", () => {
    expect(errorText(null, "Could not load the ladder")).toBe("Could not load the ladder");
  });
});
