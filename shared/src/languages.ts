/**
 * Suvidha supports one *language of instruction* (what the professor actually
 * speaks) and many *comprehension languages* (what each student hears).
 *
 * The distinction matters: we never translate a lecture *out of* its discipline.
 * Technical vocabulary stays in the language of instruction so that students
 * still build the vocabulary they will be examined and employed in. Only the
 * connective explanation around those terms is translated.
 */

export type LangCode = 'en' | 'hi' | 'bn' | 'fr';

export interface Language {
  code: LangCode;
  /** English name, for UI in the professor console. */
  name: string;
  /** Endonym - what speakers call it. Shown to students. */
  nativeName: string;
  /** BCP-47 tag preferred for Web Speech recognition. */
  sttLocale: string;
  /** BCP-47 tags acceptable for speech synthesis, best first. */
  ttsLocales: string[];
  /** Script direction. All four are LTR but downstream languages may not be. */
  dir: 'ltr' | 'rtl';
}

export const LANGUAGES: Record<LangCode, Language> = {
  en: {
    code: 'en',
    name: 'English',
    nativeName: 'English',
    sttLocale: 'en-IN',
    ttsLocales: ['en-IN', 'en-GB', 'en-US'],
    dir: 'ltr',
  },
  hi: {
    code: 'hi',
    name: 'Hindi',
    nativeName: 'हिन्दी',
    sttLocale: 'hi-IN',
    ttsLocales: ['hi-IN'],
    dir: 'ltr',
  },
  bn: {
    code: 'bn',
    name: 'Bengali',
    nativeName: 'বাংলা',
    sttLocale: 'bn-IN',
    ttsLocales: ['bn-IN', 'bn-BD', 'bn'],
    dir: 'ltr',
  },
  fr: {
    code: 'fr',
    name: 'French',
    nativeName: 'Français',
    sttLocale: 'fr-FR',
    ttsLocales: ['fr-FR', 'fr-CA'],
    dir: 'ltr',
  },
};

export const LANGUAGE_LIST: Language[] = Object.values(LANGUAGES);

export function isLangCode(v: unknown): v is LangCode {
  return typeof v === 'string' && v in LANGUAGES;
}
