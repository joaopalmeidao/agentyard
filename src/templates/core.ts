/** Modelos de tarefa para agentes, sem depender do VS Code (testado em test/env.test.js). */

export interface TaskTemplate {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  source: 'padrão' | 'configuração' | 'repositório';
  /** Arquivo .md de origem (modelos do repositório). */
  file?: string;
}

export const DEFAULT_TEMPLATES: TaskTemplate[] = [
  {
    id: 'fix-tests',
    name: 'Corrigir testes que falham',
    description: 'Roda a suíte, investiga e corrige as falhas',
    prompt:
      'Na branch ${branch}, rode a suíte de testes do projeto, investigue cada falha e corrija a causa (não o teste, a menos que o teste esteja errado). Rode de novo até passar e faça commits pequenos explicando cada correção.',
    source: 'padrão',
  },
  {
    id: 'update-deps',
    name: 'Atualizar dependências',
    description: 'Atualiza dependências com segurança e roda os testes',
    prompt:
      'Na branch ${branch}, atualize as dependências do projeto para versões compatíveis (sem saltos de versão maior sem necessidade). Leia os changelogs relevantes, ajuste o código se algo quebrar, rode os testes e faça um commit por grupo de dependências.',
    source: 'padrão',
  },
  {
    id: 'write-tests',
    name: 'Escrever testes para o arquivo aberto',
    description: 'Testes para ${file}',
    prompt:
      'Escreva testes para ${file} na branch ${branch}, seguindo o padrão de testes que o projeto já usa. Cubra os caminhos principais e os casos de borda, rode os testes e faça commit.',
    source: 'padrão',
  },
  {
    id: 'simplify-diff',
    name: 'Revisar e simplificar o diff',
    description: 'Revisa o que a branch mudou em relação à base',
    prompt:
      'Revise o que a branch ${branch} mudou em relação a ${base} (git diff ${base}...HEAD). Simplifique o que estiver complexo demais, remova código morto e duplicação, sem mudar o comportamento. Rode os testes e faça commit.',
    source: 'padrão',
  },
  {
    id: 'document-branch',
    name: 'Documentar a branch no README',
    description: 'Atualiza a documentação com o que a branch traz',
    prompt:
      'Documente no README (ou na documentação do projeto) o que a branch ${branch} traz em relação a ${base}: como usar, configurações novas e limitações. Mantenha o estilo da documentação existente e faça commit.',
    source: 'padrão',
  },
  {
    id: 'investigate-error',
    name: 'Investigar erro',
    description: 'Investiga o erro selecionado no editor',
    prompt:
      'Investigue o erro abaixo na branch ${branch}. Encontre a causa, proponha a correção mínima, implemente, rode os testes e faça commit. Se não conseguir reproduzir, explique o que verificou.\n\n```\n${selection}\n```',
    source: 'padrão',
  },
];

/** Troca ${nome}; placeholders sem valor viram texto vazio (exceto os desconhecidos, que ficam). */
export function renderTemplate(prompt: string, vars: Record<string, string | undefined>): string {
  return prompt.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] ?? '' : m));
}

/** Placeholders usados pelo modelo (para avisar quando falta arquivo ou seleção). */
export function placeholdersOf(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/\$\{(\w+)\}/g)].map(m => m[1]))];
}

/**
 * Arquivo `.agentyard/templates/<id>.md`: frontmatter opcional (name, description) e o prompt no corpo.
 */
export function parseTemplateFile(text: string, fileName: string): TaskTemplate {
  const id = fileName.replace(/\.md$/i, '');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const field = (k: string) => (fm ? new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm[1])?.[1].replace(/^["']|["']$/g, '').trim() : undefined);
  return {
    id,
    name: field('name') ?? id,
    description: field('description'),
    prompt: (fm ? text.slice(fm[0].length) : text).trim(),
    source: 'repositório',
  };
}

export function templateFileText(name: string, description: string, prompt: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${prompt}\n`;
}

export function slug(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'modelo'
  );
}
