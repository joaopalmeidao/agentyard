/**
 * Agendamentos: cron de 5 campos, atalhos em português (e o equivalente em inglês), próximos horários
 * e execuções perdidas. Sem dependência do VS Code, para ser testado direto (test/schedule.test.js). Horário local.
 */
import { locale, t } from '../i18n';

export type When = { kind: 'cron'; expr: string } | { kind: 'once'; at: number };

export type Target =
  | { kind: 'branch'; branch: string }
  | { kind: 'new'; prefix: string }
  | { kind: 'pattern'; pattern: string };

export interface Schedule {
  id: string;
  name: string;
  /** Texto como a pessoa escreveu (cron ou atalho); interpretado por parseWhen. */
  when: string;
  target: Target;
  prompt: string;
  agent?: string;
  delivery: 'launch' | 'queue';
  conditions: { onlyClean?: boolean; onlyIfBaseMoved?: boolean; skipIfAgentOpen?: boolean };
  /** Horário que passou com o VS Code fechado: executar uma vez ao abrir, ou pular. */
  missed: 'run' | 'skip';
  enabled: boolean;
  /** local: só nesta máquina; shared: em .agentyard/schedules.json no repositório. */
  scope: 'local' | 'shared';
  createdAt: number;
}

export interface RunRecord {
  at: number;
  scheduleId: string;
  name: string;
  target: string;
  result: 'ok' | 'skipped' | 'error';
  message: string;
}

// ---------- cron ----------

interface Field {
  min: number;
  max: number;
}
const FIELDS: Field[] = [
  { min: 0, max: 59 }, // minuto
  { min: 0, max: 23 }, // hora
  { min: 1, max: 31 }, // dia do mês
  { min: 1, max: 12 }, // mês
  { min: 0, max: 7 }, // dia da semana (0 e 7 = domingo)
];

export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Dia do mês e dia da semana restritos ao mesmo tempo: vale qualquer um dos dois (regra do cron). */
  domStar: boolean;
  dowStar: boolean;
}

function parseField(text: string, f: Field): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(t('invalid field: "{0}"', part));
    const step = m[4] ? Number(m[4]) : 1;
    if (step < 1) throw new Error(t('invalid step: "{0}"', part));
    let lo: number;
    let hi: number;
    if (m[1] === '*') {
      lo = f.min;
      hi = f.max;
    } else {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : m[4] ? f.max : lo;
    }
    if (lo < f.min || hi > f.max || lo > hi) throw new Error(t('out of range {0}-{1}: "{2}"', f.min, f.max, part));
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(t('cron needs 5 fields: minute hour day month weekday'));
  const [mi, h, d, mo, w] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (w.has(7)) w.add(0);
  return { minutes: mi, hours: h, days: d, months: mo, weekdays: w, domStar: parts[2] === '*', dowStar: parts[4] === '*' };
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.days.has(d.getDate());
  const dow = c.weekdays.has(d.getDay());
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dow;
  if (c.dowStar) return dom;
  return dom || dow;
}

/** Próximo horário estritamente depois de `from`, ou undefined se não houver em ~5 anos. */
export function nextCron(c: Cron, from: Date): Date | undefined {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 5 * 366 * 86400_000;
  // pula mês, dia e hora inteiros quando não casam; no pior caso são poucos milhares de passos
  for (let guard = 0; guard < 200_000 && d.getTime() <= limit; guard++) {
    if (!c.months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hours.has(d.getHours())) {
      const h = d.getHours();
      d.setHours(h + 1, 0, 0, 0);
      // horário de verão pode "pular" a hora; se não andou, força uma hora à frente
      if (d.getHours() === h) d.setTime(d.getTime() + 3600_000);
      continue;
    }
    if (!c.minutes.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1);
      continue;
    }
    return d;
  }
  return undefined;
}

// ---------- atalhos ----------

const WEEKDAYS: Record<string, number> = {
  domingo: 0, dom: 0, segunda: 1, seg: 1, 'segunda-feira': 1, terça: 2, terca: 2, ter: 2, 'terça-feira': 2,
  quarta: 3, qua: 3, 'quarta-feira': 3, quinta: 4, qui: 4, 'quinta-feira': 4, sexta: 5, sex: 5, 'sexta-feira': 5,
  sábado: 6, sabado: 6, sab: 6, sáb: 6,
  // inglês
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};

/** "9", "9h", "09:30", "8h30", e também "9am", "9:30 pm". */
const hm = (s: string) => {
  const m = /^(\d{1,2})(?:[:h](\d{2}))?(?:h|\s?(am|pm))?$/.exec(s.trim());
  if (!m) return undefined;
  let h = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  if (m[3]) {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (m[3] === 'pm' ? 12 : 0);
  }
  return h <= 23 && mi <= 59 ? { h, mi } : undefined;
};

/**
 * Interpreta o "quando": um cron de 5 campos ou um atalho:
 *   "todo dia às 09:00", "dias úteis às 8h30", "toda segunda às 10:00", "a cada 2 h",
 *   "a cada 30 min", "de hora em hora", "uma vez em 2026-10-01 14:00";
 * ou em inglês: "every day at 9am", "weekdays at 8:30", "every monday at 10:00", "every 2 hours",
 *   "every 30 min", "hourly", "once on 2026-10-01 14:00".
 */
