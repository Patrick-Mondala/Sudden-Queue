/**
 * Translation.
 *
 * The English sentence is its own key. `t("Ready to queue")` looks that string
 * up in the active catalogue and returns it unchanged when there is no entry —
 * so English needs no catalogue at all, a missing translation degrades to
 * readable English rather than to a bare key like `play.ready`, and nobody has
 * to invent a hundred and fifty key names or keep them in step with the copy.
 *
 * The cost is that two identical English strings needing different translations
 * would collide. If that ever happens, the fix is to disambiguate the source
 * string, which is also better English.
 *
 * `t` is a plain function rather than a hook so it works where text is actually
 * assembled — event handlers, error paths, sort comparators. Changing language
 * is rare enough that the app redraws wholesale when it happens; see
 * `onLocaleChange`.
 */

/**
 * Catalogues map English source text to the target language.
 *
 * Add a language by importing its file and listing it here. English is absent
 * on purpose: it is the identity mapping.
 */
export const CATALOGUES = {};

/** Languages that can be chosen, English first because it needs no catalogue. */
export function availableLocales() {
  return ["en", ...Object.keys(CATALOGUES)];
}

const FALLBACK = "en";
const STORAGE_KEY = "sq.locale";

/**
 * Picks the best available language for a list of preferences.
 *
 * Matches `en-GB` to `en`: a regional variant of a language we have beats the
 * fallback, and nobody wants a different interface for being in Ireland.
 */
export function resolveLocale(preferred = [], available = availableLocales()) {
  for (const tag of preferred) {
    if (!tag) continue;
    const lower = String(tag).toLowerCase();

    const exact = available.find((a) => a.toLowerCase() === lower);
    if (exact) return exact;

    const base = lower.split("-")[0];
    const loose = available.find((a) => a.toLowerCase().split("-")[0] === base);
    if (loose) return loose;
  }
  return FALLBACK;
}

/** What the user chose here before, then what their browser or OS asks for. */
function initialLocale() {
  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private windows and locked-down browsers throw on access rather than
    // returning null. A missing preference is not worth failing a render over.
  }

  const fromBrowser =
    typeof navigator === "undefined" ? [] : (navigator.languages ?? [navigator.language]);

  return resolveLocale([saved, ...fromBrowser].filter(Boolean));
}

let locale = initialLocale();
const listeners = new Set();

export function currentLocale() {
  return locale;
}

/** Changes language and tells anyone rendering to draw again. */
export function setLocale(next) {
  const resolved = resolveLocale([next]);
  if (resolved === locale) return;

  locale = resolved;
  try {
    localStorage.setItem(STORAGE_KEY, resolved);
  } catch {
    // Not worth failing over; the choice just will not survive a restart.
  }
  for (const fn of [...listeners]) fn(resolved);
}

/** Subscribes to language changes. Returns an unsubscribe. */
export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Replaces {placeholders}. A missing value is left visible rather than blank. */
function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    params[name] === undefined ? whole : String(params[name]),
  );
}

/** Looks up one phrase, falling back to the English it was written in. */
export function t(source, params) {
  const entry = CATALOGUES[locale]?.[source] ?? source;
  return interpolate(entry, params);
}

/**
 * Chooses between a singular and a plural phrasing, then translates it.
 *
 * English needs only the two, which is why this takes exactly two. Languages
 * with richer plural rules need more, and can have it when one arrives —
 * guessing at their rules now would be worse than not trying.
 */
export function tn(one, other, count, params) {
  return t(count === 1 ? one : other, { ...params, count });
}

/**
 * What to show a person when a request fails.
 *
 * Every refusal from the server carries a machine-readable code beside its
 * English sentence. The code is looked up first, so a deployment can phrase a
 * refusal its own way; failing that the server's own sentence is translated as
 * ordinary source text. Either way a refusal the catalogue has never heard of
 * still reads properly, rather than going blank until someone remembers it.
 */
export function errorText(err, fallback = "That did not work") {
  const code = err?.code;
  if (code) {
    const key = `error.${code}`;
    const translated = t(key, err?.params);
    if (translated !== key) return translated;
  }
  return err?.message ? t(err.message, err?.params) : t(fallback);
}
