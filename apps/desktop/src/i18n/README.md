# Adding a language

English needs no catalogue. It is the source text, so an untranslated build is a
working English one rather than a screen of placeholder keys.

To add another language, write a file that maps the English source text to your
translation and register it:

```js
// apps/desktop/src/i18n/de.js
export const de = {
  "Ready to queue": "Bereit für die Warteschlange",
  "Leave queue": "Warteschlange verlassen",
  "{count} placed player": "{count} platzierter Spieler",
  "{count} placed players": "{count} platzierte Spieler",
};
```

```js
// apps/desktop/src/i18n/index.js
import { de } from "./de.js";
export const CATALOGUES = { de };
```

That is the whole mechanism. A phrase you have not translated yet falls back to
English on its own, so a half-finished catalogue is a half-translated app rather
than a broken one — you can ship it and fill it in.

## Rules worth knowing

**`{placeholders}` survive translation.** They are filled in after the lookup,
so move them wherever the sentence needs them:

```js
"{n} of {total} are here": "{n} von {total} sind da",
```

Leave one out and it stays visible as `{total}` rather than leaving a hole in
the sentence. That is deliberate: a visible fault is easier to find than a
missing word.

**Plurals come in pairs.** English needs exactly two forms, so `tn` takes two.
Translate both:

```js
"{count} match to go": "noch {count} Spiel",
"{count} matches to go": "noch {count} Spiele",
```

Languages with more plural forms than English need more than this. That is a
real gap, and the honest answer is that it should be built when the first such
language actually arrives rather than guessed at now.

**Refusals from the server can be translated two ways.** Every refusal carries a
machine-readable code beside its English sentence. Translate the code when you
want to phrase it your own way:

```js
"error.CAPTAIN_OFFLINE": "Euer Kapitän ist offline.",
```

Or translate the English sentence as ordinary text. The code wins where both
exist. A refusal your catalogue has never heard of still shows the server's
English rather than going blank, so the server can add one without breaking
every language at once.

**Two identical English strings sharing one entry** is the cost of using the
source text as the key. It has not bitten yet. If it does, disambiguate the
English — which usually improves it.

## Finding untranslated text

`t("…")` marks a string as translatable. Anything not wrapped in it will stay
English for ever, silently. The pattern to look for is a bare quoted string in a
rendering position: JSX text, a `placeholder`, a `title`, an `aria-label`, or a
label inside a tuple such as `[t("Online"), count]`.

Keyboard comparisons (`e.key === "Enter"`) and configuration values are
deliberately *not* wrapped — translating either would break behaviour rather
than the interface.