export function parseWhen(text: string): When {
  const s = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) throw new Error(t('enter when'));
  const badTime = () => new Error(t('invalid time'));
  let m: RegExpExecArray | null;
  if ((m = /^(?:uma vez em|once on|once at|once) (\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2}[:h]\d{2}|\d{1,2}h?|\d{1,2}(?::\d{2})? ?(?:am|pm)))?$/.exec(s))) {
    const time = m[4] ? hm(m[4]) : { h: 9, mi: 0 };
    if (!time) throw badTime();
    const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), time.h, time.mi).getTime();
    if (Number.isNaN(at)) throw new Error(t('invalid date'));
    return { kind: 'once', at };
  }
  if ((m = /^(?:(?:todo dia|todos os dias|diariamente) (?:às|as|a)|(?:every day|everyday|daily) at) (.+)$/.exec(s))) {
    const x = hm(m[1]);
    if (!x) throw badTime();
    return { kind: 'cron', expr: `${x.mi} ${x.h} * * *` };
  }
  if ((m = /^(?:(?:dias úteis|dias uteis|de segunda a sexta) (?:às|as|a)|(?:weekdays|every weekday|monday to friday|monday through friday) at) (.+)$/.exec(s))) {
    const x = hm(m[1]);
    if (!x) throw badTime();
    return { kind: 'cron', expr: `${x.mi} ${x.h} * * 1-5` };
  }
  if (
    ((m = /^(?:todo|toda) ([a-zçáé-]+) (?:às|as|a) (.+)$/.exec(s)) || (m = /^(?:every|on) ([a-z]+?)s? at (.+)$/.exec(s))) &&
    m[1] in WEEKDAYS
  ) {
    const x = hm(m[2]);
    if (!x) throw badTime();
    return { kind: 'cron', expr: `${x.mi} ${x.h} * * ${WEEKDAYS[m[1]]}` };
  }
  if (s === 'de hora em hora' || s === 'a cada hora' || s === 'hourly' || s === 'every hour') return { kind: 'cron', expr: '0 * * * *' };
  if (s === 'a cada minuto' || s === 'every minute') return { kind: 'cron', expr: '* * * * *' };
  if ((m = /^(?:a cada|every) (\d+) ?(h|hora|horas|hr|hrs|hour|hours)$/.exec(s))) {
    const n = Number(m[1]);
    if (n < 1 || n > 23) throw new Error(t('use 1 to 23 hours'));
    return { kind: 'cron', expr: `0 */${n} * * *` };
  }
  if ((m = /^(?:a cada|every) (\d+) ?(min|minuto|minutos|mins|minute|minutes)$/.exec(s))) {
    const n = Number(m[1]);
    if (n < 1 || n > 59) throw new Error(t('use 1 to 59 minutes'));
    return { kind: 'cron', expr: `*/${n} * * * *` };
  }
  parseCron(s); // lança se não for cron válido
  return { kind: 'cron', expr: s };
}

/** Próximo horário do agendamento depois de `from` (undefined: "uma vez" que já passou). */
export function nextRun(when: When, from: Date): Date | undefined {
  if (when.kind === 'once') return when.at > from.getTime() ? new Date(when.at) : undefined;
  return nextCron(parseCron(when.expr), from);
}

export function nextRuns(when: When, from: Date, n: number): Date[] {
  const out: Date[] = [];
  let cur = from;
  for (let i = 0; i < n; i++) {
    const d = nextRun(when, cur);
    if (!d) break;
    out.push(d);
    cur = d;
  }
  return out;
}

/**
 * Houve horário entre `since` (exclusive) e `now` (inclusive)? Devolve o último deles — quem
 * esteve fechado por dias executa uma vez só, não uma por horário perdido.
 */
export function missedSince(when: When, since: number, now: number): Date | undefined {
  let last: Date | undefined;
  let cur = new Date(since);
  for (let i = 0; i < 100_000; i++) {
    const d = nextRun(when, cur);
    if (!d || d.getTime() > now) break;
    last = d;
    cur = d;
  }
  return last;
}

/** Texto amigável: "hoje 14:00", "amanhã 09:00", "seg 08:30", "12/10 09:00" (traduzido). */
export function relativeTime(d: Date, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400_000);
  if (diff === 0) return t('today {0}', time);
  if (diff === 1) return t('tomorrow {0}', time);
  if (diff === -1) return t('yesterday {0}', time);
  // dia da semana abreviado no idioma da interface ("qua", "Wed"), sem o ponto do pt-BR
  if (diff > 1 && diff < 7) return `${d.toLocaleDateString(locale(), { weekday: 'short' }).replace(/\.$/, '')} ${time}`;
  const date = d.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  return `${date} ${time}`;
}

/** Troca ${nome} pelos valores; placeholders desconhecidos ficam como estão. */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

export function slug(s: string): string {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'tarefa'
  );
}

/** Branch da "nova worktree": "agendado/relatorio-2026-09-27". */
export function newBranchName(prefix: string, name: string, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${(prefix || 'agendado').replace(/\/+$/, '')}/${slug(name)}-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export function describeTarget(target: Target): string {
  if (target.kind === 'branch') return target.branch;
  if (target.kind === 'new') return t('new worktree ({0}/…)', target.prefix || 'agendado');
  return t('each worktree {0}', target.pattern);
}
