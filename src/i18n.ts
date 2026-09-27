/**
 * Tradução da interface. O texto-fonte é em inglês; as traduções ficam em l10n/bundle.l10n.<idioma>.json
 * (chave = o texto em inglês) e, para o package.json, em package.nls.<idioma>.json.
 *
 * Use `t('Merged {0} into {1}', a, b)`: só argumentos posicionais. Fora do VS Code (testes de
 * unidade) devolve o inglês com os argumentos preenchidos.
 */
type Arg = string | number | boolean;

let api: { t(message: string, ...args: Arg[]): string; bundle?: { [key: string]: string } } | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  api = require('vscode').l10n;
} catch {
  api = undefined;
}

export function t(message: string, ...args: Arg[]): string {
  if (api) return api.t(message, ...args);
  return message.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m));
}

/** Traduções carregadas (vazio em inglês), para os webviews. */
export function bundle(): { [key: string]: string } {
  return api?.bundle ?? {};
}

/** Locale para datas e números (ex.: "pt-BR", "en"). */
export function locale(): string {
  try {
    return require('vscode').env.language || 'en';
  } catch {
    return 'en';
  }
}
